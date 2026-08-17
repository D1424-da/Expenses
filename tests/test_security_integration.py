"""セキュリティテスト — OWASP Top10 関連・認証・入力検証・レートリミット。

カバレッジ:
  A01 Broken Access Control   — 認証バイパス・他ユーザーデータ保護
  A02 Cryptographic Failures  — Webhook 署名検証
  A03 Injection               — パス・ヘッダーのインジェクション
  A04 Insecure Design         — ベータコード長・メールアドレス長
  A05 Security Misconfiguration — CORS 設定・エラーレスポンスの情報漏洩
  A07 Auth Failures           — レートリミット・トークン偽造
  A09 Logging                 — エラー時に内部情報をレスポンスに含めない
"""
from __future__ import annotations

import io
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import main
from app.routes import _shared

JPEG_MAGIC = b"\xff\xd8\xff\xe0" + b"\x00" * 100


@pytest.fixture()
def client():
    return TestClient(main.app)


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    _shared.rate_limiter._by_ip.clear()
    _shared.rate_limiter._global.clear()
    yield
    _shared.rate_limiter._by_ip.clear()
    _shared.rate_limiter._global.clear()


# ---------------------------------------------------------------------------
# A01: Broken Access Control
# ---------------------------------------------------------------------------

class TestAccessControl:
    def test_all_write_endpoints_require_auth(self, client, monkeypatch):
        """認証が必要な全エンドポイントで auth なしは 401/403。"""
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "proj")
        monkeypatch.setattr("app.routes.stripe_routes.FIREBASE_PROJECT_ID", "proj")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)

        endpoints = [
            ("POST", "/api/stripe/checkout", {"json": {"email": "a@b.com"}}),
            ("POST", "/api/trial/ensure",    {}),
            ("POST", "/api/beta/redeem",     {"json": {"code": "X"}}),
            ("POST", "/api/stripe/sync",     {"json": {"email": "a@b.com"}}),
            ("POST", "/api/stripe/portal",   {}),
        ]
        for method, path, kwargs in endpoints:
            r = client.request(method, path, **kwargs)
            assert r.status_code == 401, f"{path} は 401 を返すべきだが {r.status_code}"

    def test_ocr_requires_auth_when_project_set(self, client, monkeypatch):
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "proj")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)
        files = {"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")}
        r = client.post("/api/ocr", files=files)
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# A02: Cryptographic Failures — Webhook 署名検証
# ---------------------------------------------------------------------------

class TestWebhookSecurity:
    def test_webhook_without_signature_header_is_400(self, client):
        r = client.post("/api/stripe/webhook",
                        content=b'{"type":"ping"}',
                        headers={"Content-Type": "application/json"})
        assert r.status_code == 400

    def test_webhook_with_empty_signature_is_400(self, client):
        r = client.post("/api/stripe/webhook",
                        content=b'{"type":"ping"}',
                        headers={"stripe-signature": ""})
        assert r.status_code == 400

    def test_webhook_body_must_be_raw(self, client, monkeypatch):
        """Webhook は raw body を検証する（JSON パース不可でも処理する）。"""
        monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
        with patch("app.stripe_billing.verify_webhook", new_callable=AsyncMock,
                   return_value={"type": "ping"}), \
             patch("app.stripe_billing.process_webhook_event", new_callable=AsyncMock,
                   return_value={"received": True}):
            r = client.post("/api/stripe/webhook",
                            content=b"raw-binary-data",
                            headers={"stripe-signature": "t=1,v1=fake"})
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# A03: Injection — ヘッダー・パラメータのサニタイズ
# ---------------------------------------------------------------------------

class TestInjection:
    def test_authorization_header_injection_attempt(self, client, monkeypatch):
        """Authorization ヘッダーに改行等を含めても処理が壊れない。"""
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "proj")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)
        files = {"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")}
        r = client.post("/api/ocr", files=files,
                        headers={"Authorization": "Bearer \r\nX-Injected: evil"})
        assert r.status_code in (400, 401, 422)

    def test_recipe_items_xss_payload_is_returned_safely(self, client, monkeypatch):
        """XSS ペイロードを含む items が JSON エスケープされて返される。"""
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        xss = "<script>alert(1)</script>"
        r = client.post("/api/recipe", json={"items": [xss], "servings": 2})
        # 200 か 503 を返すがレスポンスボディに生の <script> タグが含まれない
        if r.status_code == 200:
            assert "<script>" not in r.text

    def test_email_with_special_chars_validated(self, client, monkeypatch):
        """SQL インジェクション風メールアドレスは length/format でブロックまたは通過しても安全。"""
        monkeypatch.setattr("app.routes.stripe_routes.FIREBASE_PROJECT_ID", "proj")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: "uid")
        with patch("app.stripe_billing.create_checkout_session", new_callable=AsyncMock,
                   return_value="https://checkout.stripe.com/pay/xxx"):
            r = client.post("/api/stripe/checkout",
                            json={"email": "'; DROP TABLE users; --@evil.com"},
                            headers={"Authorization": "Bearer token"})
        # 200 か 422 のどちらかで内部エラー 500 にならない
        assert r.status_code in (200, 422)


