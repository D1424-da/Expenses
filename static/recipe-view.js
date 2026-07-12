// レシピ提案モーダル。期間・種別・時短・使い切りを選んでGeminiに送る。
import { $, escapeHtml, yen, dayKey, openModal, closeModal } from "./dom-utils.js";
import { log, logErr } from "./log.js";
import { OCR_API_BASE } from "./firebase-config.js";
import { saveRecipe } from "./saved-recipes.js";
import { addItemsToList } from "./shopping-list.js";
import { saveMealPlan, saveMeal } from "./meal-plan.js";

let _getToken;
let _fetchAllExpenses;
let _getBudget;
let _expensesCache = null; // レシピモーダル1セッション中のキャッシュ
let _selectedDay = null;
let _expenses    = [];
let _periodFrom  = "";   // "YYYY-MM-DD" 食材購入期間：開始
let _periodTo    = "";   // "YYYY-MM-DD" 食材購入期間：終了
let _activePeriod  = "day"; // 期間ショートカット（予算モードの除数計算に使用）
let _activeType    = "meal";
let _maxMinutes    = 0;    // 0 = 気にしない
let _useUp         = false;
let _lastMarkdown  = "";
let _lastItems     = [];
let _lastServings  = 2;
let _selectResult  = null; // { 朝食: [{title,markdown},...], 昼食: [...], 夕食: [...] }
let _selectChosen  = { 朝食: 0, 昼食: 0, 夕食: 0 };
let _budgetMode        = false;
let _budgetSelectedItems = []; // { name, estimatedPrice }
let _budgetRemaining   = 0;

const _FAM_FIELDS = [
  { id: "fam-adults-m",   key: "adults_m" },
  { id: "fam-adults-f",   key: "adults_f" },
  { id: "fam-toddlers",   key: "toddlers" },
  { id: "fam-elementary", key: "elementary" },
  { id: "fam-junior-high",key: "junior_high" },
];

function _loadFamily() {
  try { return JSON.parse(localStorage.getItem("recipe_family") || "{}"); } catch { return {}; }
}
function _saveFamily() {
  const obj = {};
  _FAM_FIELDS.forEach(({ id, key }) => { obj[key] = Number($(id).value) || 0; });
  localStorage.setItem("recipe_family", JSON.stringify(obj));
  return obj;
}
function _restoreFamily() {
  const saved = _loadFamily();
  _FAM_FIELDS.forEach(({ id, key }) => { $(id).value = saved[key] ?? 0; });
}
function _hasFamily() {
  return _FAM_FIELDS.some(({ id }) => Number($(id).value) > 0);
}

export function clearExpensesCache() {
  _expensesCache = null;
}

