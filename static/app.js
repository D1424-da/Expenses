// レシート家計簿 — エントリポイント。
//
// Firebase の初期化・認証・Firestore 購読・OCRキューを担当する薄い司令塔。
// 画面描画の詳細は各ビューモジュールに委譲している。
//
// 役割分担:
//   expense-form.js  : 入力フォーム・編集・削除
//   list-view.js     : 店舗別一覧の描画
//   calendar-view.js : カレンダー・週計・日付モーダル
//   compare-view.js  : 最安値比較モーダル
//   ocr-client.js    : 画像縮小・バックエンドOCR・ブラウザ内PaddleOCR
//   history.js       : 履歴正規化（Gemini基準の正解辞書）
//   stats.js         : カテゴリ集計（純粋関数）
//   parser.js        : OCRテキスト → 家計簿項目の抽出
//   dom-utils.js     : DOM取得・表示整形・モーダル共通
//   log.js           : デバッグログ
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc,
  query, where, orderBy, onSnapshot, getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { firebaseConfig, OCR_API_BASE, CATEGORIES } from "./firebase-config.js";
import { parseReceipt } from "./parser.js";
import { log, logErr } from "./log.js";
import {
  $, yen, escapeHtml, dayKey, monthKey, monthLabel, renderCatBars, bindModalDismiss,
} from "./dom-utils.js";
import { requestBackendOcr, preprocessImage, runClientOcr, prewarmOcr } from "./ocr-client.js";
import { TRUSTED_ENGINES, normalizeWithHistory } from "./history.js";
import { categoryBreakdown, buildPriceHistory, lowestPriceAlerts } from "./stats.js";
import { initForm, fillForm, resetForm, editExpense, deleteExpense } from "./expense-form.js";
import { renderList, setFilter } from "./list-view.js";
import { initCalendar, renderCalendar, maybeRefreshDayModal, updateMealPlans } from "./calendar-view.js";
import { initCompare } from "./compare-view.js";
import { initRecipe, openRecipeModal } from "./recipe-view.js";
import { initBudget, loadBudget, getBudget, renderBudgetBars } from "./budget-view.js";
import { initTrend } from "./trend-view.js";
import { initSavedRecipes } from "./saved-recipes.js";
import { initShoppingList, startSync as startShoppingSync, stopSync as stopShoppingSync } from "./shopping-list.js";
import { initMealPlan, startMealPlanSync, stopMealPlanSync } from "./meal-plan.js";
import { dbSetUser, dbClearHousehold, dbBase } from "./db-paths.js";
import { initHousehold, loadHousehold, clearHousehold } from "./household.js";

window.addEventListener("error", (e) => logErr("未捕捉エラー:", e.message, e.filename, e.lineno));
window.addEventListener("unhandledrejection", (e) => logErr("未処理のPromise拒否:", e.reason));
log("app.js 読み込み開始");

// ---- Firebase 初期化 -------------------------------------------------------
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const provider = new GoogleAuthProvider();
log("Firebase初期化完了", {
  projectId: firebaseConfig.projectId,
  authDomain: firebaseConfig.authDomain,
  origin: location.origin,
  href: location.href,
});

// ---- 状態 ------------------------------------------------------------------
let currentUser = null;
let currentMonth = new Date();
let currentExpenses = [];
let unsubscribe = null;

// ---- 認証 ------------------------------------------------------------------
onAuthStateChanged(auth, (user) => {
  log("認証状態の変化:", user ? `ログイン中 (${user.email})` : "未ログイン");
  currentUser = user;
  if (user) {
    $("login-screen").hidden = true;
    $("app").hidden = false;
    setupApp();
  } else {
    if (unsubscribe) unsubscribe();
    stopShoppingSync();
    stopMealPlanSync();
    // B-1: ログアウト時にキャッシュをクリアして他ユーザーへのデータ漏洩を防ぐ
    _allExpensesCache = null;
    _priceHistoryCache = null;
    clearHousehold();
    dbClearHousehold();
    $("app").hidden = true;
    $("login-screen").hidden = false;
  }
});

