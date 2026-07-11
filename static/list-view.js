// 店舗別一覧の描画。store → branch → 明細 の3階層でグループ表示する。
// G-2: setFilter(text, cat) で絞り込みができる。
import { $, yen, escapeHtml } from "./dom-utils.js";

// イベントデリゲーション用: id → expense オブジェクトのマップ
let _expenseById = new Map();
let _onEdit, _onDelete;
let _delegated = false;

// 絞り込み状態
let _filterText = "";
let _filterCat  = "";
let _lastExpenses = [];

export function setFilter(text, cat) {
  _filterText = (text || "").toLowerCase();
  _filterCat  = cat || "";
  _render(_lastExpenses);
}

export function renderList(expenses, { onEdit, onDelete }) {
  _onEdit = onEdit;
  _onDelete = onDelete;
  _lastExpenses = expenses;
  _expenseById = new Map(expenses.map((e) => [e.id, e]));

  // リスナーはリスト要素に1度だけ登録（innerHTML 書き換えで消えない）
  const list = $("expense-list");
  if (!_delegated) {
    list.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-act]");
      if (!btn) return;
      const id = btn.closest("[data-id]")?.dataset.id;
      if (!id) return;
      if (btn.dataset.act === "edit") _onEdit?.(_expenseById.get(id));
      if (btn.dataset.act === "del") _onDelete?.(id);
    });
    _delegated = true;
  }

  _render(expenses);
}

function _applyFilter(expenses) {
  if (!_filterText && !_filterCat) return expenses;
  return expenses.filter((e) => {
    if (_filterCat && e.category !== _filterCat) return false;
    if (_filterText) {
      const haystack = [
        e.store, e.branch, e.memo, e.category, e.date,
        ...(e.items || []).map((it) => it.name),
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(_filterText)) return false;
    }
    return true;
  });
}

function _render(expenses) {
  const list = $("expense-list");
  const filtered = _applyFilter(expenses);

  list.innerHTML = "";

  const countEl = $("list-filter-count");
  if (countEl) {
    if (_filterText || _filterCat) {
      countEl.textContent = `${filtered.length} / ${expenses.length} 件`;
      countEl.hidden = false;
    } else {
      countEl.hidden = true;
    }
  }

  $("empty-msg").hidden = expenses.length > 0;
  if (!filtered.length) {
    if (expenses.length > 0) {
      list.innerHTML = `<p class="empty">条件に一致する記録がありません。</p>`;
    }
    return;
  }

  const totalOf = (arr) => arr.reduce((t, e) => t + (e.amount || 0), 0);

  const stores = new Map();
  for (const e of filtered) {
    const store = (e.store || "").trim() || "(店名なし)";
    const branch = (e.branch || "").trim();
    if (!stores.has(store)) stores.set(store, { total: 0, count: 0, branches: new Map() });
    const s = stores.get(store);
    s.total += e.amount || 0;
    s.count++;
    if (!s.branches.has(branch)) s.branches.set(branch, []);
    s.branches.get(branch).push(e);
  }

  [...stores.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([store, s]) => {
      const group = document.createElement("div");
      group.className = "store-group";
      group.innerHTML = `
        <div class="store-head">
          <span class="sg-name">${escapeHtml(store)}</span>
          <span class="sg-total">${yen(s.total)}<span class="sg-count">${s.count}件</span></span>
        </div>`;

      let hasBranches = false;
      for (const k of s.branches.keys()) { if (k) { hasBranches = true; break; } }

      [...s.branches.entries()]
        .map(([branch, entries]) => ({ branch, entries, total: totalOf(entries) }))
        .sort((a, b) => b.total - a.total)
        .forEach(({ branch, entries, total }) => {
          if (hasBranches) {
            const bhead = document.createElement("div");
            bhead.className = "branch-head";
            bhead.innerHTML = `
              <span class="bh-name">${branch ? escapeHtml(branch) : "（支店なし）"}</span>
              <span class="bh-total">${yen(total)}</span>`;
            group.appendChild(bhead);
          }
          entries
            .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
            .forEach((e) => group.appendChild(_renderRow(e, hasBranches)));
        });

      list.appendChild(group);
    });
}

function _renderRow(e, indented) {
  const row = document.createElement("div");
  row.className = "expense-item" + (indented ? " ei-indent" : "");
  row.dataset.id = e.id;
  const memo = e.memo ? ` · ${escapeHtml(e.memo)}` : "";
  const cat = e.category ? `<span class="ei-cat">${escapeHtml(e.category)}</span>` : "";
  const items = e.items || [];
  const itemsHtml = items.length
    ? `<ul class="ei-items">${items.map((it) => {
        const qty = it.qty != null ? `<span class="ei-item-qty">${escapeHtml(String(it.qty))}${escapeHtml(it.unit || "")}</span>` : "";
        return `<li><span class="ei-item-name">${escapeHtml(it.name)}</span>${qty}<span class="ei-item-price">${yen(it.price)}</span></li>`;
      }).join("")}</ul>`
    : "";
  row.innerHTML = `
    <div class="ei-main">
      <div class="ei-meta">${cat}${escapeHtml(e.date)}${memo}</div>
      ${itemsHtml}
    </div>
    <div class="ei-amount">${yen(e.amount)}</div>
    <div class="ei-actions">
      <button data-act="edit">✏️</button>
      <button data-act="del">🗑️</button>
    </div>`;
  return row;
}
