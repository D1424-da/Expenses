"""アプリ改善用：アップロードされたレシート画像を一時的にFirebase Storageへ保存する（任意機能）。

デフォルトでは無効。環境変数 DEBUG_RETAIN_RECEIPTS=true で有効化した場合のみ、
OCR に送られた画像を `debug-receipts/{uid}/` 配下に保存する。

- 保存先は Firebase Storage（Admin SDK 経由）。Storage セキュリティルールは
  クライアントからの read/write を全拒否しているため、保存された画像は
  Firebase コンソールまたは gsutil からのみ閲覧できる（エンドユーザーには非公開）。
- 自動削除は GCS バケットのライフサイクルルールで行う（DEBUG_RETAIN_DAYS で日数指定、
  既定3日）。適用方法は storage-lifecycle.json 参照。アプリコード側では削除処理を
  持たない（ライフサイクルルールが唯一の削除経路）。
- アップロード失敗時も OCR 本処理には影響させない（例外を握りつぶしログのみ）。
"""
from __future__ import annotations

import logging
import os
import time
import uuid

logger = logging.getLogger("uvicorn.error")

RETAIN_ENABLED = os.environ.get("DEBUG_RETAIN_RECEIPTS", "").strip().lower() == "true"
RETAIN_DAYS    = int(os.environ.get("DEBUG_RETAIN_DAYS", "3"))

_EXT_BY_CONTENT_TYPE = {
    "image/jpeg": "jpg",
    "image/jpg":  "jpg",
    "image/png":  "png",
    "image/webp": "webp",
    "image/heic": "heic",
}


def save_for_debug(image_bytes: bytes, content_type: str, uid: str | None) -> None:
    """DEBUG_RETAIN_RECEIPTS=true のときのみ、画像をStorageへ保存する（ベストエフォート）。"""
    if not RETAIN_ENABLED:
        return
    try:
        from firebase_admin import storage as admin_storage

        ext  = _EXT_BY_CONTENT_TYPE.get(content_type, "bin")
        who  = uid or "anonymous"
        name = f"debug-receipts/{who}/{int(time.time())}_{uuid.uuid4().hex}.{ext}"

        bucket = admin_storage.bucket()
        blob = bucket.blob(name)
        blob.upload_from_string(image_bytes, content_type=content_type)
        logger.info("デバッグ用にレシート画像を保存: %s（%d日後にライフサイクルルールで自動削除）", name, RETAIN_DAYS)
    except Exception:  # noqa: BLE001 — 保存失敗はOCR本処理に影響させない
        logger.exception("デバッグ用レシート画像の保存に失敗（OCR結果には影響なし）")
