"""OCR・ヘルスチェック エンドポイント。"""
from __future__ import annotations

import asyncio
import logging
import os

from fastapi import APIRouter, File, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

from app import debug_storage, engines, security
from app.routes._shared import rate_limiter, FIREBASE_PROJECT_ID

logger = logging.getLogger("uvicorn.error")

router = APIRouter()

ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/jpg"}
MAX_BYTES     = 8 * 1024 * 1024  # 8MB


@router.get("/health")
def health() -> dict:
    return {"status": "ok", "engine": os.environ.get("OCR_ENGINE", "tesseract")}


@router.post("/ocr")
async def ocr_receipt(
    request: Request,
    file: UploadFile = File(...),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """レシート画像を受け取り、OCR → 項目抽出した結果を返す（保存はしない）。"""
    uid = security.verify_firebase_token(authorization, FIREBASE_PROJECT_ID)
    if not uid and FIREBASE_PROJECT_ID:
        raise HTTPException(401, "認証が必要です。")
    rate_limiter.check(security.client_ip(request))
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"対応していない画像形式です: {file.content_type}")
    image_bytes = await file.read()
    if len(image_bytes) > MAX_BYTES:
        raise HTTPException(400, "画像サイズが大きすぎます（最大8MB）。")
    if not image_bytes:
        raise HTTPException(400, "空のファイルです。")
    if not security.looks_like_image(image_bytes):
        raise HTTPException(400, "画像ファイルとして認識できませんでした。")

    # アプリ改善用の一時保存（DEBUG_RETAIN_RECEIPTS=true のときのみ・既定は無効）。
    # OCR結果を待たずに非同期で実行し、保存の成否はレスポンスに影響しない。
    if debug_storage.RETAIN_ENABLED:
        asyncio.create_task(asyncio.to_thread(debug_storage.save_for_debug, image_bytes, file.content_type, uid))

    engine = os.environ.get("OCR_ENGINE", "tesseract").lower()
    if engine in engines.AI_ENGINES:
        try:
            result = await asyncio.to_thread(engines.extract_with_ai, engine, image_bytes, file.content_type)
            return JSONResponse(result)
        except engines.ExtractionError as exc:
            raise HTTPException(500, "レシートの読み取りに失敗しました。時間をおいて再試行してください。") from exc

    try:
        return JSONResponse(engines.extract_with_tesseract(image_bytes))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Tesseract OCR failed")
        raise HTTPException(500, "レシートの読み取りに失敗しました。") from exc
