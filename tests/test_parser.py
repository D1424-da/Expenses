"""app/parser.py のパース関数のテスト（ネットワーク不要）。"""
from app import parser


def test_parse_total_prefers_total_keyword():
    text = "小計 900\n合計 1080\nお預り 2000\nお釣り 920"
    assert parser.parse_total(text) == 1080


def test_parse_total_excludes_cash_and_change():
    # 合計キーワードが無い場合のフォールバックでも、お預り/お釣りは拾わない
    text = "りんご 100\nお預り 5000\nお釣り 4900"
    assert parser.parse_total(text) == 100


def test_parse_total_label_and_amount_on_next_line():
    text = "合計\n¥1,280"
    assert parser.parse_total(text) == 1280


def test_parse_date_two_digit_year_expands():
    assert parser.parse_date("24/01/02 のレシート") == "2024-01-02"


def test_parse_date_rejects_rollover():
    # 2月30日は存在しない → 採用しない
    assert parser.parse_date("2024/02/30") is None


def test_parse_date_japanese_format():
    assert parser.parse_date("2026年6月21日") == "2026-06-21"


def test_guess_category_uses_keywords():
    assert parser.guess_category("", "イオン") == "食費"
    assert parser.guess_category("映画チケット", "") == "娯楽"
    assert parser.guess_category("", "謎の店") == "その他"


def test_parse_items_same_line_name_and_price():
    text = "合計 500\nりんご 248\nぶどう 252"
    items = parser.parse_items(text)
    names = [it["name"] for it in items]
    assert "りんご" in names or "ぶどう" in names
