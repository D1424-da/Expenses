// レシピ提案モーダル。日付モーダルの品目を Gemini に送りレシピを返す。
import { $, openModal, closeModal } from "./dom-utils.js";
import { log, logErr } from "./log.js";
import { OCR_API_BASE } from "./firebase-config.js";

let _getToken;

export function initRecipe({ getToken }) {
  _getToken = getToken;
  $("recipe-close").onclick = () => closeModal("recipe-modal");
  $("recipe-suggest-btn").onclick = _suggest;
}

// items: 食材名の配列。日付モーダルの品目から渡す。
export function openRecipeModal(items) {
  const chips = $("recipe-ingredients");
  chips.innerHTML = items.map((n) => `<span class="recipe-chip">${_esc(n)}</span>`).join("");
  $("recipe-result").hidden = true;
  $("recipe-result").textContent = "";
  $("recipe-status").hidden = true;
  openModal("recipe-modal");
}

async function _suggest() {
  if (!OCR_API_BASE) {
    _showStatus("error", "バックエンドが設定されていません（firebase-config.js の OCR_API_BASE を確認してください）。");
    return;
  }
  const items = [...$("recipe-ingredients").querySelectorAll(".recipe-chip")]
    .map((el) => el.textContent.trim())
    .filter(Boolean);
  if (!items.length) {
    _showStatus("error", "食材が見つかりません。");
    return;
  }
  const servings = Math.max(1, Math.min(20, Number($("recipe-servings").value) || 2));
  const btn = $("recipe-suggest-btn");
  btn.disabled = true;
  _showStatus("loading", "🤖 レシピを考え中…");
  $("recipe-result").hidden = true;

  try {
    const token = _getToken ? await _getToken() : "";
    const res = await fetch(`${OCR_API_BASE}/api/recipe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ items, servings }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(msg || `HTTP ${res.status}`);
    }
    const { recipe } = await res.json();
    log("レシピ提案成功:", items.length, "品目,", servings, "人前");
    $("recipe-status").hidden = true;
    $("recipe-result").textContent = recipe;
    $("recipe-result").hidden = false;
  } catch (err) {
    logErr("レシピ提案エラー:", err.message, err);
    _showStatus("error", "レシピの取得に失敗しました: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

function _showStatus(type, text) {
  const s = $("recipe-status");
  s.className = "status " + type;
  s.textContent = text;
  s.hidden = false;
}

function _esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
