// OCRの生テキストから家計簿の項目を推定して抽出する（parser.py のブラウザ版）。
// 完璧な抽出は難しいため推定値を返し、ユーザーが保存前に画面で修正できる前提。

const TOTAL_KEYWORDS = ["合計", "合 計", "総合計", "お買上", "お買い上げ", "計", "total", "ﾄｰﾀﾙ"];
const EXCLUDE_KEYWORDS = [
  "小計", "お預り", "お預かり", "お釣", "釣り", "おつり", "預り", "現金",
  "クレジット", "ポイント", "残高", "課税", "消費税", "内税", "外税",
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
  食費: ["スーパー", "イオン", "西友", "ライフ", "マルエツ", "業務スーパー", "コンビニ", "セブン", "ローソン", "ファミリーマート", "ファミマ", "青果", "精肉", "鮮魚"],
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

// 1行から金額を取り出す（¥1,280 / 1280円 / 1,280 など）。なければ null。
function amountInLine(line) {
  const t = toHalfWidth(line);
  const m = t.match(/(?:[¥￥]\s*)?(\d{1,3}(?:,\d{3})+|\d{2,7})\s*円?/);
  if (!m) return null;
  const v = parseInt(m[1].replace(/,/g, ""), 10);
  return v > 0 && v < 10000000 ? v : null;
}

function parseTotal(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const hasExclude = (low) => EXCLUDE_KEYWORDS.some((ex) => low.includes(ex.toLowerCase()));

  // ラベルと金額が別の行に分かれることがある（Visionの特徴）。
  // i行目のラベルに対応する金額を、同じ行→続く2行から探す。
  const amountNear = (i) => {
    const same = amountInLine(lines[i]);
    if (same != null) return same;
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const a = amountInLine(lines[j]);
      if (a != null) return a;
    }
    return null;
  };

  // お釣り・お預り・小計・税・現金・ポイント等に紐づく金額は「合計ではない」ので除外。
  const excluded = new Set();
  lines.forEach((line, i) => {
    if (hasExclude(line.toLowerCase())) {
      const a = amountNear(i);
      if (a != null) excluded.add(a);
    }
  });

  // 1) 「合計」系キーワードに紐づく金額を最優先（除外金額は採らない）
  for (const keyword of TOTAL_KEYWORDS) {
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase();
      if (!low.includes(keyword.toLowerCase())) continue;
      if (hasExclude(low)) continue;
      const a = amountNear(i);
      if (a != null && !excluded.has(a)) return a;
    }
  }

  // 2) フォールバック: 除外金額・ノイズ行を除いた中での最大金額
  let best = null;
  lines.forEach((line) => {
    if (hasExclude(line.toLowerCase())) return;
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
    if (/(tel|電話|〒|\d{2,4}-\d{2,4}-\d{3,4})/i.test(line)) continue;
    return line.slice(0, 50);
  }
  return "";
}

// 数字・記号のみ（価格だけ）の行かどうか
function isPriceOnlyLine(line) {
  const t = toHalfWidth(line).trim();
  return /^[¥￥]?\s*\d{1,3}(?:,\d{3})+\s*円?$|^[¥￥]?\s*\d{2,7}\s*円?[*※]?$/.test(t);
}

function cleanName(s) {
  return s.replace(/^[\s　:：\-_*\d.]+/, "").replace(/[\s　:：\-_*]+$/, "").slice(0, 60);
}

function parseItems(text) {
  const items = [];
  const stopWords = [...TOTAL_KEYWORDS, ...EXCLUDE_KEYWORDS];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
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
      if (name && name.length >= 1 && price && price > 0 && price < 1000000) {
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
        if (name && price && price > 0 && price < 1000000) {
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
    amount: parseTotal(text) || 0,
    category: guessCategory(text, store),
    items: parseItems(text),
    raw_text: text,
  };
}
