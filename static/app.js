// レシート家計簿 — フロントエンドのエントリポイント（画面のオーケストレーション）。
//
// 役割分担:
//   log.js        : デバッグログ
//   dom-utils.js  : DOM取得・表示整形・モーダル共通処理
//   ocr-client.js : 画像縮小・バックエンドOCR呼び出し・ブラウザ内PaddleOCR
//   history.js    : 履歴正規化（Gemini基準の正解辞書）
//   stats.js      : カテゴリ内訳・最安値比較の集計（純粋関数）
//   parser.js     : OCRテキスト → 家計簿項目の抽出
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  getDocs,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { firebaseConfig, OCR_API_BASE, CATEGORIES } from "./firebase-config.js";
import { parseReceipt } from "./parser.js";
import { log, logErr } from "./log.js";
import {
  $, yen, monthKey, monthLabel, dayKey, todayStr, WEEKDAYS,
  escapeHtml, openModal, closeModal, bindModalDismiss,
} from "./dom-utils.js";
import {
  requestBackendOcr, preprocessImage, runClientOcr, prewarmOcr,
} from "./ocr-client.js";
import {
  TRUSTED_ENGINES, normalizeWithHistory, invalidateHistoryDict,
} from "./history.js";
import { categoryBreakdown, normName, summarizeByStore } from "./stats.js";

// 想定外の例外も全部拾う
window.addEventListener("error", (e) => logErr("未捕捉エラー:", e.message, e.filename, e.lineno));
window.addEventListener("unhandledrejection", (e) => logErr("未処理のPromise拒否:", e.reason));
log("app.js 読み込み開始");

// ---- Firebase 初期化 -------------------------------------------------------
// レシート画像は保存しない（Cloud Storage 不要 = 無料の Spark プランで動く）。
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const provider = new GoogleAuthProvider();
// 高精度な AI 読み取り（Gemini）は OCR バックエンド経由で行う。
// API キーをフロントに置くと公開され Google に無効化されるため、
// キーはサーバー側の環境変数に保持し、ここでは OCR_API_BASE を呼ぶだけにする。
log("Firebase初期化完了", {
  projectId: firebaseConfig.projectId,
  authDomain: firebaseConfig.authDomain,
  origin: location.origin,
  href: location.href,
});

// ---- 状態 ------------------------------------------------------------------
let currentUser = null;
let currentMonth = new Date(); // 表示中の月
let currentExpenses = []; // 当月の支出（リアルタイム同期）
let unsubscribe = null; // Firestore リスナー解除関数

// ---- 認証 ------------------------------------------------------------------
// ポップアップ方式は COOP（Cross-Origin-Opener-Policy）で弾かれる環境があるため、
// リダイレクト方式でログインする。
onAuthStateChanged(auth, (user) => {
  log("認証状態の変化:", user ? `ログイン中 (${user.email})` : "未ログイン");
  currentUser = user;
  if (user) {
    $("login-screen").hidden = true;
    $("app").hidden = false;
    setupApp();
  } else {
    if (unsubscribe) unsubscribe();
    $("app").hidden = true;
    $("login-screen").hidden = false;
  }
});

function showLoginError(err) {
  const el = $("login-error");
  el.textContent = "ログインに失敗しました: " + (err.code || err.message);
  el.hidden = false;
}

// リダイレクトから戻ってきた結果を確認（成功/失敗をログに出す）
log("リダイレクト結果を確認中…");
getRedirectResult(auth)
  .then((result) => {
    if (result && result.user) {
      log("リダイレクトログイン成功:", result.user.email);
    } else {
      log("リダイレクト結果なし（通常のページ読み込み、または未ログイン）");
    }
  })
  .catch((err) => {
    logErr("リダイレクト結果でエラー:", err.code, err.message, err);
    showLoginError(err);
  });

$("google-login").onclick = async () => {
  log("ログインボタン押下 → signInWithRedirect 開始");
  $("login-error").hidden = true;
  try {
    await signInWithRedirect(auth, provider);
    log("signInWithRedirect 呼び出し完了（Googleへ遷移するはず）");
  } catch (err) {
    logErr("signInWithRedirect でエラー:", err.code, err.message, err);
    showLoginError(err);
  }
};

let appInitialized = false;
function setupApp() {
  if (!appInitialized) {
    populateCategories();
    bindEvents();
    resetForm();
    prewarmOcr(); // レシート読み取りを速くするため、裏でOCRエンジンを準備しておく
    appInitialized = true;
  }
  renderMonth();
  subscribeMonth();
}

function populateCategories() {
  const sel = $("f-category");
  for (const c of CATEGORIES) {
    sel.add(new Option(c, c));
  }
}

