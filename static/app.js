"use strict";

// ---- 状態 ------------------------------------------------------------------
let currentMonth = new Date(); // 表示中の月
let categories = [];

const $ = (id) => document.getElementById(id);
const yen = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP");
const monthKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthLabel = (d) => `${d.getFullYear()}年${d.getMonth() + 1}月`;

// ---- 初期化 ----------------------------------------------------------------
async function init() {
  await loadCategories();
  bindEvents();
  renderMonth();
  await refresh();
}

async function loadCategories() {
  const res = await fetch("/api/categories");
  const data = await res.json();
  categories = data.categories;

  const sel = $("f-category");
  const filter = $("filter-category");
  for (const c of categories) {
    sel.add(new Option(c, c));
    filter.add(new Option(c, c));
  }
}

function bindEvents() {
  $("prev-month").onclick = () => shiftMonth(-1);
  $("next-month").onclick = () => shiftMonth(1);
  $("file-input").onchange = handleFile;
  $("expense-form").onsubmit = handleSubmit;
  $("reset-btn").onclick = resetForm;
  $("filter-category").onchange = loadList;
}

function shiftMonth(delta) {
  currentMonth.setMonth(currentMonth.getMonth() + delta);
  renderMonth();
  refresh();
}

function renderMonth() {
  $("current-month").textContent = monthLabel(currentMonth);
}

async function refresh() {
  await Promise.all([loadSummary(), loadList()]);
}

// ---- OCR 取り込み ----------------------------------------------------------
async function handleFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const status = $("ocr-status");
  status.hidden = false;
  status.className = "status loading";
  status.textContent = "📤 読み取り中… (数秒かかります)";

  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/ocr", { method: "POST", body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "読み取りに失敗しました");
    }
    const data = await res.json();
    fillForm(data);
    status.className = "status ok";
    status.textContent = "✅ 読み取りました。内容を確認して保存してください。";
    $("form-card").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    status.className = "status error";
    status.textContent = "⚠️ " + err.message;
  } finally {
    e.target.value = ""; // 同じファイルを再選択できるように
  }
}

// ---- フォーム --------------------------------------------------------------
function fillForm(data) {
  $("form-title").textContent = "読み取り結果を確認";
  $("f-id").value = "";
  $("f-date").value = data.date || "";
  $("f-amount").value = data.amount || 0;
  $("f-store").value = data.store || "";
  $("f-category").value = data.category || "その他";
  $("f-memo").value = "";
  $("f-image").value = data.image_path || "";
  $("f-rawtext").value = data.raw_text || "";
  renderItems(data.items || []);

  const preview = $("form-preview");
  if (data.image_path) {
    $("preview-img").src = "/api/image/" + data.image_path;
    preview.hidden = false;
  } else {
    preview.hidden = true;
  }
}

function renderItems(items) {
  const list = $("items-list");
  list.innerHTML = "";
  for (const it of items) addItemRow(it.name, it.price);
  updateItemsCount();
}

function addItemRow(name = "", price = 0) {
  const row = document.createElement("div");
  row.className = "item-row";
  row.innerHTML = `
    <input type="text" class="item-name" value="${escapeHtml(name)}" placeholder="品目" />
    <input type="number" class="item-price" value="${price || 0}" min="0" />
    <button type="button" aria-label="削除">✕</button>`;
  row.querySelector("button").onclick = () => {
    row.remove();
    updateItemsCount();
  };
  $("items-list").appendChild(row);
  updateItemsCount();
}

function collectItems() {
  return [...document.querySelectorAll(".item-row")]
    .map((r) => ({
      name: r.querySelector(".item-name").value.trim(),
      price: Number(r.querySelector(".item-price").value) || 0,
    }))
    .filter((it) => it.name || it.price);
}

function updateItemsCount() {
  $("items-count").textContent = document.querySelectorAll(".item-row").length;
}

function resetForm() {
  $("expense-form").reset();
  $("form-title").textContent = "手入力で追加";
  $("f-id").value = "";
  $("f-image").value = "";
  $("f-rawtext").value = "";
  $("items-list").innerHTML = "";
  $("form-preview").hidden = true;
  updateItemsCount();
  $("f-date").value = monthKey(new Date()) + "-" + String(new Date().getDate()).padStart(2, "0");
}

