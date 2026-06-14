"""レシートOCRサービス — FastAPI エントリポイント。

このバックエンドは「OCR専用サービス」。家計簿データそのものは Firebase
(Firestore / Storage) にフロントから直接保存するため、ここでは画像を受け取り
日付・店名・金額・品目を抽出して返すだけで、データ保存は行わない。

起動（ローカル開発）:
    uvicorn main:app --reload
ブラウザで http://localhost:8000 を開く。
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app import ocr, parser

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

    try:
        text = ocr.run_ocr(image_bytes)
    except Exception as exc:  # noqa: BLE001 — ユーザーに原因を返す
        raise HTTPException(500, f"OCR に失敗しました: {exc}") from exc

    return JSONResponse(parser.parse_receipt(text))


# ---- フロント配信（ローカル開発用。本番は Firebase Hosting を使う） ----------
# static/ をそのまま配信する。Firebase Hosting でも public ディレクトリを static/
# に設定するため、index.html は相対パスでアセットを参照している。
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
