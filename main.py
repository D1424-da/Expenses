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
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
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
MAX_BYTES = 15 * 1024 * 1024  # 15MB

app = FastAPI(title="レシートOCRサービス")

# Firebase Hosting 等、別オリジンのフロントから呼べるよう CORS を許可。
# 本番では CORS_ORIGINS にホスティングURLをカンマ区切りで指定する。
_origins = os.environ.get("CORS_ORIGINS", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if _origins == "*" else [o.strip() for o in _origins.split(",")],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "engine": os.environ.get("OCR_ENGINE", "tesseract")}


@app.post("/api/ocr")
async def ocr_receipt(file: UploadFile = File(...)) -> JSONResponse:
    """レシート画像を受け取り、OCR → 項目抽出した結果を返す（保存はしない）。"""
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"対応していない画像形式です: {file.content_type}")
    image_bytes = await file.read()
    if len(image_bytes) > MAX_BYTES:
        raise HTTPException(400, "画像サイズが大きすぎます（最大15MB）。")
    if not image_bytes:
        raise HTTPException(400, "空のファイルです。")

    # OCR_ENGINE=gemini / vertex のときは Gemini で画像から直接構造化抽出（高精度）。
    #   gemini: Developer API（APIキー / AI Studio 課金）
    #   vertex: Vertex AI（OAuth / Google Cloud 課金=無料トライアル等を消費）
    # 鍵・資格情報はサーバーの環境変数に保持し、フロントには出さない。
    engine = os.environ.get("OCR_ENGINE", "tesseract").lower()
    if engine in ("gemini", "vertex"):
        ai = vertex if engine == "vertex" else gemini
        ai_name = "Vertex AI" if engine == "vertex" else "Gemini"
        if ai is None:
            raise HTTPException(500, f"{ai_name} エンジンを利用できません。")
        try:
            return JSONResponse(ai.extract_receipt(image_bytes))
        except Exception as exc:  # noqa: BLE001 — ユーザーに原因を返す
            logger.exception("%s OCR failed", ai_name)  # 原因を Render ログに出す
            # 保険: VISION_API_KEY があれば Vision でフォールバック（OCR専用）。
            has_vision_key = bool(os.environ.get("VISION_API_KEY"))
            if vision is not None and has_vision_key:
                try:
                    logger.warning("%s 失敗。Vision にフォールバックします。", ai_name)
                    result = vision.extract_receipt(image_bytes)
                    result["engine"] = "vision"  # フロントの履歴正規化の対象
                    return JSONResponse(result)
                except Exception as vexc:  # noqa: BLE001 — フォールバックも失敗
                    logger.exception("Vision fallback failed")
                    # Vision が失敗した本当の理由（Cloud Vision 未有効化=403、
                    # APIキー制限など）が AI エラーに隠れないよう両方返す。
                    raise HTTPException(
                        500,
                        f"AI 読み取りに失敗しました。"
                        f"{ai_name}: {exc} / Vision フォールバックも失敗: {vexc}",
                    ) from vexc
            # フォールバック未設定/無効のときは、その旨も添えて原因を返す。
            reason = (
                "（VISION_API_KEY 未設定のためフォールバック無効）"
                if not has_vision_key
                else "（Vision フォールバック利用不可）"
            )
            raise HTTPException(
                500, f"AI 読み取りに失敗しました: {exc} {reason}"
            ) from exc

    try:
        from app import ocr  # 遅延 import（OpenCV/Tesseract が必要なときだけ）
        text = ocr.run_ocr(image_bytes)
    except Exception as exc:  # noqa: BLE001 — ユーザーに原因を返す
        raise HTTPException(500, f"OCR に失敗しました: {exc}") from exc

    result = parser.parse_receipt(text)
    result["engine"] = "tesseract"  # フロントの履歴正規化の対象
    return JSONResponse(result)


# ---- フロント配信（ローカル開発用。本番は Firebase Hosting を使う） ----------
# static/ をそのまま配信する。Firebase Hosting でも public ディレクトリを static/
# に設定するため、index.html は相対パスでアセットを参照している。
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
