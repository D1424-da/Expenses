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
# レシートのヘッダ/フッタの定型ラベル（明細ではない）。商品名として拾わない。
_RECEIPT_META_KEYWORDS = [
    "お会計券", "会計券", "登録番号", "精算機", "精算", "責任者", "担当", "レジ",
    "取引番号", "伝票", "バーコード", "軽減税率", "対象商品", "営業時間",
    "買上点数", "点数", "買上", "番号", "顧客", "累計", "有効期限", "領収",
]

# カテゴリ推定用キーワード
_CATEGORY_KEYWORDS: dict[str, list[str]] = {
    "外食": ["レストラン", "食堂", "カフェ", "珈琲", "coffee", "マクドナルド", "スターバックス", "牛丼", "ラーメン", "居酒屋", "bar", "ダイニング"],
    "交通費": ["jr", "鉄道", "バス", "タクシー", "駐車", "高速", "etc", "ガソリン", "eneos", "出光", "コスモ", "suica", "pasmo"],
    "医療費": ["薬局", "薬", "病院", "クリニック", "ドラッグ", "調剤", "マツモトキヨシ", "ウエルシア", "サンドラッグ"],
    "光熱費": ["電力", "電気", "ガス", "水道"],
    "通信費": ["docomo", "au", "softbank", "携帯", "通信", "wifi", "インターネット"],
    "衣服": ["ユニクロ", "uniqlo", "gu", "しまむら", "衣料", "アパレル", "zara"],
    "日用品": ["ドラッグ", "薬局", "ホームセンター", "カインズ", "ニトリ", "100円", "ダイソー", "セリア", "雑貨"],
    "食費": ["スーパー", "イオン", "西友", "ライフ", "マルエツ", "業務スーパー", "コンビニ", "セブン", "ローソン", "ファミリーマート", "ファミマ", "青果", "精肉", "鮮魚", "タイヨー", "問屋", "生鮮"],
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
    # 時刻（17:18 など）。「お会計券 #000002 R1068 17:18」を価格18と誤読しない。
    if re.search(r"\d{1,2}\s*[:：]\s*\d{2}", line):
        return True
    # 「甲突店26」「○○店 12」等の店舗・レジ番号行
    if re.search(r"店\s*\d{1,6}\s*$", line):
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


def _amount_in_line(line: str) -> int | None:
    """1行から金額を取り出す。Vision が「¥1, 771」のように空白を挟むことも許容。"""
    t = line.translate(str.maketrans("０１２３４５６７８９，．", "0123456789,."))
    raw = None
    m = re.search(r"[¥￥]\s*([0-9][0-9,\s]*[0-9]|[0-9])", t)  # ¥ の直後を最優先
    if m:
        raw = m.group(1)
    if raw is None:
        m = re.search(r"([0-9][0-9,\s]*[0-9]|[0-9])\s*円", t)  # 〜円
        if m:
            raw = m.group(1)
    if raw is None:
        m = re.search(r"(\d{1,3}(?:,\s?\d{3})+|\d{2,7})", t)  # カンマ区切り or 2桁以上
        if m:
            raw = m.group(1)
    if raw is None:
        return None
    try:
        v = int(re.sub(r"[,\s]", "", raw))
    except ValueError:
        return None
    return v if 0 < v < 10_000_000 else None


def parse_total(text: str) -> int | None:
    """合計金額を推定する。

    まず「合計」系キーワードを含む行の金額を最優先で探す。
    見つからなければ、支払い系を除いた金額の最大値を合計とみなす。

    Google Vision はラベルと金額を別の行に分けて出力することが多いため、
    キーワード行だけでなく直後の数行も見て金額を拾う。
    """
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]

    def has(line: str, words: list[str]) -> bool:
        low = line.lower()
        return any(w.lower() in low for w in words)

    # ラベルと金額が別の行に分かれることがある（Vision の特徴）。
    def amount_near(i: int) -> int | None:
        same = _amount_in_line(lines[i])
        if same is not None:
            return same
        for j in range(i + 1, min(i + 3, len(lines))):
            a = _amount_in_line(lines[j])
            if a is not None:
                return a
        return None

    # 支払い・お釣り・ポイント等の金額は「購入合計ではない」ので除外。
    # （小計や税は除外しない。税込だと小計＝合計で一致することがあるため）
    cash_exclude = ["お預", "お釣", "おつり", "釣り", "預り", "現金",
                    "クレジット", "ポイント", "残高", "チャージ", "お返し", "電子マネー"]
    excluded: set[int] = set()
    for i, line in enumerate(lines):
        if has(line, cash_exclude):
            a = amount_near(i)
            if a is not None:
                excluded.add(a)

    # 1) 「合計」系キーワードに紐づく金額を最優先（最初の合計を即採用）。
    #    支払い額が合計と一致して除外される問題を避けるため excluded は見ない。
    for keyword in _TOTAL_KEYWORDS:
        for i, line in enumerate(lines):
            if not has(line, [keyword]):
                continue
            if has(line, cash_exclude):
                continue
            a = amount_near(i)
            if a is not None:
                return a

    # 2) フォールバック: 支払い系を除いた中での最大金額
    best: int | None = None
    for line in lines:
        if has(line, cash_exclude):
            continue
        if _is_noise_line(line):
            continue
        a = _amount_in_line(line)
        if a is not None and a not in excluded:
            best = a if best is None else max(best, a)
    return best


