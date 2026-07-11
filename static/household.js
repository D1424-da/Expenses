// 世帯（家族グループ）管理 — 作成・参加・退出・ステータス表示。
//
// Firestore 構造:
//   households/{hid}  { members:[uid], createdBy:uid, inviteCode:string }
//   users/{uid}/settings/household  { householdId:string|null }
//
// 世帯作成後は新規の支出・買い物リスト・献立が households/{hid} 配下に保存される。
// 既存の個人データ（users/{uid}/expenses 等）はそのまま残る（移行は手動）。
import {
  collection, doc, getDoc, setDoc, updateDoc, getDocs, query,
  where, arrayUnion, arrayRemove, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { $, escapeHtml, openModal, closeModal } from "./dom-utils.js";
import { dbSetHousehold, dbClearHousehold, dbGetHousehold } from "./db-paths.js";
import { log, logErr } from "./log.js";

let _db, _getUser, _onChanged;

export function initHousehold({ db, getUser, onChanged }) {
  _db = db;
  _getUser = getUser;
  _onChanged = onChanged;

  $("household-close").onclick  = () => closeModal("household-modal");
  $("household-create-btn").onclick = _create;
  $("household-join-btn").onclick   = _join;
  $("household-leave-btn").onclick  = _leave;
}

// ログイン時に呼ぶ。世帯メンバーなら householdId を返す。
export async function loadHousehold(uid) {
  try {
    const snap = await getDoc(doc(_db, "users", uid, "settings", "household"));
    const hid = snap.exists() ? snap.data().householdId : null;
    if (!hid) return null;
    // まだメンバーかどうか確認（退出済みの場合は null を返す）
    const hSnap = await getDoc(doc(_db, "households", hid));
    if (hSnap.exists() && (hSnap.data().members || []).includes(uid)) {
      dbSetHousehold(hid);
      return hid;
    }
    // メンバーから外れていた → 参照を消す
    await setDoc(doc(_db, "users", uid, "settings", "household"), { householdId: null });
  } catch (err) {
    logErr("世帯情報の読み込みエラー:", err.message);
  }
  dbClearHousehold();
  return null;
}

// ログアウト時に呼ぶ
export function clearHousehold() {
  dbClearHousehold();
}

async function _open() {
  openModal("household-modal");
  await _refresh();
}

async function _refresh() {
  const hid = dbGetHousehold();
  const statusEl = $("household-status");
  const createSec = $("household-create-sec");
  const joinSec   = $("household-join-sec");
  const leaveSec  = $("household-leave-sec");

  if (!hid) {
    statusEl.innerHTML = "個人モードで使用中です。";
    createSec.hidden = false;
    joinSec.hidden   = false;
    leaveSec.hidden  = true;
    return;
  }
  statusEl.innerHTML = "読み込み中…";
  try {
    const snap = await getDoc(doc(_db, "households", hid));
    if (!snap.exists()) { dbClearHousehold(); await _refresh(); return; }
    const d = snap.data();
    const count = (d.members || []).length;
    statusEl.innerHTML =
      `<strong>グループ参加中</strong>（${count}人）<br>` +
      `招待コード: <span class="household-code-display">${escapeHtml(d.inviteCode || "")}</span>` +
      `<p class="household-hint">このコードを家族に伝えると、同じデータを共有できます。</p>`;
    createSec.hidden = true;
    joinSec.hidden   = true;
    leaveSec.hidden  = false;
  } catch (err) {
    logErr("世帯情報取得エラー:", err.message);
    statusEl.textContent = "取得に失敗しました。";
  }
}

async function _create() {
  const user = _getUser();
  if (!user) return;
  if (!confirm(
    "新しい世帯グループを作成します。\n\n" +
    "作成後は新規の支出・買い物リスト・献立が世帯共有になります。\n" +
    "既存のデータは個人フォルダに残ります。続けますか？",
  )) return;

  const btn = $("household-create-btn");
  btn.disabled = true;
  try {
    const ref = doc(collection(_db, "households"));
    const hid = ref.id;
    const code = hid.slice(0, 8).toUpperCase();
    await setDoc(ref, {
      members: [user.uid],
      createdBy: user.uid,
      createdAt: serverTimestamp(),
      inviteCode: code,
    });
    await setDoc(doc(_db, "users", user.uid, "settings", "household"), { householdId: hid });
    dbSetHousehold(hid);
    log("世帯作成:", hid, "招待コード:", code);
    _onChanged();
    await _refresh();
  } catch (err) {
    logErr("世帯作成エラー:", err.message, err);
    alert("作成に失敗しました: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function _join() {
  const code = ($("household-code-input").value || "").trim().toUpperCase();
  if (!code) { alert("招待コードを入力してください。"); return; }
  const user = _getUser();
  if (!user) return;

  const btn = $("household-join-btn");
  btn.disabled = true;
  try {
    const q = query(collection(_db, "households"), where("inviteCode", "==", code));
    const snap = await getDocs(q);
    if (snap.empty) { alert("招待コードが見つかりませんでした: " + code); return; }
    const hDoc = snap.docs[0];
    const hid = hDoc.id;
    if ((hDoc.data().members || []).includes(user.uid)) {
      // 既にメンバー
      dbSetHousehold(hid);
    } else {
      await updateDoc(doc(_db, "households", hid), { members: arrayUnion(user.uid) });
      await setDoc(doc(_db, "users", user.uid, "settings", "household"), { householdId: hid });
      dbSetHousehold(hid);
      log("世帯に参加:", hid);
    }
    $("household-code-input").value = "";
    _onChanged();
    await _refresh();
  } catch (err) {
    logErr("世帯参加エラー:", err.message, err);
    alert("参加に失敗しました: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function _leave() {
  const user = _getUser();
  if (!user) return;
  const hid = dbGetHousehold();
  if (!hid) return;
  if (!confirm("世帯グループから退出します。個人モードに切り替わります。")) return;

  try {
    await updateDoc(doc(_db, "households", hid), { members: arrayRemove(user.uid) });
    await setDoc(doc(_db, "users", user.uid, "settings", "household"), { householdId: null });
    dbClearHousehold();
    log("世帯から退出");
    _onChanged();
    await _refresh();
  } catch (err) {
    logErr("世帯退出エラー:", err.message, err);
    alert("退出に失敗しました: " + err.message);
  }
}
