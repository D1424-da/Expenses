"""管理者専用：デバッグ保存されたレシート画像の一覧・ダウンロード。

DEBUG_RETAIN_RECEIPTS=true で debug-receipts/ に保存された画像を、
アプリ運営者だけが確認できるようにする。

- 認証: Firebase ID トークン必須（FIREBASE_PROJECT_ID が未設定なら機能自体を無効化）
- 認可: ADMIN_UIDS（カンマ区切りのFirebase UID）に含まれるユーザーのみ許可
- 画像はGCS署名URLを使わず、バックエンド経由でストリーミング返却する
  （署名URLは秘密鍵/IAM SignBlob権限が必要で環境依存のため、シンプルさを優先）
"""
from __future__ import annotations

import os

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import Response

from app import security
from app.routes._shared import FIREBASE_PROJECT_ID

router = APIRouter()

ADMIN_UIDS = {u.strip() for u in os.environ.get("ADMIN_UIDS", "").split(",") if u.strip()}


def _require_admin(authorization: str | None) -> str:
    if not FIREBASE_PROJECT_ID:
        raise HTTPException(503, "管理者機能は FIREBASE_PROJECT_ID 未設定のため利用できません。")
    if not ADMIN_UIDS:
        raise HTTPException(503, "管理者機能は ADMIN_UIDS 未設定のため利用できません。")
    uid = security.verify_firebase_token(authorization, FIREBASE_PROJECT_ID)
    if uid not in ADMIN_UIDS:
        raise HTTPException(403, "管理者権限がありません。")
    return uid


@router.get("/admin/receipts")
def list_debug_receipts(authorization: str | None = Header(default=None)) -> dict:
    """debug-receipts/ 配下の一覧（uid・ファイル名・サイズ・作成日時）を返す。"""
    _require_admin(authorization)
    from firebase_admin import storage as admin_storage

    bucket = admin_storage.bucket()
    items = []
    for blob in bucket.list_blobs(prefix="debug-receipts/"):
        if blob.name.endswith("/"):
            continue
        items.append({
            "name": blob.name,
            "size": blob.size,
            "createdAt": blob.time_created.isoformat() if blob.time_created else None,
            "contentType": blob.content_type,
        })
    items.sort(key=lambda x: x["createdAt"] or "", reverse=True)
    return {"items": items}


@router.get("/admin/receipts/download")
def download_debug_receipt(
    name: str = Query(...),
    authorization: str | None = Header(default=None),
) -> Response:
    """指定ファイルをバックエンド経由でダウンロードする（署名URL不使用）。"""
    _require_admin(authorization)
    if not name.startswith("debug-receipts/") or ".." in name:
        raise HTTPException(400, "不正なファイル名です。")
    from firebase_admin import storage as admin_storage

    bucket = admin_storage.bucket()
    blob = bucket.blob(name)
    if not blob.exists():
        raise HTTPException(404, "ファイルが見つかりません（3日経過で自動削除された可能性があります）。")
    data = blob.download_as_bytes()
    return Response(content=data, media_type=blob.content_type or "application/octet-stream")
