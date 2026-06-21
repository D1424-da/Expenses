"""レシートOCRサービス — FastAPI エントリポイント。

このバックエンドは「OCR専用サービス」。家計簿データそのものは Firebase
(Firestore / Storage) にフロントから直接保存するため、ここでは画像を受け取り
日付・店名・金額・品目を抽出して返すだけで、データ保存は行わない。

起動（ローカル開発）:
    uvicorn main:app --reload
ブラウザで http://localhost:8000 を開く。
"""
from __future__ import annotations

import logging
import os
import threading
import time
from collections import deque
from pathlib import Path

from fastapi import FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger("uvicorn.error")

from app import parser
# ocr モジュールは OpenCV/Tesseract に依存するため、必要になるまで読み込まない。
# Gemini エンジンだけを使う軽量(Docker無し)デプロイで起動が失敗しないようにする。
try:
    from app import gemini
except Exception:  # noqa: BLE001 — gemini は任意
    gemini = None  # type: ignore
# Vertex AI 版 Gemini（Google Cloud 課金=無料トライアル等で動かす）。任意の依存。
try:
    from app import vertex
except Exception:  # noqa: BLE001 — vertex は任意
    vertex = None  # type: ignore
# Vision は AI が失敗したときの保険（OCR専用）。任意の依存にする。
try:
    from app import vision
except Exception:  # noqa: BLE001 — vision は任意
    vision = None  # type: ignore

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/jpg"}
MAX_BYTES = 8 * 1024 * 1024  # 8MB（フロントで縮小済み。課金/DoS対策で控えめに）

# Firebase ID トークン検証（任意）。FIREBASE_PROJECT_ID を設定すると /api/ocr を
# 認証必須にできる（未設定なら検証はスキップし、レート制限のみで保護）。
FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "").strip()

# 簡易レート制限（単一インスタンス前提・インメモリ）。IP単位＋全体上限で、
# 認証なしの公開エンドポイントが課金を浪費されるのを防ぐ最低限の歯止め。
RATE_WINDOW_SEC = int(os.environ.get("RATE_WINDOW_SEC", "60"))
RATE_PER_IP = int(os.environ.get("RATE_PER_IP", "10"))      # IPあたり/分
RATE_GLOBAL = int(os.environ.get("RATE_GLOBAL", "60"))      # 全体/分
_rate_lock = threading.Lock()
_rate_by_ip: dict[str, deque[float]] = {}
_rate_global: deque[float] = deque()

app = FastAPI(title="レシートOCRサービス")

# Firebase Hosting 等、別オリジンのフロントから呼べるよう CORS を許可。
# 本番では CORS_ORIGINS にホスティングURLをカンマ区切りで指定する。
# 未設定時は「許可なし」にフェイルクローズ（誤って全許可にしない）。
_origins = os.environ.get("CORS_ORIGINS", "").strip()
if _origins == "*":
    _allow_origins = ["*"]
elif _origins:
    _allow_origins = [o.strip() for o in _origins.split(",") if o.strip()]
else:
    _allow_origins = []
    logger.warning("CORS_ORIGINS 未設定。ブラウザからのクロスオリジン呼び出しは拒否されます。")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

# 画像のマジックバイト（content_type はクライアント申告で信用できないため実体を確認）。
def _looks_like_image(b: bytes) -> bool:
    return (
        b[:3] == b"\xff\xd8\xff"  # JPEG
        or b[:8] == b"\x89PNG\r\n\x1a\n"  # PNG
        or (b[:4] == b"RIFF" and b[8:12] == b"WEBP")  # WEBP
        or b[4:8] == b"ftyp"  # HEIC/HEIF (ISO-BMFF)
    )


def _client_ip(request: Request) -> str:
    # Render などのプロキシ経由。XFF の先頭を採用。
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_limit(ip: str) -> None:
    now = time.time()
    cutoff = now - RATE_WINDOW_SEC
    with _rate_lock:
        while _rate_global and _rate_global[0] < cutoff:
            _rate_global.popleft()
        dq = _rate_by_ip.setdefault(ip, deque())
        while dq and dq[0] < cutoff:
            dq.popleft()
        if len(dq) >= RATE_PER_IP or len(_rate_global) >= RATE_GLOBAL:
            raise HTTPException(429, "リクエストが多すぎます。しばらく待って再試行してください。")
        dq.append(now)
        _rate_global.append(now)


