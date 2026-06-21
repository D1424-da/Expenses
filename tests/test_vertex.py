"""app/vertex.py の URL/ホスト組み立てのテスト（認証・通信はモック）。"""
import json
from unittest import mock

from app import gemini, vertex


def _fake_token(monkeypatch):
    monkeypatch.setattr(vertex, "_get_access_token", lambda: "tok")


def _capture_url(monkeypatch, env):
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    _fake_token(monkeypatch)
    captured = {}

    class FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps(
                {"candidates": [{"content": {"parts": [{"text": "{}"}]}}]}
            ).encode()

    def fake_urlopen(req, timeout=0):
        captured["url"] = req.full_url
        return FakeResp()

    with mock.patch("urllib.request.urlopen", fake_urlopen):
        vertex.extract_receipt(b"\xff\xd8\xff")
    return captured["url"]


def test_regional_host(monkeypatch):
    url = _capture_url(
        monkeypatch,
        {"GOOGLE_CLOUD_PROJECT": "proj", "VERTEX_LOCATION": "us-central1"},
    )
    assert "us-central1-aiplatform.googleapis.com" in url
    assert "/projects/proj/locations/us-central1/" in url


def test_global_host_has_no_region_prefix(monkeypatch):
    url = _capture_url(
        monkeypatch,
        {"GOOGLE_CLOUD_PROJECT": "proj", "VERTEX_LOCATION": "global"},
    )
    assert "//aiplatform.googleapis.com" in url
    assert "us-central1-aiplatform" not in url


def test_vertex_model_takes_precedence(monkeypatch):
    url = _capture_url(
        monkeypatch,
        {
            "GOOGLE_CLOUD_PROJECT": "proj",
            "VERTEX_LOCATION": "global",
            "VERTEX_MODEL": "gemini-x",
            "GEMINI_MODEL": "should-not-be-used",
        },
    )
    assert "gemini-x" in url
