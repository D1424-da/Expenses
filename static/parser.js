// OCRの生テキストから家計簿の項目を推定して抽出する（parser.py のブラウザ版）。
// 完璧な抽出は難しいため推定値を返し、ユーザーが保存前に画面で修正できる前提。

const TOTAL_KEYWORDS = ["合計", "合 計", "総合計", "お買上", "お買い上げ", "total", "ﾄｰﾀﾙ"];
// 「金額そのものを合計から除外したい」行（支払い・釣り・ポイント等）。
const CASH_EXCLUDE = ["お預", "お釣", "おつり", "釣り", "預り", "現金", "クレジット", "ポイント", "残高", "チャージ", "お返し", "電子マネー"];
// 「合計ではない／小計や税」のラベル。明細の終端判定にも使う。
const SUBTOTAL_KEYWORDS = ["小計", "消費税", "内税", "外税", "課税", "対象", "値引", "税込", "税抜"];
// レシートのヘッダ/フッタの定型ラベル（明細ではない）。商品名として拾わない。
const RECEIPT_META_KEYWORDS = [
  "お会計券", "会計券", "登録番号", "精算機", "精算", "責任者", "担当", "レジ",
  "取引番号", "伝票", "バーコード", "軽減税率", "対象商品", "営業時間",
  "買上点数", "点数", "買上", "番号", "顧客", "累計", "有効期限", "領収",
];
const EXCLUDE_KEYWORDS = [...CASH_EXCLUDE, ...SUBTOTAL_KEYWORDS, ...RECEIPT_META_KEYWORDS];
// 店名として採用したくない挨拶・定型文・業態の説明。
const GREETINGS = [
  "ありがとう", "毎度", "またのお越し", "領収", "レシート", "お客様", "控え", "ご来店", "お買い上げ",
  "ディスカウントストア", "ドラッグストア", "スーパーマーケット", "コンビニエンスストア", "ホームセンター", "ショッピングセンター",
];

// カテゴリ推定用キーワード（上から順に優先）
const CATEGORY_KEYWORDS = {
  外食: ["レストラン", "食堂", "カフェ", "珈琲", "coffee", "マクドナルド", "スターバックス", "牛丼", "ラーメン", "居酒屋", "bar", "ダイニング"],
  交通費: ["jr", "鉄道", "バス", "タクシー", "駐車", "高速", "etc", "ガソリン", "eneos", "出光", "コスモ", "suica", "pasmo"],
  医療費: ["薬局", "薬", "病院", "クリニック", "ドラッグ", "調剤", "マツモトキヨシ", "ウエルシア", "サンドラッグ"],
  光熱費: ["電力", "電気", "ガス", "水道"],
  通信費: ["docomo", "au", "softbank", "携帯", "通信", "wifi", "インターネット"],
  衣服: ["ユニクロ", "uniqlo", "gu", "しまむら", "衣料", "アパレル", "zara"],
  日用品: ["ドラッグ", "薬局", "ホームセンター", "カインズ", "ニトリ", "100円", "ダイソー", "セリア", "雑貨"],
  食費: ["スーパー", "イオン", "西友", "ライフ", "マルエツ", "業務スーパー", "コンビニ", "セブン", "ローソン", "ファミリーマート", "ファミマ", "青果", "精肉", "鮮魚", "タイヨー", "問屋", "生鮮"],
};

function toHalfWidth(s) {
  return s.replace(/[０-９，．]/g, (ch) => {
    if (ch === "，") return ",";
    if (ch === "．") return ".";
    return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
  });
}

function normalizeAmount(text) {
  const m = toHalfWidth(text).match(/(\d[\d,]*)/);
  if (!m) return null;
  const v = parseInt(m[1].replace(/,/g, ""), 10);
  return Number.isNaN(v) ? null : v;
}

