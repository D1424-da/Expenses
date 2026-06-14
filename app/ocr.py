"""レシート画像から文字を読み取る OCR 層。

既定エンジンは無料・オフラインで動く Tesseract（日本語）。
精度を上げるため OpenCV で前処理（グレースケール化・拡大・二値化）を行う。

環境変数 OCR_ENGINE で切り替え可能:
  - "tesseract"  : 既定。無料・オフライン。
  - "claude"     : ANTHROPIC_API_KEY が必要。最も高精度。
  - "google"     : Google Cloud Vision（GOOGLE_APPLICATION_CREDENTIALS が必要）。
将来別エンジンを足す場合も run_ocr(image_bytes) -> str の形を保てばよい。
"""
from __future__ import annotations

import os

import cv2
import numpy as np


def _preprocess(image_bytes: bytes) -> np.ndarray:
    """OCR 精度を上げるための前処理。

    レシートは細い感熱紙印字が多いので、拡大→グレースケール→ノイズ除去→
    適応的二値化、で読み取りやすくする。
    """
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("画像を読み込めませんでした。対応形式か確認してください。")

    # 小さすぎる画像は拡大すると文字が認識しやすくなる
    h, w = img.shape[:2]
    target_w = 1500
    if w < target_w:
        scale = target_w / w
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.fastNlMeansDenoising(gray, h=10)
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 15
    )
    return binary


def _ocr_tesseract(image_bytes: bytes) -> str:
    import pytesseract
    from PIL import Image

    processed = _preprocess(image_bytes)
    pil_img = Image.fromarray(processed)
    # PSM 6: 単一の均一なテキストブロックとして扱う（レシート向き）
    config = "--psm 6"
    return pytesseract.image_to_string(pil_img, lang="jpn+eng", config=config)


def _ocr_claude(image_bytes: bytes) -> str:
    import base64

    import anthropic  # type: ignore

    client = anthropic.Anthropic()
    b64 = base64.standard_b64encode(image_bytes).decode("ascii")
    message = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=2000,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": b64,
                        },
                    },
                    {
                        "type": "text",
                        "text": "このレシート画像に書かれている文字を、レイアウトの行順を保ったまま"
                        "すべてそのまま書き出してください。解説は不要です。",
                    },
                ],
            }
        ],
    )
    return "".join(block.text for block in message.content if block.type == "text")


def _ocr_google(image_bytes: bytes) -> str:
    from google.cloud import vision  # type: ignore

    client = vision.ImageAnnotatorClient()
    image = vision.Image(content=image_bytes)
    response = client.document_text_detection(image=image)
    if response.error.message:
        raise RuntimeError(response.error.message)
    return response.full_text_annotation.text


_ENGINES = {
    "tesseract": _ocr_tesseract,
    "claude": _ocr_claude,
    "google": _ocr_google,
}


def run_ocr(image_bytes: bytes) -> str:
    """設定されたエンジンで OCR を実行し、生テキストを返す。"""
    engine = os.environ.get("OCR_ENGINE", "tesseract").lower()
    fn = _ENGINES.get(engine, _ocr_tesseract)
    return fn(image_bytes)
