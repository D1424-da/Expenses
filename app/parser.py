"""OCR の生テキストから、家計簿に使う項目を推定して抽出する。

完璧な抽出は難しいため、推定値を返し、ユーザーが保存前に画面で修正できる
ことを前提にしている（OCR + 人の確認）。
"""
from __future__ import annotations

import datetime as dt
import re
from typing import Any

# 合計金額を示しやすいキーワード（優先度が高い順）
_TOTAL_KEYWORDS = ["合計", "合 計", "総合計", "お買上", "お買い上げ", "計", "total", "ﾄｰﾀﾙ"]
# 合計と紛らわしいので金額抽出から除外したい行
_EXCLUDE_KEYWORDS = ["小計", "お預り", "お預かり", "お釣", "釣り", "おつり", "預り", "現金", "クレジット", "ポイント", "残高", "課税", "消費税", "内税", "外税"]

# カテゴリ推定用キーワード
_CATEGORY_KEYWORDS: dict[str, list[str]] = {
    "外食": ["レストラン", "食堂", "カフェ", "珈琲", "coffee", "マクドナルド", "スターバックス", "牛丼", "ラーメン", "居酒屋", "bar", "ダイニング"],
    "交通費": ["jr", "鉄道", "バス", "タクシー", "駐車", "高速", "etc", "ガソリン", "eneos", "出光", "コスモ", "suica", "pasmo"],
    "医療費": ["薬局", "薬", "病院", "クリニック", "ドラッグ", "調剤", "マツモトキヨシ", "ウエルシア", "サンドラッグ"],
    "光熱費": ["電力", "電気", "ガス", "水道"],
    "通信費": ["docomo", "au", "softbank", "携帯", "通信", "wifi", "インターネット"],
    "衣服": ["ユニクロ", "uniqlo", "gu", "しまむら", "衣料", "アパレル", "zara"],
    "日用品": ["ドラッグ", "薬局", "ホームセンター", "カインズ", "ニトリ", "100円", "ダイソー", "セリア", "雑貨"],
    "食費": ["スーパー", "イオン", "西友", "ライフ", "マルエツ", "業務スーパー", "コンビニ", "セブン", "ローソン", "ファミリーマート", "ファミマ", "青果", "精肉", "鮮魚"],
}


def _normalize_amount(text: str) -> int | None:
    """'¥1,280' や '1280円' などから整数の金額を取り出す。"""
    # 全角→半角の数字変換
    text = text.translate(str.maketrans("０１２３４５６７８９，．", "0123456789,."))
    m = re.search(r"(\d[\d,]*)", text)
    if not m:
        return None
    try:
        return int(m.group(1).replace(",", ""))
    except ValueError:
        return None


def _is_noise_line(line: str) -> bool:
    """電話番号・FAX・郵便番号・日付など、金額や品目として扱うべきでない行。"""
    low = line.lower()
    if re.search(r"(tel|電話|fax|〒)", low):
        return True
    if re.search(r"\d{2,4}-\d{2,4}-\d{3,4}", line):  # 電話番号
        return True
    if re.search(r"\d{1,4}\s*[年/\-.]\s*\d{1,2}\s*[月/\-.]\s*\d{1,2}", line):  # 日付
        return True
    return False