# ---------------------------------------------------------------------------
# A04: Insecure Design — 入力長制限
# ---------------------------------------------------------------------------

class TestInputLimits:
    def test_beta_code_max_length_enforced(self, client, monkeypatch):
        monkeypatch.setattr("app.routes.stripe_routes.FIREBASE_PROJECT_ID", "proj")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: "uid")
        long_code = "A" * 51  # max_length=50 を超える
        r = client.post("/api/beta/redeem",
                        json={"code": long_code},
                        headers={"Authorization": "Bearer token"})
        assert r.status_code == 422

    def test_email_max_length_enforced(self, client, monkeypatch):
        monkeypatch.setattr("app.routes.stripe_routes.FIREBASE_PROJECT_ID", "proj")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: "uid")
        long_email = "a" * 250 + "@b.com"  # max_length=254 を超える
        r = client.post("/api/stripe/checkout",
                        json={"email": long_email},
                        headers={"Authorization": "Bearer token"})
        assert r.status_code == 422

    def test_recipe_item_max_length_enforced(self, client):
        long_item = "食" * 201  # max_length=200 を超える
        r = client.post("/api/recipe",
                        json={"items": [long_item], "servings": 2})
        assert r.status_code == 422

    def test_image_size_limit_enforced(self, client, monkeypatch):
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)
        over_8mb = JPEG_MAGIC + b"\x00" * (8 * 1024 * 1024 + 1)
        files = {"file": ("big.jpg", io.BytesIO(over_8mb), "image/jpeg")}
        r = client.post("/api/ocr", files=files)
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# A05: Security Misconfiguration — CORS・情報漏洩
# ---------------------------------------------------------------------------

class TestSecurityMisconfiguration:
    def test_error_response_does_not_leak_stack_trace(self, client, monkeypatch):
        """500 エラーのレスポンスにスタックトレースや内部パスが含まれない。"""
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)
        monkeypatch.setenv("OCR_ENGINE", "gemini")
        from app.engines import ExtractionError
        with patch("app.engines.extract_with_ai", side_effect=ExtractionError("internal detail")):
            files = {"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")}
            r = client.post("/api/ocr", files=files)
        assert r.status_code == 500
        body = r.json().get("detail", "")
        # 内部エラーメッセージ ("internal detail") がそのまま露出しない
        assert "internal detail" not in body
        assert "Traceback" not in body

    def test_wildcard_cors_not_set_by_default(self, client, monkeypatch):
        """CORS_ORIGINS 未設定時に * が返らない。"""
        monkeypatch.setenv("CORS_ORIGINS", "")
        r = client.options("/api/health",
                           headers={"Origin": "https://attacker.com",
                                    "Access-Control-Request-Method": "GET"})
        assert r.headers.get("access-control-allow-origin") != "*"


# ---------------------------------------------------------------------------
# A07: Identification and Authentication Failures — レートリミット
# ---------------------------------------------------------------------------

class TestAuthenticationSecurity:
    def test_brute_force_ocr_blocked_by_rate_limit(self, client, monkeypatch):
        """同一 IP から連続リクエストは 429 でブロックされる。"""
        monkeypatch.setattr(_shared.rate_limiter, "per_ip", 5)
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)
        monkeypatch.setenv("OCR_ENGINE", "gemini")
        with patch("app.engines.extract_with_ai", return_value={"amount": 0}):
            for _ in range(5):
                client.post("/api/ocr",
                            files={"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")})
            r = client.post("/api/ocr",
                            files={"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")})
        assert r.status_code == 429

    def test_fake_firebase_token_rejected(self, client, monkeypatch):
        """偽の Firebase トークンは verify_firebase_token が None を返し 401 になる。"""
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "real-project")
        # security モジュールは本物のトークン検証をするが、テスト環境でキーがないので None
        import app.security as sec
        original = sec.verify_firebase_token
        monkeypatch.setattr(sec, "verify_firebase_token",
                            lambda token, proj: None if token == "Bearer fake-token" else original(token, proj))
        files = {"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")}
        r = client.post("/api/ocr", files=files,
                        headers={"Authorization": "Bearer fake-token"})
        assert r.status_code == 401

    def test_recipe_does_not_require_auth(self, client, monkeypatch):
        """レシピ提案はパブリックエンドポイント（認証不要）。"""
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        r = client.post("/api/recipe", json={"items": ["卵"], "servings": 1})
        assert r.status_code != 401


# ---------------------------------------------------------------------------
# A09: Security Logging Failures — ログ情報漏洩
# ---------------------------------------------------------------------------

class TestInformationDisclosure:
    def test_404_does_not_expose_internal_path(self, client):
        r = client.get("/api/nonexistent-endpoint")
        assert r.status_code == 404
        body = r.text
        assert "/home/" not in body
        assert "site-packages" not in body

    def test_422_validation_error_safe_format(self, client):
        """バリデーションエラーは安全な構造化レスポンスで返る。"""
        r = client.post("/api/recipe", json={"items": [], "servings": 0})
        assert r.status_code == 422
        data = r.json()
        assert "detail" in data
        # Pydantic の detail は list か str — スタックトレースでない
        assert isinstance(data["detail"], (list, str))
