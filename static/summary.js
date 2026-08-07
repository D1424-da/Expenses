// サマリーエリアの描画: 合計金額・件数・カテゴリバー・最安値アラート。
import { state } from "./app-state.js";
import { $, yen, escapeHtml, monthKey, renderCatBars } from "./dom-utils.js";
import { categoryBreakdown, buildPriceHistory, lowestPriceAlerts } from "./stats.js";
import { renderBudgetBars } from "./budget-view.js";
import { renderUsageBar, checkGate } from "./stripe-billing.js";
import { fetchAllExpenses } from "./firestore-data.js";

/** 今月（実際のカレンダー月）の記録件数。制限判定・バー表示に使う。 */
export function thisMonthCount() {
  const todayKey = monthKey(new Date());
  if (monthKey(state.currentMonth) === todayKey) return state.currentExpenses.length;
  if (state.allExpensesCache) {
    return state.allExpensesCache.filter(
      (e) => typeof e.date === "string" && e.date.startsWith(todayKey)
    ).length;
  }
  return 0; // キャッシュ未ロード時は許可側に倒す
}

export function renderSummary() {
  const total = state.currentExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  $("summary-total").textContent = yen(total);
  $("summary-count").textContent = state.currentExpenses.length
    ? `${state.currentExpenses.length}件の記録` : "記録なし";
  renderUsageBar(thisMonthCount());

  const bars = $("category-bars");
  const usedBudget = renderBudgetBars(state.currentExpenses, bars);
  if (!usedBudget) renderCatBars(bars, categoryBreakdown(state.currentExpenses));

  _refreshAlerts();
}

async function _refreshAlerts() {
  const el = $("lowest-alerts");
  if (!el) return;
  try {
    if (!state.allExpensesCache) {
      state.allExpensesCache = await fetchAllExpenses();
    }
    const curMonthKey  = monthKey(state.currentMonth);
    const pastExpenses = state.allExpensesCache.filter(
      (e) => typeof e.date === "string" && !e.date.startsWith(curMonthKey),
    );
    const pastPriceHistory = buildPriceHistory(pastExpenses);
    const alerts = lowestPriceAlerts(pastPriceHistory, state.currentExpenses);
    if (!alerts.length) { el.hidden = true; return; }
    el.hidden = false;
    const foodCats = new Set(["食費", "外食"]);
    const food  = alerts.filter((a) => foodCats.has(a.category));
    const daily = alerts.filter((a) => !foodCats.has(a.category));
    const _rows = (arr) => arr.map((a) =>
      `<div class="alert-row">
        <span class="alert-name">${escapeHtml(a.name)}</span>
        <span class="alert-detail">${escapeHtml(a.store)} <strong>${yen(a.price)}</strong>（過去最安！）</span>
      </div>`).join("");
    let html = `<div class="alert-title">🎉 今月のお得な買い物</div>`;
    if (food.length)  html += `<div class="alert-section">🍱 食料品</div>${_rows(food)}`;
    if (daily.length) html += `<div class="alert-section">🧴 日用品</div>${_rows(daily)}`;
    el.innerHTML = html;
  } catch (_) {
    el.hidden = true;
  }
}

export { checkGate };
