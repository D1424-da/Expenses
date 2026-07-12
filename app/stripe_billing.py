"""Stripe サブスクリプション管理。

チェックアウトセッション作成と Webhook 処理を担当する。
Firestore への書き込みは Firebase Admin SDK 経由（バックエンドのみ書き込み可能）。

必要な環境変数（Render.com の Environment Variables に設定）:
  STRIPE_SECRET_KEY      : Stripe シークレットキー (sk_live_... / sk_test_...)
  STRIPE_WEBHOOK_SECRET  : Stripe Webhook 署名シークレット (whsec_...)
  STRIPE_PRICE_ID        : 月額プランの Price ID (price_...)
  APP_URL                : フロントエンドの URL（リダイレクト先）
  FIREBASE_SERVICE_ACCOUNT_JSON: Firebase サービスアカウント JSON 文字列
"""
from __future__ import annotations

import json
import logging
import os
import time

from fastapi import HTTPException

logger = logging.getLogger("uvicorn.error")

STRIPE_SECRET_KEY     = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRICE_ID       = os.environ.get("STRIPE_PRICE_ID", "")
APP_URL               = os.environ.get("APP_URL", "https://get-tohon.online")
BETA_CODES            = {c.strip().upper() for c in os.environ.get("BETA_CODES", "").split(",") if c.strip()}

# ---- Firebase Admin SDK（遅延初期化） ---------------------------------------

_firestore_client = None


def _get_firestore():
    global _firestore_client
    if _firestore_client is not None:
        return _firestore_client
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore as admin_fs

        try:
            firebase_admin.get_app()
        except ValueError:
            sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
            if sa_json:
                cred = credentials.Certificate(json.loads(sa_json))
            else:
                cred = credentials.ApplicationDefault()
            firebase_admin.initialize_app(cred)

        _firestore_client = admin_fs.client()
        return _firestore_client
    except Exception as exc:  # noqa: BLE001
        logger.error("Firebase Admin SDK の初期化に失敗しました: %s", exc)
        raise HTTPException(503, "サブスクリプション機能が設定されていません。") from exc


# ---- Stripe 操作 ------------------------------------------------------------

def _stripe():
    """stripe ライブラリを返す（インポートをここに集中させる）。"""
    try:
        import stripe as _s
        if not STRIPE_SECRET_KEY:
            raise HTTPException(503, "Stripe が設定されていません（STRIPE_SECRET_KEY）。")
        _s.api_key = STRIPE_SECRET_KEY
        return _s
    except ImportError as exc:
        raise HTTPException(503, "Stripe ライブラリが未インストールです。") from exc


async def create_checkout_session(uid: str, email: str) -> str:
    """Stripe Checkout セッションを作成して URL を返す。"""
    if not STRIPE_PRICE_ID:
        raise HTTPException(503, "Stripe Price ID が未設定です（STRIPE_PRICE_ID）。")
    stripe = _stripe()
    session = stripe.checkout.Session.create(
        payment_method_types=["card"],
        mode="subscription",
        line_items=[{"price": STRIPE_PRICE_ID, "quantity": 1}],
        customer_email=email,
        metadata={"uid": uid},
        subscription_data={"metadata": {"uid": uid}},
        success_url=f"{APP_URL}/app?checkout=success",
        cancel_url=f"{APP_URL}/app?checkout=cancel",
        idempotency_key=f"checkout-{uid}-{int(time.time() // 300)}",
    )
    return session.url


async def sync_subscription(uid: str, email: str) -> dict:
    """チェックアウト後にサブスクリプション状態を Stripe から取得して Firestore に同期する。"""
    stripe = _stripe()
    customers = stripe.Customer.list(email=email, limit=5)
    for customer in customers.auto_paging_iter():
        subs = stripe.Subscription.list(customer=customer.id, status="all", limit=5)
        for sub in subs.auto_paging_iter():
            if sub.get("metadata", {}).get("uid") == uid or True:
                _persist_subscription(uid, sub, customer.id)
                return {"status": sub.get("status"), "synced": True}
    return {"status": "not_found", "synced": False}


