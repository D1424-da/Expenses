"""Gemini による高精度レシート抽出（バックエンド側）。

API キーをフロント（公開される静的ファイル）に置くと GitHub 等で公開され、
Google に「漏洩キー」として自動無効化される。そこでキーはサーバーの環境変数
``GEMINI_API_KEY`` に保持し、フロントはこのバックエンドの ``/api/ocr`` を呼ぶ。

画像から構造化 JSON（日付・店名・支店名・合計・カテゴリ・明細）を直接得るため、
Tesseract + 正規表現より精度が高い。新しい依存は増やさず標準ライブラリで実装する。
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import os
import urllib.request

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

# フロント(static/app.js)と同一のプロンプト。支店名(branch)を含む。
PROMPT = """あなたは日本のレシートを読み取るアシスタントです。
画像のレシートを読み取り、次の形式のJSONだけを出力してください（説明文やマークダウンは不要）。

{
  "date": "YYYY-MM-DD",
  "store": "店舗・チェーン名",
  "branch": "支店名・店舗名（〇〇店）",
  "total": 整数,
  "category": "食費|日用品|外食|交通費|医療費|娯楽|衣服|光熱費|通信費|その他",
  "items": [ { "name": "商品名", "price": 整数 } ]
}

ルール:
- store は店名（チェーン名や屋号）。挨拶、住所、電話、登録番号は含めない。
- branch は支店名・店舗名（「〇〇店」など）。無ければ空文字。
- total は税込の支払い合計（「合計」の金額）。お預り・お釣り・小計・ポイントは含めない。
- items は購入した商品のみ。税・値引・小計・合計・ポイント等は含めない。
- price と total は数値のみ（カンマや¥や円は付けない）。
- 読み取れない項目は空文字または空配列にする。"""

CATEGORIES = [
    "食費", "日用品", "外食", "交通費", "医療費",
    "娯楽", "衣服", "光熱費", "通信費", "その他",
]


def _to_int(value: object) -> int:
    try:
        return int(round(float(value)))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


def _normalize(structured: dict, raw_text: str) -> dict:
    """フロントと同じ形（parser.parse_receipt 互換）に整える。"""
    items = []
    for it in structured.get("items") or []:
        if isinstance(it, dict) and it.get("name"):
            items.append({
                "name": str(it["name"])[:60],
                "price": _to_int(it.get("price")),
            })
    category = structured.get("category")
    return {
        "date": str(structured.get("date") or "")[:10] or dt.date.today().isoformat(),
        "store": str(structured.get("store") or "")[:50],
        "branch": str(structured.get("branch") or "")[:50],
        "amount": _to_int(structured.get("total")),
        "category": category if category in CATEGORIES else "その他",
        "items": items,
        "raw_text": raw_text,
    }


def extract_receipt(image_bytes: bytes) -> dict:
    """Gemini で画像から構造化レシートデータを抽出する。"""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY が設定されていません。")

    b64 = base64.standard_b64encode(image_bytes).decode("ascii")
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={api_key}"
    )
    body = {
        "contents": [{"parts": [
            {"inline_data": {"mime_type": "image/jpeg", "data": b64}},
            {"text": PROMPT},
        ]}],
        "generationConfig": {"response_mime_type": "application/json", "temperature": 0},
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 — 固定の信頼できるURL
        result = json.loads(resp.read().decode("utf-8"))

    try:
        text = result["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        text = ""
    clean = text.strip()
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[-1] if "\n" in clean else clean
        clean = clean.replace("```json", "").replace("```", "").strip()
    try:
        structured = json.loads(clean)
    except json.JSONDecodeError:
        structured = {}
    return _normalize(structured, text)