function bindEvents() {
  $("logout").onclick = () => signOut(auth);
  $("prev-month").onclick = () => shiftMonth(-1);
  $("next-month").onclick = () => shiftMonth(1);
  $("file-input").onchange = handleFiles; // アルバムから複数選択
  $("camera-input").onchange = handleFiles; // その場で撮影（1枚ずつ）
  // カメラやアルバムを開く瞬間にもバックエンドを起こす。操作している間に起動が
  // 進むので、放置後でも読み取り開始までの待ち時間を短縮できる。
  $("file-input").onclick = prewarmOcr;
  $("camera-input").onclick = prewarmOcr;
  $("expense-form").onsubmit = handleSubmit;
  $("reset-btn").onclick = resetForm;
  $("skip-btn").onclick = skipCurrent;
  $("compare-btn").onclick = openCompare;
  $("compare-close").onclick = () => closeModal("compare-modal");
  bindModalDismiss();
  $("compare-search").oninput = renderCompare;
  // カレンダー: カテゴリ候補を埋め、日付タップ用モーダルのイベントを束ねる
  for (const c of CATEGORIES) $("day-category").add(new Option(c, c));
  $("day-category").value = "食費";
  $("day-close").onclick = () => closeModal("day-modal");
  $("day-form").onsubmit = handleDayAdd;
  $("week-close").onclick = () => closeModal("week-modal");
}

function shiftMonth(delta) {
  currentMonth.setMonth(currentMonth.getMonth() + delta);
  renderMonth();
  subscribeMonth();
}

function renderMonth() {
  $("current-month").textContent = monthLabel(currentMonth);
}

// ---- Firestore（当月をリアルタイム購読） -----------------------------------
function expensesCol() {
  return collection(db, "users", currentUser.uid, "expenses");
}

// 履歴正規化・最安値比較用: 全期間の支出データを取得する。
async function fetchAllExpenses() {
  const snap = await getDocs(expensesCol());
  return snap.docs.map((d) => d.data());
}

function subscribeMonth() {
  if (unsubscribe) unsubscribe();
  const start = monthKey(currentMonth) + "-01";
  // 翌月1日（文字列比較の上限）
  const next = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
  const end = monthKey(next) + "-01";

  const q = query(
    expensesCol(),
    where("date", ">=", start),
    where("date", "<", end),
    orderBy("date", "desc")
  );
  log("Firestore購読開始:", monthKey(currentMonth), "uid:", currentUser.uid);
  unsubscribe = onSnapshot(
    q,
    (snap) => {
      currentExpenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      log("Firestore更新:", currentExpenses.length, "件");
      renderList();
      renderSummary();
      renderCalendar();
      if (!$("day-modal").hidden) renderDayModal(); // 開いていれば内容を更新
    },
    (err) => {
      logErr("Firestore購読エラー:", err.code, err.message, err);
      $("ocr-status").hidden = false;
      $("ocr-status").className = "status error";
      $("ocr-status").textContent =
        "データ取得に失敗しました（Firebaseの設定/ルールを確認してください）: " + err.message;
    }
  );
}

// ---- OCR 取り込み（複数枚対応） --------------------------------------------
let ocrQueue = []; // これから処理する画像
let ocrTotal = 0; // 今回選んだ合計枚数
let currentPreviewUrl = null; // プレビュー用の Object URL（メモリ解放のため保持）

function handleFiles(e) {
  const files = [...e.target.files];
  e.target.value = ""; // 同じファイルを再選択できるように
  if (!files.length) return;
  ocrQueue = files;
  ocrTotal = files.length;
  processNext();
}

function queuePrefix() {
  // 「(2/5枚目)」のような表示。1枚だけなら空。
  if (ocrTotal <= 1) return "";
  const idx = ocrTotal - ocrQueue.length; // 現在処理中の番号
  return `(${idx}/${ocrTotal}枚目) `;
}

function processNext() {
  if (ocrQueue.length === 0) {
    ocrTotal = 0;
    $("skip-btn").hidden = true;
    return;
  }
  const file = ocrQueue.shift();
  $("skip-btn").hidden = ocrTotal <= 1; // 複数枚のときだけ「スキップ」を出す
  ocrAndShow(file);
}

// 保存/スキップ後に次の画像へ進む。なければ片付け。
function advanceQueue() {
  if (ocrQueue.length > 0) {
    processNext();
    return true;
  }
  if (ocrTotal > 1) {
    const status = $("ocr-status");
    status.hidden = false;
    status.className = "status ok";
    status.textContent = `✅ ${ocrTotal}枚すべて処理しました。`;
  }
  ocrTotal = 0;
  $("skip-btn").hidden = true;
  return false;
}

