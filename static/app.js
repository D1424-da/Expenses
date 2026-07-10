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
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc,
  query, where, orderBy, onSnapshot, getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { firebaseConfig, OCR_API_BASE, CATEGORIES } from "./firebase-config.js";
import { parseReceipt } from "./parser.js";
import { log, logErr } from "./log.js";
import {
  $, yen, monthKey, monthLabel, renderCatBars, bindModalDismiss,
} from "./dom-utils.js";
import { requestBackendOcr, preprocessImage, runClientOcr, prewarmOcr } from "./ocr-client.js";
import { TRUSTED_ENGINES, normalizeWithHistory } from "./history.js";
import { categoryBreakdown } from "./stats.js";
import { initForm, fillForm, resetForm, editExpense, deleteExpense } from "./expense-form.js";
import { renderList } from "./list-view.js";
import { initCalendar, renderCalendar, maybeRefreshDayModal } from "./calendar-view.js";
import { initCompare } from "./compare-view.js";
import { initRecipe, openRecipeModal } from "./recipe-view.js";
import { initBudget, loadBudget, getBudget, renderBudgetBars } from "./budget-view.js";
import { initTrend } from "./trend-view.js";
import { initSavedRecipes } from "./saved-recipes.js";
import { initShoppingList, startSync as startShoppingSync, stopSync as stopShoppingSync } from "./shopping-list.js";
import { lowestPriceAlerts } from "./stats.js";

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
    $("app").hidden = true;
    $("login-screen").hidden = false;
  }
});

$("google-login").onclick = async () => {
  log("ログインボタン押下 → signInWithPopup 開始");
  $("login-error").hidden = true;
  try {
    const result = await signInWithPopup(auth, provider);
    log("ポップアップログイン成功:", result.user.email);
  } catch (err) {
    logErr("signInWithPopup でエラー:", err.code, err.message, err);
    const el = $("login-error");
    el.textContent = "ログインに失敗しました: " + (err.code || err.message);
    el.hidden = false;
  }
};

// ---- アプリ初期化 ----------------------------------------------------------
let appInitialized = false;
function setupApp() {
  if (!appInitialized) {
    const sel = $("f-category");
    for (const c of CATEGORIES) sel.add(new Option(c, c));

    initForm({
      db,
      getUser: () => currentUser,
      expensesCol,
      onSaved: _onFormSaved,
    });
    initCalendar({
      onAddExpense: _addCalendarExpense,
      onEdit: editExpense,
      onDelete: deleteExpense,
      onRecipeSuggest: (selectedDay, expenses) =>
        openRecipeModal({ selectedDay, expenses, initialPeriod: "day" }),
    });
    initCompare({ fetchAllExpenses });
    initRecipe({ getToken: () => currentUser?.getIdToken() });
    initBudget({ db, getUser: () => currentUser, categories: CATEGORIES, onUpdated: renderSummary });
    initTrend({ fetchMonthExpenses });
    initSavedRecipes({ db, getUser: () => currentUser });
    initShoppingList({ db, getUser: () => currentUser });

    $("logout").onclick = () => { stopShoppingSync(); signOut(auth); };
    $("prev-month").onclick = () => shiftMonth(-1);
    $("next-month").onclick = () => shiftMonth(1);
    $("file-input").onchange = handleFiles;
    $("camera-input").onchange = handleFiles;
    $("file-input").onclick = prewarmOcr;
    $("camera-input").onclick = prewarmOcr;
    $("skip-btn").onclick = skipCurrent;
    bindModalDismiss();

    prewarmOcr();
    appInitialized = true;
  }
  loadBudget().then(renderSummary);
  startShoppingSync();
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
  return collection(db, "users", currentUser.uid, "expenses");
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
    expensesCol(),
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
    expensesCol(),
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
      renderSummary();
      renderCalendar(currentExpenses, currentMonth);
      maybeRefreshDayModal();
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

async function _refreshAlerts() {
  const el = $("lowest-alerts");
  if (!el) return;
  try {
    const all = await fetchAllExpenses();
    const alerts = lowestPriceAlerts(all, currentExpenses);
    if (!alerts.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<div class="alert-title">🎉 今月のお得な買い物</div>` +
      alerts.map((a) =>
        `<div class="alert-row">
          <span class="alert-name">${a.name}</span>
          <span class="alert-detail">${a.store} <strong>${yen(a.price)}</strong>（過去最安！）</span>
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
  _jumpToMonthOf(date);
}

// ---- フォーム保存後のコールバック（expense-form のコールバック） ------------
function _onFormSaved(dateStr, wasEdit) {
  _jumpToMonthOf(dateStr);
  if (wasEdit) $("expense-list").scrollIntoView({ behavior: "smooth" });
  if (!_advanceQueue()) $("ocr-status").hidden = true;
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
