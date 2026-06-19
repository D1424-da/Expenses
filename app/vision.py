"""Google Cloud Vision API による OCR（Gemini が使えないときの保険）。

Gemini が一時的なエラー（レート制限・障害・モデル未提供など）で失敗した場合の
フォールバックとして使う。Vision は「文字起こし（OCR）」専用で、Gemini のような
構造化抽出はしないため、認識した生テキストを既存の ``parser.parse_receipt`` に
渡して日付・店名・金額・明細を推定する。

キーはサーバーの環境変数 ``VISION_API_KEY`` に保持し、フロントには出さない。
サービスアカウントの JSON 鍵は不要で、API キー1個で ``images:annotate`` を呼べる。
新しい依存は増やさず標準ライブラリ（urllib）で実装する。
"""
from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request

from app import parser


def extract_text(image_bytes: bytes) -> str:
    """Vision API でレシート画像から生テキストを取り出す。"""
    api_key = os.environ.get("VISION_API_KEY")
    if not api_key:
        raise RuntimeError("VISION_API_KEY が設定されていません。")

    b64 = base64.standard_b64encode(image_bytes).decode("ascii")
    url = f"https://vision.googleapis.com/v1/images:annotate?key={api_key}"
    body = {
        "requests": [{
            "image": {"content": b64},
            # DOCUMENT_TEXT_DETECTION はレシートのような密な文書向けで精度が高い。
            "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
            "imageContext": {"languageHints": ["ja"]},
        }]
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 — 固定の信頼できるURL
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Vision からのエラー本文（キー不正・API未有効化など）を原因に含める。
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"Vision API エラー (HTTP {exc.code}): {detail}") from exc

    try:
        response = result["responses"][0]
    except (KeyError, IndexError, TypeError):
        return ""
    # API 自体は 200 でも、レスポンス内に error が入ることがある。
    if isinstance(response, dict) and response.get("error"):
        message = response["error"].get("message", "不明なエラー")
        raise RuntimeError(f"Vision API エラー: {message}")
    full = response.get("fullTextAnnotation") if isinstance(response, dict) else None
    if isinstance(full, dict):
        return str(full.get("text") or "")
    return ""


def extract_receipt(image_bytes: bytes) -> dict:
    """Vision で文字起こし → 既存パーサで構造化し、Gemini と同じ形で返す。"""
    text = extract_text(image_bytes)
    return parser.parse_receipt(text)
