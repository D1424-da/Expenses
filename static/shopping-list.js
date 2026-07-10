// 買い物リスト — Firestore でリアルタイム同期、ヘッダーにバッジ表示。
import {
  doc, setDoc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { $, escapeHtml, openModal, closeModal } from "./dom-utils.js";
import { log, logErr } from "./log.js";

let _db, _getUser;
let _items = [];   // [{ id, name, done }]
let _unsub = null; // Firestore のリスナー

export function initShoppingList({ db, getUser }) {
  _db = db;
  _getUser = getUser;
  $("shopping-close").onclick       = () => closeModal("shopping-modal");
  $("shopping-btn").onclick         = _open;
  $("shopping-add-form").onsubmit   = _handleAdd;
  $("shopping-clear-done").onclick  = _clearDone;
}

// ログイン後に呼ぶ。ログアウト時は stopSync() で止める。
export function startSync() {
  if (_unsub) return;
  const user = _getUser();
  if (!user) return;
  _unsub = onSnapshot(
    _ref(user.uid),
    (snap) => {
      _items = snap.exists() ? (snap.data().items || []) : [];
      _updateBadge();
      if (!$("shopping-modal").hidden) _render();
    },
    (err) => logErr("買い物リスト購読エラー:", err.message, err),
  );
}

export function stopSync() {
  if (_unsub) { _unsub(); _unsub = null; }
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
  listEl.innerHTML = "";

  if (!_items.length) { emptyEl.hidden = false; return; }
  emptyEl.hidden = true;

  // 店舗別にグループ化（未完了→完了の順、店舗なしは最後）
  const groups = new Map();
  const sorted = [..._items].sort((a, b) => Number(a.done) - Number(b.done));
  for (const item of sorted) {
    const key = item.store || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  // 店舗あり → 名前順 → 店舗なし
  const storeKeys = [...groups.keys()].sort((a, b) => {
    if (!a) return 1; if (!b) return -1;
    return a.localeCompare(b, "ja");
  });

  for (const storeKey of storeKeys) {
    // 店舗ヘッダー
    const header = document.createElement("div");
    header.className = "shopping-store-header";
    header.textContent = storeKey ? `🏪 ${storeKey}` : "🛒 店舗未設定";
    listEl.appendChild(header);

    for (const item of groups.get(storeKey)) {
      const row = document.createElement("div");
      row.className = "shopping-item" + (item.done ? " done" : "");
      row.innerHTML = `
        <label class="shopping-check">
          <input type="checkbox" ${item.done ? "checked" : ""} />
          <span class="shopping-check-name">${escapeHtml(item.name)}</span>
        </label>
        <button class="shopping-del" aria-label="削除" type="button">✕</button>`;
      row.querySelector("input").onchange   = () => _toggle(item.id);
      row.querySelector(".shopping-del").onclick = () => _remove(item.id);
      listEl.appendChild(row);
    }
  }
}

async function _handleAdd(e) {
  e.preventDefault();
  const input = $("shopping-add-input");
  const name  = input.value.trim();
  if (!name) return;
  input.value = "";
  await _persist([...(_items || []), { id: _uid(), name, done: false }]);
}

async function _toggle(id) {
  await _persist(_items.map((it) => it.id === id ? { ...it, done: !it.done } : it));
}

async function _remove(id) {
  await _persist(_items.filter((it) => it.id !== id));
}

async function _clearDone() {
  await _persist(_items.filter((it) => !it.done));
}

async function _persist(items) {
  const user = _getUser();
  if (!user) return;
  try {
    await setDoc(_ref(user.uid), { items });
    // onSnapshot が _items と _updateBadge を自動更新するので手動更新不要
  } catch (err) {
    logErr("買い物リスト保存エラー:", err.message, err);
    alert("保存に失敗しました: " + err.message);
  }
}

function _updateBadge() {
  const count = _items.filter((it) => !it.done).length;
  const badge = $("shopping-badge");
  badge.hidden = count === 0;
  badge.textContent = count > 9 ? "9+" : String(count);
  const badgePc = $("shopping-badge-pc");
  if (badgePc) { badgePc.hidden = count === 0; badgePc.textContent = count > 9 ? "9+" : String(count); }
}

function _ref(uid) {
  return doc(_db, "users", uid, "settings", "shoppingList");
}

function _uid() {
  return Math.random().toString(36).slice(2, 10);
}
