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


# ── 停止性（無限ループ・計算量の防止） ──────────────────────────────
#
# parse_items のパターンB/C は「価格だけの連続ブロック」を集めるが、
# _amount_in_line() が None を返す行（3桁区切りの形なのに桁が大きすぎる等）
# では内側の while が即 break し、i が進まないまま i = j となって
# 無限ループしていた。1行あるだけでワーカーが永久に固まる。
#
# pytest-timeout は導入していないため、別スレッドで実行して時間を測る。

def _run_with_timeout(fn, seconds: float = 10.0):
    """fn を別スレッドで実行し、時間内に終わらなければ False を返す。"""
    import threading
    done = threading.Event()
    result = {}

    def _target():
        result["value"] = fn()
        done.set()

    t = threading.Thread(target=_target, daemon=True)
    t.start()
    return (done.wait(seconds), result.get("value"))


def test_parse_items_terminates_on_unparsable_price_line():
    """金額として解釈できない「価格だけの行」で停止する（無限ループの回帰）。"""
    finished, _ = _run_with_timeout(lambda: parser.parse_items("1,000,000,000"))
    assert finished, "parse_items が終了しない（無限ループの再発）"


def test_parse_receipt_terminates_on_unparsable_price_line():
    finished, result = _run_with_timeout(lambda: parser.parse_receipt("1,000,000,000"))
    assert finished, "parse_receipt が終了しない（無限ループの再発）"
    assert result["items"] == []


def test_parse_items_terminates_with_normal_lines_around():
    """前後に通常の明細がある場合も停止し、他の明細は拾える。"""
    text = "スーパーA\n牛乳\n198\n1,000,000,000\nパン\n148\n"
    finished, items = _run_with_timeout(lambda: parser.parse_items(text))
    assert finished, "parse_items が終了しない"
    assert any(it["name"] == "牛乳" for it in items)


def test_parse_items_skips_absurdly_long_line():
    """極端に長い1行は明細として扱わない。

    パターンA の正規表現は先頭が .*? のため、1行が長いほど後戻りが増え、
    所要時間が行長の2乗で伸びる（実測で16000字の1行に7.5秒）。
    レシートの1行は普通20〜40字なので足切りする。
    """
    long_line = "あ" * 500 + " 198"
    items = parser.parse_items(long_line)
    assert items == []
    # 通常の長さなら従来どおり拾える
    assert parser.parse_items("りんご 198")[0]["price"] == 198
