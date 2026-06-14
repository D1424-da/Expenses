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

function parseTotal(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const hasExclude = (low) => EXCLUDE_KEYWORDS.some((ex) => low.includes(ex.toLowerCase()));

  // 明細など、行末に現れる金額候補の最大値（妥当性チェック用）
  let lineMax = 0;
  for (const line of lines) {
    if (hasExclude(line.toLowerCase())) continue;
    if (isNoiseLine(line)) continue;
    const m = line.match(/(\d{1,3}(?:,\d{3})+|\d{2,7})\s*円?\s*[*※]?$/);
    if (m) {
      const val = normalizeAmount(m[1]);
      if (val && val > 0 && val < 10000000) lineMax = Math.max(lineMax, val);
    }
  }

  // 1) キーワード行を優先（OCR誤読で合計が明細より小さい場合は信用しない）
  for (const keyword of TOTAL_KEYWORDS) {
    for (const line of lines) {
      const low = line.toLowerCase();
      if (!low.includes(keyword.toLowerCase())) continue;
      if (hasExclude(low)) continue;
      const amount = normalizeAmount(line);
      if (amount && amount > 0 && amount >= lineMax) return amount;
    }
  }

  // 2) フォールバック: 金額らしき数値の最大
  const candidates = [];
  for (const line of lines) {
    if (hasExclude(line.toLowerCase())) continue;
    if (isNoiseLine(line)) continue;
    if (/[¥￥]|円|\d,\d{3}/.test(line)) {
      const amount = normalizeAmount(line);
      if (amount && amount > 0 && amount < 10000000) candidates.push(amount);
    }
  }
  if (candidates.length) return Math.max(...candidates);
  return lineMax || null;
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

function parseItems(text) {
  const items = [];
  const stopWords = [...TOTAL_KEYWORDS, ...EXCLUDE_KEYWORDS];
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line) continue;
    const low = line.toLowerCase();
    if (stopWords.some((kw) => low.includes(kw.toLowerCase()))) continue;
    if (isNoiseLine(line)) continue;
    const m = line.match(/[¥￥]?\s*(\d{1,3}(?:,\d{3})+|\d{2,6})\s*円?\s*[*※]?$/);
    if (!m) continue;
    const price = normalizeAmount(m[1]);
    const name = line
      .slice(0, m.index)
      .replace(/^[\s　:：\-_*]+/, "")
      .replace(/[\s　:：\-_*]+$/, "");
    if (name && price && price > 0 && price < 1000000) {
      items.push({ name: name.slice(0, 60), price });
    }
  }
  return items.slice(0, 50);
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
