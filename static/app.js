// レシート家計簿 — エントリポイント（司令塔）。
//
// 各モジュールを初期化し、コールバックで結線するだけにとどめる。
// ビジネスロジックや DOM 操作は各専門モジュールに委譲している。
//
// モジュール一覧:
//   firebase-init.js   : Firebase 初期化
//   app-state.js       : 共有ミュータブル状態
//   auth.js            : 認証（Google / メール / インアプリブラウザ）
//   firestore-data.js  : Firestore データアクセス
//   summary.js         : サマリー描画・最安値アラート
//   ocr-queue.js       : OCR キュー管理
//   csv-export.js      : CSV エクスポート
//   expense-form.js    : 入力フォーム・編集・削除
//   list-view.js       : 店舗別一覧の描画
//   calendar-view.js   : カレンダー・週計・日付モーダル
//   compare-view.js    : 最安値比較モーダル
//   ocr-client.js      : 画像縮小・バックエンドOCR・ブラウザ内PaddleOCR
//   history.js         : 履歴正規化（Gemini基準の正解辞書）
//   stats.js           : カテゴリ集計（純粋関数）
//   parser.js          : OCRテキスト → 家計簿項目の抽出
//   dom-utils.js       : DOM取得・表示整形・モーダル共通
//   log.js             : デバッグログ

import { CATEGORIES } from "./firebase-config.js";
import { apiJson } from "./api-client.js";
import { log, logErr } from "./log.js";
import { $, dayKey, monthKey, monthLabel, bindModalDismiss, openModal, closeModal } from "./dom-utils.js";
import { state } from "./app-state.js";
import { watchAuthState, auth, signOut } from "./auth.js";
import { db } from "./firebase-init.js";
import {
  expensesCol, fetchAllExpenses, fetchMonthExpenses,
  subscribeMonth, addCalendarExpense,
} from "./firestore-data.js";
import { renderSummary, thisMonthCount } from "./summary.js";
import { handleFiles, advanceQueue, skipCurrent, prewarmOcr } from "./ocr-queue.js";
import { exportCsv } from "./csv-export.js";
import { initForm, fillForm, resetForm, editExpense, deleteExpense, inlineSave } from "./expense-form.js";
import { renderList, setFilter, resetList } from "./list-view.js";
import { initCalendar, renderCalendar, maybeRefreshDayModal, updateMealPlans } from "./calendar-view.js";
import { initCompare } from "./compare-view.js";
import { initRecipe, openRecipeModal, clearExpensesCache } from "./recipe-view.js";
import { initBudget, loadBudget, getBudget, renderBudgetBars } from "./budget-view.js";
import { initTrend } from "./trend-view.js";
import { initSavedRecipes } from "./saved-recipes.js";
import { initShoppingList, startSync as startShoppingSync, stopSync as stopShoppingSync } from "./shopping-list.js";
import { initMealPlan, startMealPlanSync, stopMealPlanSync } from "./meal-plan.js";
import { dbSetUser } from "./db-paths.js";
import {
  initBilling, startBillingSync, stopBillingSync, ensureTrial,
  checkGate, renderUsageBar, isPremium, openPortal, premiumExpiryLabel,
} from "./stripe-billing.js";

window.addEventListener("error", (e) => logErr("未捕捉エラー:", e.message, e.filename, e.lineno));
window.addEventListener("unhandledrejection", (e) => logErr("未処理のPromise拒否:", e.reason));
log("app.js 読み込み開始");

// ---- Stripe Checkout リダイレクト結果 --------------------------------------
const _checkoutResult = (() => {
  const params = new URLSearchParams(location.search);
  const result = params.get("checkout");
  if (!result) return null;
  history.replaceState(null, "", location.pathname);
  const s = document.createElement("div");
  if (result === "success") {
    s.className = "toast toast-success";
    s.textContent = "🎉 プレミアムプランへようこそ！サブスクリプションを確認中…";
    setTimeout(() => s.remove(), 8000);
  } else if (result === "cancel") {
    s.className = "toast";
    s.textContent = "支払いはキャンセルされました。";
    setTimeout(() => s.remove(), 4000);
  }
  if (result === "success" || result === "cancel") document.body.appendChild(s);
  return result;
})();

