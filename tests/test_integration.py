"""結合テスト — API レイヤ + 認証 + レートリミット + エンジン選択の連携を検証する。

単体テストと異なり、複数コンポーネントが連携して動作することを確認する:
  - 認証ミドルウェア ↔ エンドポイント
  - レートリミッター ↔ エンドポイント
  - エンジン選択 ↔ フォールバック
  - Stripe エンドポイント ↔ 認証
  - Webhook ↔ 署名検証
"""
from __future__ import annotations

import io
import sys
import time
import types
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

import main
from app.routes import _shared


# ---------------------------------------------------------------------------
# 共通フィクスチャ
# ---------------------------------------------------------------------------

@pytest.fixture()
def client():
    return TestClient(main.app)


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    """各テスト前にレートリミッターをリセットする。"""
    _shared.rate_limiter._by_ip.clear()
    _shared.rate_limiter._global.clear()
    yield
    _shared.rate_limiter._by_ip.clear()
    _shared.rate_limiter._global.clear()


@pytest.fixture()
def fake_auth(monkeypatch):
    """verify_firebase_token が常に uid='test-uid' を返すようにする。"""
    monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: "test-uid")
    # FIREBASE_PROJECT_ID はインポート時定数のため各モジュールを直接パッチ
    monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "test-project")
    monkeypatch.setattr("app.routes.stripe_routes.FIREBASE_PROJECT_ID", "test-project")


# ---------------------------------------------------------------------------
# ヘルスチェック
# ---------------------------------------------------------------------------

class TestHealth:
    def test_health_returns_ok(self, client):
        r = client.get("/api/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

    def test_health_includes_engine_key(self, client):
        r = client.get("/api/health")
        assert "engine" in r.json()


# ---------------------------------------------------------------------------
# OCR エンドポイント × 認証の結合
# ---------------------------------------------------------------------------

JPEG_MAGIC = b"\xff\xd8\xff\xe0" + b"\x00" * 100

class TestOcrAuth:
    def test_ocr_without_auth_blocked_when_project_set(self, client, monkeypatch):
        """FIREBASE_PROJECT_ID が設定されていると認証なし → 401。"""
        # FIREBASE_PROJECT_ID はインポート時定数なので直接パッチする
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "test-project")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)
        files = {"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")}
        r = client.post("/api/ocr", files=files)
        assert r.status_code == 401

    def test_ocr_without_auth_passes_when_project_unset(self, client, monkeypatch):
        """FIREBASE_PROJECT_ID が未設定なら認証スキップ（開発環境想定）。"""
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)
        monkeypatch.setenv("OCR_ENGINE", "gemini")
        with patch("app.engines.extract_with_ai", return_value={"amount": 0}):
            files = {"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")}
            r = client.post("/api/ocr", files=files)
        assert r.status_code == 200

    def test_ocr_with_valid_auth_passes_validation(self, client, fake_auth, monkeypatch):
        """有効な認証トークンがあれば画像バリデーション以降に進む。"""
        monkeypatch.setenv("OCR_ENGINE", "gemini")
        with patch("app.engines.extract_with_ai", return_value={"amount": 1000, "store": "テストスーパー"}):
            files = {"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")}
            r = client.post("/api/ocr", files=files, headers={"Authorization": "Bearer fake"})
        assert r.status_code == 200
        data = r.json()
        assert data["store"] == "テストスーパー"


# ---------------------------------------------------------------------------
# OCR エンドポイント × 入力バリデーション
# ---------------------------------------------------------------------------

