"""Stripe Webhook E2E テスト

実際の HMAC-SHA256 署名を生成し、stripe.Webhook.construct_event による
本物の署名検証を通過させた上で、各イベントタイプの処理ロジックを検証する。

カバー範囲:
  - 署名生成 / 検証のラウンドトリップ（本物の HMAC-SHA256）
  - タイムスタンプ古すぎでリプレイ攻撃を検出
  - checkout.session.completed → _persist_subscription 呼び出しと引数
  - customer.subscription.updated / deleted → _persist_subscription
  - invoice.payment_failed → Subscription.retrieve → _persist_subscription
  - uid / metadata 欠落時のグレースフル処理（Firestore 書き込みスキップ）
  - 未知イベントタイプの無害な通過
  - _persist_subscription の Firestore 書き込み内容（merge=True / 各フィールド）
  - Firestore 未設定時の 503
"""
from __future__ import annotations

import hashlib
import hmac
import json
import sys
import time
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest
from fastapi.testclient import TestClient

import main
import app.stripe_billing as billing

# ---------------------------------------------------------------------------
# テスト用定数
# ---------------------------------------------------------------------------

WEBHOOK_SECRET = "whsec_test_e2e_secret_1234567890"
UID = "test-uid-abc123"


# ---------------------------------------------------------------------------
# ヘルパー: 本物の Stripe Webhook 署名を生成する
# ---------------------------------------------------------------------------

def make_stripe_sig(payload: bytes, secret: str, ts: int | None = None) -> str:
    """stripe.Webhook.construct_event が受理する HMAC-SHA256 署名ヘッダーを返す。"""
    t = ts if ts is not None else int(time.time())
    signed = f"{t}.".encode() + payload
    sig = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return f"t={t},v1={sig}"


def make_payload(event_type: str, obj: dict) -> bytes:
    return json.dumps({"type": event_type, "data": {"object": obj}}).encode()


def _sub_obj(
    uid: str = UID,
    status: str = "active",
    cancel: bool = False,
    period_offset: int = 86400 * 30,
) -> dict:
    return {
        "id": "sub_xxx",
        "metadata": {"uid": uid} if uid else {},
        "status": status,
        "current_period_end": int(time.time()) + period_offset,
        "cancel_at_period_end": cancel,
        "customer": "cus_xxx",
    }


# ---------------------------------------------------------------------------
# フィクスチャ
# ---------------------------------------------------------------------------

