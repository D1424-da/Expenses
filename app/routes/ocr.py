"""OCR・ヘルスチェック エンドポイント。"""
from __future__ import annotations

import asyncio
import logging
import os

from fastapi import (
    APIRouter, BackgroundTasks, File, Header, HTTPException, Request, UploadFile,
)
from fastapi.responses import JSONResponse

from app import debug_storage, engines, security
from app.routes._shared import rate_limiter, FIREBASE_PROJECT_ID

logger = logging.getLogger("uvicorn.error")

router = APIRouter()

ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/jpg"}
MAX_BYTES     = 8 * 1024 * 1024  # 8MB
# multipart のヘッダ・境界文字列の分。Content-Length は本体より少し大きい。
_MULTIPART_OVERHEAD = 8 * 1024

# OCR_ENGINE 未設定時の既定。
#
# 以前は "tesseract" だったが、本番の依存（requirements-gemini.txt）には
# OpenCV も Tesseract も入っていない。ダッシュボードで OCR_ENGINE が
# 消えると、フォールバックが働かず全リクエストが 500 になっていた。
# 実際に env が巻き戻る事故が起きているため、動く方を既定にする。
DEFAULT_ENGINE = "gemini"


def _engine() -> str:
    return os.environ.get("OCR_ENGINE", DEFAULT_ENGINE).strip().lower() or DEFAULT_ENGINE


@router.get("/health")
def health() -> dict:
    return {"status": "ok", "engine": _engine()}


@router.post("/ocr")
async def ocr_receipt(
    request: Request,
    background_tasks: BackgroundTasks,
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
    # Content-Length で先に弾く。
    # 読み切ってから len() を見ると、Starlette が 1MB 超のアップロードを
    # ディスクへスプールするため、巨大なリクエストでディスクを消費できる。
    # 申告値なので信用はしないが、素直なクライアントの無駄な転送は防げる。
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BYTES + _MULTIPART_OVERHEAD:
        raise HTTPException(400, "画像サイズが大きすぎます（最大8MB）。")
    image_bytes = await file.read()
    if len(image_bytes) > MAX_BYTES:
        raise HTTPException(400, "画像サイズが大きすぎます（最大8MB）。")
    if not image_bytes:
        raise HTTPException(400, "空のファイルです。")
    if not security.looks_like_image(image_bytes):
        raise HTTPException(400, "画像ファイルとして認識できませんでした。")

    # アプリ改善用の一時保存（DEBUG_RETAIN_RECEIPTS=true のときのみ・既定は無効）。
    # asyncio.create_task() は戻り値を保持しないとGCでタスクごと消えることがある
    # （イベントループは弱参照しか持たない）ため、レスポンス送信後に確実に実行される
    # FastAPI の BackgroundTasks を使う。保存の成否はレスポンスに影響しない。
    if debug_storage.RETAIN_ENABLED:
        background_tasks.add_task(
            debug_storage.save_for_debug, image_bytes, file.content_type, uid,
        )

    engine = _engine()
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