class TestOcrValidation:
    def test_rejects_oversized_file(self, client, fake_auth):
        big = JPEG_MAGIC + b"\x00" * (9 * 1024 * 1024)
        files = {"file": ("big.jpg", io.BytesIO(big), "image/jpeg")}
        r = client.post("/api/ocr", files=files, headers={"Authorization": "Bearer x"})
        assert r.status_code == 400

    def test_rejects_unsupported_mime(self, client, fake_auth):
        files = {"file": ("doc.pdf", io.BytesIO(JPEG_MAGIC), "application/pdf")}
        r = client.post("/api/ocr", files=files, headers={"Authorization": "Bearer x"})
        assert r.status_code == 400

    def test_rejects_empty_file(self, client, fake_auth):
        files = {"file": ("empty.jpg", io.BytesIO(b""), "image/jpeg")}
        r = client.post("/api/ocr", files=files, headers={"Authorization": "Bearer x"})
        assert r.status_code == 400

    def test_rejects_non_image_bytes(self, client, fake_auth):
        files = {"file": ("fake.jpg", io.BytesIO(b"not an image"), "image/jpeg")}
        r = client.post("/api/ocr", files=files, headers={"Authorization": "Bearer x"})
        assert r.status_code == 400

    def test_accepts_png_magic_bytes(self, client, fake_auth, monkeypatch):
        monkeypatch.setenv("OCR_ENGINE", "gemini")
        png_magic = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
        with patch("app.engines.extract_with_ai", return_value={"amount": 500}):
            files = {"file": ("r.png", io.BytesIO(png_magic), "image/png")}
            r = client.post("/api/ocr", files=files, headers={"Authorization": "Bearer x"})
        assert r.status_code == 200

    def test_accepts_webp_magic_bytes(self, client, fake_auth, monkeypatch):
        monkeypatch.setenv("OCR_ENGINE", "gemini")
        webp_magic = b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 100
        with patch("app.engines.extract_with_ai", return_value={"amount": 300}):
            files = {"file": ("r.webp", io.BytesIO(webp_magic), "image/webp")}
            r = client.post("/api/ocr", files=files, headers={"Authorization": "Bearer x"})
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# OCR エンジンフォールバック × エンドポイント連携
# ---------------------------------------------------------------------------

class TestOcrEngineFallback:
    def test_extraction_error_returns_500(self, client, fake_auth, monkeypatch):
        """全エンジンが失敗すると ExtractionError → HTTP 500。"""
        from app.engines import ExtractionError
        with patch("app.engines.extract_with_ai", side_effect=ExtractionError("all failed")):
            monkeypatch.setenv("OCR_ENGINE", "gemini")
            files = {"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")}
            r = client.post("/api/ocr", files=files, headers={"Authorization": "Bearer x"})
        assert r.status_code == 500

    def test_successful_extraction_returns_structured_json(self, client, fake_auth, monkeypatch):
        monkeypatch.setenv("OCR_ENGINE", "gemini")
        payload = {
            "amount": 2500,
            "store": "スーパーA",
            "date": "2026-08-01",
            "items": [{"name": "牛乳", "price": 200}],
        }
        with patch("app.engines.extract_with_ai", return_value=payload):
            files = {"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")}
            r = client.post("/api/ocr", files=files, headers={"Authorization": "Bearer x"})
        assert r.status_code == 200
        data = r.json()
        assert data["amount"] == 2500
        assert data["store"] == "スーパーA"
        assert len(data["items"]) == 1


# ---------------------------------------------------------------------------
# レートリミッター × エンドポイントの結合
# ---------------------------------------------------------------------------

class TestRateLimitIntegration:
    def test_rate_limit_blocks_after_threshold(self, client, fake_auth, monkeypatch):
        """IP が per_ip 上限を超えると 429 が返る。"""
        monkeypatch.setattr(_shared.rate_limiter, "per_ip", 3)
        with patch("app.engines.extract_with_ai", return_value={"amount": 0}):
            for _ in range(3):
                files = {"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")}
                client.post("/api/ocr", files=files, headers={"Authorization": "Bearer x"})
            files = {"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")}
            r = client.post("/api/ocr", files=files, headers={"Authorization": "Bearer x"})
        assert r.status_code == 429

    def test_health_not_rate_limited(self, client, fake_auth, monkeypatch):
        """ヘルスチェックはレートリミット対象外。"""
        for _ in range(20):
            r = client.get("/api/health")
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# Stripe エンドポイント × 認証の結合
# ---------------------------------------------------------------------------

class TestStripeAuth:
    def _no_auth(self, monkeypatch):
        monkeypatch.setattr("app.routes.stripe_routes.FIREBASE_PROJECT_ID", "test-project")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)

    def test_checkout_requires_auth(self, client, monkeypatch):
        self._no_auth(monkeypatch)
        r = client.post("/api/stripe/checkout", json={"email": "a@example.com"})
        assert r.status_code == 401

    def test_trial_ensure_requires_auth(self, client, monkeypatch):
        self._no_auth(monkeypatch)
        r = client.post("/api/trial/ensure")
        assert r.status_code == 401

    def test_beta_redeem_requires_auth(self, client, monkeypatch):
        self._no_auth(monkeypatch)
        r = client.post("/api/beta/redeem", json={"code": "TEST"})
        assert r.status_code == 401

    def test_portal_requires_auth(self, client, monkeypatch):
        self._no_auth(monkeypatch)
        r = client.post("/api/stripe/portal")
        assert r.status_code == 401

    def test_sync_requires_auth(self, client, monkeypatch):
        self._no_auth(monkeypatch)
        r = client.post("/api/stripe/sync", json={"email": "a@example.com"})
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# Stripe エンドポイント × ビジネスロジックの結合
# ---------------------------------------------------------------------------