function skipCurrent() {
  resetForm();
  if (!advanceQueue()) $("ocr-status").hidden = true;
}

// ブラウザ内 PaddleOCR で読み取り、既存パーサで構造化する。
async function ocrInBrowser(file, status) {
  const canvas = await preprocessImage(file);
  const text = await runClientOcr(canvas, (p) => {
    status.textContent = `🔍 文字を読み取り中… ${Math.round(p * 100)}%`;
  });
  return parseReceipt(text);
}

async function ocrAndShow(file) {
  log("OCR開始:", file.name, file.type, `${Math.round(file.size / 1024)}KB`, OCR_API_BASE ? "(バックエンド)" : "(ブラウザ内PaddleOCR)");
  const status = $("ocr-status");
  status.hidden = false;
  status.className = "status loading";
  status.textContent = `📤 ${queuePrefix()}読み取り中… (数秒かかります)`;

  try {
    let data;
    if (OCR_API_BASE) {
      // OCRバックエンド(FastAPI)を使う設定の場合。高精度AI(Gemini)もここ経由。
      // 失敗時はブラウザ内OCRにフォールバックする。
      try {
        status.textContent = "🤖 AIで読み取り中…";
        data = await requestBackendOcr(
          file,
          () => (currentUser ? currentUser.getIdToken() : ""),
          () => {
            status.textContent = "🤖 AIサーバーを起動中…（初回は少し時間がかかります）";
          },
        );
        const used = data.engine || "不明";
        log("バックエンド読み取り成功:", `エンジン=${used}`);
        if (TRUSTED_ENGINES.includes(used)) {
          log(`✅ 高精度AI（${used}）で読み取りました`);
        } else {
          logErr(
            `⚠️ Gemini/Vertex を使えず ${used} にフォールバックしました。` +
            "AI のキー/課金状態を確認してください（429=クレジット枯渇など）。",
          );
        }
      } catch (err) {
        logErr("バックエンドOCR失敗、ブラウザ内PaddleOCRに切替:", err.message, err);
        status.textContent = "🔍 文字を読み取り中…（PaddleOCR・初回はモデル取得で時間がかかります）";
        data = await ocrInBrowser(file, status);
      }
    } else {
      // ブラウザ内で PaddleOCR を使って OCR（サーバー不要）
      data = await ocrInBrowser(file, status);
    }
    log("OCR完了。抽出結果:", data);
    // 高精度AI（Gemini / Vertex）以外（Vision / PaddleOCR）は抽出精度が低いので、
    // 過去に Gemini/Vertex で保存したデータ（店名・支店・商品名・カテゴリ）を
    // 正解辞書として正規化する。
    if (data && !TRUSTED_ENGINES.includes(data.engine)) {
      data = await normalizeWithHistory(data, fetchAllExpenses);
    }
    // 画像は保存しないが、確認用にその場でプレビュー表示する
    fillForm(data, URL.createObjectURL(file));
    status.className = "status ok";
    status.textContent =
      `✅ ${queuePrefix()}読み取りました。内容を確認して保存してください。` +
      (ocrTotal > 1 ? "（保存すると次の画像へ進みます）" : "");
    $("form-card").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    logErr("OCRエラー:", err.message || err, err);
    status.className = "status error";
    status.textContent = `⚠️ ${queuePrefix()}` + (err.message || err) +
      (ocrTotal > 1 ? "（「スキップ」で次へ進めます）" : "");
  }
}

// ---- フォーム --------------------------------------------------------------
function fillForm(data, previewUrl) {
  // OCR取り込みは新規追加。編集中にレシートを読み取った場合でも編集モード
  // （バナー・枠線・「更新する」表示）を確実に解除してから埋める。
  setFormMode("add");
  $("form-title").textContent = "読み取り結果を確認";
  $("f-id").value = "";
  $("f-date").value = data.date || todayStr();
  $("f-amount").value = data.amount || 0;
  $("f-store").value = data.store || "";
  $("f-branch").value = data.branch || "";
  $("f-category").value = data.category || "その他";
  $("f-memo").value = "";
  $("f-image-url").value = "";
  $("f-rawtext").value = data.raw_text || "";
  // どのエンジンで抽出したか記録（保存時に ocrEngine として残し、正解辞書の判定に使う）
  $("f-engine").value = data.engine || "";
  renderItems(data.items || []);
  showPreview(previewUrl);
}