export function initRecipe({ getToken, fetchAllExpenses, getBudget }) {
  _getToken = getToken;
  _fetchAllExpenses = fetchAllExpenses;
  _getBudget = getBudget;
  $("recipe-close").onclick       = () => closeModal("recipe-modal");
  $("recipe-suggest-btn").onclick = _suggest;

  // 家族構成トグル
  $("family-toggle").onclick = () => {
    const panel = $("family-panel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) _restoreFamily();
  };
  // 家族構成の各フィールドが変わったら自動保存
  _FAM_FIELDS.forEach(({ id }) => {
    $(id).addEventListener("change", () => { _saveFamily(); _updateFamilyToggleLabel(); });
  });

  // 食材選択モードタブ（購入履歴 / 予算から）
  $("recipe-mode-tabs").querySelectorAll(".recipe-tab").forEach((btn) => {
    btn.onclick = () => {
      _budgetMode = btn.dataset.mode === "budget";
      _setActiveTab("recipe-mode-tabs", btn);
      $("recipe-period-label").textContent = _budgetMode ? "残り予算の計算対象" : "食材の購入期間";
      $("recipe-budget-info").hidden = !_budgetMode;
      if (_budgetMode) _renderBudgetIngredients(); else _renderIngredients();
    };
  });
  // 期間タブ（ショートカット — 日付入力を自動設定する）
  $("recipe-period-tabs").querySelectorAll(".recipe-tab").forEach((btn) => {
    btn.onclick = () => {
      _applyPeriodShortcut(btn.dataset.period);
      _setActiveTab("recipe-period-tabs", btn);
      if (_budgetMode) _renderBudgetIngredients(); else _renderIngredients();
    };
  });
  // 日付範囲入力（手入力でも反映）
  $("recipe-date-from").addEventListener("change", (e) => {
    _periodFrom = e.target.value;
    if (_periodTo < _periodFrom) { _periodTo = _periodFrom; $("recipe-date-to").value = _periodTo; }
    if (_budgetMode) _renderBudgetIngredients(); else _renderIngredients();
  });
  $("recipe-date-to").addEventListener("change", (e) => {
    _periodTo = e.target.value;
    if (_periodFrom > _periodTo) { _periodFrom = _periodTo; $("recipe-date-from").value = _periodFrom; }
    if (_budgetMode) _renderBudgetIngredients(); else _renderIngredients();
  });
  // 種別タブ
  $("recipe-type-tabs").querySelectorAll(".recipe-tab").forEach((btn) => {
    btn.onclick = () => {
      _activeType = btn.dataset.rtype;
      _setActiveTab("recipe-type-tabs", btn);
      $("recipe-plan-start-row").hidden = _activeType !== "weekly";
      $("recipe-select-picker").hidden = true;
      _renderIngredients();
    };
  });
  // 時短タブ
  $("recipe-time-tabs").querySelectorAll(".recipe-tab").forEach((btn) => {
    btn.onclick = () => { _maxMinutes = Number(btn.dataset.minutes); _setActiveTab("recipe-time-tabs", btn); };
  });
  // 使い切りチェックボックス
  $("recipe-useup").addEventListener("change", (e) => { _useUp = e.target.checked; });

  // 保存ボタン → 料理選択パネルを表示
  $("recipe-save-btn").onclick = () => _showDishSelector();

  // 買い物リスト追加ボタン → 店名付きで追加
  $("recipe-shopping-btn").onclick = async () => {
    const btn = $("recipe-shopping-btn");
    btn.disabled = true;
    try {
      const ingredients = _extractIngredients(_lastMarkdown);
      const names = ingredients.length ? ingredients : _lastItems;
      const itemsWithStore = await _attachStores(names);
      const added = await addItemsToList(itemsWithStore);
      btn.textContent = `✅ ${added}品目を追加`;
      setTimeout(() => { btn.textContent = "🛒 リストに追加"; }, 3000);
    } catch (err) {
      logErr("買い物リスト追加エラー:", err.message, err);
      alert("買い物リストへの追加に失敗しました: " + err.message);
    } finally {
      btn.disabled = false;
    }
  };

  // 料理選択パネルの「保存」ボタン
  $("recipe-dish-save-btn").onclick = _saveDishSelection;
  $("recipe-dish-cancel-btn").onclick = _hideDishSelector;

  // カレンダーに反映ボタン
  $("recipe-calendar-btn").onclick = _exportToCalendar;

  // 朝・昼・夜 選択UI のアクションボタン
  $("recipe-select-calendar-btn").onclick = _selectConfirmCalendar;
  $("recipe-select-save-btn").onclick = _selectConfirmSave;

  // 食事スロット選択パネル（1食分をカレンダーに追加するとき）
  $("recipe-meal-slot-cancel").onclick = () => {
    $("recipe-meal-slot-picker").hidden = true;
    $("recipe-post-actions").hidden = false;
  };
  $("recipe-meal-slot-picker").querySelectorAll("[data-slot]").forEach((btn) => {
    btn.onclick = () => _saveMealSlot(btn.dataset.slot);
  });

  // saved-recipes.js からレシピのヘルパー関数を参照できるようにする
  window.__recipeHelpers__ = { _markdownToHtml, _extractIngredients, _attachStores };
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
  _activeType = "meal";

  // 期間ショートカット初期値を設定（日付入力も連動）
  _applyPeriodShortcut(initialPeriod);
  _setActiveTabByValue("recipe-period-tabs", "data-period", initialPeriod);
  _setActiveTabByValue("recipe-type-tabs", "data-rtype", _activeType);

  // 週間献立開始日を選択日に初期化
  $("recipe-plan-start").value = selectedDay || "";
  $("recipe-plan-start-row").hidden = true;

  _budgetMode = false;
  _budgetSelectedItems = [];
  _setActiveTabByValue("recipe-mode-tabs", "data-mode", "history");
  $("recipe-period-label").textContent = "食材の購入期間";
  $("recipe-budget-info").hidden = true;

  _lastMarkdown = "";
  _lastItems = [];
  _selectResult = null;
  _selectChosen = { 朝食: 0, 昼食: 0, 夕食: 0 };
  $("recipe-result").hidden = true;
  $("recipe-result").innerHTML = "";
  $("recipe-status").hidden = true;
  $("recipe-post-actions").hidden = true;
  $("recipe-select-picker").hidden = true;
  $("recipe-dish-selector").hidden = true;
  $("recipe-save-btn").textContent = "📚 保存";
  $("recipe-shopping-btn").textContent = "🛒 リストに追加";
  $("recipe-calendar-btn").textContent = "📅 カレンダーに追加";
  $("recipe-calendar-btn").hidden = true;
  $("recipe-meal-slot-picker").hidden = true;
  // 前回使った人数を復元（なければ2）
  $("recipe-servings").value = localStorage.getItem("recipe_servings") || "2";
  // 時短タブ・使い切りをリセット
  _maxMinutes = 0;
  _useUp = false;
  $("recipe-useup").checked = false;
  _setActiveTabByValue("recipe-time-tabs", "data-minutes", "0");

  _restoreFamily();
  _updateFamilyToggleLabel();
  _renderIngredients();
  openModal("recipe-modal");

  // バックエンドがスリープしている場合に備えてウォームアップする
  if (OCR_API_BASE) {
    fetch(`${OCR_API_BASE}/api/health`, { cache: "no-store" })
      .then((r) => r.json().catch(() => ({})))
      .then((h) => log("レシピバックエンド稼働:", h.status || "ok"))
      .catch((err) => log("レシピバックエンド ウォームアップ:", err.message));
  }
}

function _updateFamilyToggleLabel() {
  const btn = $("family-toggle");
  if (_hasFamily()) {
    const saved = _loadFamily();
    const parts = [];
    if (saved.adults_m)   parts.push(`男${saved.adults_m}`);
    if (saved.adults_f)   parts.push(`女${saved.adults_f}`);
    if (saved.toddlers)   parts.push(`幼児${saved.toddlers}`);
    if (saved.elementary) parts.push(`小学生${saved.elementary}`);
    if (saved.junior_high)parts.push(`中高生${saved.junior_high}`);
    btn.textContent = `👨‍👩‍👧 家族構成: ${parts.join("・")}人`;
    btn.classList.add("active");
  } else {
    btn.textContent = "👨‍👩‍👧 家族構成を設定（より最適なレシピになります）";
    btn.classList.remove("active");
  }
}

// 期間ショートカット（今日/今週/今月）をクリックしたとき日付入力に反映する。
function _applyPeriodShortcut(period) {
  if (!_selectedDay) return;
  let from, to;
  if (period === "day") {
    from = to = _selectedDay;
  } else if (period === "week") {
    const d = new Date(_selectedDay + "T00:00:00");
    const dow = d.getDay();
    const sun = new Date(d); sun.setDate(d.getDate() - dow);
    const sat = new Date(d); sat.setDate(d.getDate() + (6 - dow));
    from = dayKey(sun); to = dayKey(sat);
  } else { // month
    const d = new Date(_selectedDay + "T00:00:00");
    const y = d.getFullYear(), m = d.getMonth();
    from = `${y}-${String(m + 1).padStart(2, "0")}-01`;
    to   = dayKey(new Date(y, m + 1, 0));
  }
  _periodFrom = from;
  _periodTo   = to;
  _activePeriod = period;
  $("recipe-date-from").value = from;
  $("recipe-date-to").value   = to;
}

// _periodFrom〜_periodTo に含まれる支出を返す。
function _filterExpenses() {
  if (!_periodFrom || !_periodTo) return [];
  return _expenses.filter((e) => e.date && e.date >= _periodFrom && e.date <= _periodTo);
}

// 選択期間の食材チップを描画する。
function _renderIngredients() {
  const items = _itemsForPeriod();
  const unique = [...new Set(items)];
  const chips = $("recipe-ingredients");
  if (unique.length === 0) {
    chips.innerHTML = `<span class="recipe-empty-hint">この期間に明細品目がありません。期間を変更するか、「＋ 明細を追加」でレシートに品目を登録してください。</span>`;
  } else {
    chips.innerHTML = unique.map((n) => `<span class="recipe-chip">${escapeHtml(n)}</span>`).join("");
  }
  const label = _periodFrom === _periodTo ? _periodFrom : `${_periodFrom}〜${_periodTo}`;
  $("recipe-modal-title").textContent = `🍳 レシピ提案（${label}）`;
  $("recipe-result").hidden = true;
  $("recipe-status").hidden = true;
}

function _itemsForPeriod() {
  return _filterExpenses()
    .flatMap((e) => (e.items || []).map((it) => {
      if (!it.name || it.name.length < 1) return null;
      // 数量・単位がある場合は "牛肉 300g" "たまご 6個" 形式でAPIに渡す（精度向上）
      if (it.qty != null && it.unit) return `${it.name} ${it.qty}${it.unit}`;
      if (it.qty != null) return `${it.name} ×${it.qty}`;
      return it.name;
    }).filter(Boolean));
}

async function _suggest() {
  if (!OCR_API_BASE) {
    _showStatus("error", "バックエンドが設定されていません（firebase-config.js の OCR_API_BASE を確認してください）。");
    return;
  }
  const items = [...$("recipe-ingredients").querySelectorAll(".recipe-chip")]
    .map((el) => el.dataset.name || el.textContent.trim())
    .filter(Boolean);
  if (!items.length) {
    _showStatus("error", "食材が見つかりません。期間を変更するか、明細付きのレシートを保存してください。");
    return;
  }
  const itemLimit = _activeType === "select" ? 15 : 50;
  const cappedItems = items.length > itemLimit ? items.slice(0, itemLimit) : items;
  if (items.length > itemLimit) log(`食材が${items.length}品あるため上位${itemLimit}品に絞りました`);
  const servings = Math.max(1, Math.min(20, Number($("recipe-servings").value) || 2));
  const btn = $("recipe-suggest-btn");
  btn.disabled = true;
  _showStatus("loading", "🤖 レシピを考え中…");
  $("recipe-result").hidden = true;
  $("recipe-dish-selector").hidden = true;

  try {
    const token = _getToken ? await _getToken() : "";
    const body = JSON.stringify({
      items: cappedItems,
      servings,
      recipe_type: _activeType,
      max_minutes: _maxMinutes || null,
      use_up: _useUp,
      family: _hasFamily() ? _saveFamily() : null,
    });
    const headers = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    let res;
    try {
      res = await fetch(`${OCR_API_BASE}/api/recipe`, { method: "POST", headers, body });
    } catch (fetchErr) {
      // 接続エラー（サーバースリープ中など）— 最大30秒待ってリトライ
      log("レシピバックエンド接続エラー、再試行中:", fetchErr.message);
      _showStatus("loading", "⏳ バックエンドを起動中です…（初回は30秒ほどかかる場合があります）");
      await new Promise((r) => setTimeout(r, 15000));
      res = await fetch(`${OCR_API_BASE}/api/recipe`, { method: "POST", headers, body });
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      logErr("レシピAPI HTTPエラー:", res.status, raw);
      // FastAPI は {"detail": "..."} 形式でエラーを返す
      let detail = raw;
      try { detail = JSON.parse(raw)?.detail || raw; } catch { /* raw のまま */ }
      detail = String(detail).replace(/<[^>]*>/g, "").trim().slice(0, 300);
      if (res.status === 401 || res.status === 403) {
        throw new Error("認証エラーです。一度ログアウトして再ログインしてください。");
      }
      if (res.status === 503 && detail.includes("GEMINI_API_KEY")) {
        throw new Error("レシピ機能のAPIキーがバックエンドに設定されていません（Render の環境変数 GEMINI_API_KEY を確認してください）。");
      }
      throw new Error(`HTTP ${res.status}${detail ? " — " + detail : ""}`);
    }
    const { recipe } = await res.json();
    if (!recipe || !recipe.trim()) {
      _showStatus("error", "レシピを取得できませんでした。食材を変えて再試行してください。");
      return;
    }
    log("レシピ提案成功:", items.length, "品目,", servings, "人前,", _activeType);
    _lastMarkdown = recipe;
    _lastItems    = items;
    _lastServings = servings;
    localStorage.setItem("recipe_servings", servings);
    $("recipe-status").hidden = true;

    if (_activeType === "select") {
      _selectResult = _parseSelectResult(recipe);
      _selectChosen = { 朝食: 0, 昼食: 0, 夕食: 0 };
      _renderSelectPicker();
      $("recipe-select-picker").hidden = false;
    } else {
      const result = $("recipe-result");
      result.innerHTML = _markdownToHtml(recipe);
      result.hidden = false;
      $("recipe-post-actions").hidden = false;
      $("recipe-calendar-btn").hidden = false;
      $("recipe-calendar-btn").textContent =
        _activeType === "weekly" ? "📅 カレンダーに反映" : "📅 カレンダーに追加";
    }
  } catch (err) {
    logErr("レシピ提案エラー:", err.message, err);
    // 接続エラーの場合はコールドスタートを疑う
    const isNetworkErr = err.message.includes("fetch") || err.message.includes("network") || err.message.includes("Network");
    const hint = isNetworkErr ? "\n\n（バックエンドが起動中の場合は30秒ほど待ってから再試行してください）" : "";
    _showStatus("error", `レシピの取得に失敗しました。\n${err.message}${hint}`);
  } finally {
    btn.disabled = false;
  }
}

// ---- 料理選択パネル -------------------------------------------------------

// markdownから個別料理を抽出する。
// meal型: ## 見出し, weekly型: ### 見出し をそれぞれ1料理として扱う
function _extractDishes(md, rtype) {
  const headingRe = rtype === "weekly" ? /^### (.+)$/gm : /^## (.+)$/gm;
  const dishes = [];
  let match;
  while ((match = headingRe.exec(md)) !== null) {
    const title = match[1].replace(/\*\*/g, "").trim();
    dishes.push({ title, start: match.index });
  }
  // 各料理の本文を切り出す
  return dishes.map((d, i) => {
    const end = i + 1 < dishes.length ? dishes[i + 1].start : md.length;
    return { title: d.title, markdown: md.slice(d.start, end).trim() };
  });
}

async function _showDishSelector() {
  const dishes = _extractDishes(_lastMarkdown, _activeType);
  if (dishes.length <= 1) {
    await _doSave([{ title: _extractTitle(_lastMarkdown), markdown: _lastMarkdown }]);
    return;
  }
  const list = $("recipe-dish-list");
  list.innerHTML = dishes.map((d, i) =>
    `<label class="dish-select-row">
      <input type="checkbox" data-idx="${i}" checked />
      <span>${escapeHtml(d.title)}</span>
    </label>`,
  ).join("");
  list.dataset.dishes = JSON.stringify(dishes.map((d) => d.title));
  $("recipe-dish-selector").hidden = false;
  $("recipe-post-actions").hidden = true;
}

function _hideDishSelector() {
  $("recipe-dish-selector").hidden = true;
  $("recipe-post-actions").hidden = false;
}

async function _saveDishSelection() {
  const checkboxes = [...$("recipe-dish-list").querySelectorAll("input[type='checkbox']")];
  const dishes = _extractDishes(_lastMarkdown, _activeType);
  const selected = checkboxes
    .map((cb, i) => ({ checked: cb.checked, dish: dishes[i] }))
    .filter((x) => x.checked && x.dish)
    .map((x) => x.dish);
  if (!selected.length) {
    alert("保存する料理を選んでください。");
    return;
  }
  await _doSave(selected);
  _hideDishSelector();
}

async function _doSave(dishes) {
  const btn = $("recipe-save-btn");
  btn.disabled = true;
  try {
    for (const d of dishes) {
      // 料理ごとの食材を抽出。見つからなければ期間の食材チップにフォールバック
      const dishItems = _extractIngredients(d.markdown);
      await saveRecipe({
        title: d.title,
        markdown: d.markdown,
        items: dishItems.length ? dishItems : _lastItems,
        period: _activePeriod,
        rtype: _activeType,
        servings: _lastServings,
      });
    }
    btn.textContent = `✅ ${dishes.length}品を保存しました`;
    setTimeout(() => { btn.textContent = "📚 保存"; }, 2500);
  } finally {
    btn.disabled = false;
  }
}

// ---- 店名付き買い物リスト追加 --------------------------------------------

// 過去の購入履歴から各食材の最安値の店名を返す
async function _attachStores(names) {
  try {
    if (!_fetchAllExpenses) return names.map((n) => ({ name: n }));
    _expensesCache = _expensesCache ?? await _fetchAllExpenses();
    const all = _expensesCache;
    // 食材名 → { store, minPrice }
    const priceMap = new Map();
    for (const exp of all) {
      if (!exp.store || !exp.items) continue;
      for (const it of exp.items) {
        if (!it.name || it.price == null) continue;
        const key = it.name;
        const cur = priceMap.get(key);
        if (!cur || it.price < cur.price) {
          priceMap.set(key, { store: exp.store, price: it.price });
        }
      }
    }
    return names.map((n) => {
      const hit = priceMap.get(n);
      return { name: n, store: hit?.store || "" };
    });
  } catch (err) {
    logErr("店名付きリスト取得エラー:", err.message, err);
    return names.map((n) => ({ name: n }));
  }
}

// Markdown → HTML 変換（見出し・太字・番号リスト・箇条書き）。
// <li> は必ず <ol>/<ul> で囲む（囲みなしだとブラウザでマーカーが表示されない）。
// **難易度**: ★★☆ 行は専用バッジに変換する。
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
    } else if ((m = line.match(/^\*\*難易度\*\*[：:]\s*(.+)$/))) {
      // ★の数で色を変える
      closeList();
      const stars = m[1].trim();
      const level = (stars.match(/★/g) || []).length;
      const cls = level === 1 ? "diff-easy" : level === 2 ? "diff-mid" : "diff-hard";
      out.push(`<div class="recipe-difficulty"><span class="diff-badge ${cls}">${stars}</span> 難易度</div>`);
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

// Markdown から最初の ## 見出しをタイトルとして取り出す
function _extractTitle(md) {
  const m = md.match(/^##\s+(.+)$/m);
  return m ? m[1].replace(/\*\*/g, "").trim() : "レシピ";
}

// Markdown の「**使う食材**:」行から食材名を抽出（量の表記は除去）
function _extractIngredients(md) {
  const items = [];
  const rx = /\*\*使う食材\*\*[：:]\s*([^\n]+)/g;
  let m;
  while ((m = rx.exec(md)) !== null) {
    m[1].split(/[、，,]/).forEach((raw) => {
      const name = raw
        .replace(/\s*[\d一二三四五六七八九十百]+\s*[gGkKmlg個本枚杯食片束パック袋缶大小さじtsp]+[程度くらい以上以下]*\s*/g, "")
        .replace(/\*\*/g, "")
        .trim();
      if (name.length >= 1) items.push(name);
    });
  }
  return [...new Set(items)];
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

// ---- 予算モード：過去購入履歴から予算内食材を自動選択 -------------------------

async function _renderBudgetIngredients() {
  const chips = $("recipe-ingredients");
  chips.innerHTML = `<span class="recipe-empty-hint">💰 予算内の食材を計算中…</span>`;
  $("recipe-budget-status").textContent = "";
  $("recipe-budget-total").textContent  = "";
  const _budgetPeriodLabel = _periodFrom === _periodTo ? _periodFrom : `${_periodFrom}〜${_periodTo}`;
  $("recipe-modal-title").textContent = `🍳 レシピ提案（予算モード・${_budgetPeriodLabel}）`;

  const budget = _getBudget?.() || {};
  const foodBudget = budget["食費"] || 0;

  if (!foodBudget) {
    $("recipe-budget-status").textContent = "食費の月次予算が未設定です";
    chips.innerHTML = `<span class="recipe-empty-hint">ホーム画面の「💰 予算」ボタンから食費の月次予算を設定してください。</span>`;
    return;
  }

  // 期間ごとの予算と支出を計算（ショートカット由来の _activePeriod で月額比率を決定）
  const divisors = { month: 1, week: 4.3, day: 30 };
  const periodBudget = Math.round(foodBudget / (divisors[_activePeriod] || 1));
  const periodLabel  = _periodFrom === _periodTo ? _periodFrom : `${_periodFrom}〜${_periodTo}`;

  const periodExpenses = _filterExpenses()
    .filter((e) => !e.category || e.category === "食費");
  const spent = periodExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  _budgetRemaining = Math.max(0, periodBudget - spent);

  if (_budgetRemaining <= 0) {
    $("recipe-budget-status").textContent =
      `${periodLabel}の食費予算を超過（支出 ${yen(spent)} / 予算 ${yen(periodBudget)}）`;
    chips.innerHTML = `<span class="recipe-empty-hint">⚠️ ${periodLabel}の食費予算を使い切っています。</span>`;
    return;
  }

  try {
    const all = _expensesCache ?? await _fetchAllExpenses();
    _expensesCache = all;

    // 品目ごとに平均単価・購入回数・直近日付を集計
    const itemMap = new Map();
    for (const exp of all) {
      if (!exp.items) continue;
      for (const it of exp.items) {
        if (!it.name || !it.price || it.price <= 0) continue;
        const cur = itemMap.get(it.name) || { totalPrice: 0, count: 0, lastDate: "" };
        itemMap.set(it.name, {
          totalPrice: cur.totalPrice + it.price,
          count:      cur.count + 1,
          lastDate:   exp.date > cur.lastDate ? exp.date : cur.lastDate,
        });
      }
    }

    if (!itemMap.size) {
      $("recipe-budget-status").textContent = `${periodLabel}の食費残り ${yen(_budgetRemaining)}`;
      chips.innerHTML = `<span class="recipe-empty-hint">過去のレシートに明細品目がありません。OCRでレシートを読み取ると自動で食材を選択できます。</span>`;
      return;
    }

    // 購入回数の多い順→直近順でソート、予算内に収まる食材を貪欲に選択
    const sorted = [...itemMap.entries()]
      .map(([name, { totalPrice, count, lastDate }]) => ({
        name,
        estimatedPrice: Math.round(totalPrice / count),
        count,
        lastDate,
      }))
      .filter((i) => i.estimatedPrice > 0 && i.estimatedPrice <= _budgetRemaining)
      .sort((a, b) => b.count !== a.count ? b.count - a.count : b.lastDate.localeCompare(a.lastDate));

    let totalCost = 0;
    _budgetSelectedItems = [];
    for (const item of sorted) {
      if (totalCost + item.estimatedPrice <= _budgetRemaining && _budgetSelectedItems.length < 30) {
        _budgetSelectedItems.push(item);
        totalCost += item.estimatedPrice;
      }
    }

    if (!_budgetSelectedItems.length) {
      $("recipe-budget-status").textContent = `${periodLabel}の食費残り ${yen(_budgetRemaining)}`;
      chips.innerHTML = `<span class="recipe-empty-hint">予算内に収まる食材が見つかりませんでした。</span>`;
      return;
    }

    _renderBudgetChips();
  } catch (err) {
    logErr("予算食材計算エラー:", err.message);
    chips.innerHTML = `<span class="recipe-empty-hint">食材の計算に失敗しました: ${escapeHtml(err.message)}</span>`;
  }
}

function _renderBudgetChips() {
  const chips = $("recipe-ingredients");
  chips.innerHTML = _budgetSelectedItems.map((item) =>
    `<span class="recipe-chip recipe-chip-budget" data-name="${escapeHtml(item.name)}" title="推定 ${yen(item.estimatedPrice)} — タップで除外">
      ${escapeHtml(item.name)}<button class="chip-remove" type="button" aria-label="${escapeHtml(item.name)}を除外">×</button>
    </span>`,
  ).join("");

  chips.querySelectorAll(".chip-remove").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const name = btn.closest(".recipe-chip-budget").dataset.name;
      _budgetSelectedItems = _budgetSelectedItems.filter((i) => i.name !== name);
      _renderBudgetChips();
    };
  });

  const totalCost = _budgetSelectedItems.reduce((s, i) => s + i.estimatedPrice, 0);
  const _chipPeriodLabel = _periodFrom === _periodTo ? _periodFrom : `${_periodFrom}〜${_periodTo}`;
  $("recipe-budget-status").textContent = `${_chipPeriodLabel}の食費残り ${yen(_budgetRemaining)}`;
  $("recipe-budget-total").textContent  = `推定合計 ${yen(totalCost)}`;
}