class TestStripeIntegration:
    def test_checkout_returns_url(self, client, fake_auth):
        with patch("app.stripe_billing.create_checkout_session", new_callable=AsyncMock,
                   return_value="https://checkout.stripe.com/pay/cs_test_xxx"):
            r = client.post("/api/stripe/checkout",
                            json={"email": "user@example.com"},
                            headers={"Authorization": "Bearer token"})
        assert r.status_code == 200
        assert r.json()["url"].startswith("https://checkout.stripe.com")

    def test_trial_ensure_returns_started_true(self, client, fake_auth):
        with patch("app.stripe_billing.ensure_trial", new_callable=AsyncMock,
                   return_value={"started": True}):
            r = client.post("/api/trial/ensure", headers={"Authorization": "Bearer token"})
        assert r.status_code == 200
        assert r.json()["started"] is True

    def test_trial_ensure_idempotent(self, client, fake_auth):
        """2回目は started=False（冪等性）。"""
        with patch("app.stripe_billing.ensure_trial", new_callable=AsyncMock,
                   return_value={"started": False}):
            r = client.post("/api/trial/ensure", headers={"Authorization": "Bearer token"})
        assert r.status_code == 200
        assert r.json()["started"] is False

    def test_beta_redeem_invalid_code_returns_400(self, client, fake_auth):
        with patch("app.stripe_billing.redeem_beta_code", new_callable=AsyncMock,
                   return_value=False):
            r = client.post("/api/beta/redeem",
                            json={"code": "INVALID"},
                            headers={"Authorization": "Bearer token"})
        assert r.status_code == 400

    def test_beta_redeem_valid_code_returns_ok(self, client, fake_auth):
        with patch("app.stripe_billing.redeem_beta_code", new_callable=AsyncMock,
                   return_value=True):
            r = client.post("/api/beta/redeem",
                            json={"code": "VALID123"},
                            headers={"Authorization": "Bearer token"})
        assert r.status_code == 200
        assert r.json()["ok"] is True

    def test_portal_returns_url(self, client, fake_auth):
        with patch("app.stripe_billing.create_portal_session", new_callable=AsyncMock,
                   return_value="https://billing.stripe.com/session/xxx"):
            r = client.post("/api/stripe/portal", headers={"Authorization": "Bearer token"})
        assert r.status_code == 200
        assert "billing.stripe.com" in r.json()["url"]


# ---------------------------------------------------------------------------
# Webhook × 署名検証の結合
# ---------------------------------------------------------------------------

class TestWebhookIntegration:
    def test_webhook_missing_signature_returns_400(self, client):
        r = client.post("/api/stripe/webhook",
                        content=b'{"type":"checkout.session.completed"}',
                        headers={"Content-Type": "application/json"})
        assert r.status_code == 400

    def test_webhook_invalid_signature_returns_400(self, client, monkeypatch):
        import stripe as stripe_lib  # noqa: import-inside-function
        monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
        with patch("app.stripe_billing._stripe") as mock_stripe:
            err_cls = type("SignatureVerificationError", (Exception,), {})
            mock_stripe.return_value.Webhook.construct_event.side_effect = err_cls("bad sig")
            mock_stripe.return_value.error.SignatureVerificationError = err_cls
            r = client.post("/api/stripe/webhook",
                            content=b'{}',
                            headers={"stripe-signature": "t=1,v1=bad"})
        assert r.status_code in (400, 503)

    def test_webhook_valid_payload_returns_received(self, client, monkeypatch):
        monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
        # ルーターは検証と反映を分けて呼ぶ（反映は BackgroundTasks 側）。
        with patch("app.stripe_billing.verify_webhook", new_callable=AsyncMock,
                   return_value={"type": "ping"}), \
             patch("app.stripe_billing.process_webhook_event", new_callable=AsyncMock,
                   return_value={"received": True}):
            r = client.post("/api/stripe/webhook",
                            content=b'{"type":"ping"}',
                            headers={"stripe-signature": "t=1,v1=fake"})
        assert r.status_code == 200
        assert r.json()["received"] is True