function showPreview(url) {
  const preview = $("form-preview");
  // 直前のプレビュー画像（Object URL）を解放する。複数枚を続けて読み取ると
  // 解放しないままだとスマホ写真（各数MB）がメモリに溜まり、フリーズや
  // クラッシュの原因になる。
  if (currentPreviewUrl && currentPreviewUrl !== url) {
    URL.revokeObjectURL(currentPreviewUrl);
    currentPreviewUrl = null;
  }
  if (url) {
    currentPreviewUrl = url;
    $("preview-img").src = url;
    preview.hidden = false;
  } else {
    $("preview-img").removeAttribute("src");
    preview.hidden = true;
  }
}

function renderItems(items) {
  $("items-list").innerHTML = "";
  for (const it of items) addItemRow(it.name, it.price, it.category);
  updateItemsCount();
}

function addItemRow(name = "", price = 0, category = "") {
  const row = document.createElement("div");
  row.className = "item-row";
  // 行のカテゴリ初期値: AI/保存値 → 未指定なら支出全体のカテゴリ → "その他"。
  let selected = category || $("f-category").value || "その他";
  if (!CATEGORIES.includes(selected)) selected = "その他";
  const options = CATEGORIES.map(
    (c) => `<option value="${c}"${c === selected ? " selected" : ""}>${c}</option>`,
  ).join("");
  row.innerHTML = `
    <input type="text" class="item-name" value="${escapeHtml(name)}" placeholder="品目" />
    <input type="number" class="item-price" value="${price || 0}" min="0" step="1" inputmode="numeric" />
    <select class="item-category" aria-label="明細カテゴリ">${options}</select>
    <button type="button" aria-label="削除">✕</button>`;
  row.querySelector("button").onclick = () => {
    row.remove();
    updateItemsCount();
  };
  $("items-list").appendChild(row);
  updateItemsCount();
}

function collectItems() {
  return [...document.querySelectorAll(".item-row")]
    .map((r) => ({
      name: r.querySelector(".item-name").value.trim(),
      price: Number(r.querySelector(".item-price").value) || 0,
      category: r.querySelector(".item-category").value,
    }))
    .filter((it) => it.name || it.price);
}

function updateItemsCount() {
  $("items-count").textContent = document.querySelectorAll(".item-row").length;
}

function resetForm() {
  $("expense-form").reset();
  $("f-id").value = "";
  $("f-image-url").value = "";
  $("f-rawtext").value = "";
  $("f-engine").value = "manual"; // 手入力。正解辞書には含めない
  $("items-list").innerHTML = "";
  showPreview(null);
  updateItemsCount();
  $("f-date").value = todayStr();
  setFormMode("add");
}

// 保存/追加した支出の月が表示中の月と違えば、その月へ移動して購読し直す。
function jumpToMonthOf(dateStr) {
  const target = new Date(dateStr + "T00:00:00");
  if (monthKey(target) !== monthKey(currentMonth)) {
    currentMonth = target;
    renderMonth();
    subscribeMonth();
  }
}

async function handleSubmit(e) {
  e.preventDefault();
  const saveBtn = $("save-btn");
  saveBtn.disabled = true;
  saveBtn.textContent = "保存中…";
  try {
    const id = $("f-id").value;
    const engine = $("f-engine").value;
    const payload = {
      date: $("f-date").value,
      store: $("f-store").value.trim(),
      branch: $("f-branch").value.trim(),
      amount: Number($("f-amount").value) || 0,
      category: $("f-category").value,
      memo: $("f-memo").value.trim(),
      items: collectItems(),
      // 抽出元エンジン。正解辞書（gemini/vertex のみ採用）の判定に使う。
      // 新規のみ未設定を "manual" とする。編集時は元の値を維持し、ocrEngine の
      // 無い旧データ（主に Gemini 由来＝信頼）を "manual" に降格させない。
      ocrEngine: engine || (id ? "" : "manual"),
    };

    log(id ? "更新:" : "新規保存:", payload);
    if (id) {
      // 更新
      await updateDoc(doc(db, "users", currentUser.uid, "expenses", id), payload);
    } else {
      // 新規（レシート画像は保存しない）
      await addDoc(expensesCol(), {
        ...payload,
        rawText: $("f-rawtext").value || "",
        createdAt: serverTimestamp(),
      });
    }
    log("保存成功");
    invalidateHistoryDict(); // 保存で正解辞書が変わるので作り直させる

    // 保存した支出の月へ移動
    jumpToMonthOf($("f-date").value);
    const wasEdit = !!id;
    resetForm();
    // 編集の保存後は、編集元の一覧へ自然に戻す。
    if (wasEdit) $("expense-list").scrollIntoView({ behavior: "smooth" });
    // 複数枚取り込み中なら次の画像へ。なければステータスを消す。
    if (!advanceQueue()) $("ocr-status").hidden = true;
  } catch (err) {
    logErr("保存エラー:", err.code, err.message, err);
    alert("保存に失敗しました: " + err.message);
  } finally {
    saveBtn.disabled = false;
    // 編集中ならラベルを維持（エラーで編集を続ける場合に備える）。
    saveBtn.textContent = $("f-id").value ? "更新する" : "保存";
  }
}

