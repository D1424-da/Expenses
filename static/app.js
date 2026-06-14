// レシート家計簿 — フロントエンド（Firebase + OCRバックエンド連携）
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
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
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { firebaseConfig, OCR_API_BASE, CATEGORIES } from "./firebase-config.js";
import { parseReceipt } from "./parser.js";

// ---- Firebase 初期化 -------------------------------------------------------
// レシート画像は保存しない（Cloud Storage 不要 = 無料の Spark プランで動く）。
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const provider = new GoogleAuthProvider();

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
onAuthStateChanged(auth, (user) => {
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

$("google-login").onclick = async () => {
  $("login-error").hidden = true;
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    const el = $("login-error");
    el.textContent = "ログインに失敗しました: " + (err.message || err.code);
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
  $("file-input").onchange = handleFile;
  $("expense-form").onsubmit = handleSubmit;
  $("reset-btn").onclick = resetForm;
  $("filter-category").onchange = renderList;
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
  unsubscribe = onSnapshot(
    q,
    (snap) => {
      currentExpenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderList();
      renderSummary();
    },
    (err) => {
      console.error(err);
      $("ocr-status").hidden = false;
      $("ocr-status").className = "status error";
      $("ocr-status").textContent =
        "データ取得に失敗しました（Firebaseの設定/ルールを確認してください）: " + err.message;
    }
  );
}

// ---- OCR 取り込み ----------------------------------------------------------
async function handleFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const status = $("ocr-status");
  status.hidden = false;
  status.className = "status loading";
  status.textContent = "📤 読み取り中… (数秒かかります)";

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
    } else {
      // 既定: ブラウザ内で Tesseract.js を使って OCR（サーバー不要）
      const canvas = await preprocessImage(file);
      const text = await runClientOcr(canvas, (p) => {
        status.textContent = `🔍 文字を読み取り中… ${Math.round(p * 100)}%`;
      });
      data = parseReceipt(text);
    }
    // 画像は保存しないが、確認用にその場でプレビュー表示する
    fillForm(data, URL.createObjectURL(file));
    status.className = "status ok";
    status.textContent = "✅ 読み取りました。内容を確認して保存してください。";
    $("form-card").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    console.error(err);
    status.className = "status error";
    status.textContent = "⚠️ " + (err.message || err);
  } finally {
    e.target.value = ""; // 同じファイルを再選択できるように
  }
}

// レシートは細い印字が多いので、拡大＋グレースケール化して読み取りやすくする。
async function preprocessImage(file) {
  const img = await createImageBitmap(file);
  const targetW = 1500;
  const scale = img.width < targetW ? targetW / img.width : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
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

    // 保存した支出の月へ移動
    const savedMonth = new Date($("f-date").value + "T00:00:00");
    if (monthKey(savedMonth) !== monthKey(currentMonth)) {
      currentMonth = savedMonth;
      renderMonth();
      subscribeMonth();
    }
    resetForm();
    $("ocr-status").hidden = true;
  } catch (err) {
    console.error(err);
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
