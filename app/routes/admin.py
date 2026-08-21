"""管理者専用：デバッグ保存されたレシート画像の一覧・ダウンロード。

DEBUG_RETAIN_RECEIPTS=true で debug-receipts/ に保存された画像を、
アプリ運営者だけが確認できるようにする。

- 認証: Firebase ID トークン必須（FIREBASE_PROJECT_ID が未設定なら機能自体を無効化）
- 認可: ADMIN_UIDS（カンマ区切りのFirebase UID）に含まれるユーザーのみ許可
- 画像はGCS署名URLを使わず、バックエンド経由でストリーミング返却する
  （署名URLは秘密鍵/IAM SignBlob権限が必要で環境依存のため、シンプルさを優先）
"""
from __future__ import annotations

import logging
import os
import time

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import Response

from app import debug_storage, security
from app.routes._shared import FIREBASE_PROJECT_ID
from app.stripe_billing import _get_firestore

logger = logging.getLogger("uvicorn.error")

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


def _get_bucket():
    """Storage バケットを取得する。

    未処理例外のまま 500 を返すと CORSMiddleware を通らずヘッダーが欠落し、
    ブラウザには本当の原因ではなく CORS エラーとして表示されてしまう。
    そのため HTTPException に変換して原因が読めるようにする。
    """
    try:
        from firebase_admin import storage as admin_storage
        return admin_storage.bucket(debug_storage.bucket_name())
    except HTTPException:
        raise
    # pyo3 の PanicException は BaseException 派生のため Exception では捕まらない。
    except BaseException as exc:  # noqa: BLE001 — 原因をクライアントに伝える
        logger.exception("Storage バケットの取得に失敗")
        raise HTTPException(503, f"ストレージに接続できません: {exc}") from exc


@router.get("/admin/receipts")
def list_debug_receipts(authorization: str | None = Header(default=None)) -> dict:
    """debug-receipts/ 配下の一覧（uid・ファイル名・サイズ・作成日時）を返す。"""
    _require_admin(authorization)
    bucket = _get_bucket()
    try:
        blobs = list(bucket.list_blobs(prefix="debug-receipts/"))
    except Exception as exc:  # noqa: BLE001
        logger.exception("一覧の取得に失敗")
        raise HTTPException(503, f"一覧を取得できません: {exc}") from exc

    items = []
    for blob in blobs:
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


def _make_thumbnail(data: bytes, max_px: int) -> tuple[bytes, str] | None:
    """縮小したJPEGを返す。Pillow が無い/失敗した場合は None（原寸で返す）。

    一覧に原寸（1枚あたり数百KB）を並べると数MB〜十数MBの転送になるため、
    プレビュー用は必ず縮小して返す。
    """
    try:
        import io

        from PIL import Image

        img = Image.open(io.BytesIO(data))
        img.thumbnail((max_px, max_px))
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=70, optimize=True)
        return buf.getvalue(), "image/jpeg"
    except Exception:  # noqa: BLE001 — 縮小できなくても原寸で表示できればよい
        logger.warning("サムネイル生成に失敗したため原寸を返します", exc_info=True)
        return None


@router.get("/admin/receipts/download")
def download_debug_receipt(
    name: str = Query(...),
    w: int = Query(0, ge=0, le=2000, description="指定するとその最大辺に縮小したJPEGを返す"),
    authorization: str | None = Header(default=None),
) -> Response:
    """指定ファイルをバックエンド経由で返す（署名URL不使用）。

    w を指定するとプレビュー用に縮小したJPEGを返す。
    """
    _require_admin(authorization)
    if not name.startswith("debug-receipts/") or ".." in name:
        raise HTTPException(400, "不正なファイル名です。")
    bucket = _get_bucket()
    blob = bucket.blob(name)
    if not blob.exists():
        raise HTTPException(404, "ファイルが見つかりません（3日経過で自動削除された可能性があります）。")
    data = blob.download_as_bytes()
    media_type = blob.content_type or "application/octet-stream"

    if w:
        thumb = _make_thumbnail(data, w)
        if thumb:
            data, media_type = thumb

    # 3日で消えるうえ管理者専用なので、ブラウザ側でも短時間キャッシュさせて
    # 一覧の再読み込みごとに全画像を取り直さないようにする。
    return Response(
        content=data,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=600"},
    )


def _is_premium(sub: dict | None) -> bool:
    """プレミアム判定。static/stripe-billing.js の isPremium() と必ず同じ結果になるよう
    そちらの判定式をそのまま移植している。ロジックがずれると、管理画面が「無料」と
    出しているユーザーがアプリ側では課金中（またはその逆）という食い違いが起きる。
    """
    if not sub:
        return False
    if sub.get("plan") == "beta" and sub.get("status") == "active":
        return True
    if sub.get("status") != "active":
        return False
    end = sub.get("currentPeriodEnd")
    if isinstance(end, (int, float)) and end > 0 and end < time.time():
        return False
    return True


@router.get("/admin/users")
def list_registered_users(
    page_token: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
) -> dict:
    """登録ユーザーの一覧を返す。

    登録日時・メールは Firebase Authentication 側にしかない（Firestore には
    ユーザー台帳が存在しない）ため、まず auth.list_users() で名簿を取り、
    そのuid群でプラン状態（users/{uid}/settings/subscription）をまとめて引く。
    1ページ最大1000件（Firebase Admin SDK の上限）。それを超える規模になったら
    nextPageToken でクライアント側がページングする。
    """
    _require_admin(authorization)
    from firebase_admin import auth as admin_auth

    try:
        page = admin_auth.list_users(page_token=page_token, max_results=1000)
    except Exception as exc:  # noqa: BLE001
        logger.exception("ユーザー一覧の取得に失敗")
        raise HTTPException(503, f"ユーザー一覧を取得できません: {exc}") from exc

    db = _get_firestore()
    refs = [
        db.collection("users").document(u.uid).collection("settings").document("subscription")
        for u in page.users
    ]
    subs: dict[str, dict] = {}
    if refs:
        try:
            for snap in db.get_all(refs):
                if snap.exists:
                    # ref.parent は settings コレクション、その parent がユーザーの文書。
                    uid = snap.reference.parent.parent.id
                    subs[uid] = snap.to_dict()
        except Exception:  # noqa: BLE001 — 課金状態が引けなくても名簿自体は返す
            logger.warning("サブスクリプション情報の一括取得に失敗", exc_info=True)

    items = []
    for u in page.users:
        sub = subs.get(u.uid)
        meta = u.user_metadata
        items.append({
            "uid": u.uid,
            "email": u.email,
            "displayName": u.display_name,
            "createdAt": meta.creation_timestamp if meta else None,
            "lastSignInAt": meta.last_sign_in_timestamp if meta else None,
            "plan": (sub or {}).get("plan", "free"),
            "status": (sub or {}).get("status"),
            "currentPeriodEnd": (sub or {}).get("currentPeriodEnd"),
            "isPremium": _is_premium(sub),
        })
    items.sort(key=lambda x: x["createdAt"] or 0, reverse=True)  # 新しい登録者を先に
    return {"items": items, "nextPageToken": page.next_page_token}
