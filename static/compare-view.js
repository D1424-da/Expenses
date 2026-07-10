// 商品の最安値比較モーダル。全期間の明細を店舗ごとに集計して表示する。
import { $, yen, escapeHtml, openModal, closeModal } from "./dom-utils.js";
import { log, logErr } from "./log.js";
import { normName, summarizeByStore } from "./stats.js";

let _fetchAll;
let _data = []; // { name, price, store, branch, date }[]

// ctx: { fetchAllExpenses: () => Promise<expense[]> }
export function initCompare({ fetchAllExpenses }) {
  _fetchAll = fetchAllExpenses;
  $("compare-btn").onclick = _open;
  $("compare-close").onclick = () => closeModal("compare-modal");
  let _debounce = null;
  $("compare-search").oninput = () => { clearTimeout(_debounce); _debounce = setTimeout(_render, 200); };
}

async function _open() {
  openModal("compare-modal");
  const list = $("compare-list");
  list.innerHTML = "<p class='empty'>読み込み中…</p>";
  try {
    const expenses = await _fetchAll();
    _data = [];
    for (const e of expenses) {
      for (const it of e.items || []) {
        if (it?.name && it.price > 0) {
          _data.push({
            name: String(it.name),
            price: Number(it.price),
            store: e.store || "(店名なし)",
            branch: e.branch || "",
            date: e.date || "",
          });
        }
      }
    }
    log("最安値比較: 明細", _data.length, "件");
    _render();
  } catch (err) {
    logErr("最安値比較の読み込み失敗:", err.code, err.message, err);
    list.innerHTML = "<p class='empty'>読み込みに失敗しました。</p>";
  }
}

function _render() {
  const q = normName($("compare-search").value.trim());
  const list = $("compare-list");

  const groups = new Map();
  for (const it of _data) {
    const key = normName(it.name);
    if (!key || (q && !key.includes(q))) continue;
    if (!groups.has(key)) groups.set(key, { label: it.name, entries: [] });
    groups.get(key).entries.push(it);
  }

  if (!groups.size) {
    list.innerHTML = "<p class='empty'>該当する商品がありません。明細付きで保存するとここに集計されます。</p>";
    return;
  }

  const rows = [...groups.values()].map((g) => {
    const stores = summarizeByStore(g.entries);
    const currents = stores.map((s) => s.current);
    const min = Math.min(...currents);
    const max = Math.max(...currents);
    const bestEver = stores.reduce((b, s) => (s.low < b.low ? s : b), stores[0]);
    return { ...g, stores, min, max, spread: max - min, bestEver };
  });
  rows.sort((a, b) => b.spread - a.spread || b.stores.length - a.stores.length);

  list.innerHTML = "";
  for (const g of rows) {
    const sorted = [...g.stores].sort((a, b) => a.current - b.current || a.low - b.low);
    const rowsHtml = sorted.map((s) => {
      const isMin = s.current === g.min;
      const lowHtml = s.hasLow
        ? `<div class="cmp-low">📉 過去最安 ${yen(s.low)}${s.lowDate ? ` <span class="cmp-date">${escapeHtml(s.lowDate)}</span>` : ""}${s.isSaleLow ? ' <span class="cmp-tag">セール</span>' : ""}</div>`
        : "";
      return `<div class="cmp-row">
          <div class="cmp-store ${isMin ? "cmp-min" : ""}">
            <span>${escapeHtml(s.store)}${s.branch ? ` <span class="cmp-branch">${escapeHtml(s.branch)}</span>` : ""}${s.currentDate ? ` <span class="cmp-date">${escapeHtml(s.currentDate)}</span>` : ""}${s.saleNow ? ' <span class="cmp-tag">セール中</span>' : ""}</span>
            <span>${yen(s.current)}${isMin ? " 🏆" : ""}</span>
          </div>
          ${lowHtml}
        </div>`;
    }).join("");
    const saleBest = g.bestEver.low < g.min
      ? ` <span class="cmp-sale">🔥セール最安 ${yen(g.bestEver.low)}</span>` : "";
    const card = document.createElement("div");
    card.className = "cmp-item";
    card.innerHTML = `
      <div class="cmp-head">
        <span class="cmp-name">${escapeHtml(g.label)}</span>
        <span class="cmp-best">今の最安 ${yen(g.min)}${g.spread > 0 ? `（最大${yen(g.max)}）` : ""}${saleBest}</span>
      </div>
      <div class="cmp-stores">${rowsHtml}</div>`;
    list.appendChild(card);
  }
}