def parse_date(text: str) -> str | None:
    """テキストから日付を探して YYYY-MM-DD で返す。見つからなければ None。"""
    t = text.translate(str.maketrans("０１２３４５６７８９", "0123456789"))

    patterns = [
        # 2024年1月2日 / 2024年01月02日
        (r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", "%Y-%m-%d"),
        # 2024/01/02, 2024-01-02, 2024.01.02
        (r"(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})", "%Y-%m-%d"),
        # 24/01/02 (2桁年)
        (r"(\d{2})[/\-.](\d{1,2})[/\-.](\d{1,2})", "%y-%m-%d"),
    ]
    for pattern, _fmt in patterns:
        for m in re.finditer(pattern, t):
            y, mo, d = m.groups()
            year = int(y)
            if len(y) == 2:
                year += 2000
            try:
                date = dt.date(year, int(mo), int(d))
            except ValueError:
                continue
            # 未来すぎ/古すぎる日付は誤読として除外
            today = dt.date.today()
            if dt.date(2000, 1, 1) <= date <= today + dt.timedelta(days=2):
                return date.isoformat()
    return None


def parse_total(text: str) -> int | None:
    """合計金額を推定する。

    まず「合計」系キーワードを含む行の金額を最優先で探す。
    見つからなければ、行内に現れる金額の最大値を合計とみなす。
    """
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]

    # 明細など、行末に現れる金額候補の最大値（妥当性チェック用）
    line_max = 0
    for line in lines:
        low = line.lower()
        if any(ex.lower() in low for ex in _EXCLUDE_KEYWORDS):
            continue
        if _is_noise_line(line):
            continue
        m = re.search(r"(\d{1,3}(?:,\d{3})+|\d{2,7})\s*円?\s*[*※]?$", line)
        if m:
            val = _normalize_amount(m.group(1))
            if val and 0 < val < 10_000_000:
                line_max = max(line_max, val)

    # 1) キーワード行を優先（除外語を含む行は無視）
    # ただし OCR 誤読で合計が明細より小さくなった場合は信用しない。
    for keyword in _TOTAL_KEYWORDS:
        for line in lines:
            low = line.lower()
            if keyword.lower() not in low:
                continue
            if any(ex.lower() in low for ex in _EXCLUDE_KEYWORDS):
                continue
            amount = _normalize_amount(line)
            if amount and amount > 0 and amount >= line_max:
                return amount

    # 2) フォールバック: 金額らしき数値の最大を採用（除外語の行は無視）
    candidates: list[int] = []
    for line in lines:
        low = line.lower()
        if any(ex.lower() in low for ex in _EXCLUDE_KEYWORDS):
            continue
        # 「円」や「¥」が付く、またはカンマ区切りの数値を金額候補とする
        if _is_noise_line(line):
            continue
        if re.search(r"[¥￥]|円|\d,\d{3}", line):
            amount = _normalize_amount(line)
            if amount and 0 < amount < 10_000_000:
                candidates.append(amount)
    if candidates:
        return max(candidates)
    return line_max or None


def parse_store(text: str) -> str:
    """店名を推定する。レシート上部の意味のある行を採用する。"""
    skip = re.compile(r"^\s*[\d\W_]+\s*$")  # 数字・記号のみの行は除外
    for line in text.splitlines():
        line = line.strip()
        if len(line) < 2:
            continue
        if skip.match(line):
            continue
        # 電話番号や住所っぽい行は除外
        if re.search(r"(tel|電話|〒|\d{2,4}-\d{2,4}-\d{3,4})", line, re.IGNORECASE):
            continue
        return line[:50]
    return ""


def parse_items(text: str) -> list[dict[str, Any]]:
    """品目と価格の組を推定する（行末に金額がある行を拾う）。"""
    items: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        low = line.lower()
        if any(kw.lower() in low for kw in _TOTAL_KEYWORDS + _EXCLUDE_KEYWORDS):
            continue
        # 電話番号・郵便番号・日付など、品目でない行は除外
        if _is_noise_line(line):
            continue
        # 行末の金額（¥1,280 / 1280 / 1,280円 など）
        m = re.search(r"[¥￥]?\s*(\d{1,3}(?:,\d{3})+|\d{2,6})\s*円?\s*[*※]?$", line)
        if not m:
            continue
        price = _normalize_amount(m.group(1))
        name = line[: m.start()].strip(" 　:：-_*")
        if name and price and 0 < price < 1_000_000 and len(name) >= 1:
            items.append({"name": name[:60], "price": price})
    return items[:50]


def guess_category(text: str, store: str) -> str:
    haystack = (store + "\n" + text).lower()
    for category, keywords in _CATEGORY_KEYWORDS.items():
        if any(kw.lower() in haystack for kw in keywords):
            return category
    return "その他"


def parse_receipt(text: str) -> dict[str, Any]:
    """OCR テキストを家計簿の各項目に変換する。"""
    store = parse_store(text)
    return {
        "date": parse_date(text) or dt.date.today().isoformat(),
        "store": store,
        "amount": parse_total(text) or 0,
        "category": guess_category(text, store),
        "items": parse_items(text),
        "raw_text": text,
    }