// ---- 朝・昼・夜を選ぶ --------------------------------------------------------

const _MEAL_SLOTS = ["朝食", "昼食", "夕食"];
const _MEAL_ICONS = { 朝食: "🌅", 昼食: "☀️", 夕食: "🌙" };
// カレンダー保存時のスロットキー（昼食はカレンダーでは「お弁当」として保存）
const _MEAL_SLOT_KEY = { 朝食: "朝食", 昼食: "お弁当", 夕食: "夕食" };

// APIレスポンスのMarkdownを {朝食:[{title,markdown}], 昼食:[...], 夕食:[...]} に変換する。
function _parseSelectResult(md) {
  const result = {};
  const sections = md.split(/^## /m).slice(1);
  for (const section of sections) {
    const nl = section.indexOf("\n");
    if (nl === -1) continue;
    const heading = section.slice(0, nl).trim();
    const mealTime = _MEAL_SLOTS.find((m) => heading.includes(m));
    if (!mealTime) continue;
    const body = section.slice(nl);
    const options = body.split(/^### /m).slice(1).map((opt) => {
      const onl = opt.indexOf("\n");
      const rawTitle = onl === -1 ? opt.trim() : opt.slice(0, onl).trim();
      // ① ② ③ などの番号プレフィックスを除去
      const title = rawTitle.replace(/^[①②③④⑤\d][.．\s]*/, "").trim();
      return { title, markdown: opt.trim() };
    }).filter((o) => o.title);
    if (options.length) result[mealTime] = options;
  }
  return result;
}