// LINE / Instagram / Facebook などのインアプリブラウザを検知する。
// これらのWebViewではGoogleのOAuthが完全にブロックされるため、外部ブラウザへ誘導する。
const _ua = navigator.userAgent;
const _isInAppBrowser = /Line\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(_ua);
const _isMobile = /Android|iPhone|iPad|iPod/i.test(_ua);

if (_isInAppBrowser) {
  log("インアプリブラウザを検知:", _ua);
  const warning = $("inapp-warning");
  if (warning) warning.hidden = false;
  const loginBtn = $("google-login");
  if (loginBtn) loginBtn.hidden = true;
}

$("copy-url-btn") && ($("copy-url-btn").onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    $("copy-url-btn").textContent = "✅ コピーしました";
    setTimeout(() => { $("copy-url-btn").textContent = "🔗 URLをコピー"; }, 2500);
  } catch {
    prompt("URLをコピーしてください:", location.href);
  }
});

getRedirectResult(auth).then((result) => {
  if (result?.user) log("リダイレクトログイン成功:", result.user.email);
}).catch((err) => {
  if (err.code === "auth/credential-already-in-use") return;
  logErr("getRedirectResult エラー:", err.code, err.message);
  const el = $("login-error");
  el.textContent = "ログインに失敗しました: " + (err.code || err.message);
  el.hidden = false;
});

$("google-login").onclick = async () => {
  log("ログインボタン押下:", _isMobile ? "redirect" : "popup");
  $("login-error").hidden = true;
  try {
    if (_isMobile) {
      await signInWithRedirect(auth, provider);
    } else {
      const result = await signInWithPopup(auth, provider);
      log("ポップアップログイン成功:", result.user.email);
    }
  } catch (err) {
    logErr("ログインエラー:", err.code, err.message, err);
    const el = $("login-error");
    el.textContent = "ログインに失敗しました: " + (err.code || err.message);
    el.hidden = false;
  }
};

// ---- アプリ初期化 ----------------------------------------------------------
let appInitialized = false;
async function setupApp() {
  // G-5: ログインユーザーを db-paths.js に登録し、世帯メンバーシップを確認
  dbSetUser(currentUser.uid);
  try {
    await loadHousehold(currentUser.uid);
  } catch (err) {
    logErr("世帯読み込みエラー（個人モードで続行）:", err.message);
    dbClearHousehold();
  }

  if (!appInitialized) {
    const sel = $("f-category");
    for (const c of CATEGORIES) sel.add(new Option(c, c));

    // G-2: 検索フィルターのカテゴリ選択肢を生成
    const catFilter = $("list-cat-filter");
    if (catFilter) {
      for (const c of CATEGORIES) catFilter.add(new Option(c, c));
      $("list-search").oninput  = (e) => setFilter(e.target.value, catFilter.value);
      catFilter.onchange        = (e) => setFilter($("list-search").value, e.target.value);
    }

    initForm({
      db,
      getUser: () => currentUser,
      expensesCol,
      onSaved: _onFormSaved,
    });
    initCalendar({
      onAddExpense: _addCalendarExpense,
      onEdit: editExpense,
      onDelete: _deleteAndClearCache,
    });
    initCompare({ fetchAllExpenses });
    initRecipe({ getToken: () => currentUser?.getIdToken(), fetchAllExpenses, getBudget });
    initBudget({
      db,
      getUser: () => currentUser,
      categories: CATEGORIES,
      onUpdated: renderSummary,
      getCurrentMonth: () => currentMonth,
    });
    initTrend({ fetchMonthExpenses });
    initSavedRecipes({ db, getUser: () => currentUser });
    initShoppingList({ db, getUser: () => currentUser });
    initMealPlan({ db, getUser: () => currentUser });
    initHousehold({
      db,
      getUser: () => currentUser,
      onChanged: _onHouseholdChanged,
    });

    $("logout").onclick = () => { stopShoppingSync(); stopMealPlanSync(); signOut(auth); };
    $("prev-month").onclick = () => shiftMonth(-1);
    $("next-month").onclick = () => shiftMonth(1);
    $("file-input").onchange = handleFiles;
    $("camera-input").onchange = handleFiles;
    $("skip-btn").onclick = skipCurrent;
    $("fab-camera").onclick = () => $("camera-input").click();
    $("bnav-home").onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
    $("bnav-calendar").onclick = () => $("calendar").scrollIntoView({ behavior: "smooth" });
    $("bnav-shopping").onclick = () => $("shopping-btn").click();
    $("bnav-recipe").onclick = () => openRecipeModal({
      selectedDay: dayKey(new Date()),
      expenses: currentExpenses,
      initialPeriod: "month",
    });

    // G-1: CSV エクスポート
    $("export-btn").onclick = _exportCsv;

    // PC nav
    $("pcnav-home").onclick     = () => window.scrollTo({ top: 0, behavior: "smooth" });
    $("pcnav-calendar").onclick = () => $("calendar").scrollIntoView({ behavior: "smooth" });
    $("pcnav-recipe").onclick   = () => openRecipeModal({
      selectedDay: dayKey(new Date()),
      expenses: currentExpenses,
      initialPeriod: "month",
    });
    $("pcnav-shopping").onclick   = () => $("shopping-btn").click();
    $("pcnav-saved").onclick      = () => $("saved-recipes-btn").click();
    $("pcnav-compare").onclick    = () => $("compare-btn").click();
    $("pcnav-budget").onclick     = () => $("budget-btn").click();
    $("pcnav-trend").onclick      = () => $("trend-btn").click();
    $("pcnav-household").onclick  = () => $("household-btn").click();

    bindModalDismiss();

    // G-3: Service Worker 登録
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js")
        .then((r) => log("SW 登録:", r.scope))
        .catch((err) => logErr("SW 登録失敗:", err.message));
    }

    prewarmOcr();
    appInitialized = true;
  }
  loadBudget().then(renderSummary);
  startShoppingSync();
  startMealPlanSync((map) => {
    updateMealPlans(map);
    renderCalendar(currentExpenses, currentMonth);
    maybeRefreshDayModal();
  });
  renderMonth();
  subscribeMonth();
}

