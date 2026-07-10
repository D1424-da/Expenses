// 店舗別一覧の描画。store → branch → 明細 の3階層でグループ表示する。
import { $, yen, escapeHtml } from "./dom-utils.js";

export function renderList(expenses, { onEdit, onDelete }) {
  const list = $("expense-list");
  list.innerHTML = "";
  $("empty-msg").hidden = expenses.length > 0;
  if (!expenses.length) return;

  const totalOf = (arr) => arr.reduce((t, e) => t + (e.amount || 0), 0);

  const stores = new Map();
  for (const e of expenses) {
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

      const hasBranches = [...s.branches.keys()].some(Boolean);
      [...s.branches.entries()]
        .sort((a, b) => totalOf(b[1]) - totalOf(a[1]))
        .forEach(([branch, entries]) => {
          if (hasBranches) {
            const bhead = document.createElement("div");
            bhead.className = "branch-head";
            bhead.innerHTML = `
              <span class="bh-name">${branch ? escapeHtml(branch) : "（支店なし）"}</span>
              <span class="bh-total">${yen(totalOf(entries))}</span>`;
            group.appendChild(bhead);
          }
          entries
            .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
            .forEach((e) => group.appendChild(_renderRow(e, hasBranches, onEdit, onDelete)));
        });

      list.appendChild(group);
    });
}

function _renderRow(e, indented, onEdit, onDelete) {
  const row = document.createElement("div");
  row.className = "expense-item" + (indented ? " ei-indent" : "");
  const memo = e.memo ? ` · ${escapeHtml(e.memo)}` : "";
  const cat = e.category ? `<span class="ei-cat">${escapeHtml(e.category)}</span>` : "";
  row.innerHTML = `
    <div class="ei-main">
      <div class="ei-meta">${cat}${escapeHtml(e.date)}${memo}</div>
    </div>
    <div class="ei-amount">${yen(e.amount)}</div>
    <div class="ei-actions">
      <button data-act="edit">✏️</button>
      <button data-act="del">🗑️</button>
    </div>`;
  row.querySelector('[data-act="edit"]').onclick = () => onEdit(e);
  row.querySelector('[data-act="del"]').onclick = () => onDelete(e.id);
  return row;
}
