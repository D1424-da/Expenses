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

from app import net

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
  "items": [ { "name": "商品名", "price": 整数, "category": "食費|日用品|外食|交通費|医療費|娯楽|衣服|光熱費|通信費|その他" } ]
}

ルール:
- store は店名（チェーン名や屋号）。挨拶、住所、電話、登録番号は含めない。
- branch は支店名・店舗名（「〇〇店」など）。無ければ空文字。
- total は税込の支払い合計（「合計」の金額）。お預り・お釣り・小計・ポイントは含めない。
- items は購入した商品のみ。税・値引・小計・合計・ポイント等は含めない。
- items の category は各商品ごとに上記候補から1つ選ぶ（例: 牛乳→食費、洗剤→日用品）。判断できなければ全体の category と同じにする。
- category（全体）はレシート全体の主なカテゴリ。
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


def normalize_receipt(structured: dict, raw_text: str, engine: str = "gemini") -> dict:
    """フロントと同じ形（parser.parse_receipt 互換）に整える。"""
    category = structured.get("category")
    overall = category if category in CATEGORIES else "その他"
    items = []
    for it in structured.get("items") or []:
        if isinstance(it, dict) and it.get("name"):
            item_cat = it.get("category")
            items.append({
                "name": str(it["name"])[:60],
                "price": _to_int(it.get("price")),
                # 行ごとのカテゴリ。候補外/未指定はレシート全体のカテゴリで補う。
                "category": item_cat if item_cat in CATEGORIES else overall,
            })
    return {
        "date": str(structured.get("date") or "")[:10] or dt.date.today().isoformat(),
        "store": str(structured.get("store") or "")[:50],
        "branch": str(structured.get("branch") or "")[:50],
        "amount": _to_int(structured.get("total")),
        "category": overall,
        "items": items,
        "raw_text": raw_text,
        "engine": engine,
    }


def parse_generate_content(result: dict) -> tuple[dict, str]:
    """generateContent のレスポンスから (構造化dict, 生テキスト) を取り出す。

    Gemini Developer API と Vertex AI で応答形式が共通なので両方で使える。
    """
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
    return structured, text


def build_request_body(b64_image: str, content_type: str = "image/jpeg") -> dict:
    """generateContent のリクエストボディ（Gemini/Vertex 共通）。

    role は Vertex AI では必須（"user"/"model"）。Gemini Developer API でも
    有効なので両対応のため明示する。
    """
    return {
        "contents": [{
            "role": "user",
            "parts": [
                {"inline_data": {"mime_type": content_type, "data": b64_image}},
                {"text": PROMPT},
            ],
        }],
        "generationConfig": {"response_mime_type": "application/json", "temperature": 0},
    }


def extract_receipt(image_bytes: bytes, content_type: str = "image/jpeg") -> dict:
    """Gemini で画像から構造化レシートデータを抽出する。"""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY が設定されていません。")

    b64 = base64.standard_b64encode(image_bytes).decode("ascii")
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={api_key}"
    )
    result = net.post_json(url, build_request_body(b64, content_type), service="Gemini API")
    structured, text = parse_generate_content(result)
    return normalize_receipt(structured, text)