async function handleSubmit(e) {
  e.preventDefault();
  const id = $("f-id").value;
  const fd = new FormData();
  fd.append("date", $("f-date").value);
  fd.append("store", $("f-store").value);
  fd.append("amount", $("f-amount").value || 0);
  fd.append("category", $("f-category").value);
  fd.append("memo", $("f-memo").value);
  fd.append("items", JSON.stringify(collectItems()));

  let url = "/api/expenses";
  let method = "POST";
  if (id) {
    url += "/" + id;
    method = "PUT";
  } else {
    fd.append("image_path", $("f-image").value);
    fd.append("raw_text", $("f-rawtext").value);
  }

  const res = await fetch(url, { method, body: fd });
  if (!res.ok) {
    alert("保存に失敗しました。");
    return;
  }
  // 保存した支出の月へ移動して表示
  const saved = (await res.json()).expense;
  if (saved && saved.date) currentMonth = new Date(saved.date + "T00:00:00");
  resetForm();
  $("ocr-status").hidden = true;
  renderMonth();
  await refresh();
}

// ---- サマリー --------------------------------------------------------------
async function loadSummary() {
  const res = await fetch("/api/summary?month=" + monthKey(currentMonth));
  const data = await res.json();
  $("summary-total").textContent = yen(data.total);
  $("summary-count").textContent = data.count
    ? `${data.count}件の記録`
    : "記録なし";

  const bars = $("category-bars");
  bars.innerHTML = "";
  const entries = Object.entries(data.by_category).sort((a, b) => b[1] - a[1]);
  const max = entries.length ? entries[0][1] : 0;
  for (const [cat, amt] of entries) {
    const row = document.createElement("div");
    row.className = "cat-row";
    const pct = max ? (amt / max) * 100 : 0;
    row.innerHTML = `
      <span class="cat-name">${escapeHtml(cat)}</span>
      <span class="cat-bar-wrap"><span class="cat-bar" style="width:${pct}%"></span></span>
      <span class="cat-amount">${yen(amt)}</span>`;
    bars.appendChild(row);
  }
}

// ---- 一覧 ------------------------------------------------------------------
async function loadList() {
  const cat = $("filter-category").value;
  let url = "/api/expenses?month=" + monthKey(currentMonth);
  if (cat) url += "&category=" + encodeURIComponent(cat);
  const res = await fetch(url);
  const data = await res.json();
  const list = $("expense-list");
  list.innerHTML = "";
  $("empty-msg").hidden = data.expenses.length > 0;

  for (const e of data.expenses) {
    const item = document.createElement("div");
    item.className = "expense-item";
    const thumb = e.image_path
      ? `<img class="ei-thumb" src="/api/image/${e.image_path}" alt="" />`
      : `<div class="ei-thumb"></div>`;
    item.innerHTML = `
      ${thumb}
      <div class="ei-main">
        <div class="ei-store">${escapeHtml(e.store || "(店名なし)")}</div>
        <div class="ei-meta"><span class="ei-cat">${escapeHtml(e.category)}</span>${e.date}${e.memo ? " · " + escapeHtml(e.memo) : ""}</div>
      </div>
      <div class="ei-amount">${yen(e.amount)}</div>
      <div class="ei-actions">
        <button data-act="edit">✏️</button>
        <button data-act="del">🗑️</button>
      </div>`;
    item.querySelector('[data-act="edit"]').onclick = () => editExpense(e);
    item.querySelector('[data-act="del"]').onclick = () => deleteExpense(e.id);
    list.appendChild(item);
  }
}

function editExpense(e) {
  $("form-title").textContent = "支出を編集";
  $("f-id").value = e.id;
  $("f-date").value = e.date;
  $("f-amount").value = e.amount;
  $("f-store").value = e.store;
  $("f-category").value = e.category;
  $("f-memo").value = e.memo;
  renderItems(e.items || []);
  const preview = $("form-preview");
  if (e.image_path) {
    $("preview-img").src = "/api/image/" + e.image_path;
    preview.hidden = false;
  } else {
    preview.hidden = true;
  }
  $("form-card").scrollIntoView({ behavior: "smooth" });
}

async function deleteExpense(id) {
  if (!confirm("この記録を削除しますか?")) return;
  const res = await fetch("/api/expenses/" + id, { method: "DELETE" });
  if (res.ok) await refresh();
}

// ---- ユーティリティ --------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// 明細を手動追加できるよう、details 内にボタンを差し込む
window.addEventListener("DOMContentLoaded", () => {
  const details = $("items-details");
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "＋ 明細を追加";
  addBtn.style.marginTop = "8px";
  addBtn.onclick = () => addItemRow();
  details.appendChild(addBtn);
  resetForm();
  init();
});