// ---- サマリー --------------------------------------------------------------
function renderSummary() {
  const total = currentExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  $("summary-total").textContent = yen(total);
  $("summary-count").textContent = currentExpenses.length
    ? `${currentExpenses.length}件の記録`
    : "記録なし";

  // カテゴリ別は明細(items)のカテゴリで集計する（レシート全体のカテゴリは使わない）。
  renderCatBars($("category-bars"), categoryBreakdown(currentExpenses));
}

// { カテゴリ: 金額 } をバーで描画する（サマリーと週計内訳で共用）
function renderCatBars(container, byCat) {
  const entries = Object.entries(byCat)
    .filter(([, a]) => a > 0) // 端数調整で生じうる0/負の値は表示しない
    .sort((a, b) => b[1] - a[1]);
  const max = entries.reduce((m, [, a]) => Math.max(m, a), 0);
  container.innerHTML = "";
  for (const [cat, amt] of entries) {
    const row = document.createElement("div");
    row.className = "cat-row";
    const pct = max > 0 ? Math.max(0, (amt / max) * 100) : 0;
    row.innerHTML = `
      <span class="cat-name">${escapeHtml(cat)}</span>
      <span class="cat-bar-wrap"><span class="cat-bar" style="width:${pct}%"></span></span>
      <span class="cat-amount">${yen(amt)}</span>`;
    container.appendChild(row);
  }
}

// ---- カレンダー ------------------------------------------------------------
let selectedDay = null; // 日付モーダルで開いている日（"YYYY-MM-DD"）
let weekBreakdowns = []; // 各週の内訳 [{ start, end, total, byCat }]

// 当月の支出を日付ごとに合計する { "YYYY-MM-DD": 金額 }
function totalsByDay() {
  const map = {};
  for (const e of currentExpenses) {
    if (!e.date) continue;
    map[e.date] = (map[e.date] || 0) + (e.amount || 0);
  }
  return map;
}

// 当月の支出を日付ごとにまとめる { "YYYY-MM-DD": [expense, ...] }
function expensesByDay() {
  const map = {};
  for (const e of currentExpenses) {
    if (!e.date) continue;
    (map[e.date] || (map[e.date] = [])).push(e);
  }
  return map;
}

// 月のカレンダーを描画。各セルにその日の買い物合計、行末に週間合計を出す。
function renderCalendar() {
  const cal = $("calendar");
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const totals = totalsByDay();
  const byDay = expensesByDay();
  const todayKey = dayKey(new Date());
  weekBreakdowns = [];

  // グリッドの先頭は週の頭（日曜）に揃える
  const first = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - first.getDay());

  // 曜日見出し + 「週計」列
  let html = '<div class="cal-grid">';
  for (const w of WEEKDAYS) html += `<div class="cal-dow">${w}</div>`;
  html += '<div class="cal-dow cal-week-h">週計</div>';

  // 当月を覆うのに必要な週数（4〜6週）だけ描く
  const cursor = new Date(gridStart);
  const weeks = Math.ceil((first.getDay() + new Date(year, month + 1, 0).getDate()) / 7);
  for (let w = 0; w < weeks; w++) {
    let weekSum = 0;
    let rowHtml = "";
    const weekExpenses = []; // この週の当月分の支出（内訳集計用）
    let weekStart = null;
    let weekEnd = null;
    for (let i = 0; i < 7; i++) {
      const key = dayKey(cursor);
      const inMonth = cursor.getMonth() === month;
      const amt = totals[key] || 0;
      if (inMonth) {
        weekSum += amt;
        if (byDay[key]) weekExpenses.push(...byDay[key]);
        if (!weekStart) weekStart = new Date(cursor);
        weekEnd = new Date(cursor);
      }
      const cls = [
        "cal-day",
        inMonth ? "" : "cal-out",
        key === todayKey ? "cal-today" : "",
        amt > 0 ? "cal-has" : "",
      ].filter(Boolean).join(" ");
      rowHtml += `<div class="${cls}" data-day="${key}" ${inMonth ? "" : "data-out"}>
          <span class="cal-num">${cursor.getDate()}</span>
          ${amt > 0 ? `<span class="cal-amt">${yen(amt)}</span>` : ""}
        </div>`;
      cursor.setDate(cursor.getDate() + 1);
    }
    weekBreakdowns.push({
      start: weekStart,
      end: weekEnd,
      total: weekSum,
      byCat: categoryBreakdown(weekExpenses),
    });
    const weekCls = "cal-week" + (weekSum > 0 ? " cal-week-click" : "");
    rowHtml += `<div class="${weekCls}" data-week="${w}">${weekSum > 0 ? yen(weekSum) : ""}</div>`;
    html += rowHtml;
  }
  html += "</div>";
  cal.innerHTML = html;

  // 当月の日付タップで入力モーダルを開く（前後月の日は無効）
  cal.querySelectorAll(".cal-day:not(.cal-out)").forEach((el) => {
    el.onclick = () => openDayModal(el.dataset.day);
  });
  // 週計タップでカテゴリ別の内訳を開く
  cal.querySelectorAll(".cal-week-click").forEach((el) => {
    el.onclick = () => openWeekModal(Number(el.dataset.week));
  });
}

