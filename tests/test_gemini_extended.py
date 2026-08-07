"""app/gemini.py の追加単体テスト（_validated_date・normalize_receipt 拡張）。"""
import datetime as dt
from unittest.mock import patch

from app import gemini


# ── _validated_date ──────────────────────────────────────────────────────────

def test_validated_date_valid_past_date():
    assert gemini._validated_date("2024-06-15") == "2024-06-15"


def test_validated_date_none_returns_today():
    today = dt.date.today().isoformat()
    assert gemini._validated_date(None) == today


def test_validated_date_empty_string_returns_today():
    today = dt.date.today().isoformat()
    assert gemini._validated_date("") == today


def test_validated_date_far_future_returns_today():
    today = dt.date.today().isoformat()
    assert gemini._validated_date("2099-01-01") == today


def test_validated_date_too_old_returns_today():
    today = dt.date.today().isoformat()
    assert gemini._validated_date("1999-12-31") == today


def test_validated_date_invalid_format_returns_today():
    today = dt.date.today().isoformat()
    assert gemini._validated_date("not-a-date") == today


def test_validated_date_tomorrow_is_accepted():
    tomorrow = (dt.date.today() + dt.timedelta(days=1)).isoformat()
    assert gemini._validated_date(tomorrow) == tomorrow


# ── normalize_receipt ─────────────────────────────────────────────────────────

def test_normalize_receipt_engine_field():
    out = gemini.normalize_receipt({}, "", engine="vertex")
    assert out["engine"] == "vertex"


def test_normalize_receipt_amount_clamped_to_zero():
    out = gemini.normalize_receipt({"total": -100}, "")
    assert out["amount"] == 0


def test_normalize_receipt_amount_clamped_to_max():
    out = gemini.normalize_receipt({"total": 999_999_999}, "")
    assert out["amount"] == gemini._MAX_AMOUNT


def test_normalize_receipt_store_truncated_to_50():
    long_store = "あ" * 100
    out = gemini.normalize_receipt({"store": long_store}, "")
    assert len(out["store"]) == 50


def test_normalize_receipt_branch_truncated_to_50():
    long_branch = "い" * 100
    out = gemini.normalize_receipt({"branch": long_branch}, "")
    assert len(out["branch"]) == 50


def test_normalize_receipt_item_name_truncated_to_60():
    long_name = "う" * 100
    out = gemini.normalize_receipt(
        {"total": 0, "items": [{"name": long_name, "price": 100, "category": "食費"}]}, ""
    )
    assert len(out["items"][0]["name"]) == 60


def test_normalize_receipt_item_price_clamped():
    out = gemini.normalize_receipt(
        {"total": 0, "items": [{"name": "x", "price": -10, "category": "食費"}]}, ""
    )
    assert out["items"][0]["price"] == 0


def test_normalize_receipt_items_non_dict_ignored():
    out = gemini.normalize_receipt(
        {"total": 100, "items": ["not a dict", None, {"name": "x", "price": 50}]}, ""
    )
    assert len(out["items"]) == 1
    assert out["items"][0]["name"] == "x"


def test_normalize_receipt_raw_text_preserved():
    out = gemini.normalize_receipt({}, "生テキスト")
    assert out["raw_text"] == "生テキスト"


def test_normalize_receipt_items_none_becomes_empty_list():
    out = gemini.normalize_receipt({"items": None}, "")
    assert out["items"] == []


# ── _to_int ───────────────────────────────────────────────────────────────────

def test_to_int_rounds_float():
    assert gemini._to_int(1.6) == 2


def test_to_int_negative():
    assert gemini._to_int(-5) == -5


def test_to_int_string_with_decimal():
    assert gemini._to_int("3.7") == 4
