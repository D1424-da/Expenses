"""Gemini を使ったレシピ提案。

食材リスト・人数・提案種別（1食分 or 週間献立）を受け取り、
家庭向けのレシピをマークダウンテキストで返す。
量が不明な食材はGeminiに家庭的な目安量で補完させる。

呼び出し順:
1. Gemini Developer API（GEMINI_API_KEY が設定済みの場合）
2. Vertex AI（GOOGLE_CLOUD_PROJECT + 認証が設定済みの場合）
"""
from __future__ import annotations

import logging
import os

from app import net

logger = logging.getLogger("uvicorn.error")

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")

_NOTES = {
    "common": (
        "食材の量が不明な場合は、家庭での一般的な使用量を想定してください。"
        "リストにマクドナルド・コンビニ弁当・ファストフードのメニュー名など、"
        "調理不要の完成品や外食メニューが含まれている場合はそれらを無視し、"
        "調理が必要な生鮮食品・加工食品のみを使って提案してください。"
    ),
    "time":   "各料理（1品・1食）ごとの調理時間を{max_minutes}分以内に収めてください。週全体や複数日の合計ではなく、1品あたりの目安時間です。",
    "use_up": "食材が余らないよう、できるだけすべて使い切ってください。",
    "quantity": (
        "食材リストに記載された数量（g・個・パックなど）を必ず考慮し、"
        "実際にその量で賄える日数分だけ献立を作成してください。"
        "食材が不足していて指定期間の全日程を賄えない場合は、"
        "無理に埋めずに賄える日数までで献立を止め、"
        "最後に「※現在の食材では約〇日分しか賄えません。残りは買い足しが必要です」と一言添えてください。"
       
    ),
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
以下の食材を使って、{servings}人前・最大{days}日分の献立を提案してください（{day_labels}）。
{note}

食材: {items}

【食事の基本方針】
- 朝食: 軽くてシンプルな和食・洋食（ご飯＋味噌汁、トースト＋卵、ヨーグルト＋フルーツなど）。パスタ・揚げ物・こってり料理は朝食に使わないこと。
- 昼食: 中程度の食事（丼・麺・サンドイッチなど手軽なもの）。
- 夕食: メインの料理（しっかりした一品）。

以下のマークダウン形式で記載してください。朝食・昼食は料理名のみ、夕食は料理名・使う食材・作り方を記載してください。
見出しは指定した曜日ラベル（{day_labels}）をそのまま使い、順番通りに記載してください。

## 月曜日
- **朝食**: ...
- **昼食**: ...
### 夕食: 料理名
**難易度**: ★☆☆
**調理時間**: 約〇分
**使う食材**: 食材A、食材B、食材C
**作り方**:
1. ...
2. ...

## 火曜日
...（食材が続く限り、指定した曜日ラベルの分だけ同様に記載）""",

    "select": """\
以下の食材を使って、{servings}人前の朝食・昼食・夕食をそれぞれ3パターン提案してください。
食材リストの数量（記載がある場合）を踏まえ、実際に用意できる範囲の料理にしてください。
{note}

食材: {items}

【食事の基本方針】
- 朝食: 軽くてシンプルな和食・洋食（ご飯＋味噌汁、トースト＋卵、ヨーグルト＋フルーツなど）。パスタ・揚げ物・こってり料理は朝食に使わないこと。
- 昼食: 中程度の食事（丼・麺・サンドイッチなど手軽なもの）。
- 夕食: メインの料理（しっかりした一品）。

各オプションは「料理名（調理時間の目安）」だけを記載してください。詳細レシピは不要です。

## 朝食
### ① 料理名（約〇分）
### ② 料理名（約〇分）
### ③ 料理名（約〇分）

## 昼食
### ① 料理名（約〇分）
### ② 料理名（約〇分）
### ③ 料理名（約〇分）

## 夕食
### ① 料理名（約〇分）
### ② 料理名（約〇分）
### ③ 料理名（約〇分）""",
}