// 週計をタップ → その週のカテゴリ別内訳（明細カテゴリで集計）を表示
function openWeekModal(idx) {
  const wk = weekBreakdowns[idx];
  if (!wk) return;
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  $("week-modal-title").textContent =
    wk.start && wk.end ? `${fmt(wk.start)}〜${fmt(wk.end)} の内訳` : "週の内訳";
  $("week-total").textContent = yen(wk.total);
  renderCatBars($("week-bars"), wk.byCat);
  openModal("week-modal");
}

// ---- 日付モーダル（その日の合計確認＋金額の追加入力） ----------------------
function openDayModal(key) {
  selectedDay = key;
  $("day-amount").value = "";
  $("day-store").value = "";
  $("day-category").value = "食費";
  renderDayModal();
  openModal("day-modal");
  $("day-amount").focus();
}

function renderDayModal() {
  if (!selectedDay) return;
  const [y, m, d] = selectedDay.split("-").map(Number);
  $("day-modal-title").textContent = `${y}年${m}月${d}日の買い物`;

  const items = currentExpenses
    .filter((e) => e.date === selectedDay)
    .sort((a, b) => (b.amount || 0) - (a.amount || 0));
  const total = items.reduce((s, e) => s + (e.amount || 0), 0);
  $("day-total").textContent = yen(total);

  const list = $("day-list");
  if (!items.length) {
    list.innerHTML = "<p class='empty'>まだ記録がありません。</p>";
    return;
  }
  list.innerHTML = "";
  for (const e of items) {
    const row = document.createElement("div");
    row.className = "day-row";
    row.innerHTML = `
      <div class="day-row-main">
        <span class="ei-cat">${escapeHtml(e.category)}</span>
        <span class="day-row-store">${escapeHtml(e.store || "(店名なし)")}</span>
      </div>
      <span class="day-row-amt">${yen(e.amount)}</span>
      <button data-act="edit" aria-label="編集">✏️</button>
      <button data-act="del" aria-label="削除">🗑️</button>`;
    row.querySelector('[data-act="edit"]').onclick = () => editExpense(e);
    row.querySelector('[data-act="del"]').onclick = () => deleteExpense(e.id);
    list.appendChild(row);
  }
}

