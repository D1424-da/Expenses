// 管理者ページ（/admin.html）のロジック。
//
// CSP の script-src に 'unsafe-inline' が無いため、インライン script では
// ブロックされる。必ず外部ファイルとして読み込むこと。
// 画像は署名URLではなくバックエンド経由で取得するため、fetch に
// Authorization ヘッダを付けて blob URL 化して表示する。

import { auth, provider } from "./firebase-init.js";
import { OCR_API_BASE } from "./firebase-config.js";
import { signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

/** 原寸画像をオーバーレイで拡大表示する（サムネイルでは文字が読めないため）。 */
async function openViewer(url, filename, token) {
  const overlay = $("viewer");
  const imgEl = $("viewer-img");
  const caption = $("viewer-caption");

  caption.textContent = `${filename}（読み込み中…）`;
  imgEl.removeAttribute("src");
  overlay.hidden = false;

  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    // 前回のオブジェクトURLを解放してからdiff差し替え（開くたびにメモリが増えるのを防ぐ）
    if (imgEl.dataset.objectUrl) URL.revokeObjectURL(imgEl.dataset.objectUrl);
    const objectUrl = URL.createObjectURL(blob);
    imgEl.dataset.objectUrl = objectUrl;
    imgEl.src = objectUrl;
    caption.textContent = filename;
  } catch (err) {
    caption.textContent = `${filename}（読み込みに失敗しました: ${err.message}）`;
  }
}

function closeViewer() {
  const overlay = $("viewer");
  const imgEl = $("viewer-img");
  overlay.hidden = true;
  if (imgEl.dataset.objectUrl) {
    URL.revokeObjectURL(imgEl.dataset.objectUrl);
    delete imgEl.dataset.objectUrl;
  }
  imgEl.removeAttribute("src");
}

function fmtSize(bytes) {
  if (!bytes) return "-";
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

async function loadList(token) {
  statusEl.textContent = "";
  const res = await fetch(`${OCR_API_BASE}/api/admin/receipts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    statusEl.textContent = `エラー: ${res.status} ${body.detail ?? ""}`;
    $("table").hidden = true;
    $("empty").hidden = true;
    return;
  }
  const { items } = await res.json();
  const tbody = $("tbody");
  tbody.innerHTML = "";
  if (items.length === 0) {
    $("table").hidden = true;
    $("empty").hidden = false;
    return;
  }
  $("table").hidden = false;
  $("empty").hidden = true;
  for (const item of items) {
    const uid = item.name.split("/")[1] ?? "-";
    const filename = item.name.split("/").pop();
    const dlUrl = `${OCR_API_BASE}/api/admin/receipts/download?name=${encodeURIComponent(item.name)}`;
    // 一覧では縮小版を使う（原寸を並べると1画面で十数MBの転送になる）
    const thumbUrl = `${dlUrl}&w=200`;

    const tr = document.createElement("tr");
    const tdThumb = document.createElement("td");
    const img = document.createElement("img");
    img.className = "thumb";
    img.loading = "lazy";
    img.alt = filename;
    img.title = "クリックで拡大";
    // 画像取得も認証が要るため fetch → blob URL 化
    fetch(thumbUrl, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => { if (blob) img.src = URL.createObjectURL(blob); })
      .catch(() => {});
    // クリックで原寸を拡大表示（サムネイルでは文字が読めないため）
    img.onclick = () => openViewer(dlUrl, filename, token);
    tdThumb.appendChild(img);

    const tdUid = document.createElement("td");
    tdUid.textContent = uid;
    const tdName = document.createElement("td");
    tdName.textContent = filename;
    const tdSize = document.createElement("td");
    tdSize.textContent = fmtSize(item.size);
    const tdDate = document.createElement("td");
    tdDate.textContent = item.createdAt ? new Date(item.createdAt).toLocaleString("ja-JP") : "-";

    const tdDl = document.createElement("td");
    const a = document.createElement("a");
    a.textContent = "ダウンロード";
    a.className = "dl-link";
    a.href = "#";
    a.onclick = async (e) => {
      e.preventDefault();
      const r = await fetch(dlUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { statusEl.textContent = "ダウンロードに失敗しました"; return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    };
    tdDl.appendChild(a);

    tr.append(tdThumb, tdUid, tdName, tdSize, tdDate, tdDl);
    tbody.appendChild(tr);
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    $("login-box").style.display = "block";
    $("main-box").style.display = "none";
    return;
  }
  $("login-box").style.display = "none";
  $("main-box").style.display = "block";
  $("who").textContent = `ログイン中: ${user.email}`;
  const token = await user.getIdToken();
  await loadList(token);
  $("reload-btn").onclick = async () => {
    const t = await user.getIdToken(true);
    await loadList(t);
  };
});

$("login-btn").onclick = () => signInWithPopup(auth, provider).catch((e) => {
  statusEl.textContent = `ログイン失敗: ${e.message}`;
});

// ビューアを閉じる操作（背景クリック・×ボタン・Escキー）
$("viewer").onclick = (e) => {
  // 画像そのものをクリックしたときは閉じない（拡大表示を見続けたいため）
  if (e.target === $("viewer-img")) return;
  closeViewer();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("viewer").hidden) closeViewer();
});
