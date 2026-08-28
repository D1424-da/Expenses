// 予算設定の手がかり（過去の平均・先月の実績）を計算する純粋関数。
//
// DOM も Firestore も触らない。budget-view.js は Firebase を CDN から
// import しているためテストから読み込めないので、判定をここに分けて
// static/budget-stats.test.js で固定する（recipe-parse.js と同じ方針）。
//
// ## なぜ「3か月に満たなければ出さない」のか
//
// 予算欄が空のまま並んでいても、初めての人は何円と入れればよいか分からない。
// そこで過去の実績を手がかりに出すが、**実績が1〜2か月しかない状態の
// 「平均」は根拠が薄く、かえって誤った基準を与える**。記録を始めた月は
// 数日分しかないこともある。そのため月数が足りないときは出さない。

/** 何か月分の実績を平均の対象にするか。 */
export const AVERAGE_MONTHS = 3;

/** Date → "YYYY-MM" */
const _mk = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/**
 * 当月の1つ前から遡って、対象にする月のキーを返す（新しい順）。
 * 当月は途中なので含めない。
 */
export function targetMonthKeys(now, months = AVERAGE_MONTHS) {
  const keys = [];
  for (let i = 1; i <= months; i++) {
    keys.push(_mk(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  }
  return keys;
}

/**
 * 過去の支出から、カテゴリ別の平均・先月額をまとめる。
 *
 * @param {Array<{date?: string, amount?: number, category?: string}>} expenses
 * @param {Date} now 当月を表す日付
 * @param {number} months 平均の対象月数
 * @returns {{
 *   monthsWithData: number,          // 対象月のうち実績があった月数
 *   hasAverage: boolean,             // 平均を出してよいか
 *   hasLastMonth: boolean,           // 先月の実績があるか
 *   average: Record<string, number>, // カテゴリ別の平均（円・整数）
 *   lastMonth: Record<string, number>,
 *   averageTotal: number,
 *   lastMonthTotal: number,
 * }}
 */
export function summarizeHistory(expenses, now, months = AVERAGE_MONTHS) {
  const keys     = targetMonthKeys(now, months);
  const lastKey  = keys[0];
  const inRange  = new Set(keys);

  const byMonth  = new Map();   // "YYYY-MM" → { カテゴリ: 合計 }
  for (const e of expenses || []) {
    const date = typeof e?.date === "string" ? e.date : "";
    const mk   = date.slice(0, 7);
    if (!inRange.has(mk)) continue;
    const amount = Number(e?.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const cat = e?.category || "その他";
    const m   = byMonth.get(mk) || {};
    m[cat] = (m[cat] || 0) + amount;
    byMonth.set(mk, m);
  }

  const monthsWithData = byMonth.size;
  const lastMonth      = byMonth.get(lastKey) || {};

  // 平均は「実績のあった月数」ではなく対象月数で割る。使わなかった月を
  // 0 として扱わないと、たまたま記録が少ない月がある人の平均が跳ね上がる。
  const totals = {};
  for (const m of byMonth.values()) {
    for (const [cat, v] of Object.entries(m)) totals[cat] = (totals[cat] || 0) + v;
  }
  const average = {};
  for (const [cat, v] of Object.entries(totals)) {
    average[cat] = Math.round(v / months);
  }

  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  return {
    monthsWithData,
    hasAverage:   monthsWithData >= months,
    hasLastMonth: Object.keys(lastMonth).length > 0,
    average,
    lastMonth,
    averageTotal:   sum(average),
    lastMonthTotal: sum(lastMonth),
  };
}

/** 予算欄の合計。空欄・0・不正値は 0 として扱う。 */
export function sumLimits(values) {
  return (values || []).reduce((acc, v) => {
    const n = Number(v);
    return acc + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
}


/**
 * 表示中の月の残り日数。当月でなければ null（過去・未来の月に「残り日数」は
 * 意味がない）。
 */
export function daysLeftInMonth(now, month) {
  if (now.getFullYear() !== month.getFullYear() || now.getMonth() !== month.getMonth()) {
    return null;
  }
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  return last - now.getDate() + 1;   // 今日を含めた残り日数
}

/**
 * 予算に対する残額。
 *
 * @param {Record<string, number>} limits カテゴリ別の予算
 * @param {Array<{amount?: number}>} expenses 表示中の月の支出
 * @returns {{ hasBudget: boolean, limit: number, spent: number,
 *             remaining: number, over: boolean, pct: number }}
 *   remaining は超過時も正の数（超過額）を返す。over で向きを判断する。
 */
export function budgetRemaining(limits, expenses) {
  const limit = Object.values(limits || {})
    .reduce((a, v) => a + (Number(v) > 0 ? Number(v) : 0), 0);
  const spent = (expenses || [])
    .reduce((a, e) => a + (Number(e?.amount) > 0 ? Number(e.amount) : 0), 0);
  const diff = limit - spent;
  return {
    hasBudget: limit > 0,
    limit,
    spent,
    remaining: Math.abs(diff),
    over: diff < 0,
    // バーは 100% で頭打ちにする。超過分まで伸ばすと枠からはみ出す。
    pct: limit > 0 ? Math.min(100, (spent / limit) * 100) : 0,
  };
}