// 3択カードをレンダリングする。
function _renderSelectPicker() {
  const groups = $("recipe-select-groups");
  groups.innerHTML = _MEAL_SLOTS.map((slot) => {
    const options = _selectResult[slot] || [];
    if (!options.length) return "";
    const icon = _MEAL_ICONS[slot];
    const cards = options.map((opt, i) => `
      <button type="button" class="meal-select-card${i === _selectChosen[slot] ? " selected" : ""}"
        data-slot="${escapeHtml(slot)}" data-idx="${i}">
        <span class="meal-select-card-title">${escapeHtml(opt.title)}</span>
      </button>`).join("");
    return `<div class="meal-select-group">
      <div class="meal-select-heading">${icon} ${slot}</div>
      <div class="meal-select-cards">${cards}</div>
    </div>`;
  }).join("");

  groups.querySelectorAll(".meal-select-card").forEach((btn) => {
    btn.onclick = () => {
      const slot = btn.dataset.slot;
      const idx  = Number(btn.dataset.idx);
      _selectChosen[slot] = idx;
      // 同グループの選択状態を更新
      groups.querySelectorAll(`.meal-select-card[data-slot="${slot}"]`).forEach((b, i) => {
        b.classList.toggle("selected", i === idx);
      });
    };
  });

  // カレンダー追加ボタンは _selectedDay がないと無効
  $("recipe-select-calendar-btn").disabled = !_selectedDay;
  $("recipe-select-calendar-btn").title = _selectedDay ? "" : "カレンダーの日付をタップしてからレシピを開いてください";
}