def _family_note(family: dict | None) -> str:
    """家族構成を自然な日本語に変換する。"""
    if not family:
        return ""
    parts = []
    if family.get("adults_m"):  parts.append(f"大人（男）{family['adults_m']}人")
    if family.get("adults_f"):  parts.append(f"大人（女）{family['adults_f']}人")
    if family.get("toddlers"):  parts.append(f"幼児{family['toddlers']}人")
    if family.get("elementary"):parts.append(f"小学生{family['elementary']}人")
    if family.get("junior_high"):parts.append(f"中学生・高校生{family['junior_high']}人")
    if not parts:
        return ""
    return "家族構成: " + "、".join(parts) + "。この構成に合った料理（辛さ・量・食感など）を提案してください。"


_DAY_LABELS = ["月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日", "日曜日"]


def suggest_recipes(
    items: list[str],
    servings: int,
    recipe_type: str = "meal",
    max_minutes: int | None = None,
    use_up: bool = False,
    family: dict | None = None,
    days: int | None = None,
) -> str:
    """食材リストと人数からレシピ提案テキストを返す。"""
    # select タイプは朝・昼・夜×3のレシピを生成するため応答が長く、タイムアウトを延長する
    timeout = 120 if recipe_type == "select" else 60

    notes = [_NOTES["common"]]
    if max_minutes:
        notes.append(_NOTES["time"].format(max_minutes=max_minutes))
    if use_up:
        notes.append(_NOTES["use_up"])
    if recipe_type in ("weekly", "select"):
        notes.append(_NOTES["quantity"])
    family_note = _family_note(family)
    if family_note:
        notes.append(family_note)

    template = _PROMPTS.get(recipe_type, _PROMPTS["meal"])
    days_n = max(1, min(7, days or 7))
    day_labels = "、".join(_DAY_LABELS[:days_n])
    prompt = template.format(
        servings=servings,
        items="、".join(items),
        note="\n".join(notes),
        days=days_n,
        day_labels=day_labels,
    )
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.7},
    }

    result = _call_with_fallback(body, timeout)
    try:
        text = result["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        text = ""
    if not text or not text.strip():
        raise RuntimeError("Gemini がレシピを生成できませんでした。")
    return text


_VERTEX_MODEL_MAP = {
    "gemini-2.0-flash": "gemini-2.0-flash-001",
    "gemini-2.5-flash": "gemini-2.5-flash-001",
    "gemini-1.5-flash": "gemini-1.5-flash-001",
    "gemini-1.5-pro": "gemini-1.5-pro-001",
    "gemini-flash-latest": "gemini-2.0-flash-001",
}


def _to_vertex_model(model: str) -> str:
    """Gemini Developer API のモデル名を Vertex AI 用に変換する。"""
    return _VERTEX_MODEL_MAP.get(model, model)


def _call_with_fallback(body: dict, timeout: int) -> dict:
    """Gemini Developer API → Vertex AI の順で generateContent を呼ぶ。"""
    model = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
    api_key = os.environ.get("GEMINI_API_KEY")
    errors: list[str] = []

    if api_key:
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model}:generateContent"
        )
        try:
            return net.post_json(url, body, headers={"x-goog-api-key": api_key}, service="Gemini Recipe API", timeout=timeout)
        except Exception as exc:
            logger.warning("Gemini Developer API レシピ生成失敗、Vertex AI へフォールバック: %s", exc)
            errors.append(f"Gemini: {exc}")

    # Vertex AI フォールバック
    project = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("VERTEX_PROJECT")
    if project:
        try:
            from app import vertex as _vertex
            token = _vertex._get_access_token()
            location = os.environ.get("VERTEX_LOCATION", "us-central1")
            vertex_model = os.environ.get("VERTEX_MODEL") or _to_vertex_model(model)
            host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
            url = (
                f"https://{host}/v1/projects/{project}/locations/{location}"
                f"/publishers/google/models/{vertex_model}:generateContent"
            )
            return net.post_json(url, body, headers={"Authorization": f"Bearer {token}"}, service="Vertex AI Recipe API", timeout=timeout)
        except Exception as exc:
            logger.exception("Vertex AI レシピ生成失敗")
            errors.append(f"Vertex AI: {exc}")

    if not errors:
        raise RuntimeError("GEMINI_API_KEY も GOOGLE_CLOUD_PROJECT も設定されていません。")
    raise RuntimeError("レシピ生成に失敗しました: " + " / ".join(errors))