def _split_store_branch(line: str) -> tuple[str, str]:
    """「スーパータイヨー 甲突店」のように店名と支店が同じ行にある場合に分割する。

    Google Vision はチェーン名と「〇〇店」を1行にまとめて出すことが多く、
    そのままだと店名に支店が混ざり、支店欄が空になる（最安値比較が店名＋支店
    ごとの集計なので、支店が取れないと別支店を区別できない）。
    """
    m = re.match(r"^(.*?\S)[\s　]+([^\s　]{1,20}店)\s*\d{0,6}$", line)
    if m and len(m.group(1)) >= 2:
        return m.group(1).strip(), m.group(2)
    return line, ""


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
        # 「毎日! 新鮮! 激安!」のような宣伝スローガン（!が複数）は店名にしない
        if len(re.findall(r"[!！]", line)) >= 2:
            continue
        # 店名行に支店（〇〇店）が同居していればチェーン名だけを採用する。
        store, _branch = _split_store_branch(line)
        return store[:50]
    return ""


def parse_branch(text: str, store: str) -> str:
    """支店名（「〇〇店」）を推定する。店名行とは別の「△△店」行を拾う。"""
    for line in text.splitlines():
        line = line.strip()
        if len(line) < 2 or len(line) > 30:
            continue
        if line == store:
            continue
        if re.search(r"(tel|電話|〒|登録番号|\d{2,4}-\d{2,4}-\d{3,4})", line, re.IGNORECASE):
            continue
        m = re.search(r"([^\s　]{1,20}店)\s*\d{0,6}\s*$", line)
        if m:
            return m.group(1)[:50]
    return ""


def _clean_item_name(s: str) -> str:
    # 「外8 0104」「内8 5401」「外85416」等の軽減税率印＋商品コードを除去。
    # これがあると別店舗の同一商品が比較でグルーピングできない。
    s = re.sub(r"^\s*[内外]税?\s*8?\s*\d{3,6}\s+", "", s)
    return s.strip(" 　:：-_*¥￥")[:60]


def _is_valid_item_name(name: str) -> bool:
    """コード・記号だけの「商品名らしくない」文字列を弾く。

    「R」「T834…」等のレジ/登録コードや店舗番号を商品として保存しないため。
    """
    if not name:
        return False
    if re.search(r"店\s*\d*$", name) and len(re.sub(r"[\s　\d]", "", name)) <= 4:
        return False
    has_ja = re.search(r"[一-龥぀-ゟ゠-ヿー々]", name) is not None  # 漢字・かな・カナ
    latin = len(re.findall(r"[A-Za-z]", name))
    return has_ja or latin >= 2


def _is_price_only_line(line: str) -> bool:
    """数字・記号のみ（価格だけ）の行かどうか。"""
    t = line.translate(str.maketrans("０１２３４５６７８９，．", "0123456789,.")).strip()
    return bool(
        re.match(r"^[¥￥]?\s*\d{1,3}(?:,\d{3})+\s*円?$", t)
        or re.match(r"^[¥￥]?\s*\d{2,7}\s*円?[*※]?$", t)
    )


