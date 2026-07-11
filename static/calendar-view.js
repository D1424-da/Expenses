// カレンダー描画・週計モーダル・日付モーダル（その日の一覧＋直接追加）。
//
// 同月の再描画（Firestore 更新・献立更新）は差分パッチのみで行い全再構築しない。
// 月が変わったときだけ innerHTML を差し替える。
import { $, yen, dayKey, escapeHtml, openModal, closeModal, renderCatBars, WEEKDAYS } from "./dom-utils.js";
import { log, logErr } from "./log.js";
import { categoryBreakdown } from "./stats.js";
import { CATEGORIES } from "./firebase-config.js";
import { saveMeal, deleteMeal } from "./meal-plan.js";

let _onAddExpense, _onEdit, _onDelete, _onInlineSave;
let _expenses  = [];
let _mealPlans = {};
let _selectedDay = null;
let _weekBreakdowns = [];

// 日付モーダルのデリゲーション用マップ（_renderDayModal のたびに再構築）
const _dayExpenseById = new Map();

// 差分更新用の状態
let _renderedMonth = null; // { year, month } — 最後に全再構築した月
let _dayEls  = new Map(); // dateKey → { dayEl, amtEl, mealEl, lastAmt, lastMeal }
let _weekEls = [];        // [{ el, lastTotal }] — 週計セルへの参照

export function initCalendar({ onAddExpense, onEdit, onDelete, onInlineSave }) {
  _onAddExpense = onAddExpense;
  _onEdit = onEdit;
  _onDelete = onDelete;
  _onInlineSave = onInlineSave;

  for (const c of CATEGORIES) $("day-category").add(new Option(c, c));
  $("day-category").value = "食費";
  $("day-close").onclick  = () => closeModal("day-modal");
  $("day-form").onsubmit  = _handleDayAdd;
  $("week-close").onclick = () => closeModal("week-modal");
  $("day-prev").onclick   = () => _navigateDay(-1);
  $("day-next").onclick   = () => _navigateDay(1);

  // カレンダー全体に1つデリゲーションリスナーを置く（innerHTML 差し替え後も有効）
  $("calendar").addEventListener("click", (ev) => {
    const weekEl = ev.target.closest("[data-week]");
    if (weekEl?.classList.contains("cal-week-click")) {
      _openWeekModal(Number(weekEl.dataset.week));
      return;
    }
    const dayEl = ev.target.closest("[data-day]");
    if (dayEl && !dayEl.hasAttribute("data-out")) _openDayModal(dayEl.dataset.day);
  });
}

export function renderCalendar(expenses, month) {
  _expenses = expenses;
  const year = month.getFullYear();
  const m    = month.getMonth();

  if (_renderedMonth?.year === year && _renderedMonth?.month === m) {
    _diffUpdate(year, m);
  } else {
    _fullBuild(year, m);
    _renderedMonth = { year, month: m };
  }
}

// Firestore 更新時、日付モーダルが開いていれば内容を最新化する
export function maybeRefreshDayModal() {
  if (!$("day-modal").hidden) _renderDayModal();
}

// 献立マップが更新されたときに呼ぶ（app.js → mealPlanSync コールバック）
export function updateMealPlans(map) {
  _mealPlans = map || {};
}

// ---- グリッド全再構築（月が変わったとき） ------------------------------------

