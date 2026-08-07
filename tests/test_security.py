"""app/security.py の単体テスト（ネットワーク不要）。"""
import time
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app import security


# ── looks_like_image ─────────────────────────────────────────────────────────

def test_looks_like_image_webp():
    data = b"RIFF\x00\x00\x00\x00WEBP"
    assert security.looks_like_image(data)


def test_looks_like_image_heic():
    data = b"\x00\x00\x00\x18ftyp"
    assert security.looks_like_image(data)


def test_looks_like_image_pdf_is_false():
    assert not security.looks_like_image(b"%PDF-1.4")


def test_looks_like_image_empty_bytes():
    assert not security.looks_like_image(b"")


# ── client_ip ─────────────────────────────────────────────────────────────────

def _make_request(xff: str | None = None, host: str = "127.0.0.1"):
    req = MagicMock()
    req.headers = {"x-forwarded-for": xff} if xff else {}
    req.client = MagicMock()
    req.client.host = host
    return req


def test_client_ip_uses_last_xff_entry():
    req = _make_request(xff="1.1.1.1, 2.2.2.2, 3.3.3.3")
    assert security.client_ip(req) == "3.3.3.3"


def test_client_ip_single_xff():
    req = _make_request(xff="10.0.0.5")
    assert security.client_ip(req) == "10.0.0.5"


def test_client_ip_falls_back_to_client_host():
    req = _make_request(xff=None, host="192.168.1.100")
    assert security.client_ip(req) == "192.168.1.100"


def test_client_ip_no_client():
    req = MagicMock()
    req.headers = {}
    req.client = None
    assert security.client_ip(req) == "unknown"


# ── RateLimiter ───────────────────────────────────────────────────────────────

def test_rate_limiter_allows_within_per_ip_limit():
    rl = security.RateLimiter(window_sec=60, per_ip=3, global_limit=100)
    for _ in range(3):
        rl.check("1.2.3.4")  # should not raise


def test_rate_limiter_blocks_over_per_ip_limit():
    rl = security.RateLimiter(window_sec=60, per_ip=2, global_limit=100)
    rl.check("1.2.3.4")
    rl.check("1.2.3.4")
    with pytest.raises(HTTPException) as exc_info:
        rl.check("1.2.3.4")
    assert exc_info.value.status_code == 429


def test_rate_limiter_blocks_over_global_limit():
    rl = security.RateLimiter(window_sec=60, per_ip=100, global_limit=2)
    rl.check("1.1.1.1")
    rl.check("2.2.2.2")
    with pytest.raises(HTTPException) as exc_info:
        rl.check("3.3.3.3")
    assert exc_info.value.status_code == 429


def test_rate_limiter_different_ips_are_independent():
    rl = security.RateLimiter(window_sec=60, per_ip=1, global_limit=100)
    rl.check("1.1.1.1")
    rl.check("2.2.2.2")  # 別 IP なのでブロックされない


def test_rate_limiter_window_expires():
    rl = security.RateLimiter(window_sec=1, per_ip=1, global_limit=100)
    rl.check("1.2.3.4")
    time.sleep(1.1)
    rl.check("1.2.3.4")  # ウィンドウが切れたので通る


# ── verify_firebase_token ────────────────────────────────────────────────────

def test_verify_firebase_token_skips_when_no_project_id():
    result = security.verify_firebase_token("Bearer sometoken", project_id="")
    assert result is None


def test_verify_firebase_token_raises_401_when_no_token():
    with pytest.raises(HTTPException) as exc_info:
        security.verify_firebase_token(None, project_id="my-project")
    assert exc_info.value.status_code == 401


def test_verify_firebase_token_raises_401_for_empty_bearer():
    with pytest.raises(HTTPException) as exc_info:
        security.verify_firebase_token("Bearer ", project_id="my-project")
    assert exc_info.value.status_code == 401


def test_verify_firebase_token_raises_401_on_invalid_token(monkeypatch):
    # google.oauth2 モジュールのインポートを迂回し、verify_firebase_token 内部で
    # 例外が発生した場合に 401 を返すことを確認する。
    import types
    fake_id_token = types.SimpleNamespace(
        verify_firebase_token=lambda token, req, audience: (_ for _ in ()).throw(Exception("bad"))
    )
    fake_requests = types.SimpleNamespace(Request=lambda: None)
    fake_google = types.SimpleNamespace(
        oauth2=types.SimpleNamespace(id_token=fake_id_token),
        auth=types.SimpleNamespace(transport=types.SimpleNamespace(requests=fake_requests)),
    )
    monkeypatch.setitem(__import__("sys").modules, "google.oauth2.id_token", fake_id_token)
    monkeypatch.setitem(__import__("sys").modules, "google.auth.transport.requests", fake_requests)
    with pytest.raises(HTTPException) as exc_info:
        security.verify_firebase_token("Bearer badtoken", project_id="my-project")
    assert exc_info.value.status_code == 401


def test_verify_firebase_token_returns_uid_on_success(monkeypatch):
    import types
    fake_id_token = types.SimpleNamespace(
        verify_firebase_token=lambda token, req, audience: {"sub": "uid-abc"}
    )
    fake_requests = types.SimpleNamespace(Request=lambda: None)
    monkeypatch.setitem(__import__("sys").modules, "google.oauth2.id_token", fake_id_token)
    monkeypatch.setitem(__import__("sys").modules, "google.auth.transport.requests", fake_requests)
    uid = security.verify_firebase_token("Bearer goodtoken", project_id="my-project")
    assert uid == "uid-abc"
