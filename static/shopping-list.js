// 買い物リスト — Firestore でリアルタイム同期、ヘッダーにバッジ表示。
import {
  doc, setDoc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { $, escapeHtml, openModal, closeModal } from "./dom-utils.js";
import {
  splitShoppingItems, summaryLabel, MOVE_DELAY_MS,
} from "./shopping-order.js";
import { dbBase } from "./db-paths.js";
import { log, logErr } from "./log.js";
import { showError } from "./ui-feedback.js";

let _db, _getUser;
let _items = [];   // [{ id, name, done }]
let _unsub = null; // Firestore のリスナー
// チェック直後に元の位置へ留めている品目: id → { prevDone, timer }
// 即座に並び替えると、押し間違えたときに何が動いたのか分からない。
const _pending = new Map();

export function initShoppingList({ db, getUser }) {
  _db = db;
  _getUser = getUser;
  $("shopping-close").onclick       = () => closeModal("shopping-modal");
  $("shopping-btn").onclick         = _open;
  $("shopping-add-form").onsubmit   = _handleAdd;
}

// ログイン後に呼ぶ。ログアウト時は stopSync() で止める。
export function startSync() {
  if (_unsub) return;
  const user = _getUser();
  if (!user) return;
  _unsub = onSnapshot(
    _ref(),
    (snap) => {
      _items = snap.exists() ? (snap.data().items || []) : [];
      _updateBadge();
      _renderIfOpen();
    },
    (err) => logErr("買い物リスト購読エラー:", err.message, err),
  );
}

export function stopSync() {
  if (_unsub) { _unsub(); _unsub = null; }
  // 保留中のタイマーが残ると、ログアウト後に描画を試みて落ちる。
  for (const { timer } of _pending.values()) clearTimeout(timer);
  _pending.clear();
  _items = [];
  _updateBadge();
}

// recipe-view から呼ぶ: 食材リストをリストに追加（重複は除く）
// items: string[] または { name, store? }[] のどちらでも可
export async function addItemsToList(items) {
  const normalized = items.map((it) =>
    typeof it === "string" ? { name: it } : it,
  );
  const existing = new Set(_items.map((it) => it.name));
  const newOnes  = normalized.filter((it) => it.name && !existing.has(it.name));
  if (!newOnes.length) return 0;
  const merged = [
    ..._items,
    ...newOnes.map(({ name, store }) => ({ id: _uid(), name, store: store || "", done: false })),
  ];
  await _persist(merged);
  return newOnes.length;
}

function _open() {
  openModal("shopping-modal");
  _render();
}

function _render() {
  const listEl  = $("shopping-items");
  const emptyEl = $("shopping-empty");
  const countEl = $("shopping-count");
  listEl.innerHTML = "";

  const { pendingItems, doneItems, remaining, doneCount } =
    splitShoppingItems(_items, _pending);

  if (countEl) {
    countEl.textContent = remaining + doneCount > 0
      ? summaryLabel(remaining, doneCount) : "";
  }

  if (!remaining && !doneCount) { emptyEl.hidden = false; return; }
  emptyEl.hidden = true;

  for (const { store, items } of pendingItems) {
    const header = document.createElement("div");
    header.className = "shopping-store-header";
    header.textContent = store ? `🏪 ${store}` : "🛒 店舗未設定";
    listEl.appendChild(header);
    for (const item of items) listEl.appendChild(_row(item));
  }

  if (doneItems.length) {
    const divider = document.createElement("div");
    divider.className = "shopping-done-divider";
    divider.textContent = `カゴに入れた ${doneItems.length}点`;
    listEl.appendChild(divider);
    for (const item of doneItems) listEl.appendChild(_row(item));
  }
}

function _row(item) {
  const row = document.createElement("div");
  row.className = "shopping-item" + (item.done ? " done" : "");
  row.innerHTML = `
    <label class="shopping-check">
      <input type="checkbox" ${item.done ? "checked" : ""} />
      <span class="shopping-check-name">${escapeHtml(item.name)}</span>
    </label>
    <button class="shopping-del" aria-label="${escapeHtml(item.name)}を削除" type="button">✕</button>`;
  row.querySelector("input").onchange       = () => _toggle(item.id, item.done);
  row.querySelector(".shopping-del").onclick = () => _remove(item.id);
  return row;
}

async function _handleAdd(e) {
  e.preventDefault();
  const input = $("shopping-add-input");
  const name  = input.value.trim();
  if (!name) return;
  input.value = "";
  await _persist([...(_items || []), { id: _uid(), name, done: false }]);
}

async function _toggle(id, prevDone) {
  // 位置は MOVE_DELAY_MS のあいだ据え置く。押し間違いに気づく猶予。
  const old = _pending.get(id);
  if (old) clearTimeout(old.timer);
  _pending.set(id, {
    prevDone: old ? old.prevDone : Boolean(prevDone),
    timer: setTimeout(() => { _pending.delete(id); _renderIfOpen(); }, MOVE_DELAY_MS),
  });
  await _persist(_items.map((it) => it.id === id ? { ...it, done: !it.done } : it));
}

function _renderIfOpen() {
  if (!$("shopping-modal").hidden) _render();
}

async function _remove(id) {
  const p = _pending.get(id);
  if (p) { clearTimeout(p.timer); _pending.delete(id); }
  await _persist(_items.filter((it) => it.id !== id));
}

async function _persist(items) {
  const user = _getUser();
  if (!user) return;
  try {
    await setDoc(_ref(), { items });
    // onSnapshot が _items と _updateBadge を自動更新するので手動更新不要
  } catch (err) {
    logErr("買い物リスト保存エラー:", err.message, err);
    showError(err, "保存できませんでした。");
  }
}

function _updateBadge() {
  const count = _items.filter((it) => !it.done).length;
  const text  = count > 9 ? "9+" : String(count);
  // バッジはヘッダ・PCナビ・ボトムナビの3か所にある。個別に取ると
  // 増やしたときに更新漏れが起きるので、クラスでまとめて更新する。
  document.querySelectorAll(".shopping-badge").forEach((el) => {
    el.hidden = count === 0;
    el.textContent = text;
  });
}

function _ref() {
  return doc(_db, ...dbBase(), "settings", "shoppingList");
}

function _uid() {
  return Math.random().toString(36).slice(2, 10);
}
