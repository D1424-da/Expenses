"""Gemini を使ったレシピ提案。

食材リスト・人数・提案種別（1食分 or 週間献立）を受け取り、
家庭向けのレシピをマークダウンテキストで返す。
量が不明な食材はGeminiに家庭的な目安量で補完させる。
"""
from __future__ import annotations

import os

from app import net

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

_NOTES = {
    "common": "食材の量が不明な場合は、家庭での一般的な使用量を想定してください。",
    "time":   "調理時間の合計を{max_minutes}分以内に収めてください。",
    "use_up": "食材が余らないよう、できるだけすべて使い切ってください。",
}

_PROMPTS: dict[str, str] = {
    "meal": """\
以下の食材を使って、{servings}人前の料理を2〜3品提案してください。
{note}

食材: {items}

各料理について以下のマークダウン形式で簡潔に記載してください。
難易度は料理の手間・技術・工程数をもとに ★☆☆（かんたん）★★☆（ふつう）★★★（手間あり）の3段階で評価してください。

## 料理名
**難易度**: ★☆☆
**調理時間**: 約〇分
**使う食材**: （上記リストから使うもの＋目安量）
**作り方**:
1. ...
2. ...

家庭で作りやすいシンプルなレシピを優先してください。""",

    "weekly": """\
以下の食材を使って、{servings}人前の1週間分の献立（月〜日）を提案してください。
{note}

食材: {items}

以下のマークダウン形式で記載してください。

## 月曜日
- **朝食**: ...
- **昼食**: ...
- **夕食**: ...（メインの料理名と主な食材、難易度★）

## 火曜日
...（以下同様）""",
}


def suggest_recipes(
    items: list[str],
    servings: int,
    recipe_type: str = "meal",
    max_minutes: int | None = None,
    use_up: bool = False,
) -> str:
    """食材リストと人数からレシピ提案テキストを返す。"""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY が設定されていません。")

    notes = [_NOTES["common"]]
    if max_minutes:
        notes.append(_NOTES["time"].format(max_minutes=max_minutes))
    if use_up:
        notes.append(_NOTES["use_up"])

    template = _PROMPTS.get(recipe_type, _PROMPTS["meal"])
    prompt = template.format(
        servings=servings,
        items="、".join(items),
        note="\n".join(notes),
    )
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
        text = result["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        text = ""
    if not text or not text.strip():
        raise RuntimeError("Gemini がレシピを生成できませんでした。")
    return text
