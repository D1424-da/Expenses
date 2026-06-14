// レシート家計簿 — フロントエンド（Firebase + OCRバックエンド連携）
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
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
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

import {
  firebaseConfig,
  OCR_API_BASE,
  USE_CLOUD_VISION,
  CATEGORIES,
} from "./firebase-config.js";
import { parseReceipt } from "./parser.js";

// ---- デバッグログ ----------------------------------------------------------
// 問題の切り分け用。安定したら DEBUG = false にする。
const DEBUG = true;
const log = (...a) => DEBUG && console.log("%c[家計簿]", "color:#2f855a;font-weight:bold", ...a);
const logErr = (...a) => DEBUG && console.error("[家計簿]", ...a);

// 想定外の例外も全部拾う
window.addEventListener("error", (e) => logErr("未捕捉エラー:", e.message, e.filename, e.lineno));
window.addEventListener("unhandledrejection", (e) => logErr("未処理のPromise拒否:", e.reason));
log("app.js 読み込み開始", "Tesseract利用可能:", !!window.Tesseract);

// ---- Firebase 初期化 -------------------------------------------------------
// レシート画像は保存しない（Cloud Storage 不要 = 無料の Spark プランで動く）。
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const provider = new GoogleAuthProvider();
// 高精度OCR用の Cloud Functions（東京リージョン）
const functions = getFunctions(fbApp, "asia-northeast1");
const cloudOcr = httpsCallable(functions, "ocrReceipt");
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

const $ = (id) => document.getElementById(id);
const yen = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP");
const pad = (n) => String(n).padStart(2, "0");
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const monthLabel = (d) => `${d.getFullYear()}年${d.getMonth() + 1}月`;
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

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
    const el = $("login-error");
    el.textContent = "ログインに失敗しました: " + (err.code || err.message);
    el.hidden = false;
  });

$("google-login").onclick = async () => {
  log("ログインボタン押下 → signInWithRedirect 開始");
  $("login-error").hidden = true;
  try {
    await signInWithRedirect(auth, provider);
    log("signInWithRedirect 呼び出し完了（Googleへ遷移するはず）");
  } catch (err) {
    logErr("signInWithRedirect でエラー:", err.code, err.message, err);
    const el = $("login-error");
    el.textContent = "ログインに失敗しました: " + (err.code || err.message);
    el.hidden = false;
  }
};

let appInitialized = false;
function setupApp() {
  if (!appInitialized) {
    populateCategories();
    bindEvents();
    resetForm();
    appInitialized = true;
  }
  renderMonth();
  subscribeMonth();
}

function populateCategories() {
  const sel = $("f-category");
  const filter = $("filter-category");
  for (const c of CATEGORIES) {
    sel.add(new Option(c, c));
    filter.add(new Option(c, c));
  }
}

