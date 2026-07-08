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