// カレンダーから、その日の買い物金額を直接追加する
async function handleDayAdd(e) {
  e.preventDefault();
  const amount = Number($("day-amount").value);
  if (!amount || amount <= 0) {
    $("day-amount").focus();
    return;
  }
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    await addDoc(expensesCol(), {
      date: selectedDay,
      store: $("day-store").value.trim(),
      branch: "",
      amount,
      category: $("day-category").value,
      memo: "",
      items: [],
      rawText: "",
      ocrEngine: "manual", // 手入力。正解辞書には含めない
      createdAt: serverTimestamp(),
    });
    log("カレンダーから追加:", selectedDay, amount);
    $("day-amount").value = "";
    $("day-store").value = "";
    // 当月以外の日に追加した場合はその月へ移動して購読し直す。
    // 同月ならリアルタイム購読が renderDayModal を更新する。
    jumpToMonthOf(selectedDay);
  } catch (err) {
    logErr("カレンダー追加エラー:", err.code, err.message, err);
    alert("追加に失敗しました: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---- 店舗別一覧 ------------------------------------------------------------
// 店舗 → 支店 → 明細 の順にまとめて表示する。支店名が入っている店舗だけ
// 支店の小計見出しを挟み、支店が無い店舗はそのまま明細を並べる。
function renderList() {
  const list = $("expense-list");
  list.innerHTML = "";
  $("empty-msg").hidden = currentExpenses.length > 0;
  if (!currentExpenses.length) return;

  const sum = (arr) => arr.reduce((t, e) => t + (e.amount || 0), 0);

  // 店舗ごとに { total, count, branches: Map(支店名 -> 支出[]) } を作る
  const stores = new Map();
  for (const e of currentExpenses) {
    const store = (e.store || "").trim() || "(店名なし)";
    const branch = (e.branch || "").trim();
    let s = stores.get(store);
    if (!s) {
      s = { total: 0, count: 0, branches: new Map() };
      stores.set(store, s);
    }
    s.total += e.amount || 0;
    s.count += 1;
    if (!s.branches.has(branch)) s.branches.set(branch, []);
    s.branches.get(branch).push(e);
  }

  // 合計金額の大きい店舗から表示
  const storeList = [...stores.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [store, s] of storeList) {
    const group = document.createElement("div");
    group.className = "store-group";
    group.innerHTML = `
      <div class="store-head">
        <span class="sg-name">${escapeHtml(store)}</span>
        <span class="sg-total">${yen(s.total)}<span class="sg-count">${s.count}件</span></span>
      </div>`;

    const hasBranches = [...s.branches.keys()].some((b) => b !== "");
    const branchList = [...s.branches.entries()].sort((a, b) => sum(b[1]) - sum(a[1]));
    for (const [branch, entries] of branchList) {
      if (hasBranches) {
        const bhead = document.createElement("div");
        bhead.className = "branch-head";
        bhead.innerHTML = `
          <span class="bh-name">${branch ? escapeHtml(branch) : "（支店なし）"}</span>
          <span class="bh-total">${yen(sum(entries))}</span>`;
        group.appendChild(bhead);
      }
      entries.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      for (const e of entries) group.appendChild(renderExpenseRow(e, hasBranches));
    }
    list.appendChild(group);
  }
}

// 店舗別一覧の1明細行。支店見出しの下に入るときは indented で字下げする。
function renderExpenseRow(e, indented) {
  const row = document.createElement("div");
  row.className = "expense-item" + (indented ? " ei-indent" : "");
  const memo = e.memo ? " · " + escapeHtml(e.memo) : "";
  const cat = e.category ? `<span class="ei-cat">${escapeHtml(e.category)}</span>` : "";
  row.innerHTML = `
    <div class="ei-main">
      <div class="ei-meta">${cat}${escapeHtml(e.date)}${memo}</div>
    </div>
    <div class="ei-amount">${yen(e.amount)}</div>
    <div class="ei-actions">
      <button data-act="edit">✏️</button>
      <button data-act="del">🗑️</button>
    </div>`;
  row.querySelector('[data-act="edit"]').onclick = () => editExpense(e);
  row.querySelector('[data-act="del"]').onclick = () => deleteExpense(e.id);
  return row;
}

function editExpense(e) {
  $("f-id").value = e.id;
  $("f-date").value = e.date;
  $("f-amount").value = e.amount;
  $("f-store").value = e.store || "";
  $("f-branch").value = e.branch || "";
  $("f-category").value = e.category;
  $("f-memo").value = e.memo || "";
  $("f-engine").value = e.ocrEngine || ""; // 抽出元エンジンを保持（再保存時も維持）
  renderItems(e.items || []);
  showPreview(null);
  setFormMode("edit", e);
  // カレンダーの日付モーダルから編集を始めた場合は閉じてフォームを見せる
  closeModal("day-modal");
  $("form-card").scrollIntoView({ behavior: "smooth" });
}

// フォームの見た目を「編集中／新規追加」で切り替える。
// 何を編集しているかが分かるよう、見出し・ボタン文言・編集中バナーを更新する。
function setFormMode(mode, e) {
  const editing = mode === "edit";
  $("form-card").classList.toggle("editing", editing);
  $("form-title").textContent = editing ? "支出を編集" : "手入力で追加";
  $("save-btn").textContent = editing ? "更新する" : "保存";
  $("reset-btn").textContent = editing ? "編集をやめる" : "クリア";
  const banner = $("edit-banner");
  if (editing && e) {
    const where = [e.store || "(店名なし)", e.branch].filter(Boolean).join(" ");
    banner.textContent = `編集中: ${where} ・ ${e.date}`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

async function deleteExpense(id) {
  if (!confirm("この記録を削除しますか?")) return;
  try {
    await deleteDoc(doc(db, "users", currentUser.uid, "expenses", id));
  } catch (err) {
    alert("削除に失敗しました: " + err.message);
  }
}

// ---- 商品の最安値比較 ------------------------------------------------------
let compareData = []; // [{name, price, store, date}] 全明細をフラット化

async function openCompare() {
  openModal("compare-modal");
  const list = $("compare-list");
  list.innerHTML = "<p class='empty'>読み込み中…</p>";
  try {
    // 全期間の支出を取得して、明細を商品ごとに集計する
    const expenses = await fetchAllExpenses();
    compareData = [];
    for (const e of expenses) {
      (e.items || []).forEach((it) => {
        if (it && it.name && it.price > 0) {
          compareData.push({
            name: String(it.name),
            price: Number(it.price),
            store: e.store || "(店名なし)",
            branch: e.branch || "",
            date: e.date || "",
          });
        }
      });
    }
    log("最安値比較: 明細", compareData.length, "件");
    renderCompare();
  } catch (err) {
    logErr("最安値比較の読み込み失敗:", err.code, err.message, err);
    list.innerHTML = "<p class='empty'>読み込みに失敗しました。</p>";
  }
}

function renderCompare() {
  const q = normName($("compare-search").value.trim());
  const list = $("compare-list");

  // 商品名（正規化）でグルーピング
  const groups = new Map();
  for (const it of compareData) {
    const key = normName(it.name);
    if (!key) continue;
    if (q && !key.includes(q)) continue;
    if (!groups.has(key)) groups.set(key, { label: it.name, entries: [] });
    groups.get(key).entries.push(it);
  }

  if (groups.size === 0) {
    list.innerHTML = "<p class='empty'>該当する商品がありません。明細付きで保存するとここに集計されます。</p>";
    return;
  }

  // 「現在価格の差が大きい商品」を上に（比較の価値が高い順）
  const rows = [...groups.values()].map((g) => {
    const stores = summarizeByStore(g.entries); // 店舗ごとに現在価格＋過去最安を集計
    const currents = stores.map((s) => s.current);
    const min = Math.min(...currents);
    const max = Math.max(...currents);
    let bestEver = stores[0]; // 全店通しての過去最安（セール最安）
    for (const s of stores) if (s.low < bestEver.low) bestEver = s;
    return { ...g, stores, min, max, spread: max - min, bestEver };
  });
  rows.sort((a, b) => b.spread - a.spread || b.stores.length - a.stores.length);

  list.innerHTML = "";
  for (const g of rows) {
    // 現在価格が安い順。同額なら過去最安が安い順。
    const stores = [...g.stores].sort((a, b) => a.current - b.current || a.low - b.low);
    const rowsHtml = stores
      .map((s) => {
        const isMin = s.current === g.min;
        const lowHtml = s.hasLow
          ? `<div class="cmp-low">📉 過去最安 ${yen(s.low)}${s.lowDate ? ` <span class="cmp-date">${escapeHtml(s.lowDate)}</span>` : ""}${s.isSaleLow ? ' <span class="cmp-tag">セール</span>' : ""}</div>`
          : "";
        return `<div class="cmp-row">
            <div class="cmp-store ${isMin ? "cmp-min" : ""}">
              <span>${escapeHtml(s.store)}${s.branch ? ` <span class="cmp-branch">${escapeHtml(s.branch)}</span>` : ""}${s.currentDate ? ` <span class="cmp-date">${escapeHtml(s.currentDate)}</span>` : ""}${s.saleNow ? ' <span class="cmp-tag">セール中</span>' : ""}</span>
              <span>${yen(s.current)}${isMin ? " 🏆" : ""}</span>
            </div>
            ${lowHtml}
          </div>`;
      })
      .join("");
    // 過去最安が現在の最安より安ければ「セール最安」を見出しに添える
    const saleBest = g.bestEver.low < g.min
      ? ` <span class="cmp-sale">🔥セール最安 ${yen(g.bestEver.low)}</span>`
      : "";
    const card = document.createElement("div");
    card.className = "cmp-item";
    card.innerHTML = `
      <div class="cmp-head">
        <span class="cmp-name">${escapeHtml(g.label)}</span>
        <span class="cmp-best">今の最安 ${yen(g.min)}${g.spread > 0 ? `（最大${yen(g.max)}）` : ""}${saleBest}</span>
      </div>
      <div class="cmp-stores">${rowsHtml}</div>`;
    list.appendChild(card);
  }
}

// 明細を手動追加するボタンを details 内に差し込む
const addBtn = document.createElement("button");
addBtn.type = "button";
addBtn.textContent = "＋ 明細を追加";
addBtn.style.marginTop = "8px";
addBtn.onclick = () => addItemRow();
$("items-details").appendChild(addBtn);