# ---------------------------------------------------------------------------
# レシピエンドポイント × 認証 + バリデーションの結合
# ---------------------------------------------------------------------------

class TestRecipeIntegration:
    def test_recipe_empty_items_rejected(self, client):
        r = client.post("/api/recipe", json={"items": []})
        assert r.status_code in (400, 422)

    def test_recipe_too_many_items_rejected(self, client):
        r = client.post("/api/recipe", json={"items": ["食材"] * 51, "servings": 2})
        assert r.status_code == 422

    def test_recipe_valid_request_reaches_engine(self, client, monkeypatch):
        """有効なリクエストはエンジンを呼び出し、503（キーなし）か 200 を返す。"""
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        r = client.post("/api/recipe", json={"items": ["卵", "牛乳"], "servings": 2})
        assert r.status_code in (200, 503)

    def test_recipe_weekly_type_accepted(self, client, monkeypatch):
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        r = client.post("/api/recipe",
                        json={"items": ["野菜", "肉"], "servings": 4,
                              "recipe_type": "weekly", "days": 5})
        assert r.status_code in (200, 503)

    def test_recipe_invalid_type_rejected(self, client):
        r = client.post("/api/recipe",
                        json={"items": ["卵"], "servings": 2, "recipe_type": "invalid"})
        assert r.status_code == 422


# ---------------------------------------------------------------------------
# CORS ヘッダーの結合確認
# ---------------------------------------------------------------------------

class TestCorsIntegration:
    def test_options_preflight_no_origin_by_default(self, client, monkeypatch):
        """CORS_ORIGINS 未設定時はプリフライトが Access-Control-Allow-Origin を返さない。"""
        monkeypatch.setenv("CORS_ORIGINS", "")
        r = client.options("/api/health",
                           headers={"Origin": "https://evil.example.com",
                                    "Access-Control-Request-Method": "GET"})
        assert "access-control-allow-origin" not in r.headers

    def test_allowed_origin_gets_cors_header(self, monkeypatch):
        """許可オリジンからのリクエストはヘッダーが返る。"""
        monkeypatch.setenv("CORS_ORIGINS", "https://get-tohon.online")
        # CORS_ORIGINS 変更後は新しい app インスタンスが必要
        import importlib
        import main as m
        importlib.reload(m)
        c = TestClient(m.app)
        r = c.options("/api/health",
                      headers={"Origin": "https://get-tohon.online",
                               "Access-Control-Request-Method": "GET"})
        assert r.headers.get("access-control-allow-origin") == "https://get-tohon.online"


class TestDebugRetention:
    """レシート画像の一時保存（DEBUG_RETAIN_RECEIPTS）の呼び出し保証。

    asyncio.create_task() は戻り値を保持しないとGCで消えることがあり、
    実際に保存が行われないまま「該当する画像はありません」となる不具合が
    起きた。BackgroundTasks 経由で確実に呼ばれることを固定する。
    """

    def _post_ocr(self, client):
        files = {"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")}
        return client.post("/api/ocr", files=files, headers={"Authorization": "Bearer fake"})

    def test_有効なら保存が呼ばれる(self, client, fake_auth, monkeypatch):
        monkeypatch.setenv("OCR_ENGINE", "gemini")
        monkeypatch.setattr("app.debug_storage.RETAIN_ENABLED", True)
        called = []
        monkeypatch.setattr(
            "app.debug_storage.save_for_debug",
            lambda img, ct, uid: called.append((len(img), ct, uid)),
        )
        with patch("app.engines.extract_with_ai", return_value={"amount": 100}):
            r = self._post_ocr(client)
        assert r.status_code == 200
        assert len(called) == 1, "BackgroundTasks 経由で save_for_debug が呼ばれること"
        assert called[0][1] == "image/jpeg"

    def test_無効なら保存は呼ばれない(self, client, fake_auth, monkeypatch):
        monkeypatch.setenv("OCR_ENGINE", "gemini")
        monkeypatch.setattr("app.debug_storage.RETAIN_ENABLED", False)
        called = []
        monkeypatch.setattr(
            "app.debug_storage.save_for_debug",
            lambda *a: called.append(a),
        )
        with patch("app.engines.extract_with_ai", return_value={"amount": 100}):
            r = self._post_ocr(client)
        assert r.status_code == 200
        assert called == []