// GA4 の収益レポートに使う金額。static/index.html の表示価格（¥500/月）と
// 必ず一致させること。プラン変更時はそちらも合わせて直す。
const PREMIUM_PLAN_JPY = 500;

async function _syncStripeSubscription(user) {
  if (_checkoutResult !== "success") return;
  try {
    const token = await user.getIdToken();
    const data = await apiJson("/api/stripe/sync", {
      token, method: "POST", body: { email: user.email },
    });
    log("Stripe 同期:", data.status);
    // Checkout の URL パラメータは _checkoutResult 生成時に history.replaceState で
    // 消しているため、リロードでは再発火しない。webhook 側の反映と二重にならない
    // よう、購入の確定計測はここ（フロント）だけに置く。
    if (
      (data.status === "active" || data.status === "trialing") &&
      typeof window.trackEvent === "function"
    ) {
      window.trackEvent("purchase", {
        currency: "JPY",
        value: PREMIUM_PLAN_JPY,
        items: [{ item_name: "プレミアムプラン", price: PREMIUM_PLAN_JPY, quantity: 1 }],
      });
    }
  } catch (e) {
    logErr("Stripe 同期エラー:", e.message);
  }
}

// ---- 月ナビゲーション -------------------------------------------------------
function _renderMonth() {
  $("current-month").textContent = monthLabel(state.currentMonth);
  const todayBtn = $("today-month");
  if (todayBtn) {
    const isCurrentMonth = monthKey(state.currentMonth) === monthKey(new Date());
    todayBtn.hidden = isCurrentMonth;
  }
}

function _shiftMonth(delta) {
  state.currentMonth.setMonth(state.currentMonth.getMonth() + delta);
  _renderMonth();
  subscribeMonth(_onSnapshotUpdate);
}

function _jumpToMonthOf(dateStr) {
  const target = new Date(dateStr + "T00:00:00");
  if (monthKey(target) !== monthKey(state.currentMonth)) {
    state.currentMonth = target;
    _renderMonth();
    subscribeMonth(_onSnapshotUpdate);
  }
}

// ---- Firestore 購読コールバック --------------------------------------------
function _onSnapshotUpdate(expenses) {
  clearExpensesCache();
  renderList(expenses, { onEdit: editExpense, onDelete: _deleteAndClearCache, onInlineSave: _inlineSave });
  renderCalendar(expenses, state.currentMonth);
  maybeRefreshDayModal();
  requestAnimationFrame(renderSummary);
}

// ---- キャッシュ付きコールバック --------------------------------------------
async function _deleteAndClearCache(id) {
  await deleteExpense(id);
  state.allExpensesCache = null;
}

async function _inlineSave(id, payload) {
  await inlineSave(id, payload);
  state.allExpensesCache = null;
}

function _onFormSaved(dateStr, wasEdit) {
  state.allExpensesCache = null;
  _jumpToMonthOf(dateStr);
  if (wasEdit) $("expense-list").scrollIntoView({ behavior: "smooth" });
  if (!advanceQueue()) $("ocr-status").hidden = true;
}

async function _addCalendarExpenseChecked({ date, store, amount, category }) {
  if (!checkGate(thisMonthCount())) return;
  await addCalendarExpense({ date, store, amount, category });
  _jumpToMonthOf(date);
}

// ---- アプリ初期化 ----------------------------------------------------------
let appInitialized = false;
let _setupRunning  = false;