function bindEvents() {
  $("logout").onclick = () => signOut(auth);
  $("prev-month").onclick = () => shiftMonth(-1);
  $("next-month").onclick = () => shiftMonth(1);
  $("file-input").onchange = handleFiles;
  $("expense-form").onsubmit = handleSubmit;
  $("reset-btn").onclick = resetForm;
  $("skip-btn").onclick = skipCurrent;
  $("filter-category").onchange = renderList;
  $("compare-btn").onclick = openCompare;
  $("compare-close").onclick = () => ($("compare-modal").hidden = true);
  $("compare-search").oninput = renderCompare;
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

async function ocrAndShow(file) {
  log("OCR開始:", file.name, file.type, `${Math.round(file.size / 1024)}KB`, OCR_API_BASE ? "(バックエンド)" : USE_CLOUD_VISION ? "(クラウドVision)" : "(ブラウザ内Tesseract)");
  const status = $("ocr-status");
  status.hidden = false;
  status.className = "status loading";
  status.textContent = `📤 ${queuePrefix()}読み取り中… (数秒かかります)`;

  try {
    let data;
    if (OCR_API_BASE) {
      // OCRバックエンド(FastAPI)を使う設定の場合
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${OCR_API_BASE}/api/ocr`, { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "読み取りに失敗しました");
      }
      data = await res.json();
    } else if (USE_CLOUD_VISION) {
      // 高精度: Google Cloud Vision（Cloud Functions経由）。失敗時はブラウザ内OCRへ。
      let text;
      try {
        status.textContent = "🔍 クラウドOCRで読み取り中…";
        const imageBase64 = await fileToBase64(file, 1600);
        const res = await cloudOcr({ imageBase64 });
        text = (res.data && res.data.text) || "";
        log("クラウドOCR成功");
      } catch (err) {
        logErr("クラウドOCR失敗、ブラウザ内OCRに切替:", err.code, err.message, err);
        status.textContent = "🔍 文字を読み取り中…（ブラウザ内OCR）";
        const canvas = await preprocessImage(file);
        text = await runClientOcr(canvas, (p) => {
          status.textContent = `🔍 文字を読み取り中… ${Math.round(p * 100)}%`;
        });
      }
      data = parseReceipt(text);
    } else {
      // ブラウザ内で Tesseract.js を使って OCR（サーバー不要）
      const canvas = await preprocessImage(file);
      const text = await runClientOcr(canvas, (p) => {
        status.textContent = `🔍 文字を読み取り中… ${Math.round(p * 100)}%`;
      });
      data = parseReceipt(text);
    }
    log("OCR完了。抽出結果:", data);
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

// クラウドOCR送信用: 画像を縮小してJPEGのbase64文字列にする（通信量削減）。
async function fileToBase64(file, maxW = 1600) {
  const img = await createImageBitmap(file);
  const scale = img.width > maxW ? maxW / img.width : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return dataUrl.split(",")[1]; // "data:image/jpeg;base64," を除去
}

// レシートは細い印字が多いので、拡大＋グレースケール＋コントラスト補正＋
// 二値化（大津の手法）で読み取りやすくする。
async function preprocessImage(file) {
  const img = await createImageBitmap(file);
  const targetW = 2000; // 高解像度化すると細かい文字が認識されやすい
  const scale = img.width < targetW ? targetW / img.width : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;

  // 1) グレースケール化 + ヒストグラム作成
  const hist = new Array(256).fill(0);
  const gray = new Uint8ClampedArray(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const g = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
    gray[j] = g;
    hist[g]++;
  }

  // 2) 大津の手法でしきい値を自動決定
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }

  // 3) 二値化（白背景・黒文字）。少し甘めにして文字を太らせる
  const thr = threshold + 10;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = gray[j] > thr ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

// Tesseract.js（ブラウザ内OCR）。日本語データは初回に自動ダウンロードされる。
async function runClientOcr(image, onProgress) {
  if (!window.Tesseract) {
    throw new Error("OCRライブラリの読み込みに失敗しました（ネットワークをご確認ください）");
  }
  const worker = await window.Tesseract.createWorker("jpn", 1, {
    logger: (m) => {
      if (m.status === "recognizing text" && onProgress) onProgress(m.progress);
    },
  });
  try {
    // レシート向け: 単一の縦並びテキストとして扱い、単語間スペースを保持
    await worker.setParameters({
      tessedit_pageseg_mode: "6",
      preserve_interword_spaces: "1",
    });
    const { data } = await worker.recognize(image);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

// ---- フォーム --------------------------------------------------------------
function fillForm(data, previewUrl) {
  $("form-title").textContent = "読み取り結果を確認";
  $("f-id").value = "";
  $("f-date").value = data.date || todayStr();
  $("f-amount").value = data.amount || 0;
  $("f-store").value = data.store || "";
  $("f-category").value = data.category || "その他";
  $("f-memo").value = "";
  $("f-image-url").value = "";
  $("f-rawtext").value = data.raw_text || "";
  renderItems(data.items || []);
  showPreview(previewUrl);
}

function showPreview(url) {
  const preview = $("form-preview");
  if (url) {
    $("preview-img").src = url;
    preview.hidden = false;
  } else {
    preview.hidden = true;
  }
}

function renderItems(items) {
  $("items-list").innerHTML = "";
  for (const it of items) addItemRow(it.name, it.price);
  updateItemsCount();
}

function addItemRow(name = "", price = 0) {
  const row = document.createElement("div");
  row.className = "item-row";
  row.innerHTML = `
    <input type="text" class="item-name" value="${escapeHtml(name)}" placeholder="品目" />
    <input type="number" class="item-price" value="${price || 0}" min="0" />
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
    }))
    .filter((it) => it.name || it.price);
}