// 電話番号・FAX・郵便番号・日付など、金額や品目として扱うべきでない行。
function isNoiseLine(line) {
  const low = line.toLowerCase();
  if (/(tel|電話|fax|〒)/.test(low)) return true;
  if (/\d{2,4}-\d{2,4}-\d{3,4}/.test(line)) return true;
  if (/\d{1,4}\s*[年/\-.]\s*\d{1,2}\s*[月/\-.]\s*\d{1,2}/.test(line)) return true;
  // 時刻（17:18 など）。「お会計券 #000002 R1068 17:18」を価格18と誤読しない。
  if (/\d{1,2}\s*[:：]\s*\d{2}/.test(line)) return true;
  // 「甲突店26」「○○店 12」等の店舗・レジ番号行（店名+番号を商品と誤読しない）。
  if (/店\s*\d{1,6}\s*$/.test(line)) return true;
  return false;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseDate(text) {
  const t = toHalfWidth(text);
  const patterns = [
    /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, // 2024年1月2日
    /(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/g, // 2024/01/02 等
    /(\d{2})[/\-.](\d{1,2})[/\-.](\d{1,2})/g, // 24/01/02
  ];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxDate = new Date(today.getTime() + 2 * 86400000);
  const minDate = new Date(2000, 0, 1);

  for (const re of patterns) {
    for (const m of t.matchAll(re)) {
      const y = m[1];
      let year = parseInt(y, 10);
      if (y.length === 2) year += 2000;
      const month = parseInt(m[2], 10);
      const day = parseInt(m[3], 10);
      const date = new Date(year, month - 1, day);
      // ロールオーバー（例 2月30日）を弾く
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
        continue;
      }
      if (date >= minDate && date <= maxDate) {
        const p = (n) => String(n).padStart(2, "0");
        return `${year}-${p(month)}-${p(day)}`;
      }
    }
  }
  return null;
}

// 1行から金額を取り出す。Visionが「¥1, 771」のように空白を挟むことがあるので許容。
function amountInLine(line) {
  const t = toHalfWidth(line);
  let raw = null;
  let m = t.match(/[¥￥]\s*([0-9][0-9,\s]*[0-9]|[0-9])/); // ¥の直後を最優先
  if (m) raw = m[1];
  if (raw == null) {
    m = t.match(/([0-9][0-9,\s]*[0-9]|[0-9])\s*円/); // 〜円
    if (m) raw = m[1];
  }
  if (raw == null) {
    m = t.match(/(\d{1,3}(?:,\s?\d{3})+|\d{2,7})/); // カンマ区切り or 2桁以上
    if (m) raw = m[1];
  }
  if (raw == null) return null;
  const v = parseInt(raw.replace(/[,\s]/g, ""), 10);
  return v > 0 && v < 10000000 ? v : null;
}

function parseTotal(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const has = (line, words) => {
    const low = line.toLowerCase();
    return words.some((w) => low.includes(w.toLowerCase()));
  };

  // ラベルと金額が別の行に分かれることがある（Visionの特徴）。
  const amountNear = (i) => {
    const same = amountInLine(lines[i]);
    if (same != null) return same;
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const a = amountInLine(lines[j]);
      if (a != null) return a;
    }
    return null;
  };

  // 支払い・お釣り・ポイント等の金額は「購入合計ではない」ので除外。
  // （小計や税は除外しない。税込だと小計＝合計で一致することがあるため）
  const excluded = new Set();
  lines.forEach((line, i) => {
    if (has(line, CASH_EXCLUDE)) {
      const a = amountNear(i);
      if (a != null) excluded.add(a);
    }
  });

  // 1) 「合計」系キーワードに紐づく金額を最優先（最初の合計を信用して即採用）。
  //    支払い額(クレジット等)が合計と一致して除外されてしまう問題を避けるため、
  //    ここでは excluded を見ない。
  for (const keyword of TOTAL_KEYWORDS) {
    for (let i = 0; i < lines.length; i++) {
      if (!has(lines[i], [keyword])) continue;
      if (has(lines[i], CASH_EXCLUDE)) continue;
      const a = amountNear(i);
      if (a != null) return a;
    }
  }

  // 2) フォールバック: 支払い系を除いた中での最大金額
  let best = null;
  lines.forEach((line) => {
    if (has(line, CASH_EXCLUDE)) return;
    if (isNoiseLine(line)) return;
    const a = amountInLine(line);
    if (a != null && !excluded.has(a)) best = best == null ? a : Math.max(best, a);
  });
  return best;
}

function parseStore(text) {
  // 数字・記号・空白のみの行は除外（日本語/英字を含む行を店名候補にする）
  const skip = /^[\s\d\p{P}\p{S}_]+$/u;
  for (let line of text.split("\n")) {
    line = line.trim();
    if (line.length < 2) continue;
    if (skip.test(line)) continue;
    if (/(tel|電話|〒|登録番号|\d{2,4}-\d{2,4}-\d{3,4})/i.test(line)) continue;
    // 「毎日! 新鮮! 激安!」のような宣伝スローガン（!が複数）は店名にしない
    if ((line.match(/[!！]/g) || []).length >= 2) continue;
    // 挨拶・定型文（毎度ありがとうございます等）は店名にしない
    if (GREETINGS.some((g) => line.includes(g))) continue;
    return line.slice(0, 50);
  }
  return "";
}

