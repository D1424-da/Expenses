// レシピ提案モーダル。期間・種別・時短・使い切りを選んでGeminiに送る。
import { $, escapeHtml, yen, dayKey, openModal, closeModal } from "./dom-utils.js";
import { log, logErr } from "./log.js";
import { OCR_API_BASE } from "./firebase-config.js";
import { saveRecipe } from "./saved-recipes.js";
import { addItemsToList } from "./shopping-list.js";
import { saveMealPlan } from "./meal-plan.js";

let _getToken;
let _fetchAllExpenses;
let _getBudget;
let _expensesCache = null; // レシピモーダル1セッション中のキャッシュ
let _selectedDay = null;
let _expenses    = [];
let _activePeriod  = "day";
let _activeType    = "meal";
let _maxMinutes    = 0;    // 0 = 気にしない
let _useUp         = false;
let _lastMarkdown  = "";
let _lastItems     = [];
let _lastServings  = 2;

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

  // 期間タブ
  $("recipe-period-tabs").querySelectorAll(".recipe-tab").forEach((btn) => {
    btn.onclick = () => { _activePeriod = btn.dataset.period; _setActiveTab("recipe-period-tabs", btn); _renderIngredients(); };
  });
  // 種別タブ
  $("recipe-type-tabs").querySelectorAll(".recipe-tab").forEach((btn) => {
    btn.onclick = () => { _activeType = btn.dataset.rtype; _setActiveTab("recipe-type-tabs", btn); };
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
    } finally {
      btn.disabled = false;
    }
  };

  // 料理選択パネルの「保存」ボタン
  $("recipe-dish-save-btn").onclick = _saveDishSelection;
  $("recipe-dish-cancel-btn").onclick = _hideDishSelector;

  // カレンダーに反映ボタン（週間献立のみ表示）
  $("recipe-calendar-btn").onclick = _exportToCalendar;

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
  _activePeriod = initialPeriod;
  _activeType = "meal";

  // タブ初期状態
  _setActiveTabByValue("recipe-period-tabs", "data-period", _activePeriod);
  _setActiveTabByValue("recipe-type-tabs", "data-rtype", _activeType);

  _lastMarkdown = "";
  _lastItems = [];
  _expensesCache = null;
  $("recipe-result").hidden = true;
  $("recipe-result").innerHTML = "";
  $("recipe-status").hidden = true;
  $("recipe-post-actions").hidden = true;
  $("recipe-dish-selector").hidden = true;
  $("recipe-save-btn").textContent = "📚 保存";
  $("recipe-shopping-btn").textContent = "🛒 リストに追加";
  $("recipe-calendar-btn").textContent = "📅 カレンダーに反映";
  $("recipe-calendar-btn").hidden = true;
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
  const periodLabel = { day: "今日", week: "今週", month: "今月" }[_activePeriod] || "";
  $("recipe-modal-title").textContent = `🍳 レシピ提案（${periodLabel}）`;
  $("recipe-result").hidden = true;
  $("recipe-status").hidden = true;
}

function _itemsForPeriod(period) {
  return _filterExpensesByPeriod(period)
    .flatMap((e) => (e.items || []).map((it) => it.name).filter((n) => n && n.length >= 1));
}

function _filterExpensesByPeriod(period) {
  if (!_selectedDay) return [];
  if (period === "day") return _expenses.filter((e) => e.date === _selectedDay);
  if (period === "week") {
    const { start, end } = _weekRange(_selectedDay);
    return _expenses.filter((e) => e.date && e.date >= start && e.date <= end);
  }
  return _expenses; // "month": 当月全件
}

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
  $("recipe-dish-selector").hidden = true;

  try {
    const token = _getToken ? await _getToken() : "";
    const res = await fetch(`${OCR_API_BASE}/api/recipe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        items,
        servings,
        recipe_type: _activeType,
        max_minutes: _maxMinutes || null,
        use_up: _useUp,
        family: _hasFamily() ? _saveFamily() : null,
      }),
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
    _lastMarkdown = recipe;
    _lastItems    = items;
    _lastServings = servings;
    localStorage.setItem("recipe_servings", servings);
    $("recipe-status").hidden = true;
    const result = $("recipe-result");
    result.innerHTML = _markdownToHtml(recipe);
    result.hidden = false;
    $("recipe-post-actions").hidden = false;
    // カレンダー反映ボタンは週間献立のときのみ表示
    $("recipe-calendar-btn").hidden = _activeType !== "weekly";
  } catch (err) {
    logErr("レシピ提案エラー:", err.message, err);
    _showStatus("error", "レシピの取得に失敗しました: " + err.message);
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

function _showDishSelector() {
  const dishes = _extractDishes(_lastMarkdown, _activeType);
  if (dishes.length <= 1) {
    // 1品だけなら直接保存
    _doSave([{ title: _extractTitle(_lastMarkdown), markdown: _lastMarkdown }]);
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
  } catch {
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

// ---- 週間献立 → カレンダー --------------------------------------------------

const _DAY_ORDER = ["月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日", "日曜日"];

// 買い物日を献立の1日目（月曜日扱い）とする
function _getMondayOf(selectedDay) {
  return new Date(selectedDay + "T00:00:00");
}

// 週間献立マークダウンを {date, 朝食, 昼食, 夕食}[] に変換する。
// "## 月曜日" セクションごとに3食を抽出し、_selectedDay の週の日付を割り当てる。
function _extractWeeklyMeals(md, selectedDay) {
  const monday = _getMondayOf(selectedDay);
  const results = [];

  const sections = md.split(/^## /m).slice(1);
  for (const section of sections) {
    const headingEnd = section.indexOf("\n");
    if (headingEnd === -1) continue;
    const dayName = section.slice(0, headingEnd).trim();
    const dayIdx = _DAY_ORDER.indexOf(dayName);
    if (dayIdx === -1) continue;

    const date = new Date(monday);
    date.setDate(monday.getDate() + dayIdx);
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
      朝食: breakfastM ? breakfastM[1].trim() : "",
      昼食: lunchM     ? lunchM[1].trim()     : "",
      夕食: dinnerM    ? dinnerM[1].trim()    : "",
      夕食レシピ,
    });
  }
  return results;
}

async function _exportToCalendar() {
  const btn = $("recipe-calendar-btn");
  btn.disabled = true;
  try {
    const meals = _extractWeeklyMeals(_lastMarkdown, _selectedDay);
    if (!meals.length) {
      alert("献立情報を解析できませんでした。週間献立を再生成してください。");
      return;
    }
    for (const { date, 朝食, 昼食, 夕食 } of meals) {
      if (朝食 || 昼食 || 夕食) await saveMealPlan(date, { 朝食, 昼食, 夕食 });
    }
    btn.textContent = `✅ ${meals.length}日分を反映しました`;
    setTimeout(() => { btn.textContent = "📅 カレンダーに反映"; }, 3000);
  } catch (err) {
    logErr("献立カレンダー反映エラー:", err.message);
    alert("カレンダーへの反映に失敗しました: " + err.message);
  } finally {
    btn.disabled = false;
  }
}