function updateItemsCount() {
  $("items-count").textContent = document.querySelectorAll(".item-row").length;
}

function resetForm() {
  $("expense-form").reset();
  $("form-title").textContent = "手入力で追加";
  $("f-id").value = "";
  $("f-image-url").value = "";
  $("f-rawtext").value = "";
  $("items-list").innerHTML = "";
  showPreview(null);
  updateItemsCount();
  $("f-date").value = todayStr();
}

async function handleSubmit(e) {
  e.preventDefault();
  const saveBtn = $("save-btn");
  saveBtn.disabled = true;
  saveBtn.textContent = "保存中…";
  try {
    const id = $("f-id").value;
    const payload = {
      date: $("f-date").value,
      store: $("f-store").value.trim(),
      amount: Number($("f-amount").value) || 0,
      category: $("f-category").value,
      memo: $("f-memo").value.trim(),
      items: collectItems(),
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

    // 保存した支出の月へ移動
    const savedMonth = new Date($("f-date").value + "T00:00:00");
    if (monthKey(savedMonth) !== monthKey(currentMonth)) {
      currentMonth = savedMonth;
      renderMonth();
      subscribeMonth();
    }
    resetForm();
    // 複数枚取り込み中なら次の画像へ。なければステータスを消す。
    if (!advanceQueue()) $("ocr-status").hidden = true;
  } catch (err) {
    logErr("保存エラー:", err.code, err.message, err);
    alert("保存に失敗しました: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "保存";
  }
}

// ---- サマリー --------------------------------------------------------------
function renderSummary() {
  const total = currentExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  $("summary-total").textContent = yen(total);
  $("summary-count").textContent = currentExpenses.length
    ? `${currentExpenses.length}件の記録`
    : "記録なし";

  const byCat = {};
  for (const e of currentExpenses) {
    byCat[e.category] = (byCat[e.category] || 0) + (e.amount || 0);
  }
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const max = entries.length ? entries[0][1] : 0;
  const bars = $("category-bars");
  bars.innerHTML = "";
  for (const [cat, amt] of entries) {
    const row = document.createElement("div");
    row.className = "cat-row";
    const pct = max ? (amt / max) * 100 : 0;
    row.innerHTML = `
      <span class="cat-name">${escapeHtml(cat)}</span>
      <span class="cat-bar-wrap"><span class="cat-bar" style="width:${pct}%"></span></span>
      <span class="cat-amount">${yen(amt)}</span>`;
    bars.appendChild(row);
  }
}

// ---- 一覧 ------------------------------------------------------------------
function renderList() {
  const cat = $("filter-category").value;
  const rows = cat ? currentExpenses.filter((e) => e.category === cat) : currentExpenses;
  const list = $("expense-list");
  list.innerHTML = "";
  $("empty-msg").hidden = rows.length > 0;

  for (const e of rows) {
    const item = document.createElement("div");
    item.className = "expense-item";
    item.innerHTML = `
      <div class="ei-main">
        <div class="ei-store">${escapeHtml(e.store || "(店名なし)")}</div>
        <div class="ei-meta"><span class="ei-cat">${escapeHtml(e.category)}</span>${escapeHtml(e.date)}${e.memo ? " · " + escapeHtml(e.memo) : ""}</div>
      </div>
      <div class="ei-amount">${yen(e.amount)}</div>
      <div class="ei-actions">
        <button data-act="edit">✏️</button>
        <button data-act="del">🗑️</button>
      </div>`;
    item.querySelector('[data-act="edit"]').onclick = () => editExpense(e);
    item.querySelector('[data-act="del"]').onclick = () => deleteExpense(e.id);
    list.appendChild(item);
  }
}

function editExpense(e) {
  $("form-title").textContent = "支出を編集";
  $("f-id").value = e.id;
  $("f-date").value = e.date;
  $("f-amount").value = e.amount;
  $("f-store").value = e.store || "";
  $("f-category").value = e.category;
  $("f-memo").value = e.memo || "";
  renderItems(e.items || []);
  showPreview(null);
  $("form-card").scrollIntoView({ behavior: "smooth" });
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
  const modal = $("compare-modal");
  modal.hidden = false;
  const list = $("compare-list");
  list.innerHTML = "<p class='empty'>読み込み中…</p>";
  try {
    // 全期間の支出を取得して、明細を商品ごとに集計する
    const snap = await getDocs(expensesCol());
    compareData = [];
    snap.forEach((d) => {
      const e = d.data();
      (e.items || []).forEach((it) => {
        if (it && it.name && it.price > 0) {
          compareData.push({
            name: String(it.name),
            price: Number(it.price),
            store: e.store || "(店名なし)",
            date: e.date || "",
          });
        }
      });
    });
    log("最安値比較: 明細", compareData.length, "件");
    renderCompare();
  } catch (err) {
    logErr("最安値比較の読み込み失敗:", err.code, err.message, err);
    list.innerHTML = "<p class='empty'>読み込みに失敗しました。</p>";
  }
}

// 比較用に商品名をゆるく正規化（空白・記号除去、小文字化）
function normName(name) {
  return name.toLowerCase().replace(/[\s　,.\-_*()（）]/g, "");
}

// 同一商品を同じ店舗で複数回買ったときの重複をまとめる。
// 各店舗につき1行（最新の日付の価格。同日なら安い方）にして「今その店でいくらか」を示す。
function dedupeByStore(entries) {
  const byStore = new Map();
  for (const e of entries) {
    const cur = byStore.get(e.store);
    const newer = !cur ||
      (e.date || "") > (cur.date || "") ||
      ((e.date || "") === (cur.date || "") && e.price < cur.price);
    if (newer) byStore.set(e.store, e);
  }
  return [...byStore.values()];
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

  // 「最安と最高の差が大きい商品」を上に（比較の価値が高い順）
  const rows = [...groups.values()].map((g) => {
    const entries = dedupeByStore(g.entries); // 同一店舗の重複をまとめる
    const prices = entries.map((e) => e.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    return { ...g, entries, min, max, spread: max - min };
  });
  rows.sort((a, b) => b.spread - a.spread || b.entries.length - a.entries.length);

  list.innerHTML = "";
  for (const g of rows) {
    const byStore = [...g.entries].sort((a, b) => a.price - b.price);
    const cheapest = byStore[0];
    const rowsHtml = byStore
      .map((e) => {
        const isMin = e.price === g.min;
        return `<div class="cmp-store ${isMin ? "cmp-min" : ""}">
            <span>${escapeHtml(e.store)}${e.date ? ` <span class="cmp-date">${escapeHtml(e.date)}</span>` : ""}</span>
            <span>${yen(e.price)}${isMin ? " 🏆" : ""}</span>
          </div>`;
      })
      .join("");
    const card = document.createElement("div");
    card.className = "cmp-item";
    card.innerHTML = `
      <div class="cmp-head">
        <span class="cmp-name">${escapeHtml(g.label)}</span>
        <span class="cmp-best">最安 ${yen(g.min)}${g.spread > 0 ? `（最大${yen(g.max)}）` : ""}</span>
      </div>
      <div class="cmp-stores">${rowsHtml}</div>`;
    list.appendChild(card);
  }
}

// ---- ユーティリティ --------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// 明細を手動追加するボタンを details 内に差し込む
const addBtn = document.createElement("button");
addBtn.type = "button";
addBtn.textContent = "＋ 明細を追加";
addBtn.style.marginTop = "8px";
addBtn.onclick = () => addItemRow();
$("items-details").appendChild(addBtn);