async function setupApp(user) {
  if (_setupRunning) return;
  _setupRunning = true;
  dbSetUser(user.uid);

  if (!appInitialized) {
    // カテゴリ選択肢を生成
    const sel = $("f-category");
    for (const c of CATEGORIES) sel.add(new Option(c, c));

    const catFilter = $("list-cat-filter");
    if (catFilter) {
      for (const c of CATEGORIES) catFilter.add(new Option(c, c));
      const _debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
      $("list-search").oninput = _debounce((e) => setFilter(e.target.value, catFilter.value), 300);
      catFilter.onchange       = (e) => setFilter($("list-search").value, e.target.value);
    }

    initForm({
      // 新規追加は firestore-data の expensesCol() を使うが、更新・削除は
      // expense-form 内で doc(db, ...) を組み立てるため db の実体が要る。
      // ここを null にすると編集・更新・削除が
      // 「Expected first argument to collection() to be ...」で失敗する。
      db,
      getUser:      () => state.currentUser,
      expensesCol,
      onSaved:      _onFormSaved,
      onBeforeSave: () => checkGate(thisMonthCount()),
    });
    initCalendar({
      onAddExpense: _addCalendarExpenseChecked,
      onEdit:       editExpense,
      onDelete:     _deleteAndClearCache,
      onInlineSave: _inlineSave,
    });
    initCompare({ fetchAllExpenses });
    initRecipe({ getToken: () => state.currentUser?.getIdToken(), fetchAllExpenses, getBudget, db, getUser: () => state.currentUser });
    initBudget({
      db,
      getUser:          () => state.currentUser,
      categories:       CATEGORIES,
      onUpdated:        renderSummary,
      getCurrentMonth:  () => state.currentMonth,
    });
    initTrend({ fetchMonthExpenses });
    initSavedRecipes({ db, getUser: () => state.currentUser });
    initShoppingList({ db, getUser: () => state.currentUser });
    initMealPlan({ db, getUser: () => state.currentUser });
    initBilling({ db, getUser: () => state.currentUser, onSubChange: () => renderSummary() });
    $("usage-bar").querySelector(".usage-upgrade").onclick = () => openModal("upgrade-modal");

    // アカウントモーダル
    // アップグレードCTAボタン（無料ユーザーのみtopbarに表示）
    const _upgradeCta = $("upgrade-cta-btn");
    if (_upgradeCta) {
      _upgradeCta.onclick = () => openModal("upgrade-modal");
    }

    $("account-btn").onclick = () => {
      $("account-user-email").textContent = state.currentUser?.email ?? "";
      const premium = isPremium();
      $("account-plan-free").hidden    = premium;
      $("account-plan-premium").hidden = !premium;
      const expiry = premiumExpiryLabel();
      $("account-plan-expiry").hidden  = !expiry;
      $("account-plan-expiry").textContent = expiry ?? "";
      // topbarのアップグレードCTA：無料ユーザーのみ表示
      if (_upgradeCta) _upgradeCta.hidden = premium;
      openModal("account-modal");
    };
    $("account-close").onclick      = () => closeModal("account-modal");
    $("account-upgrade-btn").onclick = () => { closeModal("account-modal"); openModal("upgrade-modal"); };
    $("account-portal-btn").onclick  = () => openPortal();
    $("logout").onclick              = () => { stopShoppingSync(); stopMealPlanSync(); signOut(auth); };
    $("prev-month").onclick          = () => _shiftMonth(-1);
    $("next-month").onclick          = () => _shiftMonth(1);
    $("empty-cta-btn")?.addEventListener("click", () => $("fab-camera")?.click());
    $("today-month")?.addEventListener("click", () => {
      state.currentMonth = new Date();
      _renderMonth();
      subscribeMonth(_onSnapshotUpdate);
    });
    $("file-input").onchange         = handleFiles;
    $("camera-input").onchange       = handleFiles;
    $("skip-btn").onclick            = skipCurrent;
    $("fab-camera").onclick          = () => $("camera-input").click();
    $("bnav-home").onclick           = () => window.scrollTo({ top: 0, behavior: "smooth" });
    $("bnav-calendar").onclick       = () => $("calendar").scrollIntoView({ behavior: "smooth" });
    $("bnav-shopping").onclick       = () => $("shopping-btn").click();
    $("bnav-recipe").onclick         = () => openRecipeModal({
      selectedDay: dayKey(new Date()),
      expenses:    state.currentExpenses,
      initialPeriod: "month",
    });

    // スマホ「もっと見る」ドロワー
    const _drawer = $("bnav-more-drawer");
    const _closeDrawer = () => { _drawer.hidden = true; };
    $("bnav-more").onclick        = () => { _drawer.hidden = false; };
    $("bnav-more-overlay").onclick = _closeDrawer;
    $("bnav-saved").onclick       = () => { _closeDrawer(); $("saved-recipes-btn").click(); };
    $("bnav-compare").onclick     = () => { _closeDrawer(); $("compare-btn").click(); };
    $("bnav-budget").onclick      = () => { _closeDrawer(); $("budget-btn").click(); };
    $("bnav-trend").onclick       = () => { _closeDrawer(); $("trend-btn").click(); };

    $("export-btn").onclick = exportCsv;

    // PC ナビ
    $("pcnav-home").onclick     = () => window.scrollTo({ top: 0, behavior: "smooth" });
    $("pcnav-calendar").onclick = () => $("calendar").scrollIntoView({ behavior: "smooth" });
    $("pcnav-recipe").onclick   = () => openRecipeModal({
      selectedDay: dayKey(new Date()),
      expenses:    state.currentExpenses,
      initialPeriod: "month",
    });
    $("pcnav-shopping").onclick = () => $("shopping-btn").click();
    $("pcnav-saved").onclick    = () => $("saved-recipes-btn").click();
    $("pcnav-compare").onclick  = () => $("compare-btn").click();
    $("pcnav-budget").onclick   = () => $("budget-btn").click();
    $("pcnav-trend").onclick    = () => $("trend-btn").click();

    bindModalDismiss();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js")
        .then((r) => log("SW 登録:", r.scope))
        .catch((err) => logErr("SW 登録失敗:", err.message));
    }

    prewarmOcr();
    appInitialized = true;
  }

  try {
    startBillingSync();
    ensureTrial();
    _syncStripeSubscription(user);
    await loadBudget();
    renderSummary();
    startShoppingSync();
    startMealPlanSync((map) => {
      updateMealPlans(map);
      renderCalendar(state.currentExpenses, state.currentMonth);
      maybeRefreshDayModal();
    });
    _renderMonth();
    // リダイレクトログイン直後にトークンが未確定の場合があるため
    // Firestoreを購読する前に強制リフレッシュして権限エラーを防ぐ
    await user.getIdToken(/* forceRefresh= */ true).catch(() => {});
    subscribeMonth(_onSnapshotUpdate);
  } finally {
    _setupRunning = false;
  }
}

