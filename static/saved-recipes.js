// 保存済みレシピの一覧・表示・削除・カテゴリ管理・献立設定。
import {
  collection, addDoc, getDocs, deleteDoc, doc, orderBy, query,
  getDoc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { $, escapeHtml, openModal, closeModal, dayKey } from "./dom-utils.js";
import { dbBase } from "./db-paths.js";
import { log, logErr } from "./log.js";
import { markdownToHtml, extractIngredients } from "./recipe-parse.js";
import { addItemsToList } from "./shopping-list.js";
import { saveMeal } from "./meal-plan.js";
import { showError, showSuccess, showToast } from "./ui-feedback.js";

const DEFAULT_CATEGORIES = ["夕食", "お弁当", "節約", "おやつ"];

let _db, _getUser;
let _currentRecipe = null;
let _categories = [...DEFAULT_CATEGORIES];
let _activeFilter = "すべて";
let _allRecipes = [];

export function initSavedRecipes({ db, getUser }) {
  _db = db;
  _getUser = getUser;
  $("saved-recipes-close").onclick   = () => closeModal("saved-recipes-modal");
  $("saved-recipes-btn").onclick     = openSavedRecipesModal;
  $("saved-recipe-back").onclick     = _showList;
  $("saved-recipe-detail").hidden    = true;
  $("saved-recipes-list-wrap").hidden = false;

  $("saved-recipe-shopping-btn").onclick = _addCurrentToShoppingList;
  $("saved-recipe-plan-btn").onclick     = _openPlanPicker;
  $("saved-recipe-plan-cancel").onclick  = _closePlanPicker;

  $("saved-recipe-plan-picker").querySelectorAll("[data-slot]").forEach((btn) => {
    btn.onclick = () => _confirmMealPlan(btn.dataset.slot);
  });
}

export async function saveRecipe({ title, markdown, items, period, rtype, servings, category }) {
  const user = _getUser();
  if (!user) return;
  try {
    const col = collection(_db, ...dbBase(), "savedRecipes");
    await addDoc(col, {
      title, markdown, items: items || [],
      period, rtype, servings,
      category: category || "",
      savedAt: serverTimestamp(),
    });
    log("レシピ保存:", title);
  } catch (err) {
    logErr("レシピ保存エラー:", err.message, err);
    showError(err, "レシピを保存できませんでした。");
  }
}

export function openSavedRecipesModal() {
  _showList();
  openModal("saved-recipes-modal");
  _loadCategories().then(() => _load());
}

async function _loadCategories() {
  const user = _getUser();
  if (!user) return;
  try {
    const ref = doc(_db, ...dbBase(), "settings", "recipeCategories");
    const snap = await getDoc(ref);
    if (snap.exists() && Array.isArray(snap.data().list)) {
      _categories = snap.data().list;
    } else {
      _categories = [...DEFAULT_CATEGORIES];
    }
  } catch {
    _categories = [...DEFAULT_CATEGORIES];
  }
}

async function _load() {
  const listEl  = $("saved-recipes-list");
  const emptyEl = $("saved-recipes-empty");
  listEl.innerHTML = "<p class='empty'>読み込み中…</p>";
  emptyEl.hidden = true;

  const user = _getUser();
  if (!user) return;
  try {
    const q = query(
      collection(_db, ...dbBase(), "savedRecipes"),
      orderBy("savedAt", "desc"),
    );
    const snap = await getDocs(q);
    _allRecipes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    _renderFilter();
    _renderList();
  } catch (err) {
    logErr("保存済みレシピ読み込みエラー:", err.message, err);
    listEl.innerHTML = "<p class='empty'>読み込みに失敗しました。</p>";
  }
}

function _renderFilter() {
  const el = $("saved-recipes-filter");
  if (!el) return;
  const usedCategories = [...new Set(_allRecipes.map((r) => r.category).filter(Boolean))];
  const tags = ["すべて", ...usedCategories];
  el.innerHTML = tags.map((t) =>
    `<button class="sr-filter-tag${t === _activeFilter ? " active" : ""}" data-cat="${escapeHtml(t)}">${escapeHtml(t)}</button>`,
  ).join("");
  el.querySelectorAll(".sr-filter-tag").forEach((btn) => {
    btn.onclick = () => {
      _activeFilter = btn.dataset.cat;
      _renderFilter();
      _renderList();
    };
  });
}

function _renderList() {
  const listEl  = $("saved-recipes-list");
  const emptyEl = $("saved-recipes-empty");
  const filtered = _activeFilter === "すべて"
    ? _allRecipes
    : _allRecipes.filter((r) => (r.category || "") === _activeFilter);

  listEl.innerHTML = "";
  if (!filtered.length) { emptyEl.hidden = false; return; }
  emptyEl.hidden = true;

  for (const r of filtered) {
    const dateStr = r.savedAt?.toDate?.()?.toLocaleDateString("ja-JP") ?? "";
    const card = document.createElement("div");
    card.className = "saved-recipe-card";
    card.innerHTML = `
      <div class="saved-recipe-head">
        <span class="saved-recipe-title">${escapeHtml(r.title || "無題")}</span>
        <span class="saved-recipe-meta">${r.category ? `<span class="sr-category-tag">${escapeHtml(r.category)}</span>` : ""}${escapeHtml(dateStr)}</span>
      </div>
      <div class="saved-recipe-actions">
        <button class="sr-view-btn">レシピを見る</button>
        <button class="sr-del-btn">削除</button>
      </div>`;
    card.querySelector(".sr-view-btn").onclick = () => _showDetail(r);
    card.querySelector(".sr-del-btn").onclick  = () => _delete(r.id, card);
    listEl.appendChild(card);
  }
}

function _showDetail(r) {
  _currentRecipe = r;
  $("saved-recipe-content").innerHTML = markdownToHtml(r.markdown || "");
  $("saved-recipe-title-detail").textContent = r.title || "無題";
  $("saved-recipe-shopping-btn").textContent = "🛒 買い物リストに追加";
  $("saved-recipes-list-wrap").hidden  = true;
  $("saved-recipe-detail").hidden      = false;
  $("saved-recipe-plan-picker").hidden = true;

  // 献立設定の日付を今日に初期化
  const today = dayKey(new Date());
  $("saved-recipe-plan-date").value = today;
}

async function _addCurrentToShoppingList() {
  if (!_currentRecipe) return;
  const btn = $("saved-recipe-shopping-btn");
  btn.disabled = true;
  try {
    const { _attachStores } = window.__recipeHelpers__ || {};
    let names = extractIngredients(_currentRecipe.markdown || "");
    if (!names.length) names = _currentRecipe.items || [];
    if (!names.length) {
      btn.textContent = "⚠️ 食材が見つかりません";
      setTimeout(() => { btn.textContent = "🛒 買い物リストに追加"; btn.disabled = false; }, 2000);
      return;
    }
    const itemsWithStore = _attachStores ? await _attachStores(names) : names;
    const added = await addItemsToList(itemsWithStore);
    btn.textContent = `✅ ${added}品目を追加しました`;
    setTimeout(() => { btn.textContent = "🛒 買い物リストに追加"; }, 2500);
  } catch (err) {
    logErr("買い物リスト追加エラー:", err.message, err);
    btn.textContent = "⚠️ 追加に失敗しました";
    setTimeout(() => { btn.textContent = "🛒 買い物リストに追加"; }, 2000);
  } finally {
    btn.disabled = false;
  }
}

function _openPlanPicker() {
  $("saved-recipe-plan-picker").hidden = false;
}

function _closePlanPicker() {
  $("saved-recipe-plan-picker").hidden = true;
}

async function _confirmMealPlan(slot) {
  if (!_currentRecipe) return;
  const date = $("saved-recipe-plan-date").value;
  if (!date) { showToast("日付を選択してください。", "error"); return; }
  const btn = $("saved-recipe-plan-picker").querySelector(`[data-slot="${slot}"]`);
  if (btn) btn.disabled = true;
  try {
    await saveMeal(date, slot, _currentRecipe.title, _currentRecipe.markdown);
    _closePlanPicker();
    const slots = { 朝食: "🌅", お弁当: "🍱", 夕食: "🌙" };
    showSuccess(`${date} の${slot}に「${_currentRecipe.title}」を設定しました。`);
  } catch (err) {
    logErr("献立設定エラー:", err.message, err);
    showError(err, "献立を設定できませんでした。");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function _showList() {
  $("saved-recipe-detail").hidden      = true;
  $("saved-recipe-plan-picker").hidden = true;
  $("saved-recipes-list-wrap").hidden  = false;
}

async function _delete(id, card) {
  if (!confirm("このレシピを削除しますか？")) return;
  const user = _getUser();
  if (!user) return;
  try {
    await deleteDoc(doc(_db, ...dbBase(), "savedRecipes", id));
    _allRecipes = _allRecipes.filter((r) => r.id !== id);
    card.remove();
    _renderFilter();
    if (!$("saved-recipes-list").children.length) $("saved-recipes-empty").hidden = false;
  } catch (err) {
    logErr("レシピ削除エラー:", err.message, err);
    showError(err, "削除できませんでした。");
  }
}