async function _selectConfirmCalendar() {
  if (!_selectedDay || !_selectResult) return;
  const btn = $("recipe-select-calendar-btn");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    for (const slot of _MEAL_SLOTS) {
      const opts = _selectResult[slot];
      if (!opts?.length) continue;
      const chosen = opts[_selectChosen[slot] ?? 0];
      await saveMeal(_selectedDay, _MEAL_SLOT_KEY[slot] || slot, chosen.title, chosen.markdown);
    }
    btn.textContent = "✅ カレンダーに追加しました";
    setTimeout(() => { btn.textContent = "📅 カレンダーに追加"; btn.disabled = false; }, 2500);
  } catch (err) {
    logErr("選択献立カレンダー追加エラー:", err.message);
    alert("カレンダーへの追加に失敗しました: " + err.message);
    btn.disabled = false;
    btn.textContent = "📅 カレンダーに追加";
  }
}

async function _selectConfirmSave() {
  if (!_selectResult) return;
  const btn = $("recipe-select-save-btn");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    let count = 0;
    for (const slot of _MEAL_SLOTS) {
      const opts = _selectResult[slot];
      if (!opts?.length) continue;
      const chosen = opts[_selectChosen[slot] ?? 0];
      await saveRecipe({
        title: chosen.title,
        markdown: chosen.markdown,
        items: _extractIngredients(chosen.markdown).length ? _extractIngredients(chosen.markdown) : _lastItems,
        period: _activePeriod,
        rtype: "meal",
        servings: _lastServings,
      });
      count++;
    }
    btn.textContent = `✅ ${count}品を保存しました`;
    setTimeout(() => { btn.textContent = "📚 レシピを保存"; btn.disabled = false; }, 2500);
  } catch (err) {
    logErr("選択レシピ保存エラー:", err.message);
    alert("保存に失敗しました: " + err.message);
    btn.disabled = false;
    btn.textContent = "📚 レシピを保存";
  }
}