def parse_items(text: str) -> list[dict[str, Any]]:
    """品目と価格の組を推定する。

    Google Vision はレシートの列が分かれると「品名」と「価格」を別の行に
    出力することが多い。そのため次の3パターンを扱う:
      A) 同一行に「品名 ... 価格」がある
      B) 「価格だけの行」の直前の行が品名（1対1）
      C) 「品名群 → 価格群」と縦に分かれる（価格だけの連続ブロックを、
         直前に同数並ぶ品名行と上から順に対応づける）
    """
    items: list[dict[str, Any]] = []
    stop_words = _TOTAL_KEYWORDS + _EXCLUDE_KEYWORDS + _RECEIPT_META_KEYWORDS
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]

    # 明細は「小計／合計」より上にある。そこで打ち切り、クレジット明細等の数字を拾わない。
    # 単独の「計」は使わない（「お会計券」等のレシート番号ヘッダに誤マッチし、
    # 明細を丸ごと切り捨ててしまうため）。合計系は具体的な語で明示する。
    subtotal_total = ["小計", "消費税", "内税", "外税", "課税", "対象",
                      "値引", "税込", "税抜", "合計", "総合計", "お買上", "お買い上げ"]
    cut_at = next(
        (i for i, ln in enumerate(lines)
         if any(kw in ln for kw in subtotal_total) and "会計券" not in ln),
        -1,
    )
    if cut_at > 0:
        lines = lines[:cut_at]

    def is_stop(line: str) -> bool:
        low = line.lower()
        return any(kw.lower() in low for kw in stop_words) or _is_noise_line(line)

    n = len(lines)
    consumed = [False] * n

    # パターンA: 「品名 ... 価格」が同じ行
    for i, line in enumerate(lines):
        if is_stop(line):
            consumed[i] = True
            continue
        # 非貪欲（.*?）にして、「¥ 1, 248」のように空白を挟む3桁区切りの金額でも
        # 末尾の数字だけ（248）でなく全体（1248）を拾えるようにする。
        m = re.search(
            r"^(.*?\D)\s*[¥￥]?\s*(\d{1,3}(?:,\s?\d{3})+|\d{2,6})\s*円?\s*[*※]?$", line
        )
        if m:
            name = _clean_item_name(m.group(1))
            price = _amount_in_line(m.group(2))
            if _is_valid_item_name(name) and price and 0 < price < 1_000_000:
                items.append({"name": name, "price": price, "_idx": i})
                consumed[i] = True

    # パターンB/C: 「価格だけの行」のかたまりを、その直前に並ぶ品名行と対応づける。
    # Vision は列がずれると「品名群 → 価格群」と縦に分けて出すため、価格だけの
    # 連続ブロックを取り、同じ個数だけ直前にある品名行と上から順にペアにする。
    # （ブロック長1は従来のパターンB＝品名の直後に価格、と同じ挙動になる）
    i = 0
    while i < n:
        if consumed[i] or is_stop(lines[i]) or not _is_price_only_line(lines[i]):
            i += 1
            continue
        # 価格だけの連続ブロックを収集
        prices: list[int] = []
        j = i
        while (
            j < n and not consumed[j] and not is_stop(lines[j])
            and _is_price_only_line(lines[j])
        ):
            amount = _amount_in_line(lines[j])
            if amount is None:
                break
            prices.append(amount)
            j += 1
        # 直前に並ぶ品名行を、価格と同数だけさかのぼって収集
        names: list[str] = []
        k = i - 1
        while k >= 0 and len(names) < len(prices):
            if consumed[k] or is_stop(lines[k]) or _is_price_only_line(lines[k]):
                break
            name = _clean_item_name(lines[k])
            if not _is_valid_item_name(name) or not re.search(r"[^\d\s¥￥,円]", lines[k]):
                break
            names.append(name)
            k += -1
        names.reverse()  # 上から下の順に戻す
        # 品名と価格が同数のときだけ採用（数が合わないと誤対応になるため）。
        if names and len(names) == len(prices):
            for idx, (name, price) in enumerate(zip(names, prices)):
                if price and 0 < price < 1_000_000:
                    items.append({"name": name, "price": price, "_idx": i - len(names) + idx})
        i = j

    # 元のレシート上の出現順に整えて内部キーを除去
    items.sort(key=lambda it: it["_idx"])
    return [{"name": it["name"], "price": it["price"]} for it in items[:80]]


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
        "branch": parse_branch(text, store),
        "amount": parse_total(text) or 0,
        "category": guess_category(text, store),
        "items": parse_items(text),
        "raw_text": text,
    }
