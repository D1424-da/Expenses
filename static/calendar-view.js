// カレンダー描画・週計モーダル・日付モーダル（その日の一覧＋直接追加）。
//
// initCalendar(ctx) で初期化。renderCalendar(expenses, month) で毎回再描画。
// Firestore 更新時は renderCalendar → maybeRefreshDayModal の順に呼ぶこと。
import { $, yen, dayKey, escapeHtml, openModal, closeModal, renderCatBars, WEEKDAYS } from "./dom-utils.js";
import { log, logErr } from "./log.js";
import { categoryBreakdown } from "./stats.js";
import { CATEGORIES } from "./firebase-config.js";

let _onAddExpense, _onEdit, _onDelete, _onRecipeSuggest;
let _expenses = [];
let _selectedDay = null;
let _weekBreakdowns = [];

// ctx: { onAddExpense({date, store, amount, category}), onEdit(e), onDelete(id), onRecipeSuggest(selectedDay, expenses) }
export function initCalendar({ onAddExpense, onEdit, onDelete, onRecipeSuggest }) {
  _onAddExpense = onAddExpense;
  _onEdit = onEdit;
  _onDelete = onDelete;
  _onRecipeSuggest = onRecipeSuggest;

  for (const c of CATEGORIES) $("day-category").add(new Option(c, c));
  $("day-category").value = "食費";
  $("day-close").onclick = () => closeModal("day-modal");
  $("day-form").onsubmit = _handleDayAdd;
  $("week-close").onclick = () => closeModal("week-modal");
}

export function renderCalendar(expenses, month) {
  _expenses = expenses;
  const cal = $("calendar");
  const year = month.getFullYear();
  const m = month.getMonth();
  const totals = _totalsByDay(expenses);
  const byDay = _expensesByDay(expenses);
  const todayKey = dayKey(new Date());
  _weekBreakdowns = [];

  const first = new Date(year, m, 1);
  const gridStart = new Date(year, m, 1 - first.getDay());

  let html = '<div class="cal-grid">';
  for (const w of WEEKDAYS) html += `<div class="cal-dow">${w}</div>`;
  html += '<div class="cal-dow cal-week-h">週計</div>';

  const cursor = new Date(gridStart);
  const weeks = Math.ceil((first.getDay() + new Date(year, m + 1, 0).getDate()) / 7);
  for (let w = 0; w < weeks; w++) {
    let weekSum = 0;
    let rowHtml = "";
    const weekExpenses = [];
    let weekStart = null, weekEnd = null;

    for (let i = 0; i < 7; i++) {
      const key = dayKey(cursor);
      const inMonth = cursor.getMonth() === m;
      const amt = totals[key] || 0;
      if (inMonth) {
        weekSum += amt;
        if (byDay[key]) weekExpenses.push(...byDay[key]);
        weekStart ??= new Date(cursor);
        weekEnd = new Date(cursor);
      }
      const cls = [
        "cal-day",
        inMonth ? "" : "cal-out",
        key === todayKey ? "cal-today" : "",
        amt > 0 ? "cal-has" : "",
      ].filter(Boolean).join(" ");
      rowHtml += `<div class="${cls}" data-day="${key}" ${inMonth ? "" : "data-out"}>
          <span class="cal-num">${cursor.getDate()}</span>
          ${amt > 0 ? `<span class="cal-amt">${yen(amt)}</span>` : ""}
        </div>`;
      cursor.setDate(cursor.getDate() + 1);
    }
    _weekBreakdowns.push({
      start: weekStart, end: weekEnd,
      total: weekSum, byCat: categoryBreakdown(weekExpenses),
    });
    const weekCls = "cal-week" + (weekSum > 0 ? " cal-week-click" : "");
    rowHtml += `<div class="${weekCls}" data-week="${w}">${weekSum > 0 ? yen(weekSum) : ""}</div>`;
    html += rowHtml;
  }
  html += "</div>";
  cal.innerHTML = html;

  cal.querySelectorAll(".cal-day:not(.cal-out)").forEach((el) => {
    el.onclick = () => _openDayModal(el.dataset.day);
  });
  cal.querySelectorAll(".cal-week-click").forEach((el) => {
    el.onclick = () => _openWeekModal(Number(el.dataset.week));
  });
}