function teardownApp() {
  if (state.unsubscribe) state.unsubscribe();
  stopShoppingSync();
  stopMealPlanSync();
  stopBillingSync();
  state.allExpensesCache = null;
  state.allExpensesCacheAt = 0;
  resetList();
  closeModal("upgrade-modal");
  closeModal("account-modal");
}

// ---- タブ非表示時にFirestore購読を停止してコスト削減 -----------------------
// ---- オフライン通知 --------------------------------------------------------
// Service Worker でオフラインキャッシュを持っているのに、通信断を利用者に
// 伝える手段が無かった。地下やエレベーターでレシートを撮ると
// 「保存に失敗しました: Failed to fetch」とだけ出て原因が分からなかった。
const _offlineBar = (() => {
  let bar = null;
  const show = () => {
    if (bar) return;
    bar = document.createElement("div");
    bar.className = "offline-bar";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");
    bar.textContent = "オフラインです。通信が戻ると自動で同期されます。";
    document.body.appendChild(bar);
  };
  const hide = () => { if (bar) { bar.remove(); bar = null; } };
  return { show, hide };
})();

window.addEventListener("offline", () => _offlineBar.show());
window.addEventListener("online", () => _offlineBar.hide());
// 起動時点で既にオフラインの場合もある
if (navigator.onLine === false) _offlineBar.show();

document.addEventListener("visibilitychange", () => {
  if (!appInitialized) return;
  if (document.hidden) {
    if (state.unsubscribe) { state.unsubscribe(); state.unsubscribe = null; }
  } else {
    subscribeMonth(_onSnapshotUpdate);
  }
});

// ---- 認証状態の監視（エントリ） --------------------------------------------
watchAuthState(setupApp, teardownApp);