// 支店名（「〇〇店」）を推定する。店名行と別に「△△店」の行があれば拾う。
function parseBranch(text, store) {
  for (let line of text.split("\n")) {
    line = line.trim();
    if (line.length < 2 || line.length > 30) continue;
    if (line === store) continue;
    if (/(tel|電話|〒|登録番号|\d{2,4}-\d{2,4}-\d{3,4})/i.test(line)) continue;
    // 「〇〇店」「〇〇店 12」等。末尾の番号は落とす。
    const m = line.match(/([^\s　]{1,20}店)\s*\d{0,6}\s*$/);
    if (m) return m[1].slice(0, 50);
  }
  return "";
}

// 数字・記号のみ（価格だけ）の行かどうか
function isPriceOnlyLine(line) {
  const t = toHalfWidth(line).trim();
  return /^[¥￥]?\s*\d{1,3}(?:,\d{3})+\s*円?$|^[¥￥]?\s*\d{2,7}\s*円?[*※]?$/.test(t);
}

function cleanName(s) {
  return s
    // 「外8 0104」「内8 5401」「外85416」等の軽減税率印＋商品コードを除去。
    // これがあると別店舗の同一商品（例: じゃがいも）が比較でグルーピングできない。
    .replace(/^\s*[内外]税?\s*8?\s*\d{3,6}\s+/, "")
    // 先頭の記号（◆◇●○・*-: 数字など）と末尾の記号（¥含む）を除去
    .replace(/^[\s　:：\-_*◆◇●○・･\d.]+/, "")
    .replace(/[\s　:：\-_*¥￥]+$/, "")
    .slice(0, 60);
}

// コード・記号だけの「商品名らしくない」文字列を弾く。
// 「R」「T834…」等のレジ/登録コードや、店舗番号を商品として保存しないため。
function isValidItemName(name) {
  if (!name || name.length < 1) return false;
  if (/店\s*\d*$/.test(name) && name.replace(/[\s　\d]/g, "").length <= 4) return false;
  const hasJa = /[一-龥぀-ゟ゠-ヿー々]/.test(name); // 漢字・かな・カタカナを含む
  const latin = (name.match(/[A-Za-z]/g) || []).length;
  return hasJa || latin >= 2; // 日本語を含むか、英字が2文字以上あれば商品名とみなす
}

function parseItems(text) {
  const items = [];
  const stopWords = [...TOTAL_KEYWORDS, ...EXCLUDE_KEYWORDS];
  let lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // 明細は「小計／合計」より上にある。そこで打ち切ってクレジット明細等の数字を拾わない。
  const cutAt = lines.findIndex((l) =>
    [...SUBTOTAL_KEYWORDS, ...TOTAL_KEYWORDS].some((kw) => l.includes(kw))
  );
  if (cutAt > 0) lines = lines.slice(0, cutAt);

  const isStop = (line) => {
    const low = line.toLowerCase();
    return stopWords.some((kw) => low.includes(kw.toLowerCase())) || isNoiseLine(line);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isStop(line)) continue;

    // パターンA: 「品名 ... 価格」が同じ行
    const m = line.match(/^(.*\D)\s*[¥￥]?\s*(\d{1,3}(?:,\d{3})+|\d{2,6})\s*円?\s*[*※]?$/);
    if (m) {
      const name = cleanName(m[1]);
      const price = normalizeAmount(m[2]);
      if (isValidItemName(name) && price && price > 0 && price < 1000000) {
        items.push({ name, price });
        continue;
      }
    }

    // パターンB: この行が「価格だけ」で、前の行が品名（Visionで分かれた場合）
    if (isPriceOnlyLine(line) && i > 0) {
      const prev = lines[i - 1];
      if (!isStop(prev) && !isPriceOnlyLine(prev) && /[^\d\s¥￥,円]/.test(prev)) {
        const price = amountInLine(line);
        const name = cleanName(prev);
        if (isValidItemName(name) && price && price > 0 && price < 1000000) {
          items.push({ name, price });
        }
      }
    }
  }
  return items.slice(0, 80);
}

function guessCategory(text, store) {
  const haystack = (store + "\n" + text).toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => haystack.includes(kw.toLowerCase()))) return category;
  }
  return "その他";
}

export function parseReceipt(text) {
  const store = parseStore(text);
  return {
    date: parseDate(text) || todayStr(),
    store,
    branch: parseBranch(text, store),
    amount: parseTotal(text) || 0,
    category: guessCategory(text, store),
    items: parseItems(text),
    raw_text: text,
  };
}