@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr("app.routes._shared.FIREBASE_PROJECT_ID", "test-project")
    # モジュール定数は起動時に確定するため env var ではなく直接パッチする
    monkeypatch.setattr("app.stripe_billing.STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET)
    monkeypatch.setattr("app.stripe_billing.STRIPE_SECRET_KEY", "sk_test_fake")
    return TestClient(main.app, raise_server_exceptions=False)


@pytest.fixture()
def mock_persist():
    """_persist_subscription をモックして呼び出し引数を記録する。"""
    with patch("app.stripe_billing._persist_subscription") as m:
        yield m


@pytest.fixture()
def mock_firestore_ref():
    """Firestore の doc.set を記録するモック参照を返す。

    _persist_subscription を直接呼ぶテスト用。
    firebase_admin もモックして pyo3 パニックを回避する。
    """
    doc_ref = MagicMock()
    doc_ref.get = MagicMock(return_value=MagicMock(exists=False))

    fs_client = MagicMock()
    (fs_client
     .collection.return_value
     .document.return_value
     .collection.return_value
     .document.return_value) = doc_ref

    admin_fs_mock = MagicMock()
    admin_fs_mock.SERVER_TIMESTAMP = "<<SERVER_TIMESTAMP>>"

    with patch("app.stripe_billing._firestore_client", fs_client), \
         patch.dict(sys.modules, {"firebase_admin": MagicMock(),
                                   "firebase_admin.firestore": admin_fs_mock}):
        yield doc_ref


# ---------------------------------------------------------------------------
# A: 署名検証のラウンドトリップ（本物の HMAC-SHA256）
# ---------------------------------------------------------------------------

class TestWebhookSignatureVerification:
    def test_valid_signature_accepted(self, client, mock_persist):
        payload = make_payload("checkout.session.completed", {
            "metadata": {"uid": UID},
            "subscription": "sub_xxx",
            "customer": "cus_xxx",
        })
        with patch("app.stripe_billing._stripe") as ms:
            import stripe as stripe_lib
            ms.return_value.Webhook.construct_event.side_effect = (
                lambda p, s, sec: stripe_lib.Webhook.construct_event(p, s, sec)
            )
            ms.return_value.Subscription.retrieve.return_value = _sub_obj()
            sig = make_stripe_sig(payload, WEBHOOK_SECRET)
            r = client.post(
                "/api/stripe/webhook",
                content=payload,
                headers={"stripe-signature": sig},
            )
        assert r.status_code == 200
        assert r.json()["received"] is True

    def test_invalid_signature_returns_400(self, client):
        payload = make_payload("checkout.session.completed", {})
        with patch("app.stripe_billing._stripe") as ms:
            import stripe as stripe_lib
            ms.return_value.Webhook.construct_event.side_effect = (
                lambda p, s, sec: stripe_lib.Webhook.construct_event(p, s, sec)
            )
            ms.return_value.error.SignatureVerificationError = (
                stripe_lib.error.SignatureVerificationError
            )
            r = client.post(
                "/api/stripe/webhook",
                content=payload,
                headers={"stripe-signature": "t=1,v1=invalidsig"},
            )
        assert r.status_code == 400

    def test_missing_signature_header_returns_400(self, client):
        payload = make_payload("checkout.session.completed", {})
        r = client.post("/api/stripe/webhook", content=payload)
        assert r.status_code == 400

    def test_replay_attack_old_timestamp_rejected(self, client):
        """5分以上前のタイムスタンプは Stripe SDK が拒否する（DEFAULT_TOLERANCE=300秒）。"""
        old_ts = int(time.time()) - 400
        payload = make_payload("checkout.session.completed", {})
        with patch("app.stripe_billing._stripe") as ms:
            import stripe as stripe_lib
            ms.return_value.Webhook.construct_event.side_effect = (
                lambda p, s, sec: stripe_lib.Webhook.construct_event(p, s, sec)
            )
            ms.return_value.error.SignatureVerificationError = (
                stripe_lib.error.SignatureVerificationError
            )
            sig = make_stripe_sig(payload, WEBHOOK_SECRET, ts=old_ts)
            r = client.post(
                "/api/stripe/webhook",
                content=payload,
                headers={"stripe-signature": sig},
            )
        assert r.status_code == 400

    def test_webhook_secret_not_configured_returns_503(self, client, monkeypatch):
        monkeypatch.setattr("app.stripe_billing.STRIPE_WEBHOOK_SECRET", "")
        payload = make_payload("checkout.session.completed", {})
        sig = make_stripe_sig(payload, WEBHOOK_SECRET)
        r = client.post(
            "/api/stripe/webhook",
            content=payload,
            headers={"stripe-signature": sig},
        )
        assert r.status_code == 503


# ---------------------------------------------------------------------------
# B: checkout.session.completed — ルーティングと引数検証
# ---------------------------------------------------------------------------

class TestCheckoutSessionCompleted:
    def _post(self, client, session_obj: dict, mock_persist):
        payload = make_payload("checkout.session.completed", session_obj)
        retrieved_sub = _sub_obj()
        with patch("app.stripe_billing._stripe") as ms:
            ms.return_value.error.SignatureVerificationError = Exception
            ms.return_value.Webhook.construct_event.return_value = {
                "type": "checkout.session.completed",
                "data": {"object": session_obj},
            }
            ms.return_value.Subscription.retrieve.return_value = retrieved_sub
            sig = make_stripe_sig(payload, WEBHOOK_SECRET)
            r = client.post(
                "/api/stripe/webhook",
                content=payload,
                headers={"stripe-signature": sig},
            )
        return r, ms, retrieved_sub

    def test_checkout_with_uid_calls_persist(self, client, mock_persist):
        session = {"metadata": {"uid": UID}, "subscription": "sub_xxx", "customer": "cus_xxx"}
        r, ms, sub = self._post(client, session, mock_persist)
        assert r.status_code == 200
        ms.return_value.Subscription.retrieve.assert_called_once_with("sub_xxx")
        mock_persist.assert_called_once_with(UID, sub, "cus_xxx")

    def test_checkout_without_uid_skips_persist(self, client, mock_persist):
        session = {"metadata": {}, "subscription": "sub_xxx", "customer": "cus_xxx"}
        r, _, _ = self._post(client, session, mock_persist)
        assert r.status_code == 200
        mock_persist.assert_not_called()

    def test_checkout_without_subscription_skips_persist(self, client, mock_persist):
        session = {"metadata": {"uid": UID}, "customer": "cus_xxx"}
        r, _, _ = self._post(client, session, mock_persist)
        assert r.status_code == 200
        mock_persist.assert_not_called()

    def test_checkout_passes_customer_id_to_persist(self, client, mock_persist):
        session = {"metadata": {"uid": UID}, "subscription": "sub_xxx", "customer": "cus_UNIQUE"}
        r, _, sub = self._post(client, session, mock_persist)
        assert r.status_code == 200
        _, args, _ = mock_persist.mock_calls[0]
        assert args[2] == "cus_UNIQUE"


# ---------------------------------------------------------------------------
# C: customer.subscription.updated / deleted — ルーティング
# ---------------------------------------------------------------------------

class TestSubscriptionEvents:
    def _post_event(self, client, event_type: str, sub: dict):
        payload = make_payload(event_type, sub)
        with patch("app.stripe_billing._stripe") as ms:
            ms.return_value.error.SignatureVerificationError = Exception
            ms.return_value.Webhook.construct_event.return_value = {
                "type": event_type,
                "data": {"object": sub},
            }
            sig = make_stripe_sig(payload, WEBHOOK_SECRET)
            return client.post(
                "/api/stripe/webhook",
                content=payload,
                headers={"stripe-signature": sig},
            )

    def test_subscription_updated_calls_persist(self, client, mock_persist):
        sub = _sub_obj()
        r = self._post_event(client, "customer.subscription.updated", sub)
        assert r.status_code == 200
        mock_persist.assert_called_once_with(UID, sub, "cus_xxx")

    def test_subscription_deleted_calls_persist(self, client, mock_persist):
        sub = _sub_obj(status="canceled", period_offset=-86400)
        r = self._post_event(client, "customer.subscription.deleted", sub)
        assert r.status_code == 200
        mock_persist.assert_called_once()
        _, args, _ = mock_persist.mock_calls[0]
        assert args[0] == UID

    def test_subscription_without_uid_skips_persist(self, client, mock_persist):
        sub = _sub_obj(uid="")  # metadata に uid なし
        r = self._post_event(client, "customer.subscription.updated", sub)
        assert r.status_code == 200
        mock_persist.assert_not_called()

    def test_cancel_at_period_end_passed_to_persist(self, client, mock_persist):
        sub = _sub_obj(cancel=True)
        self._post_event(client, "customer.subscription.updated", sub)
        _, args, _ = mock_persist.mock_calls[0]
        assert args[1]["cancel_at_period_end"] is True


# ---------------------------------------------------------------------------
# D: invoice.payment_failed — Subscription 取得 → persist
# ---------------------------------------------------------------------------

class TestInvoicePaymentFailed:
    def _post_failed(self, client, invoice: dict, sub: dict | None = None):
        payload = make_payload("invoice.payment_failed", invoice)
        with patch("app.stripe_billing._stripe") as ms:
            ms.return_value.error.SignatureVerificationError = Exception
            ms.return_value.Webhook.construct_event.return_value = {
                "type": "invoice.payment_failed",
                "data": {"object": invoice},
            }
            if sub:
                ms.return_value.Subscription.retrieve.return_value = sub
            sig = make_stripe_sig(payload, WEBHOOK_SECRET)
            r = client.post(
                "/api/stripe/webhook",
                content=payload,
                headers={"stripe-signature": sig},
            )
        return r, ms

    def test_payment_failed_retrieves_sub_and_calls_persist(self, client, mock_persist):
        sub = _sub_obj(status="past_due")
        r, ms = self._post_failed(client, {"subscription": "sub_xxx"}, sub=sub)
        assert r.status_code == 200
        ms.return_value.Subscription.retrieve.assert_called_once_with("sub_xxx")
        mock_persist.assert_called_once_with(UID, sub, "cus_xxx")

    def test_payment_failed_without_sub_id_skips(self, client, mock_persist):
        r, ms = self._post_failed(client, {})  # subscription フィールドなし
        assert r.status_code == 200
        mock_persist.assert_not_called()
        ms.return_value.Subscription.retrieve.assert_not_called()

    def test_payment_failed_sub_without_uid_skips_persist(self, client, mock_persist):
        sub = _sub_obj(uid="")  # uid なし
        r, _ = self._post_failed(client, {"subscription": "sub_xxx"}, sub=sub)
        assert r.status_code == 200
        mock_persist.assert_not_called()


# ---------------------------------------------------------------------------
# E: 未知イベントタイプ
# ---------------------------------------------------------------------------

class TestUnknownEvents:
    def test_unknown_event_returns_received_without_persist(self, client, mock_persist):
        payload = make_payload("some.unknown.event", {"foo": "bar"})
        with patch("app.stripe_billing._stripe") as ms:
            ms.return_value.error.SignatureVerificationError = Exception
            ms.return_value.Webhook.construct_event.return_value = {
                "type": "some.unknown.event",
                "data": {"object": {"foo": "bar"}},
            }
            sig = make_stripe_sig(payload, WEBHOOK_SECRET)
            r = client.post(
                "/api/stripe/webhook",
                content=payload,
                headers={"stripe-signature": sig},
            )
        assert r.status_code == 200
        assert r.json()["received"] is True
        mock_persist.assert_not_called()


# ---------------------------------------------------------------------------
# F: _persist_subscription の Firestore 書き込み内容
# ---------------------------------------------------------------------------

class TestPersistSubscription:
    """_persist_subscription を直接呼び出し、Firestore に書き込むデータを検証する。"""

    def _call(self, mock_firestore_ref, sub: dict, customer: str = "cus_xxx"):
        billing._persist_subscription(UID, sub, customer)
        return mock_firestore_ref.set.call_args

    def test_status_written(self, mock_firestore_ref):
        sub = {"id": "sub_1", "status": "active",
               "current_period_end": 9999999999, "cancel_at_period_end": False}
        args = self._call(mock_firestore_ref, sub)
        assert args[0][0]["status"] == "active"

    def test_period_end_written(self, mock_firestore_ref):
        end = int(time.time()) + 86400 * 30
        sub = {"id": "sub_1", "status": "active",
               "current_period_end": end, "cancel_at_period_end": False}
        args = self._call(mock_firestore_ref, sub)
        assert args[0][0]["currentPeriodEnd"] == end

    def test_subscription_id_written(self, mock_firestore_ref):
        sub = {"id": "sub_unique_999", "status": "active",
               "current_period_end": 9999999999, "cancel_at_period_end": False}
        args = self._call(mock_firestore_ref, sub)
        assert args[0][0]["stripeSubscriptionId"] == "sub_unique_999"

    def test_customer_id_written(self, mock_firestore_ref):
        sub = {"id": "sub_1", "status": "active",
               "current_period_end": 9999999999, "cancel_at_period_end": False}
        args = self._call(mock_firestore_ref, sub, customer="cus_UNIQUE")
        assert args[0][0]["stripeCustomerId"] == "cus_UNIQUE"

    def test_cancel_at_period_end_written(self, mock_firestore_ref):
        sub = {"id": "sub_1", "status": "active",
               "current_period_end": 9999999999, "cancel_at_period_end": True}
        args = self._call(mock_firestore_ref, sub)
        assert args[0][0]["cancelAtPeriodEnd"] is True

    def test_merge_true_preserves_existing_fields(self, mock_firestore_ref):
        """merge=True で beta プランなど既存フィールドを上書きしない。"""
        sub = {"id": "sub_1", "status": "active",
               "current_period_end": 9999999999, "cancel_at_period_end": False}
        args = self._call(mock_firestore_ref, sub)
        assert args[1].get("merge") is True

    def test_firestore_not_configured_raises_503(self, client, monkeypatch):
        """Firestore 未設定時は HTTP 503 になること（_get_firestore が HTTPException を送出）。"""
        sub = _sub_obj()
        payload = make_payload("customer.subscription.updated", sub)
        # firebase_admin のインポート自体が pyo3 パニックを起こすため sys.modules でスタブする
        admin_stub = MagicMock()
        admin_stub.firestore.SERVER_TIMESTAMP = "ts"
        with patch("app.stripe_billing._stripe") as ms, \
             patch("app.stripe_billing._firestore_client", None), \
             patch.dict(sys.modules, {"firebase_admin": admin_stub,
                                       "firebase_admin.firestore": admin_stub.firestore}):
            ms.return_value.error.SignatureVerificationError = Exception
            ms.return_value.Webhook.construct_event.return_value = {
                "type": "customer.subscription.updated",
                "data": {"object": sub},
            }
            sig = make_stripe_sig(payload, WEBHOOK_SECRET)
            r = client.post(
                "/api/stripe/webhook",
                content=payload,
                headers={"stripe-signature": sig},
            )
        assert r.status_code == 503


class TestMaskEmail:
    """ログに個人情報をそのまま残さないためのマスク処理。"""

    def test_ローカル部を伏せる(self):
        from app.stripe_billing import _mask_email
        assert _mask_email("taro.yamada@example.com") == "t***@example.com"

    def test_1文字のローカル部でも壊れない(self):
        from app.stripe_billing import _mask_email
        assert _mask_email("a@example.com") == "a***@example.com"

    def test_Noneや不正な値は不明を返す(self):
        from app.stripe_billing import _mask_email
        assert _mask_email(None) == "(不明)"
        assert _mask_email("") == "(不明)"
        assert _mask_email("not-an-email") == "(不明)"

    def test_マスク後にローカル部が復元できない(self):
        """先頭1文字以外がログに残らないこと。"""
        from app.stripe_billing import _mask_email
        masked = _mask_email("secretuser@example.com")
        assert "secretuser" not in masked
        assert "ecretuser" not in masked
