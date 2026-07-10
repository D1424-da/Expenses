"""Gemini を使ったレシピ提案。

レシート明細から取り出した食材リストと人数を受け取り、
家庭向けのレシピを2〜3品テキストで返す。
"""
from __future__ import annotations

import os

from app import net

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

_PROMPT = """\
以下の食材を使って、{servings}人前の料理を2〜3品提案してください。

食材: {items}

各料理について以下を簡潔に記載してください（マークダウン形式）。
## 料理名
**使う食材**: （上記リストから使うもの）
**作り方**:
1. ...
2. ...

家庭で作りやすいシンプルなレシピを優先してください。"""


def suggest_recipes(items: list[str], servings: int) -> str:
    """食材リストと人数からレシピ提案テキストを返す。"""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY が設定されていません。")

    prompt = _PROMPT.format(servings=servings, items="、".join(items))
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.7},
    }
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={api_key}"
    )
    result = net.post_json(url, body, service="Gemini Recipe API")
    try:
        return result["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        return ""