async def create_portal_session(uid: str) -> str:
    """Stripe カスタマーポータルセッションを作成して URL を返す（解約・領収書確認用）。"""
    stripe = _stripe()
    db = _get_firestore()
    ref = db.collection("users").document(uid).collection("settings").document("subscription")
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(404, "サブスクリプション情報が見つかりません。")
    customer_id = snap.to_dict().get("stripeCustomerId")
    if not customer_id:
        raise HTTPException(404, "Stripe 顧客 ID が見つかりません。")
    session = stripe.billing_portal.Session.create(
        customer=customer_id,
        return_url=f"{APP_URL}/app",
    )
    return session.url


async def handle_webhook(payload: bytes, sig_header: str) -> dict:
    """Stripe Webhook を検証し、サブスクリプション状態を Firestore に反映する。"""
    if not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(503, "Webhook シークレットが未設定です（STRIPE_WEBHOOK_SECRET）。")
    stripe = _stripe()
    try:
        event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
    except stripe.error.SignatureVerificationError as exc:
        raise HTTPException(400, "Webhook 署名の検証に失敗しました。") from exc

    evt_type = event["type"]
    logger.info("Stripe webhook: %s", evt_type)

    if evt_type == "checkout.session.completed":
        session = event["data"]["object"]
        uid = session.get("metadata", {}).get("uid")
        if uid and session.get("subscription"):
            sub = stripe.Subscription.retrieve(session["subscription"])
            _persist_subscription(uid, sub, session.get("customer"))

    elif evt_type in ("customer.subscription.updated", "customer.subscription.deleted"):
        sub = event["data"]["object"]
        uid = sub.get("metadata", {}).get("uid")
        if uid:
            _persist_subscription(uid, sub, sub.get("customer"))

    elif evt_type == "invoice.payment_failed":
        sub_id = event["data"]["object"].get("subscription")
        if sub_id:
            sub = stripe.Subscription.retrieve(sub_id)
            uid = sub.get("metadata", {}).get("uid")
            if uid:
                _persist_subscription(uid, sub, sub.get("customer"))

    return {"received": True}


async def redeem_beta_code(uid: str, code: str) -> bool:
    """ベータ招待コードを検証し、有効なら無料プレミアムを付与する。"""
    if not BETA_CODES:
        raise HTTPException(503, "招待コード機能が設定されていません（BETA_CODES）。")
    if code.strip().upper() not in BETA_CODES:
        return False
    from firebase_admin import firestore as admin_fs
    db = _get_firestore()
    ref = (
        db.collection("users")
        .document(uid)
        .collection("settings")
        .document("subscription")
    )
    ref.set({
        "status": "active",
        "plan": "beta",
        "currentPeriodEnd": 9999999999,
        "updatedAt": admin_fs.SERVER_TIMESTAMP,
    })
    logger.info("Beta code redeemed: uid=%s", uid)
    return True


def _persist_subscription(uid: str, subscription: dict, customer_id: str | None) -> None:
    """サブスクリプション情報を Firestore の users/{uid}/settings/subscription に書き込む。"""
    from firebase_admin import firestore as admin_fs
    db = _get_firestore()
    status = subscription.get("status", "unknown")
    period_end = subscription.get("current_period_end")  # Unix timestamp
    cancel_at_period_end = bool(subscription.get("cancel_at_period_end", False))

    ref = (
        db.collection("users")
        .document(uid)
        .collection("settings")
        .document("subscription")
    )
    # merge=True: plan:'beta' など既存フィールドを上書きしない
    ref.set({
        "status": status,
        "stripeCustomerId": customer_id,
        "stripeSubscriptionId": subscription.get("id"),
        "currentPeriodEnd": period_end,
        "cancelAtPeriodEnd": cancel_at_period_end,
        "updatedAt": admin_fs.SERVER_TIMESTAMP,
    }, merge=True)
    logger.info("Firestore subscription updated: uid=%s status=%s", uid, status)
