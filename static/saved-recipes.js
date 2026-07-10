// 保存済みレシピの一覧・表示・削除。
import {
  collection, addDoc, getDocs, deleteDoc, doc, orderBy, query, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { $, escapeHtml, openModal, closeModal } from "./dom-utils.js";
import { log, logErr } from "./log.js";

let _db, _getUser;

export function initSavedRecipes({ db, getUser }) {
  _db = db;
  _getUser = getUser;
  $("saved-recipes-close").onclick     = () => closeModal("saved-recipes-modal");
  $("saved-recipes-btn").onclick        = openSavedRecipesModal;
  $("saved-recipe-back").onclick        = _showList;
  $("saved-recipe-detail").hidden       = true;
  $("saved-recipes-list-wrap").hidden   = false;
}

export async function saveRecipe({ title, markdown, items, period, rtype, servings }) {
  const user = _getUser();
  if (!user) return;
  try {
    const col = collection(_db, "users", user.uid, "savedRecipes");
    await addDoc(col, { title, markdown, items: items || [], period, rtype, servings, savedAt: serverTimestamp() });
    log("レシピ保存:", title);
  } catch (err) {
    logErr("レシピ保存エラー:", err.message, err);
    alert("レシピの保存に失敗しました: " + err.message);
  }
}

export function openSavedRecipesModal() {
  _showList();
  openModal("saved-recipes-modal");
  _load();
}

async function _load() {
  const listEl = $("saved-recipes-list");
  const emptyEl = $("saved-recipes-empty");
  listEl.innerHTML = "<p class='empty'>読み込み中…</p>";
  emptyEl.hidden = true;

  const user = _getUser();
  if (!user) return;
  try {
    const q = query(
      collection(_db, "users", user.uid, "savedRecipes"),
      orderBy("savedAt", "desc"),
    );
    const snap = await getDocs(q);
    const recipes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    listEl.innerHTML = "";
    if (!recipes.length) { emptyEl.hidden = false; return; }

    for (const r of recipes) {
      const dateStr = r.savedAt?.toDate?.()?.toLocaleDateString("ja-JP") ?? "";
      const card = document.createElement("div");
      card.className = "saved-recipe-card";
      card.innerHTML = `
        <div class="saved-recipe-head">
          <span class="saved-recipe-title">${escapeHtml(r.title || "無題")}</span>
          <span class="saved-recipe-meta">${escapeHtml(dateStr)}</span>
        </div>
        <div class="saved-recipe-actions">
          <button class="sr-view-btn">レシピを見る</button>
          <button class="sr-del-btn">削除</button>
        </div>`;
      card.querySelector(".sr-view-btn").onclick = () => _showDetail(r);
      card.querySelector(".sr-del-btn").onclick  = () => _delete(r.id, card);
      listEl.appendChild(card);
    }
  } catch (err) {
    logErr("保存済みレシピ読み込みエラー:", err.message, err);
    listEl.innerHTML = "<p class='empty'>読み込みに失敗しました。</p>";
  }
}

function _showDetail(r) {
  const { _markdownToHtml } = window.__recipeHelpers__ || {};
  $("saved-recipe-content").innerHTML = _markdownToHtml
    ? _markdownToHtml(r.markdown || "")
    : `<pre>${escapeHtml(r.markdown || "")}</pre>`;
  $("saved-recipe-title-detail").textContent = r.title || "無題";
  $("saved-recipes-list-wrap").hidden = true;
  $("saved-recipe-detail").hidden     = false;
}

function _showList() {
  $("saved-recipe-detail").hidden     = true;
  $("saved-recipes-list-wrap").hidden = false;
}

async function _delete(id, card) {
  if (!confirm("このレシピを削除しますか？")) return;
  const user = _getUser();
  if (!user) return;
  try {
    await deleteDoc(doc(_db, "users", user.uid, "savedRecipes", id));
    card.remove();
    if (!$("saved-recipes-list").children.length) $("saved-recipes-empty").hidden = false;
  } catch (err) {
    logErr("レシピ削除エラー:", err.message, err);
    alert("削除に失敗しました: " + err.message);
  }
}