// ---- 週間献立 → カレンダー --------------------------------------------------

const _DAY_ORDER = ["月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日", "日曜日"];

// 週間献立マークダウンを {date, 朝食, 昼食, 夕食}[] に変換する。
// "## 月曜日" セクションごとに3食を抽出し、献立開始日を起点に日付を割り当てる。
// 月曜日=day0, 火曜日=day1 … 日曜日=day6 として開始日からのオフセットにマップする。
function _extractWeeklyMeals(md) {
  const planStartStr = $("recipe-plan-start").value || _selectedDay || "";
  const planStart = new Date(planStartStr + "T00:00:00");
  const results = [];

  const sections = md.split(/^## /m).slice(1);
  for (const section of sections) {
    const headingEnd = section.indexOf("\n");
    if (headingEnd === -1) continue;
    const dayName = section.slice(0, headingEnd).trim();
    const dayIdx = _DAY_ORDER.indexOf(dayName);
    if (dayIdx === -1) continue;

    const date = new Date(planStart);
    date.setDate(planStart.getDate() + dayIdx);
    const dateStr = dayKey(date);

    const body = section.slice(headingEnd);
    const breakfastM = body.match(/- \*\*朝食\*\*[：:]\s*(.+)/);
    const lunchM     = body.match(/- \*\*昼食\*\*[：:]\s*(.+)/);
    const dinnerM    = body.match(/^### 夕食[：:]\s*(.+)$/m);
    // 夕食セクション全体（### 夕食: から末尾まで）をレシピとして保存
    const dinnerSectionM = body.match(/### 夕食[：:][\s\S]*/);
    const 夕食レシピ = dinnerSectionM ? dinnerSectionM[0].trim() : "";

    results.push({
      date: dateStr,
      朝食:   breakfastM ? breakfastM[1].trim() : "",
      お弁当: lunchM     ? lunchM[1].trim()     : "",
      夕食:   dinnerM    ? dinnerM[1].trim()    : "",
      夕食レシピ,
    });
  }
  return results;
}

async function _exportToCalendar() {
  if (_activeType === "weekly") {
    const btn = $("recipe-calendar-btn");
    btn.disabled = true;
    try {
      const meals = _extractWeeklyMeals(_lastMarkdown);
      if (!meals.length) {
        alert("献立情報を解析できませんでした。週間献立を再生成してください。");
        return;
      }
      for (const { date, 朝食, お弁当, 夕食, 夕食レシピ } of meals) {
        if (朝食 || お弁当 || 夕食) await saveMealPlan(date, { 朝食, お弁当, 夕食, 夕食レシピ });
      }
      btn.textContent = `✅ ${meals.length}日分を反映しました`;
      setTimeout(() => { btn.textContent = "📅 カレンダーに反映"; btn.disabled = false; }, 3000);
    } catch (err) {
      logErr("献立カレンダー反映エラー:", err.message);
      alert("カレンダーへの反映に失敗しました: " + err.message);
      $("recipe-calendar-btn").disabled = false;
    }
  } else {
    // 1食分: 食事スロットを選んでもらう
    $("recipe-post-actions").hidden = true;
    $("recipe-meal-slot-picker").hidden = false;
  }
}

async function _saveMealSlot(slot) {
  if (!_selectedDay) {
    alert("カレンダーの日付をタップしてからレシピを開いてください。");
    $("recipe-meal-slot-picker").hidden = true;
    $("recipe-post-actions").hidden = false;
    return;
  }
  const title = _extractTitle(_lastMarkdown);
  try {
    await saveMeal(_selectedDay, slot, title, _lastMarkdown);
    $("recipe-meal-slot-picker").hidden = true;
    $("recipe-post-actions").hidden = false;
    $("recipe-calendar-btn").textContent = `✅ ${slot}に追加しました`;
    setTimeout(() => { $("recipe-calendar-btn").textContent = "📅 カレンダーに追加"; }, 3000);
  } catch (err) {
    logErr("カレンダー追加エラー:", err.message);
    alert("カレンダーへの追加に失敗しました: " + err.message);
  }
}
