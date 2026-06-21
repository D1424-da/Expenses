"""app/gemini.py の純粋関数（ネットワーク不要）のテスト。"""
from app import gemini


def test_to_int_handles_various_inputs():
    assert gemini._to_int(1280) == 1280
    assert gemini._to_int("1280") == 1280
    assert gemini._to_int(1280.4) == 1280
    assert gemini._to_int(None) == 0
    assert gemini._to_int("abc") == 0
    assert gemini._to_int("") == 0


def test_normalize_item_category_falls_back_to_overall():
    structured = {
        "date": "2026-06-21",
        "store": "スーパーA",
        "branch": "本店",
        "total": 1080,
        "category": "食費",
        "items": [
            {"name": "牛乳", "price": 200, "category": "食費"},
            {"name": "謎", "price": 100, "category": "存在しない区分"},
            {"name": "ノーカテゴリ", "price": 50},
        ],
    }
    out = gemini._normalize(structured, "raw")
    assert out["amount"] == 1080
    assert out["category"] == "食費"
    cats = [it["category"] for it in out["items"]]
    # 候補外/未指定は全体カテゴリ(食費)で補われる
    assert cats == ["食費", "食費", "食費"]


def test_normalize_invalid_overall_category_becomes_other():
    out = gemini._normalize({"category": "へんな区分", "total": 0}, "")
    assert out["category"] == "その他"


def test_normalize_empty_date_defaults_today():
    out = gemini._normalize({"total": 100}, "")
    assert out["date"]  # 空ではない（今日の日付が入る）


def test_normalize_drops_items_without_name():
    out = gemini._normalize(
        {"total": 100, "items": [{"price": 100}, {"name": "x", "price": 50}]}, ""
    )
    assert [it["name"] for it in out["items"]] == ["x"]


def test_parse_generate_content_strips_json_fence():
    result = {
        "candidates": [
            {"content": {"parts": [{"text": '```json\n{"total": 500}\n```'}]}}
        ]
    }
    structured, text = gemini.parse_generate_content(result)
    assert structured == {"total": 500}
    assert "500" in text


def test_parse_generate_content_malformed_json_returns_empty():
    result = {"candidates": [{"content": {"parts": [{"text": "not json"}]}}]}
    structured, text = gemini.parse_generate_content(result)
    assert structured == {}
    assert text == "not json"


def test_parse_generate_content_missing_candidates():
    structured, text = gemini.parse_generate_content({})
    assert structured == {}
    assert text == ""
