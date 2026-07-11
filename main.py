"""レシートOCRサービス — FastAPI エントリポイント。

このバックエンドは「OCR専用サービス」。家計簿データそのものは Firebase
(Firestore / Storage) にフロントから直接保存するため、ここでは画像を受け取り
日付・店名・金額・品目を抽出して返すだけで、データ保存は行わない。

役割分担:
- app/security.py : 画像検証・レート制限・Firebase 認証
- app/engines.py  : OCR エンジンの選択と多段フォールバック

起動（ローカル開発）:
    uvicorn main:app --reload
ブラウザで http://localhost:8000 を開く。
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from typing import Annotated

from fastapi import FastAPI, File, Header, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi import Body

from app import engines, security

logger = logging.getLogger("uvicorn.error")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/jpg"}
MAX_BYTES = 8 * 1024 * 1024  # 8MB（フロントで縮小済み。課金/DoS対策で控えめに）

# Firebase ID トークン検証（任意）。FIREBASE_PROJECT_ID を設定すると /api/ocr を
# 認証必須にできる（未設定なら検証はスキップし、レート制限のみで保護）。
FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "").strip()

_rate_limiter = security.RateLimiter(
    window_sec=int(os.environ.get("RATE_WINDOW_SEC", "60")),
    per_ip=int(os.environ.get("RATE_PER_IP", "10")),        # IPあたり/分
    global_limit=int(os.environ.get("RATE_GLOBAL", "60")),  # 全体/分
)

app = FastAPI(title="レシートOCRサービス")


def _allowed_origins() -> list[str]:
    """CORS_ORIGINS（カンマ区切り）から許可オリジンを組み立てる。

    Firebase Auth + レート制限で保護されているため、デフォルトは全オリジン許可。
    特定オリジンに絞りたい場合は CORS_ORIGINS 環境変数でカンマ区切りで指定する。
    """
    origins = os.environ.get("CORS_ORIGINS", "*").strip()
    if origins == "*":
        return ["*"]
    return [o.strip() for o in origins.split(",") if o.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "engine": os.environ.get("OCR_ENGINE", "tesseract")}


@app.post("/api/ocr")
async def ocr_receipt(
    request: Request,
    file: UploadFile = File(...),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """レシート画像を受け取り、OCR → 項目抽出した結果を返す（保存はしない）。"""
    security.verify_firebase_token(authorization, FIREBASE_PROJECT_ID)
    _rate_limiter.check(security.client_ip(request))
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"対応していない画像形式です: {file.content_type}")
    image_bytes = await file.read()
    if len(image_bytes) > MAX_BYTES:
        raise HTTPException(400, "画像サイズが大きすぎます（最大8MB）。")
    if not image_bytes:
        raise HTTPException(400, "空のファイルです。")
    if not security.looks_like_image(image_bytes):
        raise HTTPException(400, "画像ファイルとして認識できませんでした。")

    engine = os.environ.get("OCR_ENGINE", "tesseract").lower()
    if engine in engines.AI_ENGINES:
        try:
            return JSONResponse(engines.extract_with_ai(engine, image_bytes, file.content_type))
        except engines.ExtractionError as exc:
            raise HTTPException(
                500, "レシートの読み取りに失敗しました。時間をおいて再試行してください。"
            ) from exc

    try:
        return JSONResponse(engines.extract_with_tesseract(image_bytes))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Tesseract OCR failed")
        raise HTTPException(500, "レシートの読み取りに失敗しました。") from exc


class FamilyComposition(BaseModel):
    adults_m: int = Field(0, ge=0, le=20)   # 大人（男）
    adults_f: int = Field(0, ge=0, le=20)   # 大人（女）
    toddlers: int = Field(0, ge=0, le=10)   # 幼児（〜5歳）
    elementary: int = Field(0, ge=0, le=10) # 小学生
    junior_high: int = Field(0, ge=0, le=10)# 中学生・高校生


class RecipeRequest(BaseModel):
    items: list[Annotated[str, Field(max_length=200)]] = Field(..., min_length=1, max_length=50)
    servings: int = Field(2, ge=1, le=20)
    recipe_type: str = Field("meal", pattern="^(meal|weekly)$")
    max_minutes: int | None = Field(None, ge=5, le=180)
    use_up: bool = Field(False)
    family: FamilyComposition | None = Field(None)


@app.post("/api/recipe")
async def suggest_recipe(
    request: Request,
    body: RecipeRequest,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """食材リストと人数からレシピを提案する（Gemini 使用）。"""
    security.verify_firebase_token(authorization, FIREBASE_PROJECT_ID)
    _rate_limiter.check(security.client_ip(request))
    if not body.items:
        raise HTTPException(400, "食材リストが空です。")
    from app import recipe as recipe_mod
    try:
        text = recipe_mod.suggest_recipes(
            body.items, body.servings, body.recipe_type,
            max_minutes=body.max_minutes, use_up=body.use_up,
            family=body.family.model_dump() if body.family else None,
        )
        return JSONResponse({"recipe": text})
    except RuntimeError as exc:
        msg = str(exc)
        if "GEMINI_API_KEY が設定されていません" in msg:
            raise HTTPException(503, "レシピ提案サービスが設定されていません（GEMINI_API_KEY を確認してください）。") from exc
        raise HTTPException(503, f"Gemini API でエラーが発生しました。食材の数を減らして再試行してください。({msg[:150]})") from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("Recipe suggestion failed")
        raise HTTPException(500, "レシピの提案に失敗しました。時間をおいて再試行してください。") from exc


# ---- Stripe サブスクリプション ------------------------------------------------

class CheckoutRequest(BaseModel):
    email: str = Field(..., max_length=254)


@app.post("/api/stripe/checkout")
async def stripe_checkout(
    request: Request,
    body: CheckoutRequest,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """Stripe Checkout セッションを作成し URL を返す。Firebase 認証必須。"""
    uid = security.verify_firebase_token(authorization, FIREBASE_PROJECT_ID)
    if not uid:
        raise HTTPException(401, "認証が必要です。")
    from app import stripe_billing
    url = await stripe_billing.create_checkout_session(uid, body.email)
    return JSONResponse({"url": url})


class BetaRedeemRequest(BaseModel):
    code: str = Field(..., max_length=50)


@app.post("/api/beta/redeem")
async def beta_redeem(
    body: BetaRedeemRequest,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """招待コードを検証し、有効なら無料プレミアムを付与する。Firebase 認証必須。"""
    uid = security.verify_firebase_token(authorization, FIREBASE_PROJECT_ID)
    if not uid:
        raise HTTPException(401, "認証が必要です。")
    from app import stripe_billing
    ok = await stripe_billing.redeem_beta_code(uid, body.code)
    if not ok:
        raise HTTPException(400, "無効なコードです。")
    return JSONResponse({"ok": True})


@app.post("/api/stripe/webhook")
async def stripe_webhook(
    request: Request,
    stripe_signature: str | None = Header(default=None, alias="stripe-signature"),
) -> JSONResponse:
    """Stripe からの Webhook を受け取り、Firestore のサブスクリプション状態を更新する。
    署名検証のため生ボディが必要（JSONパースしないこと）。
    """
    payload = await request.body()
    if not stripe_signature:
        raise HTTPException(400, "Stripe-Signature ヘッダーがありません。")
    from app import stripe_billing
    result = await stripe_billing.handle_webhook(payload, stripe_signature)
    return JSONResponse(result)


# ---- フロント配信（ローカル開発用。本番は Firebase Hosting を使う） ----------
# static/ をそのまま配信する。Firebase Hosting でも public ディレクトリを static/
# に設定するため、index.html は相対パスでアセットを参照している。
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
