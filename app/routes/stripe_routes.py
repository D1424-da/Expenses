"""Stripe サブスクリプション関連エンドポイント。"""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from app import security, stripe_billing
from app.models import CheckoutRequest, SyncRequest, BetaRedeemRequest
from app.routes._shared import rate_limiter, FIREBASE_PROJECT_ID

router = APIRouter()


def _require_auth(authorization: str | None) -> str:
    uid = security.verify_firebase_token(authorization, FIREBASE_PROJECT_ID)
    if not uid:
        raise HTTPException(401, "認証が必要です。")
    return uid


@router.post("/stripe/checkout")
async def stripe_checkout(
    request: Request,
    body: CheckoutRequest,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """Stripe Checkout セッションを作成し URL を返す。Firebase 認証必須。"""
    rate_limiter.check(security.client_ip(request))
    uid = _require_auth(authorization)
    url = await stripe_billing.create_checkout_session(uid, body.email)
    return JSONResponse({"url": url})


@router.post("/trial/ensure")
async def trial_ensure(
    request: Request,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """初回ログイン時に14日間の無料トライアルを開始する。Firebase 認証必須。"""
    rate_limiter.check(security.client_ip(request))
    uid = _require_auth(authorization)
    result = await stripe_billing.ensure_trial(uid)
    return JSONResponse(result)


@router.post("/beta/redeem")
async def beta_redeem(
    request: Request,
    body: BetaRedeemRequest,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """招待コードを検証し、有効なら無料プレミアムを付与する。Firebase 認証必須。"""
    rate_limiter.check(security.client_ip(request))
    uid = _require_auth(authorization)
    ok = await stripe_billing.redeem_beta_code(uid, body.code)
    if not ok:
        raise HTTPException(400, "無効なコードです。")
    return JSONResponse({"ok": True})


@router.post("/stripe/sync")
async def stripe_sync(
    request: Request,
    body: SyncRequest,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """チェックアウト直後にサブスクリプション状態を Stripe から取得して Firestore に同期する。"""
    rate_limiter.check(security.client_ip(request))
    uid = _require_auth(authorization)
    result = await stripe_billing.sync_subscription(uid, body.email)
    return JSONResponse(result)


@router.post("/stripe/portal")
async def stripe_portal(
    request: Request,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """Stripe カスタマーポータル URL を返す（解約・領収書確認用）。Firebase 認証必須。"""
    rate_limiter.check(security.client_ip(request))
    uid = _require_auth(authorization)
    url = await stripe_billing.create_portal_session(uid)
    return JSONResponse({"url": url})


@router.post("/stripe/webhook")
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
    result = await stripe_billing.handle_webhook(payload, stripe_signature)
    return JSONResponse(result)
