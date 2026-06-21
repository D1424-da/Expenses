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
let historyDict = null; // Gemini/Vertex保存データから作る正解辞書（履歴正規化用・セッションキャッシュ）
// 正解として信頼する高精度AIエンジン。これ以外（vision/tesseract/paddle）は正規化対象。
const TRUSTED_ENGINES = ["gemini", "vertex"];
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
    prewarmOcr(); // レシート読み取りを速くするため、裏でOCRエンジンを準備しておく
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
  $("file-input").onchange = handleFiles; // アルバムから複数選択
  $("camera-input").onchange = handleFiles; // その場で撮影（1枚ずつ）
  // カメラやアルバムを開く瞬間にもバックエンドを起こす。操作している間に起動が
  // 進むので、放置後でも読み取り開始までの待ち時間を短縮できる。
  $("file-input").onclick = prewarmOcr;
  $("camera-input").onclick = prewarmOcr;
  $("expense-form").onsubmit = handleSubmit;
  $("reset-btn").onclick = resetForm;
  $("skip-btn").onclick = skipCurrent;
  $("filter-category").onchange = renderList;
  $("compare-btn").onclick = openCompare;
  $("compare-close").onclick = () => ($("compare-modal").hidden = true);
  $("compare-search").oninput = renderCompare;
  // カレンダー: カテゴリ候補を埋め、日付タップ用モーダルのイベントを束ねる
  for (const c of CATEGORIES) $("day-category").add(new Option(c, c));
  $("day-category").value = "食費";
  $("day-close").onclick = () => ($("day-modal").hidden = true);
  $("day-form").onsubmit = handleDayAdd;
  $("week-close").onclick = () => ($("week-modal").hidden = true);
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
        // 元画像（スマホ写真は数MB）をそのまま送ると、アップロードと
        // AI処理の両方が遅くなる。送信前に縮小してJPEGに再圧縮する。
        const upload = await downscaleForUpload(file);
        const fd = new FormData();
        fd.append("file", upload, "receipt.jpg");
        const res = await fetch(`${OCR_API_BASE}/api/ocr`, { method: "POST", body: fd });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || "読み取りに失敗しました");
        }
        data = await res.json();
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
        const canvas = await preprocessImage(file);
        const text = await runClientOcr(canvas, (p) => {
          status.textContent = `🔍 文字を読み取り中… ${Math.round(p * 100)}%`;
        });
        data = parseReceipt(text);
      }
    } else {
      // ブラウザ内で PaddleOCR を使って OCR（サーバー不要）
      const canvas = await preprocessImage(file);
      const text = await runClientOcr(canvas, (p) => {
        status.textContent = `🔍 文字を読み取り中… ${Math.round(p * 100)}%`;
      });
      data = parseReceipt(text);
    }
    log("OCR完了。抽出結果:", data);
    // 高精度AI（Gemini / Vertex）以外（Vision / PaddleOCR）は抽出精度が低いので、
    // 過去に Gemini/Vertex で保存したデータ（店名・支店・商品名・カテゴリ）を
    // 正解辞書として正規化する。
    if (data && !TRUSTED_ENGINES.includes(data.engine)) {
      data = await normalizeWithHistory(data);
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

// ---- 履歴正規化（Gemini の抽出結果を正解として Vision/PaddleOCR を補正）------
// 過去に Gemini で抽出・保存したデータ（店名・支店・商品名・カテゴリ）を辞書化し、
// 精度の低い Vision/PaddleOCR の結果があいまい一致したら、その正解表記に揃える。

// 照合用にゆらぎを吸収したキーへ正規化（全角半角・大小・記号/空白除去）。
function normKey(s) {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s,.。・･\-_/\\()'"`*※&]/g, "")
    .trim();
}

// レーベンシュタイン距離（OCRの誤字に強い類似度の土台）。
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

// 辞書（[{key, canonical, category?}]）から最も近い候補を返す（しきい値未満は null）。
function bestMatch(raw, entries, threshold) {
  const k = normKey(raw);
  if (!k || !entries.length) return null;
  let best = null, bestScore = 0;
  for (const e of entries) {
    let score = similarity(k, e.key);
    // どちらかが他方を含む（OCRで一部欠落/混入）場合は高めに評価する。
    if (e.key.includes(k) || k.includes(e.key)) score = Math.max(score, 0.9);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best && bestScore >= threshold ? { entry: best, score: bestScore } : null;
}

function bump(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}
function argmax(map) {
  let top = "", n = -1;
  for (const [k, c] of map) if (c > n) { n = c; top = k; }
  return top;
}

// 全期間の支出から正解辞書を構築（セッション内キャッシュ）。
async function loadHistoryDict() {
  if (historyDict) return historyDict;
  const stores = new Map();   // key -> {key, spellings:Map}
  const branches = new Map();
  const products = new Map();  // key -> {key, spellings:Map, cats:Map}
  const storeCat = new Map();  // storeKey -> Map(category->count)

  const add = (map, value) => {
    const k = normKey(value);
    if (!k) return;
    let e = map.get(k);
    if (!e) { e = { key: k, spellings: new Map() }; map.set(k, e); }
    bump(e.spellings, value);
  };

  const snap = await getDocs(expensesCol());
  snap.forEach((d) => {
    const e = d.data();
    // 正解辞書は Gemini/Vertex で抽出したデータのみ採用する。
    // 旧データ（ocrEngine 無し）は主に Gemini 由来なので含める。
    // vision/tesseract/paddle/manual で保存したものは除外（正解にしない）。
    if (e.ocrEngine && !TRUSTED_ENGINES.includes(e.ocrEngine)) return;
    if (e.store) add(stores, e.store);
    if (e.branch) add(branches, e.branch);
    if (e.store && e.category) {
      const sk = normKey(e.store);
      if (!storeCat.has(sk)) storeCat.set(sk, new Map());
      bump(storeCat.get(sk), e.category);
    }
    (e.items || []).forEach((it) => {
      if (!it || !it.name) return;
      const k = normKey(it.name);
      if (!k) return;
      let p = products.get(k);
      if (!p) { p = { key: k, spellings: new Map(), cats: new Map() }; products.set(k, p); }
      bump(p.spellings, it.name);
      if (it.category) bump(p.cats, it.category);
    });
  });

  const finalize = (map) =>
    [...map.values()].map((e) => ({ key: e.key, canonical: argmax(e.spellings) }));

  historyDict = {
    stores: finalize(stores),
    branches: finalize(branches),
    products: [...products.values()].map((p) => ({
      key: p.key,
      canonical: argmax(p.spellings),
      category: p.cats.size ? argmax(p.cats) : "",
    })),
    storeCat,
  };
  log("正解辞書を構築:", `店${historyDict.stores.length} 支店${historyDict.branches.length} 商品${historyDict.products.length}`);
  return historyDict;
}

// Vision/PaddleOCR の結果を、Gemini 由来の正解辞書で正規化する。
async function normalizeWithHistory(data) {
  try {
    const dict = await loadHistoryDict();
    const STORE_TH = 0.6, BRANCH_TH = 0.6, PROD_TH = 0.62;

    const sm = bestMatch(data.store, dict.stores, STORE_TH);
    let storeKey = data.store ? normKey(data.store) : null;
    if (sm) { data.store = sm.entry.canonical; storeKey = sm.entry.key; }

    const bm = bestMatch(data.branch, dict.branches, BRANCH_TH);
    if (bm) data.branch = bm.entry.canonical;

    // 全体カテゴリは弱い（空/その他）ときだけ、その店の最頻カテゴリで補う。
    if ((!data.category || data.category === "その他") && storeKey && dict.storeCat.has(storeKey)) {
      const top = argmax(dict.storeCat.get(storeKey));
      if (top) data.category = top;
    }

    if (Array.isArray(data.items)) {
      data.items = data.items.map((it) => {
        if (!it || !it.name) return it;
        const pm = bestMatch(it.name, dict.products, PROD_TH);
        if (pm) {
          it.name = pm.entry.canonical;
          // 商品名が一致したら、Gemini 由来のカテゴリを採用（強一致 or 元が弱いとき）。
          if (pm.entry.category && (pm.score >= 0.85 || !it.category || it.category === "その他")) {
            it.category = pm.entry.category;
          }
        }
        return it;
      });
    }
    log("履歴正規化を適用しました（Gemini基準）");
  } catch (err) {
    logErr("履歴正規化に失敗（生の結果を使用）:", err.message, err);
  }
  return data;
}

// AI(Gemini)へ送る画像を縮小＋JPEG再圧縮する。長辺1600pxあればレシートの
// 文字は十分読め、数MBの写真が数百KBになりアップロードもAI処理も速くなる。
// createImageBitmap が失敗する形式（HEIC 等）では元ファイルをそのまま返す。
const UPLOAD_MAX_DIM = 1600;
const UPLOAD_JPEG_QUALITY = 0.85;

async function downscaleForUpload(file) {
  try {
    const img = await createImageBitmap(file);
    const longSide = Math.max(img.width, img.height);
    const scale = longSide > UPLOAD_MAX_DIM ? UPLOAD_MAX_DIM / longSide : 1;
    // 既に十分小さいJPEGなら再圧縮せずそのまま使う。
    if (scale === 1 && file.type === "image/jpeg") {
      img.close?.();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.close?.();
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", UPLOAD_JPEG_QUALITY)
    );
    if (!blob) return file; // 失敗時は元ファイルにフォールバック
    log("アップロード用に縮小:", `${Math.round(file.size / 1024)}KB → ${Math.round(blob.size / 1024)}KB`);
    return blob;
  } catch (err) {
    logErr("画像の縮小に失敗（元画像を送信）:", err.message);
    return file;
  }
}

// レシートは細い印字が多いので、拡大＋グレースケール＋コントラスト補正＋
// 二値化（大津の手法）で読み取りやすくする。
async function preprocessImage(file) {
  // PaddleOCR(PP-OCR)は自然画像（カラー）で学習されているため、Tesseract時代の
  // ような二値化は行わず、原画像のまま渡すほうが精度が出る。大きすぎる写真は
  // メモリ・速度のため長辺1600pxに縮小するだけにする。
  const img = await createImageBitmap(file);
  const MAX_DIM = 1600;
  const longSide = Math.max(img.width, img.height);
  const scale = longSide > MAX_DIM ? MAX_DIM / longSide : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close?.();
  return canvas;
}

// ---- ブラウザ内OCR: PaddleOCR (ppu-paddle-ocr + onnxruntime-web) -------------
// Gemini→Vision が両方失敗したときの最終フォールバック。ESM/モデルは初回利用時に
// CDN から取得する（合計約21MB、以降はブラウザのHTTPキャッシュが効く）。
//
// 採用モデル: PP-OCRv5 mobile の汎用モデル。日中英＋日本語を1つの認識モデルで扱える。
// 必要に応じて URL を差し替えれば別言語・サーバーモデルにも切替可能。
const PADDLE_ESM = "https://esm.sh/ppu-paddle-ocr@5.8.3/web";
const PADDLE_MEDIA_BASE = "https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/refs/heads/main";
const PADDLE_RAW_BASE = "https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/refs/heads/main";
const PADDLE_MODELS = {
  detection: `${PADDLE_MEDIA_BASE}/detection/PP-OCRv5_mobile_det_infer.onnx`,
  recognition: `${PADDLE_MEDIA_BASE}/recognition/PP-OCRv5_mobile_rec_infer.onnx`,
  charactersDictionary: `${PADDLE_RAW_BASE}/recognition/ppocrv5_dict.txt`,
};

// 高速化のポイント: サービス（WASM/WebGPU セッション＋モデル）の初期化は重いので、
// 1度だけ作って使い回す。2枚目以降や事前ウォームアップ済みなら大幅に速くなる。
let paddleServicePromise = null;

function getPaddleOcr() {
  if (!paddleServicePromise) {
    log("PaddleOCRを初期化中…（初回のみモデル取得・約21MB）");
    paddleServicePromise = (async () => {
      // 動的 import。読み込めなければネットワーク/CDNの問題として扱う。
      const mod = await import(/* @vite-ignore */ PADDLE_ESM);
      const PaddleOcrService = mod.PaddleOcrService || mod.default?.PaddleOcrService;
      if (!PaddleOcrService) {
        throw new Error("PaddleOCRライブラリの読み込みに失敗しました。");
      }
      const service = new PaddleOcrService({ model: PADDLE_MODELS });
      await service.initialize();
      log("PaddleOCR準備完了");
      return service;
    })().catch((err) => {
      // 失敗時は次回また作り直せるようにキャッシュを破棄
      paddleServicePromise = null;
      throw err;
    });
  }
  return paddleServicePromise;
}

// 初回の体感速度を上げるため、ログイン直後などに裏で言語データを読み込んでおく。
function prewarmOcr() {
  if (OCR_API_BASE) {
    // バックエンド(Render無料プラン)はアクセスが無いとスリープし、次の
    // リクエストでコールドスタート(起動に数十秒)が発生する。アプリ起動時に
    // /api/health を叩いて先に起こしておけば、撮影中に起動が進み、最初の
    // 読み取りの待ち時間を大幅に短縮できる。
    fetch(`${OCR_API_BASE}/api/health`, { cache: "no-store" })
      .then((res) => res.json().catch(() => ({})))
      .then((h) =>
        log(
          "OCRバックエンド稼働:",
          `設定エンジン=${h.engine || "?"}`,
          h.status ? `status=${h.status}` : "",
          "(これは設定値。実際にGeminiが使えたかは読み取り時のログを参照)",
        ),
      )
      .catch((err) => logErr("OCRバックエンドのウォームアップに失敗:", err.message));
    return;
  }
  try {
    getPaddleOcr().catch((err) => logErr("OCR事前準備に失敗（実行時に再試行）:", err.message));
  } catch (err) {
    logErr("OCR事前準備をスキップ:", err.message);
  }
}

async function runClientOcr(image, onProgress) {
  // PaddleOCR は Tesseract のような細かい進捗を返さないため、初期化→認識の
  // 大まかな段階だけ通知する。
  onProgress?.(0.1);
  const service = await getPaddleOcr();
  onProgress?.(0.6);
  const result = await service.recognize(image);
  onProgress?.(1);
  return result?.text || "";
}

// ---- フォーム --------------------------------------------------------------
function fillForm(data, previewUrl) {
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
    <input type="number" class="item-price" value="${price || 0}" min="0" />
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
  $("form-title").textContent = "手入力で追加";
  $("f-id").value = "";
  $("f-image-url").value = "";
  $("f-rawtext").value = "";
  $("f-engine").value = "manual"; // 手入力。正解辞書には含めない
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
      branch: $("f-branch").value.trim(),
      amount: Number($("f-amount").value) || 0,
      category: $("f-category").value,
      memo: $("f-memo").value.trim(),
      items: collectItems(),
      // 抽出元エンジン。正解辞書（gemini/vertex のみ採用）の判定に使う。
      ocrEngine: $("f-engine").value || "manual",
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
    historyDict = null; // 保存で正解辞書が変わるので作り直させる

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

  // カテゴリ別は明細(items)のカテゴリで集計する（レシート全体のカテゴリは使わない）。
  renderCatBars($("category-bars"), categoryBreakdown(currentExpenses));
}

// ---- カレンダー ------------------------------------------------------------
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

// 明細が無い／価格が取れない支出を寄せる先のカテゴリ名
const UNCATEGORIZED = "未分類";

// 支出群を「明細(items)のカテゴリ」で集計して { カテゴリ: 金額 } を返す。
// ・明細ごとに its category へ price を加算
// ・明細が無い支出や、税・端数などで明細合計と金額がズレる分は「未分類」へ寄せる
//   （内訳の合計が週計と一致するようにするため）
function categoryBreakdown(expenses) {
  const map = {};
  const add = (cat, amt) => {
    if (!amt) return;
    map[cat] = (map[cat] || 0) + amt;
  };
  for (const e of expenses) {
    const amount = e.amount || 0;
    const items = Array.isArray(e.items) ? e.items : [];
    const itemSum = items.reduce((s, it) => s + (Number(it.price) || 0), 0);
    if (items.length && itemSum > 0) {
      for (const it of items) {
        add(it.category || UNCATEGORIZED, Number(it.price) || 0);
      }
      // 明細に表れない差額（税・端数・割引など）は未分類へ
      add(UNCATEGORIZED, amount - itemSum);
    } else {
      add(UNCATEGORIZED, amount);
    }
  }
  return map;
}

// { カテゴリ: 金額 } をバーで描画する（サマリーと週計内訳で共用）
function renderCatBars(container, byCat) {
  const entries = Object.entries(byCat)
    .filter(([, a]) => a !== 0)
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
  $("week-modal").hidden = false;
}

// ---- 日付モーダル（その日の合計確認＋金額の追加入力） ----------------------
function openDayModal(key) {
  selectedDay = key;
  $("day-amount").value = "";
  $("day-store").value = "";
  $("day-category").value = "食費";
  renderDayModal();
  $("day-modal").hidden = false;
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
      <button data-act="del" aria-label="削除">🗑️</button>`;
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
    // 当月以外の日に追加した場合はその月へ移動して購読し直す
    const addedMonth = new Date(selectedDay + "T00:00:00");
    if (monthKey(addedMonth) !== monthKey(currentMonth)) {
      currentMonth = addedMonth;
      renderMonth();
      subscribeMonth();
    }
    // 同月ならリアルタイム購読が renderDayModal を更新する
  } catch (err) {
    logErr("カレンダー追加エラー:", err.code, err.message, err);
    alert("追加に失敗しました: " + err.message);
  } finally {
    btn.disabled = false;
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
        <div class="ei-store">${escapeHtml(e.store || "(店名なし)")}${e.branch ? ` <span class="ei-branch">${escapeHtml(e.branch)}</span>` : ""}</div>
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
  $("f-branch").value = e.branch || "";
  $("f-category").value = e.category;
  $("f-memo").value = e.memo || "";
  $("f-engine").value = e.ocrEngine || ""; // 抽出元エンジンを保持（再保存時も維持）
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
            branch: e.branch || "",
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

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 同一商品を店舗ごとに集計する。各店舗について「現在価格（最新）」と
// 「その店の過去最安（セール時の値）」を出し、一時的なセールを見分けられるようにする。
// 平常価格はセール1回に引っ張られにくいよう中央値で見積もる。
function summarizeByStore(entries) {
  const map = new Map();
  // 同じチェーンでも支店ごとに別の店として集計する（店名＋支店名でグループ化）
  for (const e of entries) {
    const key = `${e.store}${e.branch || ""}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  const out = [];
  for (const [, list] of map) {
    list.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const latest = list[list.length - 1]; // 最新の記録 = 現在価格
    let low = list[0];
    for (const e of list) if (e.price < low.price) low = e; // その店の過去最安
    const regular = median(list.map((e) => e.price)); // 平常価格の目安
    out.push({
      store: list[0].store,
      branch: list[0].branch || "",
      current: latest.price,
      currentDate: latest.date,
      low: low.price,
      lowDate: low.date,
      hasLow: low.price < latest.price, // 今より安く買えた履歴がある
      saleNow: list.length >= 2 && latest.price <= regular * 0.9, // 今セール中
      isSaleLow: list.length >= 2 && low.price <= regular * 0.9, // 過去最安はセール価格
    });
  }
  return out;
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
