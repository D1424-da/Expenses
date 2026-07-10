// 集計ロジック（DOM に依存しない純粋関数）— カテゴリ内訳と最安値比較。

// 明細が無い／価格が取れない支出を寄せる先のカテゴリ名
export const UNCATEGORIZED = "未分類";

// 支出群を「明細(items)のカテゴリ」で集計して { カテゴリ: 金額 } を返す。
// ・明細ごとに「明細のカテゴリ → 無ければその支出のカテゴリ」へ割り当てる
//   （明細にカテゴリが無い古いデータ等が "未分類" に落ちないようにする）
// ・消費税や端数で「明細合計 ≠ 支払額」になる分は、明細の比率で各カテゴリへ按分する。
//   こうすると税を別枠にせずに済み、内訳の合計が支払額（=週計）と必ず一致する。
// ・明細が無い支出（カレンダー直接追加・手入力）はその支出のカテゴリへ。
//   カテゴリも無いときだけ「未分類」になる。
export function categoryBreakdown(expenses) {
  const map = {};
  const add = (cat, amt) => {
    if (!amt) return;
    map[cat] = (map[cat] || 0) + amt;
  };
  for (const e of expenses) {
    const amount = Math.round(e.amount || 0);
    const fallback = e.category || UNCATEGORIZED; // 明細にカテゴリが無いときの受け皿
    const items = Array.isArray(e.items) ? e.items : [];
    const itemSum = items.reduce((s, it) => s + (Number(it.price) || 0), 0);
    if (!items.length || itemSum <= 0) {
      add(fallback, amount);
      continue;
    }
    // 明細カテゴリごとに価格を合算
    const perCat = {};
    for (const it of items) {
      const cat = it.category || fallback;
      perCat[cat] = (perCat[cat] || 0) + (Number(it.price) || 0);
    }
    // 支払額(amount)を明細比で按分。円未満は四捨五入し、誤差は最大カテゴリで吸収して
    // 合計を支払額に厳密一致させる（消費税ぶんも各カテゴリへ自然に配分される）。
    const cats = Object.keys(perCat);
    let allocated = 0;
    let maxCat = cats[0];
    for (const cat of cats) {
      const v = Math.round((perCat[cat] * amount) / itemSum);
      add(cat, v);
      allocated += v;
      if (perCat[cat] > perCat[maxCat]) maxCat = cat;
    }
    add(maxCat, amount - allocated);
  }
  return map;
}

// ---- 最安値比較 --------------------------------------------------------------

// 比較用に商品名をゆるく正規化（空白・記号除去、小文字化）
export function normName(name) {
  return name.toLowerCase().replace(/[\s　,.\-_*()（）]/g, "");
}

export function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 全期間の支出から商品名ごとの過去最安値マップを構築する。
// 戻り値: Map<normKey, number>（normName(品名) → 最安値）
export function buildPriceHistory(allExpenses) {
  const history = new Map();
  for (const e of allExpenses) {
    for (const it of e.items || []) {
      if (!it.name || !it.price) continue;
      const key = normName(it.name);
      const cur = history.get(key);
      if (cur === undefined || it.price < cur) history.set(key, it.price);
    }
  }
  return history;
}

// 今月の支出から「過去最安値で買えた商品」を抽出してアラートリストを返す。
// priceHistory: buildPriceHistory() が返す Map<normKey, number>
// thisMonthExpenses: 今月の支出
// 戻り値: [{ name, store, price, prevMin }]
export function lowestPriceAlerts(priceHistory, thisMonthExpenses) {
  // 今月の明細品目を収集（品名 → {name, entries}）
  const thisMonth = new Map();
  for (const e of thisMonthExpenses) {
    for (const it of e.items || []) {
      if (!it.name || !it.price) continue;
      const key = normName(it.name);
      if (!thisMonth.has(key)) thisMonth.set(key, { name: it.name, entries: [] });
      thisMonth.get(key).entries.push({ store: e.store, branch: e.branch, price: it.price, date: e.date });
    }
  }
  if (!thisMonth.size) return [];

  const alerts = [];
  for (const [key, { name, entries }] of thisMonth) {
    const allTimeMin = priceHistory.get(key) ?? Infinity;
    for (const e of entries) {
      if (e.price <= allTimeMin && e.price > 0) {
        alerts.push({ name, store: e.store, price: e.price, prevMin: allTimeMin });
        break;
      }
    }
  }
  return alerts.slice(0, 5); // 最大5件
}

// 同一商品を店舗ごとに集計する。各店舗について「現在価格（最新）」と
// 「その店の過去最安（セール時の値）」を出し、一時的なセールを見分けられるようにする。
// 平常価格はセール1回に引っ張られにくいよう中央値で見積もる。
export function summarizeByStore(entries) {
  const map = new Map();
  // 同じチェーンでも支店ごとに別の店として集計する（店名＋支店名でグループ化）
  for (const e of entries) {
    const key = `${e.store}${e.branch || ""}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  const out = [];
  for (const [, list] of map) {
    list.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const latest = list[list.length - 1]; // 最新の記録 = 現在価格
    let low = list[0];
    for (const e of list) if (e.price < low.price) low = e; // その店の過去最安
    const regular = median(list.map((e) => e.price)); // 平常価格の目安
    out.push({
      store: list[0].store,
      branch: list[0].branch || "",
      current: latest.price,
      currentDate: latest.date,
      low: low.price,
      lowDate: low.date,
      hasLow: low.price < latest.price, // 今より安く買えた履歴がある
      saleNow: list.length >= 2 && latest.price <= regular * 0.9, // 今セール中
      isSaleLow: list.length >= 2 && low.price <= regular * 0.9, // 過去最安はセール価格
    });
  }
  return out;
}