def _verify_auth(authorization: str | None) -> None:
    """FIREBASE_PROJECT_ID 設定時のみ、Firebase ID トークンを検証する。"""
    if not FIREBASE_PROJECT_ID:
        return  # 未設定なら認証はスキップ（レート制限のみ）
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not token:
        raise HTTPException(401, "認証が必要です。")
    try:
        from google.auth.transport import requests as ga_requests
        from google.oauth2 import id_token as google_id_token
        google_id_token.verify_firebase_token(
            token, ga_requests.Request(), audience=FIREBASE_PROJECT_ID
        )
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 — 検証失敗は一律 401（詳細はサーバーログのみ）
        logger.exception("ID トークン検証に失敗")
        raise HTTPException(401, "認証に失敗しました。") from None


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
    _verify_auth(authorization)
    _rate_limit(_client_ip(request))
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"対応していない画像形式です: {file.content_type}")
    image_bytes = await file.read()
    if len(image_bytes) > MAX_BYTES:
        raise HTTPException(400, "画像サイズが大きすぎます（最大8MB）。")
    if not image_bytes:
        raise HTTPException(400, "空のファイルです。")
    if not _looks_like_image(image_bytes):
        raise HTTPException(400, "画像ファイルとして認識できませんでした。")

    # OCR_ENGINE=gemini / vertex のときは AI で画像から直接構造化抽出（高精度）。
    #   gemini: Developer API（APIキー / AI Studio 課金）
    #   vertex: Vertex AI（OAuth / Google Cloud 課金=無料トライアル等を消費）
    # 多段フォールバック: 設定エンジンを先頭に、もう一方の AI → Vision の順で試す。
    # （例 OCR_ENGINE=gemini なら gemini → vertex → Vision → 最後はブラウザ PaddleOCR）
    # 鍵・資格情報はサーバーの環境変数に保持し、フロントには出さない。
    engine = os.environ.get("OCR_ENGINE", "tesseract").lower()
    if engine in ("gemini", "vertex"):
        ai_modules = {"gemini": gemini, "vertex": vertex}
        ai_labels = {"gemini": "Gemini", "vertex": "Vertex AI"}
        # 設定エンジンを先頭にした試行順（重複なし）。
        order = [engine] + [e for e in ("gemini", "vertex") if e != engine]

        errors: list[str] = []
        for name in order:
            module = ai_modules.get(name)
            if module is None:
                continue  # 依存未導入などで利用不可ならスキップ
            try:
                return JSONResponse(module.extract_receipt(image_bytes))
            except Exception as exc:  # noqa: BLE001 — 次の手段へ
                logger.exception("%s OCR failed", ai_labels[name])
                errors.append(f"{ai_labels[name]}: {exc}")

        # すべての AI が失敗 → VISION_API_KEY があれば Vision で再試行（OCR専用）。
        has_vision_key = bool(os.environ.get("VISION_API_KEY"))
        if vision is not None and has_vision_key:
            try:
                logger.warning("AI 全滅。Vision にフォールバックします。")
                result = vision.extract_receipt(image_bytes)
                result["engine"] = "vision"  # フロントの履歴正規化の対象
                return JSONResponse(result)
            except Exception as vexc:  # noqa: BLE001 — フォールバックも失敗
                logger.exception("Vision fallback failed")
                errors.append(f"Vision フォールバックも失敗: {vexc}")
        # 失敗の詳細（プロバイダ由来の文言）はログにのみ残し、クライアントには
        # 内部情報を含まない一般的なメッセージを返す。
        logger.error("AI OCR 全失敗: %s", " / ".join(errors))
        raise HTTPException(500, "レシートの読み取りに失敗しました。時間をおいて再試行してください。")

    try:
        from app import ocr  # 遅延 import（OpenCV/Tesseract が必要なときだけ）
        text = ocr.run_ocr(image_bytes)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Tesseract OCR failed")
        raise HTTPException(500, "レシートの読み取りに失敗しました。") from exc

    result = parser.parse_receipt(text)
    result["engine"] = "tesseract"  # フロントの履歴正規化の対象
    return JSONResponse(result)


# ---- フロント配信（ローカル開発用。本番は Firebase Hosting を使う） ----------
# static/ をそのまま配信する。Firebase Hosting でも public ディレクトリを static/
# に設定するため、index.html は相対パスでアセットを参照している。
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
