// 管理者ページ（/admin.html）のロジック。
//
// CSP の script-src に 'unsafe-inline' が無いため、インライン script では
// ブロックされる。必ず外部ファイルとして読み込むこと。
// 画像は署名URLではなくバックエンド経由で取得するため、api-client.js の
// apiFetch で認証付きに取得し、blob URL 化して表示する。

import { auth, provider } from "./firebase-init.js";
import { apiFetch, errorDetail } from "./api-client.js";
import { signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

/** 原寸画像をオーバーレイで拡大表示する（サムネイルでは文字が読めないため）。 */
async function openViewer(name, filename, token) {
  const overlay = $("viewer");
  const imgEl = $("viewer-img");
  const caption = $("viewer-caption");

  caption.textContent = `${filename}（読み込み中…）`;
  imgEl.removeAttribute("src");
  overlay.hidden = false;

  try {
    const r = await apiFetch("/api/admin/receipts/download", { token, params: { name } });
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
  const res = await apiFetch("/api/admin/receipts", { token });
  if (!res.ok) {
    statusEl.textContent = `エラー: ${await errorDetail(res)}`;
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
    // 一覧では縮小版を使う（原寸を並べると1画面で十数MBの転送になる）

    const tr = document.createElement("tr");
    const tdThumb = document.createElement("td");
    const img = document.createElement("img");
    img.className = "thumb";
    img.loading = "lazy";
    img.alt = filename;
    img.title = "クリックで拡大";
    // 画像取得も認証が要るため fetch → blob URL 化
    apiFetch("/api/admin/receipts/download", { token, params: { name: item.name, w: 200 } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => { if (blob) img.src = URL.createObjectURL(blob); })
      .catch(() => {});
    // クリックで原寸を拡大表示（サムネイルでは文字が読めないため）
    img.onclick = () => openViewer(item.name, filename, token);
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
      const r = await apiFetch("/api/admin/receipts/download", { token, params: { name: item.name } });
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

// ---- 登録ユーザー一覧 -------------------------------------------------------

const PLAN_LABEL = { premium: "プレミアム", trial: "トライアル中", beta: "ベータ招待", free: "無料" };

function fmtDateMs(ms) {
  return ms ? new Date(ms).toLocaleString("ja-JP") : "-";
}

/** users-tbody に1ページぶんの行を追加する（さらに読み込む、で継ぎ足すため置き換えない）。 */
function appendUserRows(items) {
  const tbody = $("users-tbody");
  for (const u of items) {
    const tr = document.createElement("tr");

    const tdEmail = document.createElement("td");
    tdEmail.textContent = u.email ?? "(メール未設定)";
    const tdUid = document.createElement("td");
    tdUid.textContent = u.uid;
    const tdCreated = document.createElement("td");
    tdCreated.textContent = fmtDateMs(u.createdAt);
    const tdLast = document.createElement("td");
    tdLast.textContent = fmtDateMs(u.lastSignInAt);

    const tdPlan = document.createElement("td");
    const badge = document.createElement("span");
    // トライアルはプレミアムと同じ扱い（アプリ側のバッジ文言に合わせる）だが、
    // 管理画面ではトライアル中かどうか自体が知りたい情報なので plan で出し分ける。
    const kind = u.isPremium ? (u.plan === "trial" ? "trial" : "premium") : "free";
    badge.className = `plan-badge ${kind}`;
    badge.textContent = PLAN_LABEL[u.plan] ?? u.plan ?? "無料";
    tdPlan.appendChild(badge);

    const tdStatus = document.createElement("td");
    tdStatus.textContent = u.status ?? "-";

    tr.append(tdEmail, tdUid, tdCreated, tdLast, tdPlan, tdStatus);
    tbody.appendChild(tr);
  }
}

let _usersNextPageToken = null;

async function loadUsers(token, { append = false } = {}) {
  $("users-status").textContent = "";
  const res = await apiFetch("/api/admin/users", {
    token,
    params: { page_token: append ? _usersNextPageToken : null },
  });
  if (!res.ok) {
    $("users-status").textContent = `エラー: ${await errorDetail(res)}`;
    return;
  }
  const { items, nextPageToken } = await res.json();
  _usersNextPageToken = nextPageToken || null;
  $("users-more-btn").hidden = !_usersNextPageToken;

  if (!append) {
    $("users-tbody").innerHTML = "";
    if (items.length === 0) {
      $("users-table").hidden = true;
      $("users-empty").hidden = false;
      $("users-summary").textContent = "";
      return;
    }
    $("users-table").hidden = false;
    $("users-empty").hidden = true;
  }
  appendUserRows(items);

  // 集計は「これまでに読み込んだぶん」の実数。全ユーザー数がページングで
  // 分割されている場合はその旨を注記し、全体の数値だと誤解されないようにする。
  const rows = $("users-tbody").rows.length;
  const premiumCount = [...$("users-tbody").querySelectorAll(".plan-badge.premium, .plan-badge.trial")].length;
  const partial = _usersNextPageToken ? "（さらに読み込むと増えます）" : "";
  $("users-summary").textContent = `読み込み済み ${rows}人中 ${premiumCount}人が有料/トライアル中${partial}`;
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
  await loadUsers(token);
  await loadList(token);
  $("users-reload-btn").onclick = async () => {
    const t = await user.getIdToken(true);
    _usersNextPageToken = null;
    await loadUsers(t);
  };
  $("users-more-btn").onclick = async () => {
    const t = await user.getIdToken();
    await loadUsers(t, { append: true });
  };
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