function shiftMonth(delta) {
  currentMonth.setMonth(currentMonth.getMonth() + delta);
  renderMonth();
  subscribeMonth();
}

function renderMonth() {
  $("current-month").textContent = monthLabel(currentMonth);
}

// ---- Firestore -------------------------------------------------------------
function expensesCol() {
  return collection(db, ...dbBase(), "expenses");
}

async function fetchAllExpenses() {
  const snap = await getDocs(expensesCol());
  return snap.docs.map((d) => d.data());
}

async function fetchMonthExpenses(month) {
  const start = monthKey(month) + "-01";
  const next  = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const end   = monthKey(next) + "-01";
  const q = query(
    collection(db, ...dbBase(), "expenses"),
    where("date", ">=", start),
    where("date", "<",  end),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

function subscribeMonth() {
  if (unsubscribe) unsubscribe();
  const start = monthKey(currentMonth) + "-01";
  const next = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
  const end = monthKey(next) + "-01";
  const q = query(
    collection(db, ...dbBase(), "expenses"),
    where("date", ">=", start),
    where("date", "<", end),
    orderBy("date", "desc"),
  );
  log("Firestore購読開始:", monthKey(currentMonth), "uid:", currentUser.uid);
  unsubscribe = onSnapshot(
    q,
    (snap) => {
      currentExpenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      log("Firestore更新:", currentExpenses.length, "件");
      renderList(currentExpenses, { onEdit: editExpense, onDelete: deleteExpense });
      renderCalendar(currentExpenses, currentMonth);
      maybeRefreshDayModal();
      // サマリー（非同期の全件フェッチを含む）は描画フレームの後に遅延実行
      requestAnimationFrame(renderSummary);
    },
    (err) => {
      logErr("Firestore購読エラー:", err.code, err.message, err);
      const s = $("ocr-status");
      s.hidden = false;
      s.className = "status error";
      s.textContent = "データ取得に失敗しました（Firebaseの設定/ルールを確認してください）: " + err.message;
    },
  );
}

// ---- サマリー --------------------------------------------------------------
function renderSummary() {
  const total = currentExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  $("summary-total").textContent = yen(total);
  $("summary-count").textContent = currentExpenses.length
    ? `${currentExpenses.length}件の記録` : "記録なし";

  const bars = $("category-bars");
  const usedBudget = renderBudgetBars(currentExpenses, bars);
  if (!usedBudget) renderCatBars(bars, categoryBreakdown(currentExpenses));

  // 最安値アラート（全件取得が必要なので非同期で後からレンダリング）
  _refreshAlerts();
}

let _allExpensesCache = null;
let _priceHistoryCache = null;

async function _refreshAlerts() {
  const el = $("lowest-alerts");
  if (!el) return;
  try {
    if (!_allExpensesCache) {
      _allExpensesCache = await fetchAllExpenses();
      _priceHistoryCache = buildPriceHistory(_allExpensesCache);
    }
    const alerts = lowestPriceAlerts(_priceHistoryCache, currentExpenses);
    if (!alerts.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<div class="alert-title">🎉 今月のお得な買い物</div>` +
      alerts.map((a) =>
        `<div class="alert-row">
          <span class="alert-name">${escapeHtml(a.name)}</span>
          <span class="alert-detail">${escapeHtml(a.store)} <strong>${yen(a.price)}</strong>（過去最安！）</span>
        </div>`,
      ).join("");
  } catch (_) {
    el.hidden = true;
  }
}

// ---- カレンダーからの直接追加（calendar-view のコールバック） --------------
async function _addCalendarExpense({ date, store, amount, category }) {
  await addDoc(expensesCol(), {
    date, store, branch: "", amount, category,
    memo: "", items: [], rawText: "", ocrEngine: "manual",
    createdAt: serverTimestamp(),
  });
  log("カレンダーから追加:", date, amount);
  // キャッシュに追記して全件再フェッチを回避（onSnapshot で currentExpenses は自動更新される）
  if (_allExpensesCache) {
    _allExpensesCache.push({ date, store, branch: "", amount, category, memo: "", items: [], ocrEngine: "manual" });
    _priceHistoryCache = buildPriceHistory(_allExpensesCache);
  }
  _jumpToMonthOf(date);
}

// D-1: 削除時もキャッシュを破棄して最安値アラートが陳腐化しないようにする
function _deleteAndClearCache(id) {
  _allExpensesCache = null;
  _priceHistoryCache = null;
  deleteExpense(id);
}

// ---- フォーム保存後のコールバック（expense-form のコールバック） ------------
function _onFormSaved(dateStr, wasEdit) {
  // D-1: 編集・追加後にキャッシュを破棄（次回アラート表示時に正確な価格を反映）
  _allExpensesCache = null;
  _priceHistoryCache = null;
  _jumpToMonthOf(dateStr);
  if (wasEdit) $("expense-list").scrollIntoView({ behavior: "smooth" });
  if (!_advanceQueue()) $("ocr-status").hidden = true;
}

// ---- G-5: 世帯切替後のリセット ---------------------------------------------
function _onHouseholdChanged() {
  // Firestore リスナーを張り直して正しいコレクションを購読する
  _allExpensesCache = null;
  _priceHistoryCache = null;
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  stopShoppingSync();
  stopMealPlanSync();
  loadBudget().then(renderSummary);
  startShoppingSync();
  startMealPlanSync((map) => {
    updateMealPlans(map);
    renderCalendar(currentExpenses, currentMonth);
    maybeRefreshDayModal();
  });
  subscribeMonth();
}

// ---- G-1: CSV エクスポート --------------------------------------------------
async function _exportCsv() {
  const btn = $("export-btn");
  btn.disabled = true;
  btn.textContent = "⏳ 準備中…";
  try {
    const all = await fetchAllExpenses();
    const rows = [
      ["日付", "店名", "支店名", "金額", "カテゴリ", "メモ", "品目名", "品目価格", "OCRエンジン"],
    ];
    for (const e of all) {
      const items = e.items || [];
      if (!items.length) {
        rows.push([e.date, e.store || "", e.branch || "", e.amount, e.category || "", e.memo || "", "", "", e.ocrEngine || ""]);
      } else {
        for (const it of items) {
          rows.push([e.date, e.store || "", e.branch || "", e.amount, e.category || "", e.memo || "", it.name || "", it.price || "", e.ocrEngine || ""]);
        }
      }
    }
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM付きでExcel対応
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `家計簿_${monthKey(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    log("CSVエクスポート:", all.length, "件");
  } catch (err) {
    logErr("CSVエクスポートエラー:", err.message, err);
    alert("エクスポートに失敗しました: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "📥 CSV";
  }
}

function _jumpToMonthOf(dateStr) {
  const target = new Date(dateStr + "T00:00:00");
  if (monthKey(target) !== monthKey(currentMonth)) {
    currentMonth = target;
    renderMonth();
    subscribeMonth();
  }
}

// ---- OCR キュー（複数枚対応） ----------------------------------------------
let ocrQueue = [];
let ocrTotal = 0;

function handleFiles(e) {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  ocrQueue = files;
  ocrTotal = files.length;
  _processNext();
}

function _queuePrefix() {
  if (ocrTotal <= 1) return "";
  return `(${ocrTotal - ocrQueue.length}/${ocrTotal}枚目) `;
}

function _processNext() {
  if (!ocrQueue.length) { ocrTotal = 0; $("skip-btn").hidden = true; return; }
  $("skip-btn").hidden = ocrTotal <= 1;
  _ocrAndShow(ocrQueue.shift());
}

function _advanceQueue() {
  if (ocrQueue.length) { _processNext(); return true; }
  if (ocrTotal > 1) {
    const s = $("ocr-status");
    s.hidden = false;
    s.className = "status ok";
    s.textContent = `✅ ${ocrTotal}枚すべて処理しました。`;
  }
  ocrTotal = 0;
  $("skip-btn").hidden = true;
  return false;
}

function skipCurrent() {
  resetForm();
  if (!_advanceQueue()) $("ocr-status").hidden = true;
}

async function _ocrInBrowser(file, status) {
  const canvas = await preprocessImage(file);
  const text = await runClientOcr(canvas, (p) => {
    status.textContent = `🔍 文字を読み取り中… ${Math.round(p * 100)}%`;
  });
  return parseReceipt(text);
}

async function _ocrAndShow(file) {
  log("OCR開始:", file.name, file.type, `${Math.round(file.size / 1024)}KB`,
    OCR_API_BASE ? "(バックエンド)" : "(ブラウザ内PaddleOCR)");
  const status = $("ocr-status");
  status.hidden = false;
  status.className = "status loading";
  status.textContent = `📤 ${_queuePrefix()}読み取り中… (数秒かかります)`;
  try {
    let data;
    if (OCR_API_BASE) {
      try {
        status.textContent = "🤖 AIで読み取り中…";
        data = await requestBackendOcr(
          file,
          () => (currentUser ? currentUser.getIdToken() : ""),
          () => { status.textContent = "🤖 AIサーバーを起動中…（初回は少し時間がかかります）"; },
        );
        const used = data.engine || "不明";
        log("バックエンド読み取り成功:", `エンジン=${used}`);
        if (!TRUSTED_ENGINES.includes(used)) {
          logErr(`⚠️ Gemini/Vertex を使えず ${used} にフォールバックしました。AI のキー/課金状態を確認してください。`);
        }
      } catch (err) {
        logErr("バックエンドOCR失敗、ブラウザ内PaddleOCRに切替:", err.message, err);
        status.textContent = "🔍 文字を読み取り中…（PaddleOCR・初回はモデル取得で時間がかかります）";
        data = await _ocrInBrowser(file, status);
      }
    } else {
      data = await _ocrInBrowser(file, status);
    }
    log("OCR完了。抽出結果:", data);
    if (data && !TRUSTED_ENGINES.includes(data.engine)) {
      data = await normalizeWithHistory(data, fetchAllExpenses);
    }
    fillForm(data, URL.createObjectURL(file));
    status.className = "status ok";
    status.textContent =
      `✅ ${_queuePrefix()}読み取りました。内容を確認して保存してください。` +
      (ocrTotal > 1 ? "（保存すると次の画像へ進みます）" : "");
    $("form-card").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    logErr("OCRエラー:", err.message || err, err);
    status.className = "status error";
    status.textContent = `⚠️ ${_queuePrefix()}` + (err.message || err) +
      (ocrTotal > 1 ? "（「スキップ」で次へ進めます）" : "");
  }
}
