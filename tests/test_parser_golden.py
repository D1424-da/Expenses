"""実際の OCR 出力に近いノイジーなテキストを使ったゴールデンテスト。

各フィクスチャは実機の Tesseract / Google Vision が出力しがちな
崩れ方（列ずれ・全角/半角混在・時刻誤認・税率コード等）を再現している。
期待値は人手で確認した「これが取れれば十分」という最低ラインを表す。
"""
from __future__ import annotations

import pytest

from app import parser


# ──────────────────────────────────────────────────────────────────────────────
# フィクスチャ: 実際の OCR テキストに近いサンプル
# ──────────────────────────────────────────────────────────────────────────────

# Tesseract が感熱紙レシートを読んだ場合の典型出力。
# 列がずれて品名と価格が別行になること（パターンB）が多い。
TESSERACT_SUPERMARKET = """\
スーパータイヨー
甲突店
2025年7月15日(火) 10:32
TEL 099-000-1234
〒890-0001

牛乳
198
食パン
148
卵(10個)
218
豆腐
88

小計       652
消費税       65
合計       717
お預り    1000
お釣り     283
レジ No.3  担当 山田
"""

# Google Vision が縦長レシートで品名/価格を1行にまとめた場合（パターンA）。
# 「外8 XXXX」という軽減税率コードが品名行頭に付く。
VISION_CONVENIENCE = """\
ファミリーマート
渋谷センター街店
2026年1月20日 17:18
登録番号 T1234567890123

外8 0104 おにぎり鮭       130
外8 0205 サンドイッチ     298
お茶 500ml          120
外8 0841 チョコレート     158
会計券 #000002 R1068 17:18

小計      706
(内消費税8% 46)
合計      706
交通系IC  706
お釣り      0
レジ担当 田中
"""

# Vision が列を完全に分離して出力する場合（パターンC）。
# 品名が3行、次に価格3行が続く。
VISION_COLUMN_SPLIT = """\
業務スーパー
千葉店
2025/11/03

もやし
キャベツ
豚バラ肉500g

68
108
498

合計        674
お預り     1000
お釣り      326
"""

# ドラッグストア。店名行にスローガンが2つ以上の「!」付き。
# 価格に¥マーク付きで全角数字。
DRUGSTORE_RECEIPT = """\
毎日! 安心! 健康サポート!
マツモトキヨシ
新宿東口店

風邪薬NX      ¥780
ビタミンC     ¥398
マスク50枚    ¥498

合　計    ¥１，６７６
お預り    ¥2000
お釣り     ¥324
"""

# 全角数字・全角記号混在。合計ラベルが「お買上」形式。
FULLWIDTH_RECEIPT = """\
イオンスーパーセンター
南店
２０２５年０３月２１日

バナナ       １２０円
ヨーグルト   ２４８円
オレンジジュース  ３２０円

お買上合計    ６８８円
消費税        ６２円
お預り      １０００円
おつり        ３１２円
"""

# 時刻・電話番号・郵便番号など「ノイズ行」が多い場合。
NOISY_HEADER_RECEIPT = """\
123456
〒150-0041
東京都渋谷区
TEL 03-9876-5432
営業時間 9:00-22:00
西友 渋谷店
2025-09-10

大根        98
ほうれん草   128
しめじ       88

合計        314
お預り      500
お釣り      186
"""

# 合計キーワードなし・最大値フォールバックが発動するケース。
NO_TOTAL_KEYWORD = """\
謎の屋台
2025/04/01
たこ焼き 6個   500
焼きそば       700
"""


# ──────────────────────────────────────────────────────────────────────────────
# ゴールデンテスト
# ──────────────────────────────────────────────────────────────────────────────

class TestTesseractSupermarket:
    """感熱紙スーパー（Tesseract 典型出力・パターンB 品名→価格別行）。"""

    def test_store(self):
        r = parser.parse_receipt(TESSERACT_SUPERMARKET)
        assert r["store"] == "スーパータイヨー"

    def test_branch(self):
        r = parser.parse_receipt(TESSERACT_SUPERMARKET)
        assert r["branch"] == "甲突店"

    def test_total(self):
        r = parser.parse_receipt(TESSERACT_SUPERMARKET)
        assert r["amount"] == 717

    def test_date(self):
        r = parser.parse_receipt(TESSERACT_SUPERMARKET)
        assert r["date"] == "2025-07-15"

    def test_category(self):
        r = parser.parse_receipt(TESSERACT_SUPERMARKET)
        assert r["category"] == "食費"

    def test_items_at_least_two(self):
        r = parser.parse_receipt(TESSERACT_SUPERMARKET)
        names = [it["name"] for it in r["items"]]
        # パターンB で最低2品は取れること
        found = sum(1 for n in ["牛乳", "食パン", "卵", "豆腐"] if any(n in nm for nm in names))
        assert found >= 2

    def test_does_not_include_change(self):
        # お釣り 283 を品目として拾わない
        r = parser.parse_receipt(TESSERACT_SUPERMARKET)
        prices = [it["price"] for it in r["items"]]
        assert 283 not in prices

    def test_does_not_include_total_as_item(self):
        # 合計 717 を品目として拾わない
        r = parser.parse_receipt(TESSERACT_SUPERMARKET)
        prices = [it["price"] for it in r["items"]]
        assert 717 not in prices


