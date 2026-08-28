// 月次予算の設定・管理とカテゴリ別進捗バーの描画。
// G-4: 月ごとに異なる予算を設定できる（settings/budget_{monthKey}）。
//      月の予算が未設定なら直近の settings/budget をテンプレとして読み込む。
import {
  doc, getDoc, setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { $, yen, escapeHtml, openModal, closeModal, monthKey } from "./dom-utils.js";
import { dbBase } from "./db-paths.js";
import { summarizeHistory, sumLimits, AVERAGE_MONTHS } from "./budget-stats.js";
import { log, logErr } from "./log.js";
import { showError } from "./ui-feedback.js";

let _db, _getUser, _categories, _getCurrentMonth;
let _budget = {}; // { 食費: 30000, ... }
let _budgetLoaded = false;
let _onUpdated; // () => void — 予算保存後に呼んでサマリーを再描画させる
let _fetchHistory;  // () => Promise<expenses[]> — 過去の実績（手がかりの計算に使う）

export function initBudget({ db, getUser, categories, onUpdated, getCurrentMonth, fetchHistory }) {
  _db = db;
  _getUser = getUser;
  _categories = categories;
  _onUpdated = onUpdated;
  _fetchHistory = fetchHistory;
  _getCurrentMonth = getCurrentMonth || (() => new Date());
  $("budget-close").onclick = () => closeModal("budget-modal");
  $("budget-btn").onclick   = _openSettings;
  $("budget-form").onsubmit = _save;
}

export function getBudget() { return _budget; }

export async function loadBudget() {
  const user = _getUser();
  if (!user) return;
  try {
    const mkey = monthKey(_getCurrentMonth());
    // 今月の予算を優先して読む
    const monthSnap = await getDoc(_settingsRef(`budget_${mkey}`));
    if (monthSnap.exists()) {
      _budget = monthSnap.data().limits || {};
    } else {
      // 今月分がなければグローバル予算（直近の保存）をテンプレとして使う
      const globalSnap = await getDoc(_settingsRef("budget"));
      _budget = globalSnap.exists() ? (globalSnap.data().limits || {}) : {};
    }
    _budgetLoaded = true;
    log("予算読み込み:", mkey, _budget);
  } catch (err) {
    logErr("予算読み込みエラー:", err.message, err);
  }
}

// カテゴリ別進捗バーを描画する。予算未設定なら false を返す（呼び出し元が通常の cat-bars を表示）。
export function renderBudgetBars(expenses, container) {
  const hasLimits = Object.values(_budget).some((v) => v > 0);
  container.innerHTML = "";
  if (!hasLimits) return false;

  const spending = {};
  for (const e of expenses) {
    const cat = e.category || "その他";
    spending[cat] = (spending[cat] || 0) + (e.amount || 0);
  }

  // 予算設定カテゴリ + 今月使ったカテゴリを合わせて表示
  const cats = [...new Set([...Object.keys(_budget), ...Object.keys(spending)])].filter(
    (c) => _budget[c] > 0 || spending[c] > 0,
  );
  cats.sort((a, b) => (spending[b] || 0) - (spending[a] || 0));

  for (const cat of cats) {
    const spent  = spending[cat] || 0;
    const limit  = _budget[cat] || 0;
    const pct    = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
    const over   = limit > 0 && spent > limit;
    const warn   = !over && limit > 0 && pct >= 80;

    const row = document.createElement("div");
    row.className = "budget-row";
    row.innerHTML = `
      <div class="budget-row-head">
        <span class="cat-name">${escapeHtml(cat)}</span>
        <span class="budget-amount${over ? " budget-over" : warn ? " budget-warn" : ""}">
          ${yen(spent)}${limit > 0 ? `<span class="budget-limit"> / ${yen(limit)}</span>` : ""}
        </span>
      </div>
      ${limit > 0 ? `<div class="budget-bar-wrap">
        <div class="budget-bar${over ? " budget-bar-over" : warn ? " budget-bar-warn" : ""}"
             style="width:${pct.toFixed(1)}%"></div>
      </div>` : ""}`;
    container.appendChild(row);
  }
  return true;
}

async function _openSettings() {
  _budgetLoaded = false; // 月が変わっている可能性があるので毎回再読み込み
  await loadBudget();
  const mkey = monthKey(_getCurrentMonth());
  openModal("budget-modal");
  $("budget-modal-month").textContent = mkey.replace("-", "年") + "月の予算";

  // 手がかりは過去の実績から作る。取得に失敗しても予算設定自体は使えるように、
  // 失敗時は手がかりだけ出さない。
  let hist = null;
  try {
    if (_fetchHistory) {
      hist = summarizeHistory(await _fetchHistory(), _getCurrentMonth(), AVERAGE_MONTHS);
    }
  } catch (err) {
    logErr("予算の手がかりを取得できませんでした:", err.message);
  }

  const inputs = $("budget-inputs");
  inputs.innerHTML = "";
  for (const cat of _categories) {
    const val = _budget[cat] || "";
    const avg  = hist?.hasAverage ? hist.average[cat] : 0;
    const last = hist?.hasLastMonth ? hist.lastMonth[cat] : 0;
    const parts = [];
    if (avg  > 0) parts.push(`平均 ${yen(avg)}`);
    if (last > 0) parts.push(`先月 ${yen(last)}`);

    const row = document.createElement("div");
    row.className = "budget-input-row";
    row.innerHTML = `
      <label class="budget-cat-label">${escapeHtml(cat)}</label>
      <div class="budget-input-wrap">
        <span class="budget-yen-prefix">¥</span>
        <input type="number" min="0" step="1000" inputmode="numeric"
               data-cat="${escapeHtml(cat)}" value="${val}" placeholder="0（予算なし）" />
      </div>
      ${parts.length ? `<p class="budget-hint-line">${parts.join(" · ")}</p>` : ""}`;
    inputs.appendChild(row);
  }

  _renderSuggest(hist);
  _updateTotal();
  // 入力のたびに合計を出す。行ごとに listener を付けると再描画のたびに
  // 増えるので、コンテナ1つに委譲する。
  inputs.oninput = _updateTotal;
}

/** 上部の案内ブロック。根拠が足りないときは何も出さない。 */
function _renderSuggest(hist) {
  const box = $("budget-suggest");
  if (!box) return;
  if (!hist || (!hist.hasAverage && !hist.hasLastMonth)) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }

  const btns = [];
  if (hist.hasAverage) {
    btns.push('<button type="button" class="budget-suggest-btn" data-fill="average">平均を入れる</button>');
  }
  if (hist.hasLastMonth) {
    btns.push('<button type="button" class="budget-suggest-btn" data-fill="last">先月と同じ</button>');
  }

  const lead = hist.hasAverage
    ? `過去${AVERAGE_MONTHS}か月の平均は <strong>${yen(hist.averageTotal)}</strong> です。同じ額から始めますか？`
    : `先月の支出は <strong>${yen(hist.lastMonthTotal)}</strong> でした。同じ額から始めますか？`;

  box.innerHTML = `<p class="budget-suggest-lead">${lead}</p>
    <div class="budget-suggest-actions">${btns.join("")}</div>`;
  box.hidden = false;

  box.querySelectorAll("[data-fill]").forEach((btn) => {
    btn.onclick = () => {
      const src = btn.dataset.fill === "average" ? hist.average : hist.lastMonth;
      document.querySelectorAll("#budget-inputs input[data-cat]").forEach((el) => {
        const v = src[el.dataset.cat] || 0;
        el.value = v > 0 ? String(v) : "";
      });
      _updateTotal();
    };
  });
}

function _updateTotal() {
  const el = $("budget-total");
  if (!el) return;
  const values = [...document.querySelectorAll("#budget-inputs input[data-cat]")]
    .map((i) => i.value);
  el.textContent = yen(sumLimits(values));
}

async function _save(e) {
  e.preventDefault();
  const user = _getUser();
  if (!user) return;
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const limits = {};
    document.querySelectorAll("#budget-inputs input[data-cat]").forEach((el) => {
      const v = Number(el.value) || 0;
      if (v > 0) limits[el.dataset.cat] = v;
    });
    const mkey = monthKey(_getCurrentMonth());
    // 今月分として保存
    await setDoc(_settingsRef(`budget_${mkey}`), { limits });
    // グローバル予算も更新（来月以降のテンプレになる）
    await setDoc(_settingsRef("budget"), { limits });
    _budget = limits;
    log("予算保存:", mkey, limits);
    closeModal("budget-modal");
    _onUpdated?.();
  } catch (err) {
    logErr("予算保存エラー:", err.message, err);
    showError(err, "予算を保存できませんでした。");
  } finally {
    btn.disabled = false;
  }
}

function _settingsRef(key) {
  return doc(_db, ...dbBase(), "settings", key);
}
