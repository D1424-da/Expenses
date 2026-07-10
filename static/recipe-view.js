// レシピ提案モーダル。期間（今日/今週/今月）と種別（1食分/週間献立）を選んでGeminiに送る。
import { $, escapeHtml, dayKey, openModal, closeModal } from "./dom-utils.js";
import { log, logErr } from "./log.js";
import { OCR_API_BASE } from "./firebase-config.js";

let _getToken;
let _selectedDay = null;  // "YYYY-MM-DD"
let _expenses = [];       // 当月の全支出（Firestore購読分）
let _activePeriod = "day";
let _activeType = "meal";

export function initRecipe({ getToken }) {
  _getToken = getToken;
  $("recipe-close").onclick = () => closeModal("recipe-modal");
  $("recipe-suggest-btn").onclick = _suggest;

  // 期間タブ
  $("recipe-period-tabs").querySelectorAll(".recipe-tab").forEach((btn) => {
    btn.onclick = () => {
      _activePeriod = btn.dataset.period;
      _setActiveTab("recipe-period-tabs", btn);
      _renderIngredients();
    };
  });

  // 種別タブ
  $("recipe-type-tabs").querySelectorAll(".recipe-tab").forEach((btn) => {
    btn.onclick = () => {
      _activeType = btn.dataset.rtype;
      _setActiveTab("recipe-type-tabs", btn);
    };
  });
}

/**
 * @param {object} opts
 * @param {string}   opts.selectedDay   - "YYYY-MM-DD"（どの日から開いたか）
 * @param {Array}    opts.expenses       - 当月全支出（Firestore購読済み）
 * @param {string}  [opts.initialPeriod] - "day"|"week"|"month"（デフォルト "day"）
 */
export function openRecipeModal({ selectedDay, expenses, initialPeriod = "day" }) {
  _selectedDay = selectedDay;
  _expenses = expenses || [];
  _activePeriod = initialPeriod;
  _activeType = "meal";

  // タブ初期状態
  _setActiveTabByValue("recipe-period-tabs", "data-period", _activePeriod);
  _setActiveTabByValue("recipe-type-tabs", "data-rtype", _activeType);

  $("recipe-result").hidden = true;
  $("recipe-result").textContent = "";
  $("recipe-status").hidden = true;
  $("recipe-servings").value = "2";

  _renderIngredients();
  openModal("recipe-modal");
}

// 選択期間の食材チップを描画する
function _renderIngredients() {
  const items = _itemsForPeriod(_activePeriod);
  const unique = [...new Set(items)];
  const chips = $("recipe-ingredients");
  if (unique.length === 0) {
    chips.innerHTML = `<span class="recipe-empty-hint">この期間に明細品目がありません</span>`;
  } else {
    chips.innerHTML = unique.map((n) => `<span class="recipe-chip">${escapeHtml(n)}</span>`).join("");
  }
  // 期間ラベルを反映
  const periodLabel = { day: "今日", week: "今週", month: "今月" }[_activePeriod] || "";
  $("recipe-modal-title").textContent = `🍳 レシピ提案（${periodLabel}）`;
  // 前回の結果をリセット
  $("recipe-result").hidden = true;
  $("recipe-status").hidden = true;
}

// 期間に応じて食材名リストを返す
function _itemsForPeriod(period) {
  return _filterExpensesByPeriod(period)
    .flatMap((e) => (e.items || []).map((it) => it.name).filter(Boolean));
}

function _filterExpensesByPeriod(period) {
  if (!_selectedDay) return [];
  if (period === "day") return _expenses.filter((e) => e.date === _selectedDay);
  if (period === "week") {
    const { start, end } = _weekRange(_selectedDay);
    return _expenses.filter((e) => e.date && e.date >= start && e.date <= end);
  }
  // "month": 当月全件（Firestoreがすでに絞り込み済み）
  return _expenses;
}

// _selectedDay を含む日〜土の範囲を返す
function _weekRange(dayStr) {
  const d = new Date(dayStr + "T00:00:00");
  const dow = d.getDay();
  const sun = new Date(d); sun.setDate(d.getDate() - dow);
  const sat = new Date(d); sat.setDate(d.getDate() + (6 - dow));
  return { start: dayKey(sun), end: dayKey(sat) };
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
    _showStatus("error", "食材が見つかりません。期間を変更するか、明細付きのレシートを保存してください。");
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
      body: JSON.stringify({ items, servings, recipe_type: _activeType }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(msg || `HTTP ${res.status}`);
    }
    const { recipe } = await res.json();
    if (!recipe || !recipe.trim()) {
      _showStatus("error", "レシピを取得できませんでした。食材を変えて再試行してください。");
      return;
    }
    log("レシピ提案成功:", items.length, "品目,", servings, "人前,", _activeType);
    $("recipe-status").hidden = true;
    const result = $("recipe-result");
    result.innerHTML = _markdownToHtml(recipe);
    result.hidden = false;
  } catch (err) {
    logErr("レシピ提案エラー:", err.message, err);
    _showStatus("error", "レシピの取得に失敗しました: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// Markdown → HTML 変換（見出し・太字・番号リスト・箇条書き）。
// <li> は必ず <ol>/<ul> で囲む（囲みなしだとブラウザでマーカーが表示されない）。
function _markdownToHtml(md) {
  const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const lines = md.split("\n");
  const out = [];
  let listTag = ""; // 現在開いているリストタグ ("ol"|"ul"|"")

  const closeList = () => { if (listTag) { out.push(`</${listTag}>`); listTag = ""; } };

  for (const raw of lines) {
    const line = escapeHtml(raw);
    let m;
    if ((m = line.match(/^## (.+)$/))) {
      closeList();
      out.push(`<h3>${bold(m[1])}</h3>`);
    } else if ((m = line.match(/^### (.+)$/))) {
      closeList();
      out.push(`<h4>${bold(m[1])}</h4>`);
    } else if ((m = line.match(/^(\d+)\. (.+)$/))) {
      if (listTag !== "ol") { closeList(); out.push("<ol>"); listTag = "ol"; }
      out.push(`<li>${bold(m[2])}</li>`);
    } else if ((m = line.match(/^- (.+)$/))) {
      if (listTag !== "ul") { closeList(); out.push("<ul>"); listTag = "ul"; }
      out.push(`<li>${bold(m[1])}</li>`);
    } else if (line.trim()) {
      closeList();
      out.push(`<p>${bold(line)}</p>`);
    } else {
      closeList();
    }
  }
  closeList();
  return out.join("\n");
}

function _setActiveTab(containerId, activeBtn) {
  $(containerId).querySelectorAll(".recipe-tab").forEach((b) => b.classList.remove("active"));
  activeBtn.classList.add("active");
}

function _setActiveTabByValue(containerId, attr, value) {
  $(containerId).querySelectorAll(".recipe-tab").forEach((b) => {
    b.classList.toggle("active", b.getAttribute(attr) === value);
  });
}

function _showStatus(type, text) {
  const s = $("recipe-status");
  s.className = "status " + type;
  s.textContent = text;
  s.hidden = false;
}