// Firestore 更新時、日付モーダルが開いていれば内容を最新化する
export function maybeRefreshDayModal() {
  if (!$("day-modal").hidden) _renderDayModal();
}

function _totalsByDay(expenses) {
  return expenses.reduce((map, e) => {
    if (e.date) map[e.date] = (map[e.date] || 0) + (e.amount || 0);
    return map;
  }, {});
}

function _expensesByDay(expenses) {
  return expenses.reduce((map, e) => {
    if (e.date) (map[e.date] ??= []).push(e);
    return map;
  }, {});
}

function _openWeekModal(idx) {
  const wk = _weekBreakdowns[idx];
  if (!wk) return;
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  $("week-modal-title").textContent =
    wk.start && wk.end ? `${fmt(wk.start)}〜${fmt(wk.end)} の内訳` : "週の内訳";
  $("week-total").textContent = yen(wk.total);
  renderCatBars($("week-bars"), wk.byCat);
  openModal("week-modal");
}

function _openDayModal(key) {
  _selectedDay = key;
  $("day-amount").value = "";
  $("day-store").value = "";
  $("day-category").value = "食費";
  _renderDayModal();
  openModal("day-modal");
  $("day-amount").focus();
}

function _renderDayModal() {
  if (!_selectedDay) return;
  const [y, m, d] = _selectedDay.split("-").map(Number);
  $("day-modal-title").textContent = `${y}年${m}月${d}日の買い物`;

  const items = _expenses
    .filter((e) => e.date === _selectedDay)
    .sort((a, b) => (b.amount || 0) - (a.amount || 0));
  $("day-total").textContent = yen(items.reduce((s, e) => s + (e.amount || 0), 0));

  const list = $("day-list");
  if (!items.length) {
    list.innerHTML = "<p class='empty'>まだ記録がありません。</p>";
    return;
  }
  list.innerHTML = "";
  for (const e of items) {
    const row = document.createElement("div");
    row.className = "day-row";
    row.innerHTML = `
      <div class="day-row-main">
        <span class="ei-cat">${escapeHtml(e.category)}</span>
        <span class="day-row-store">${escapeHtml(e.store || "(店名なし)")}</span>
      </div>
      <span class="day-row-amt">${yen(e.amount)}</span>
      <button data-act="edit" aria-label="編集">✏️</button>
      <button data-act="del" aria-label="削除">🗑️</button>`;
    row.querySelector('[data-act="edit"]').onclick = () => _onEdit(e);
    row.querySelector('[data-act="del"]').onclick = () => _onDelete(e.id);
    list.appendChild(row);
  }

  // 明細品目がある支出がひとつでもあればレシピ提案ボタンを表示
  if (_onRecipeSuggest) {
    const hasItems = items.some((e) => (e.items || []).some((it) => it.name));
    if (hasItems) {
      const btn = document.createElement("button");
      btn.className = "recipe-open-btn";
      btn.textContent = "🍳 レシピを提案";
      btn.onclick = () => _onRecipeSuggest(_selectedDay, _expenses);
      list.appendChild(btn);
    }
  }
}

async function _handleDayAdd(e) {
  e.preventDefault();
  const amount = Number($("day-amount").value);
  if (!amount || amount <= 0) { $("day-amount").focus(); return; }
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    await _onAddExpense({
      date: _selectedDay,
      store: $("day-store").value.trim(),
      amount,
      category: $("day-category").value,
    });
    $("day-amount").value = "";
    $("day-store").value = "";
  } catch (err) {
    logErr("カレンダー追加エラー:", err.code, err.message, err);
    alert("追加に失敗しました: " + err.message);
  } finally {
    btn.disabled = false;
  }
}