class TestVisionConvenience:
    """コンビニ（Vision パターンA・軽減税率コード付き・時刻行を数値として誤読しない）。"""

    def test_store(self):
        r = parser.parse_receipt(VISION_CONVENIENCE)
        assert r["store"] == "ファミリーマート"

    def test_branch(self):
        r = parser.parse_receipt(VISION_CONVENIENCE)
        assert r["branch"] == "渋谷センター街店"

    def test_total(self):
        r = parser.parse_receipt(VISION_CONVENIENCE)
        assert r["amount"] == 706

    def test_date(self):
        r = parser.parse_receipt(VISION_CONVENIENCE)
        assert r["date"] == "2026-01-20"

    def test_category_food(self):
        r = parser.parse_receipt(VISION_CONVENIENCE)
        assert r["category"] == "食費"

    def test_time_18_not_mistaken_for_price(self):
        # 「17:18」が価格 18 や 17 として品目に混入しないこと
        r = parser.parse_receipt(VISION_CONVENIENCE)
        prices = [it["price"] for it in r["items"]]
        assert 18 not in prices
        assert 17 not in prices

    def test_tax_code_stripped_from_name(self):
        # 「外8 0104 おにぎり鮭」→ name が「おにぎり鮭」になること
        r = parser.parse_receipt(VISION_CONVENIENCE)
        names = [it["name"] for it in r["items"]]
        assert any("おにぎり" in n for n in names)
        assert not any(n.startswith("外8") for n in names)

    def test_items_include_sandwich(self):
        r = parser.parse_receipt(VISION_CONVENIENCE)
        names = [it["name"] for it in r["items"]]
        assert any("サンドイッチ" in n for n in names)


class TestVisionColumnSplit:
    """Vision 縦列分離パターンC（品名群→価格群）。"""

    def test_store(self):
        r = parser.parse_receipt(VISION_COLUMN_SPLIT)
        assert "業務スーパー" in r["store"]

    def test_total(self):
        r = parser.parse_receipt(VISION_COLUMN_SPLIT)
        assert r["amount"] == 674

    def test_date(self):
        r = parser.parse_receipt(VISION_COLUMN_SPLIT)
        assert r["date"] == "2025-11-03"

    def test_items_pattern_c(self):
        # 品名3つ・価格3つが正しくペアリングされること
        r = parser.parse_receipt(VISION_COLUMN_SPLIT)
        names = [it["name"] for it in r["items"]]
        prices = [it["price"] for it in r["items"]]
        assert any("もやし" in n for n in names)
        assert any("キャベツ" in n for n in names)
        assert 68 in prices
        assert 498 in prices


class TestDrugstore:
    """ドラッグストア（スローガンスキップ・¥付き全角数字・医療費カテゴリ）。"""

    def test_store_skips_slogan(self):
        # 「毎日! 安心! 健康サポート!」は店名にしない
        r = parser.parse_receipt(DRUGSTORE_RECEIPT)
        assert r["store"] == "マツモトキヨシ"

    def test_branch(self):
        r = parser.parse_receipt(DRUGSTORE_RECEIPT)
        assert r["branch"] == "新宿東口店"

    def test_total_fullwidth_yen(self):
        r = parser.parse_receipt(DRUGSTORE_RECEIPT)
        assert r["amount"] == 1676

    def test_category_medical(self):
        r = parser.parse_receipt(DRUGSTORE_RECEIPT)
        assert r["category"] == "医療費"

    def test_items_include_mask(self):
        r = parser.parse_receipt(DRUGSTORE_RECEIPT)
        names = [it["name"] for it in r["items"]]
        assert any("マスク" in n for n in names)


class TestFullwidthReceipt:
    """全角数字・「お買上」合計・「おつり」表記のレシート。"""

    def test_store(self):
        r = parser.parse_receipt(FULLWIDTH_RECEIPT)
        assert "イオン" in r["store"]

    def test_total_fullwidth(self):
        r = parser.parse_receipt(FULLWIDTH_RECEIPT)
        assert r["amount"] == 688

    def test_date_fullwidth(self):
        r = parser.parse_receipt(FULLWIDTH_RECEIPT)
        assert r["date"] == "2025-03-21"

    def test_change_not_in_items(self):
        r = parser.parse_receipt(FULLWIDTH_RECEIPT)
        prices = [it["price"] for it in r["items"]]
        assert 312 not in prices


class TestNoisyHeaderReceipt:
    """電話番号・郵便番号・時刻などノイズ行が多い場合。"""

    def test_store_skips_noise(self):
        r = parser.parse_receipt(NOISY_HEADER_RECEIPT)
        assert "西友" in r["store"]

    def test_total(self):
        r = parser.parse_receipt(NOISY_HEADER_RECEIPT)
        assert r["amount"] == 314

    def test_date(self):
        r = parser.parse_receipt(NOISY_HEADER_RECEIPT)
        assert r["date"] == "2025-09-10"

    def test_phone_not_in_items(self):
        r = parser.parse_receipt(NOISY_HEADER_RECEIPT)
        # 電話番号由来の数字が品目価格として混入しない
        prices = [it["price"] for it in r["items"]]
        assert 98765432 not in prices
        assert 150 not in prices  # 郵便番号の断片


class TestNoTotalKeyword:
    """合計キーワードなし → 最大値フォールバック。"""

    def test_fallback_returns_max(self):
        r = parser.parse_receipt(NO_TOTAL_KEYWORD)
        assert r["amount"] == 700

    def test_store(self):
        r = parser.parse_receipt(NO_TOTAL_KEYWORD)
        assert r["store"] == "謎の屋台"
