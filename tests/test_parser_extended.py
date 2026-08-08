"""app/parser.py の追加単体テスト（パターンB/C・store/branch/receipt）。"""
import datetime as dt

import pytest

from app import parser


# ── parse_store ──────────────────────────────────────────────────────────────

def test_parse_store_returns_first_meaningful_line():
    text = "スーパーマーケットA\n〒123-4567\n東京都..."
    assert parser.parse_store(text) == "スーパーマーケットA"


def test_parse_store_skips_phone_and_number_only_lines():
    text = "123456\nTEL 03-1234-5678\nイオン"
    assert parser.parse_store(text) == "イオン"


def test_parse_store_skips_slogan_with_multiple_exclamations():
    text = "毎日! 新鮮! 激安!\nライフ"
    assert parser.parse_store(text) == "ライフ"


def test_parse_store_strips_branch_from_chain_line():
    # 「スーパータイヨー 甲突店」→ チェーン名のみ
    text = "スーパータイヨー 甲突店\n合計 1000"
    assert parser.parse_store(text) == "スーパータイヨー"


def test_parse_store_returns_empty_for_all_noise():
    text = "123\nTEL 0-0-0\n〒000"
    assert parser.parse_store(text) == ""


# ── parse_branch ─────────────────────────────────────────────────────────────

def test_parse_branch_finds_separate_branch_line():
    text = "スーパーA\n渋谷店\n合計 500"
    store = "スーパーA"
    assert parser.parse_branch(text, store) == "渋谷店"


def test_parse_branch_skips_store_line_itself():
    text = "イオン\nイオン南店\n合計 1000"
    assert parser.parse_branch(text, "イオン") == "イオン南店"


def test_parse_branch_returns_empty_when_no_branch():
    text = "スーパーA\n牛乳 200\n合計 200"
    assert parser.parse_branch(text, "スーパーA") == ""


def test_parse_branch_ignores_phone_lines():
    text = "スーパーA\nTEL 03-0000-0000\n新宿店"
    assert parser.parse_branch(text, "スーパーA") == "新宿店"


# ── _split_store_branch ───────────────────────────────────────────────────────

def test_split_store_branch_with_space():
    store, branch = parser._split_store_branch("スーパータイヨー 甲突店")
    assert store == "スーパータイヨー"
    assert branch == "甲突店"


def test_split_store_branch_no_split():
    store, branch = parser._split_store_branch("イオン")
    assert store == "イオン"
    assert branch == ""


# ── parse_total (追加) ────────────────────────────────────────────────────────

def test_parse_total_fullwidth_numbers():
    text = "合計　１，２８０円"
    assert parser.parse_total(text) == 1280


def test_parse_total_yen_prefix():
    text = "合計 ¥980"
    assert parser.parse_total(text) == 980


def test_parse_total_fallback_max_value():
    # 合計キーワードなし、最大値を返す
    text = "りんご 120\nバナナ 98\nぶどう 350"
    assert parser.parse_total(text) == 350


def test_parse_total_excludes_change_in_fallback():
    text = "お釣り 1000\nりんご 500"
    assert parser.parse_total(text) == 500


# ── parse_items (追加) ────────────────────────────────────────────────────────

def test_parse_items_pattern_b_price_on_next_line():
    # パターンB: 品名行 → 価格だけの行
    text = "合計 1000\nりんご\n300\nバナナ\n200"
    items = parser.parse_items(text)
    names = [it["name"] for it in items]
    # 少なくとも片方が取れていれば OK（パターンBの動作確認）
    assert any(n in names for n in ["りんご", "バナナ"])


def test_parse_items_excludes_meta_keywords():
    # 「担当」「レジ番号」などは品目として拾わない
    text = "担当 1234\nりんご 200\n合計 200"
    items = parser.parse_items(text)
    names = [it["name"] for it in items]
    assert "担当" not in names
    assert "りんご" in names


def test_parse_items_stops_at_subtotal():
    # 「小計」以降の明細は拾わない
    text = "りんご 200\n小計 200\nバナナ 150\n合計 350"
    items = parser.parse_items(text)
    names = [it["name"] for it in items]
    assert "りんご" in names
    assert "バナナ" not in names


def test_parse_items_limit_80():
    lines = "\n".join(f"商品{i:03d} {100+i}" for i in range(100))
    items = parser.parse_items(lines)
    assert len(items) <= 80


def test_parse_items_ignores_code_only_names():
    # 「T834」のようなコード文字列は品目として拾わない
    text = "T834 500\nりんご 200\n合計 700"
    items = parser.parse_items(text)
    names = [it["name"] for it in items]
    assert "T834" not in names
    assert "りんご" in names


# ── parse_date (追加) ─────────────────────────────────────────────────────────

def test_parse_date_slash_format():
    assert parser.parse_date("2025/12/31") == "2025-12-31"


def test_parse_date_dot_format():
    assert parser.parse_date("2025.03.15") == "2025-03-15"


def test_parse_date_rejects_future_far():
    assert parser.parse_date("2099/01/01") is None


def test_parse_date_rejects_too_old():
    assert parser.parse_date("1999/12/31") is None


def test_parse_date_no_date_in_text():
    assert parser.parse_date("りんご 200円") is None


# ── parse_receipt (統合) ──────────────────────────────────────────────────────

def test_parse_receipt_full_receipt():
    text = (
        "イオン\n南千住店\n2025/06/15\n"
        "牛乳 198\nパン 158\n"
        "小計 356\n消費税 35\n合計 391\n"
        "お預り 400\nお釣り 9"
    )
    result = parser.parse_receipt(text)
    assert result["store"] == "イオン"
    assert result["amount"] == 391
    assert result["date"] == "2025-06-15"
    assert result["category"] == "食費"
    assert isinstance(result["items"], list)
    assert result["raw_text"] == text


def test_parse_receipt_defaults_today_when_no_date():
    text = "スーパーA\nりんご 100\n合計 100"
    result = parser.parse_receipt(text)
    assert result["date"] == dt.date.today().isoformat()


def test_parse_receipt_item_category_inferred():
    text = "マツモトキヨシ\n風邪薬 500\n合計 500"
    result = parser.parse_receipt(text)
    # レシート全体が医療費判定
    assert result["category"] == "医療費"


# ── guess_category ────────────────────────────────────────────────────────────

def test_guess_category_transportation():
    assert parser.guess_category("", "ENEOS") == "交通費"


def test_guess_category_medical():
    assert parser.guess_category("", "マツモトキヨシ") == "医療費"


def test_guess_category_clothing():
    assert parser.guess_category("", "UNIQLO") == "衣服"


def test_guess_category_text_keyword():
    assert parser.guess_category("映画チケット 1800円", "") == "娯楽"


# ── _normalize_amount / _amount_in_line ──────────────────────────────────────

def test_amount_in_line_yen_prefix():
    assert parser._amount_in_line("¥ 1,280") == 1280


def test_amount_in_line_en_suffix():
    assert parser._amount_in_line("980円") == 980


def test_amount_in_line_no_amount():
    assert parser._amount_in_line("スーパーA") is None


def test_amount_in_line_rejects_zero():
    assert parser._amount_in_line("¥0") is None


def test_amount_in_line_within_max_range():
    # 正規表現は最大 7 桁を拾い、上限（< 10_000_000）チェックを通過する
    assert parser._amount_in_line("9999999") == 9999999