function _fullBuild(year, m) {
  const cal      = $("calendar");
  const totals   = _totalsByDay(_expenses);
  const byDay    = _expensesByDay(_expenses);
  const todayKey = dayKey(new Date());

  _dayEls.clear();
  _weekEls = [];
  _weekBreakdowns = [];

  const first     = new Date(year, m, 1);
  const gridStart = new Date(year, m, 1 - first.getDay());
  const weeks     = Math.ceil((first.getDay() + new Date(year, m + 1, 0).getDate()) / 7);

  let html = '<div class="cal-grid">';
  for (const w of WEEKDAYS) html += `<div class="cal-dow">${w}</div>`;
  html += '<div class="cal-dow cal-week-h">週計</div>';

  const cursor = new Date(gridStart);
  for (let w = 0; w < weeks; w++) {
    let weekSum = 0;
    let rowHtml = "";
    const weekExpenses = [];
    let weekStart = null, weekEnd = null;

    for (let i = 0; i < 7; i++) {
      const key     = dayKey(cursor);
      const inMonth = cursor.getMonth() === m;
      const amt     = inMonth ? (totals[key] || 0) : 0;
      if (inMonth) {
        weekSum += amt;
        if (byDay[key]) weekExpenses.push(...byDay[key]);
        weekStart ??= new Date(cursor);
        weekEnd = new Date(cursor);
      }
      const _mp     = _mealPlans[key];
      const hasMeal = inMonth && !!_mp && !!(_mp.朝食 || _mp.お弁当 || _mp.昼食 || _mp.夕食);
      const cls = [
        "cal-day",
        inMonth ? "" : "cal-out",
        key === todayKey ? "cal-today" : "",
        amt > 0 ? "cal-has" : "",
      ].filter(Boolean).join(" ");

      rowHtml += `<div class="${cls}" data-day="${key}"${inMonth ? "" : " data-out"}>
          <span class="cal-num">${cursor.getDate()}</span>
          ${amt > 0    ? `<span class="cal-amt">${yen(amt)}</span>`            : ""}
          ${hasMeal    ? `<span class="cal-meal" title="献立あり">🍽</span>` : ""}
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

  // 差分更新用の参照を収集（次回の同月再描画で使う）
  cal.querySelectorAll("[data-day]:not([data-out])").forEach((dayEl) => {
    const key  = dayEl.dataset.day;
    const _mp  = _mealPlans[key];
    _dayEls.set(key, {
      dayEl,
      amtEl:    dayEl.querySelector(".cal-amt")  ?? null,
      mealEl:   dayEl.querySelector(".cal-meal") ?? null,
      lastAmt:  totals[key] || 0,
      lastMeal: !!_mp && !!(_mp.朝食 || _mp.お弁当 || _mp.昼食 || _mp.夕食),
    });
  });
  cal.querySelectorAll("[data-week]").forEach((el, idx) => {
    _weekEls.push({ el, lastTotal: _weekBreakdowns[idx]?.total ?? 0 });
  });
}

// ---- 同月差分パッチ（Firestore 更新・献立更新のたびに呼ばれる） ---------------

function _diffUpdate(year, m) {
  const totals = _totalsByDay(_expenses);
  const byDay  = _expensesByDay(_expenses);

  // 日付セルのパッチ（金額・献立アイコンのみ変わりうる）
  for (const [key, cell] of _dayEls) {
    const newAmt  = totals[key] || 0;
    const _mp     = _mealPlans[key];
    const newMeal = !!_mp && !!(_mp.朝食 || _mp.お弁当 || _mp.昼食 || _mp.夕食);

    if (newAmt !== cell.lastAmt) {
      cell.lastAmt = newAmt;
      if (newAmt > 0) {
        if (!cell.amtEl) {
          cell.amtEl = document.createElement("span");
          cell.amtEl.className = "cal-amt";
          cell.dayEl.appendChild(cell.amtEl);
        }
        cell.amtEl.textContent = yen(newAmt);
      } else {
        cell.amtEl?.remove();
        cell.amtEl = null;
      }
      cell.dayEl.classList.toggle("cal-has", newAmt > 0);
    }

    if (newMeal !== cell.lastMeal) {
      cell.lastMeal = newMeal;
      if (newMeal && !cell.mealEl) {
        cell.mealEl = document.createElement("span");
        cell.mealEl.className = "cal-meal";
        cell.mealEl.title = "献立あり";
        cell.mealEl.textContent = "🍽";
        cell.dayEl.appendChild(cell.mealEl);
      } else if (!newMeal && cell.mealEl) {
        cell.mealEl.remove();
        cell.mealEl = null;
      }
    }
  }

  // 週計セルのパッチ
  _recomputeWeekBreakdowns(year, m, totals, byDay);
  _weekEls.forEach((cell, idx) => {
    const newTotal = _weekBreakdowns[idx]?.total ?? 0;
    if (newTotal === cell.lastTotal) return;
    cell.lastTotal = newTotal;
    cell.el.textContent = newTotal > 0 ? yen(newTotal) : "";
    cell.el.classList.toggle("cal-week-click", newTotal > 0);
  });
}

function _recomputeWeekBreakdowns(year, m, totals, byDay) {
  const first     = new Date(year, m, 1);
  const gridStart = new Date(year, m, 1 - first.getDay());
  const weeks     = Math.ceil((first.getDay() + new Date(year, m + 1, 0).getDate()) / 7);
  const cursor    = new Date(gridStart);
  _weekBreakdowns = [];

  for (let w = 0; w < weeks; w++) {
    let weekSum = 0;
    const weekExpenses = [];
    let weekStart = null, weekEnd = null;
    for (let i = 0; i < 7; i++) {
      const key = dayKey(cursor);
      if (cursor.getMonth() === m) {
        weekSum += totals[key] || 0;
        if (byDay[key]) weekExpenses.push(...byDay[key]);
        weekStart ??= new Date(cursor);
        weekEnd = new Date(cursor);
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    _weekBreakdowns.push({ start: weekStart, end: weekEnd, total: weekSum, byCat: categoryBreakdown(weekExpenses) });
  }
}

// ---- ユーティリティ -----------------------------------------------------------

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

// ---- 週計モーダル -------------------------------------------------------------

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

// ---- 日付モーダル -------------------------------------------------------------

function _openDayModal(key) {
  _selectedDay = key;
  $("day-amount").value = "";
  $("day-store").value  = "";
  $("day-category").value = "食費";
  _renderDayModal();
  openModal("day-modal");
}

function _navigateDay(delta) {
  if (!_selectedDay) return;
  const [y, m, d] = _selectedDay.split("-").map(Number);
  const date = new Date(y, m - 1, d + delta);
  // 同月内のみナビゲート
  if (date.getFullYear() === y && date.getMonth() === m - 1) {
    _selectedDay = dayKey(date);
    _renderDayModal();
  }
}

function _renderDayModal() {
  if (!_selectedDay) return;
  const [y, m, d] = _selectedDay.split("-").map(Number);
  $("day-modal-title").textContent = `${y}年${m}月${d}日の買い物`;

  // 前後日ナビ（月の端でボタンを無効化）
  const lastDay = new Date(y, m, 0).getDate();
  $("day-prev").disabled = d <= 1;
  $("day-next").disabled = d >= lastDay;

  const items = _expenses
    .filter((e) => e.date === _selectedDay)
    .sort((a, b) => (b.amount || 0) - (a.amount || 0));
  $("day-total").textContent = yen(items.reduce((s, e) => s + (e.amount || 0), 0));

  // 献立（常に表示・各食事をインライン編集可能）
  const mealContentEl = $("day-meal-content");
  mealContentEl.innerHTML = "";
  mealContentEl.appendChild(_buildMealEditor(_mealPlans[_selectedDay] || {}));
  $("day-meal-plan").hidden = false;

  // 支出リスト（イベントデリゲーション）
  _dayExpenseById.clear();
  for (const e of items) _dayExpenseById.set(e.id, e);

  const list = $("day-list");
  list.innerHTML = items.length ? "" : "<p class='empty'>まだ記録がありません。</p>";
  if (!items.length) return;

  // リストにデリゲーションリスナーを1回だけ登録
  if (!list._delegated) {
    list.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-act]");
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.act === "edit") {
        const rowEl = btn.closest(".day-row");
        _showDayInlineEdit(id, rowEl);
      }
      if (btn.dataset.act === "del") _onDelete?.(id);
    });
    list._delegated = true;
  }

  for (const e of items) list.appendChild(_buildDayRow(e));
}

function _buildDayRow(e) {
  const row = document.createElement("div");
  row.className = "day-row";
  const items = e.items || [];
  const itemsHtml = items.length
    ? `<details class="ei-details">
        <summary class="ei-details-summary">明細 ${items.length}件</summary>
        <ul class="ei-items">${items.map((it) => {
          const qty = it.qty != null
            ? `<span class="ei-item-qty">${escapeHtml(String(it.qty))}${escapeHtml(it.unit || "")}</span>`
            : "";
          return `<li><span class="ei-item-name">${escapeHtml(it.name)}</span>${qty}<span class="ei-item-price">${yen(it.price)}</span></li>`;
        }).join("")}</ul>
      </details>`
    : "";
  row.innerHTML = `
    <div class="day-row-top">
      <div class="day-row-main">
        <span class="ei-cat">${escapeHtml(e.category)}</span>
        <span class="day-row-store">${escapeHtml(e.store || "(店名なし)")}</span>
      </div>
      <span class="day-row-amt">${yen(e.amount)}</span>
      <div class="ei-actions">
        <button data-act="edit" data-id="${e.id}" aria-label="編集">✏️</button>
        <button data-act="del"  data-id="${e.id}" aria-label="削除">🗑️</button>
      </div>
    </div>
    ${itemsHtml}`;
  return row;
}

function _showDayInlineEdit(id, rowEl) {
  const e = _dayExpenseById.get(id);
  if (!e) return;

  const catOpts = CATEGORIES.map(
    (c) => `<option value="${escapeHtml(c)}"${c === e.category ? " selected" : ""}>${escapeHtml(c)}</option>`,
  ).join("");

  rowEl.innerHTML = `
    <div class="ei-inline-form day-inline-form">
      <div class="ei-inline-row">
        <input type="number" class="ei-f-amount" value="${e.amount || 0}" min="0" step="1" inputmode="numeric" placeholder="金額" />
        <select class="ei-f-cat">${catOpts}</select>
      </div>
      <div class="ei-inline-row">
        <input type="text" class="ei-f-store" value="${escapeHtml(e.store || "")}" placeholder="店名" />
        <input type="text" class="ei-f-memo" value="${escapeHtml(e.memo || "")}" placeholder="メモ（任意）" />
      </div>
      ${(e.items || []).length ? `<div class="ei-inline-items-note">明細 ${e.items.length}件（明細も編集する場合は「明細も編集」から）</div>` : ""}
      <div class="ei-inline-actions">
        <button class="ei-save-btn primary" type="button">更新</button>
        <button class="ei-cancel-btn" type="button">キャンセル</button>
        ${(e.items || []).length ? `<button class="ei-full-edit-btn" type="button">明細も編集 ›</button>` : ""}
      </div>
    </div>`;

  rowEl.querySelector(".ei-f-amount").focus();

  rowEl.querySelector(".ei-save-btn").onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = "保存中…";
    try {
      const payload = {
        date:     e.date,
        amount:   Number(rowEl.querySelector(".ei-f-amount").value) || 0,
        store:    rowEl.querySelector(".ei-f-store").value.trim(),
        branch:   e.branch || "",
        category: rowEl.querySelector(".ei-f-cat").value,
        memo:     rowEl.querySelector(".ei-f-memo").value.trim(),
        items:    e.items || [],
      };
      await _onInlineSave?.(id, payload);
      const updated = { ...e, ...payload };
      _dayExpenseById.set(id, updated);
      // _expenses の対応エントリも即時更新してモーダルが最新データで再描画できるようにする
      const idx = _expenses.findIndex((x) => x.id === id);
      if (idx >= 0) _expenses[idx] = updated;
      const newRow = _buildDayRow(updated);
      rowEl.replaceWith(newRow);
      // 合計を再計算
      const total = [..._dayExpenseById.values()].reduce((s, x) => s + (x.amount || 0), 0);
      $("day-total").textContent = yen(total);
    } catch (err) {
      logErr("インライン保存エラー:", err.message);
      alert("保存に失敗しました: " + (err.message || err));
      btn.disabled = false;
      btn.textContent = "更新";
    }
  };

  rowEl.querySelector(".ei-cancel-btn").onclick = () => {
    const restored = _buildDayRow(e);
    rowEl.replaceWith(restored);
  };

  const fullEditBtn = rowEl.querySelector(".ei-full-edit-btn");
  if (fullEditBtn) fullEditBtn.onclick = () => _onEdit?.(e);
}


// ---- 献立インライン編集 -------------------------------------------------------

// 献立の3食をインライン編集できる DOM を組み立てる。
// blur で自動保存、🗑️ で1食削除、📖 でレシピ展開。
function _buildMealEditor(plan) {
  const SLOTS = [
    { slot: "朝食",   icon: "🌅", ph: "例：目玉焼き・ご飯" },
    { slot: "お弁当", icon: "🍱", ph: "例：唐揚げ・卵焼き　/ 給食 / 外食" },
    { slot: "夕食",   icon: "🌙", ph: "例：カレーライス" },
  ];

  const wrap = document.createElement("div");
  wrap.className = "meal-editor";

  for (const { slot, icon, ph } of SLOTS) {
    // 旧データの「昼食」フィールドはお弁当欄に引き継ぐ
    const memo   = plan[slot] || (slot === "お弁当" ? (plan["昼食"] || "") : "");
    const recipe = plan[`${slot}レシピ`] || null;

    const row = document.createElement("div");
    row.className = "meal-editor-row";

    const lbl = document.createElement("span");
    lbl.className = "meal-editor-label";
    lbl.textContent = `${icon} ${slot}`;
    row.appendChild(lbl);

    const inputWrap = document.createElement("div");
    inputWrap.className = "meal-editor-input-wrap";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "meal-editor-input";
    input.value = memo;
    input.placeholder = ph;
    input.setAttribute("aria-label", slot);
    inputWrap.appendChild(input);

    // レシピ展開ボタン＋詳細パネル
    let detailEl = null;
    if (recipe) {
      const recipeBtn = document.createElement("button");
      recipeBtn.type = "button";
      recipeBtn.className = "meal-recipe-btn";
      recipeBtn.textContent = "📖";
      recipeBtn.title = "レシピを見る";
      inputWrap.appendChild(recipeBtn);

      detailEl = document.createElement("div");
      detailEl.className = "meal-recipe-detail recipe-result";
      detailEl.hidden = true;

      recipeBtn.onclick = () => {
        if (detailEl.hidden) {
          const render = window.__recipeHelpers__?._markdownToHtml;
          detailEl.innerHTML = render
            ? render(recipe)
            : `<pre style="white-space:pre-wrap;font-size:.85rem">${escapeHtml(recipe)}</pre>`;
        }
        detailEl.hidden = !detailEl.hidden;
        recipeBtn.textContent = detailEl.hidden ? "📖" : "📖▼";
      };
    }

    // 削除ボタン
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "meal-del-btn";
    delBtn.textContent = "🗑️";
    delBtn.title = `${slot}を削除`;
    delBtn.hidden = !memo;
    inputWrap.appendChild(delBtn);

    row.appendChild(inputWrap);
    wrap.appendChild(row);
    if (detailEl) wrap.appendChild(detailEl);

    // blur → 自動保存
    let _savedVal = memo;
    input.addEventListener("blur", async () => {
      const newVal = input.value.trim();
      if (newVal === _savedVal) return;
      try {
        if (newVal) {
          await saveMeal(_selectedDay, slot, newVal);
        } else {
          await deleteMeal(_selectedDay, slot);
        }
        _savedVal = newVal;
        delBtn.hidden = !newVal;
      } catch (err) {
        logErr("献立保存エラー:", err.message);
      }
    });

    delBtn.onclick = async () => {
      input.value = "";
      _savedVal = "";
      delBtn.hidden = true;
      if (detailEl) detailEl.hidden = true;
      try {
        await deleteMeal(_selectedDay, slot);
      } catch (err) {
        logErr("献立削除エラー:", err.message);
      }
    };
  }

  return wrap;
}

// ---- カレンダーから支出追加 ---------------------------------------------------

async function _handleDayAdd(e) {
  e.preventDefault();
  const amount = Number($("day-amount").value);
  if (!amount || amount <= 0) { $("day-amount").focus(); return; }
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    await _onAddExpense({
      date:     _selectedDay,
      store:    $("day-store").value.trim(),
      amount,
      category: $("day-category").value,
    });
    $("day-amount").value = "";
    $("day-store").value  = "";
  } catch (err) {
    logErr("カレンダー追加エラー:", err.code, err.message, err);
    alert("追加に失敗しました: " + err.message);
  } finally {
    btn.disabled = false;
  }
}
