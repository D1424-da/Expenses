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


class TestCandidateOrder:
    """試行順の決定。利用不可モデルへの404を毎回繰り返さないための仕組み。"""

    def test_VERTEX_MODEL指定時はそれだけを使う(self):
        from app.vertex import _candidate_order
        assert _candidate_order("gemini-2.5-flash", None) == ["gemini-2.5-flash"]

    def test_VERTEX_MODEL指定はキャッシュより優先される(self):
        from app.vertex import _candidate_order
        assert _candidate_order("gemini-2.5-flash", "gemini-1.5-pro-001") == ["gemini-2.5-flash"]

    def test_未指定かつキャッシュ無しなら既定の候補順(self):
        from app.vertex import _candidate_order, _VERTEX_MODEL_CANDIDATES
        assert _candidate_order(None, None) == _VERTEX_MODEL_CANDIDATES

    def test_前回成功したモデルが先頭に来る(self):
        from app.vertex import _candidate_order, _VERTEX_MODEL_CANDIDATES
        order = _candidate_order(None, "gemini-2.5-flash")
        assert order[0] == "gemini-2.5-flash"
        # 他の候補も残る（そのモデルが廃止されたときに探し直せるように）
        assert len(order) == len(_VERTEX_MODEL_CANDIDATES)
        assert order.count("gemini-2.5-flash") == 1

    def test_既定リストを破壊しない(self):
        from app.vertex import _candidate_order, _VERTEX_MODEL_CANDIDATES
        before = list(_VERTEX_MODEL_CANDIDATES)
        _candidate_order(None, "gemini-2.5-flash")
        _candidate_order(None, None).append("dummy")
        assert _VERTEX_MODEL_CANDIDATES == before


class TestWorkingModelCache:
    def test_記憶と取り出し(self):
        from app import vertex
        vertex._set_working_model(None)
        assert vertex._get_working_model() is None
        vertex._set_working_model("gemini-2.5-flash")
        assert vertex._get_working_model() == "gemini-2.5-flash"
        vertex._set_working_model(None)  # 後続テストへ影響させない
