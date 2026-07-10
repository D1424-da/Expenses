"""main.py の API レイヤのテスト（OCR本体には踏み込まず検証/制限を確認）。"""
import io

import main
from app import security
from fastapi.testclient import TestClient

client = TestClient(main.app)


def test_health_ok():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_ocr_rejects_bad_content_type():
    files = {"file": ("x.txt", io.BytesIO(b"hello"), "text/plain")}
    r = client.post("/api/ocr", files=files)
    assert r.status_code == 400


def test_ocr_rejects_non_image_bytes():
    # content_type は画像だが中身が画像でない → マジックバイト検証で 400
    files = {"file": ("x.jpg", io.BytesIO(b"not really an image"), "image/jpeg")}
    r = client.post("/api/ocr", files=files)
    assert r.status_code == 400


def test_looks_like_image_signatures():
    assert security.looks_like_image(b"\xff\xd8\xff\xe0rest")
    assert security.looks_like_image(b"\x89PNG\r\n\x1a\nrest")
    assert not security.looks_like_image(b"plain text bytes")


def test_recipe_rejects_empty_items():
    r = client.post("/api/recipe", json={"items": [], "servings": 2})
    assert r.status_code in (400, 422)


def test_recipe_rejects_invalid_servings():
    r = client.post("/api/recipe", json={"items": ["卵"], "servings": 0})
    assert r.status_code == 422
    r = client.post("/api/recipe", json={"items": ["卵"], "servings": 21})
    assert r.status_code == 422


def test_recipe_returns_503_without_api_key(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    r = client.post("/api/recipe", json={"items": ["卵", "牛乳"], "servings": 2})
    assert r.status_code == 503
