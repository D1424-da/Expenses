// Stripe サブスクリプション管理 — プラン確認・アップグレードモーダル・チェックアウト。
//
// 無料プラン: 月10件まで記録可能。
// プレミアム: 記録件数無制限（月額サブスク）。
import {
  getDoc, onSnapshot, doc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { OCR_API_BASE } from "./firebase-config.js";
import { openModal, closeModal, $ } from "./dom-utils.js";
import { log, logErr } from "./log.js";

export const FREE_LIMIT = 10;

let _db, _getUser;
let _sub = null;         // キャッシュ済みサブスクリプション情報
let _unsubSub = null;    // Firestore リスナーの解除関数

export function initBilling({ db, getUser }) {
  _db = db;
  _getUser = getUser;

  $("upgrade-close").onclick   = () => closeModal("upgrade-modal");
  $("upgrade-checkout-btn").onclick = _startCheckout;
}

// ログイン時に呼ぶ。Firestore のサブスクリプション状態をリアルタイムで購読する。
export function startBillingSync() {
  const user = _getUser();
  if (!user) return;
  if (_unsubSub) _unsubSub();

  const ref = doc(_db, "users", user.uid, "settings", "subscription");
  _unsubSub = onSnapshot(ref, (snap) => {
    _sub = snap.exists() ? snap.data() : null;
    log("課金状態更新:", _sub?.status ?? "無料");
    _updatePremiumBadge();
  }, (err) => {
    logErr("課金状態取得エラー:", err.message);
    _sub = null;
  });
}

// ログアウト時に呼ぶ。
export function stopBillingSync() {
  if (_unsubSub) { _unsubSub(); _unsubSub = null; }
  _sub = null;
}

// サブスクリプションが有効かどうかを返す。
export function isPremium() {
  if (!_sub) return false;
  if (_sub.status !== "active") return false;
  const end = _sub.currentPeriodEnd;
  if (end && typeof end === "number" && end < Date.now() / 1000) return false;
  return true;
}

// 新規保存の前に呼ぶ。制限内なら true、超えていたらモーダルを開いて false。
// isEdit: 編集の場合は無条件 true（件数制限対象外）。
export function checkGate(currentMonthCount, isEdit = false) {
  if (isEdit) return true;
  if (isPremium()) return true;
  if (currentMonthCount < FREE_LIMIT) return true;
  openModal("upgrade-modal");
  return false;
}

// 残り件数バナーを更新する。
export function renderUsageBar(currentMonthCount) {
  const bar = $("usage-bar");
  if (!bar) return;
  if (isPremium()) {
    bar.hidden = true;
    return;
  }
  const remaining = Math.max(0, FREE_LIMIT - currentMonthCount);
  bar.hidden = false;
  bar.querySelector(".usage-count").textContent =
    remaining === 0
      ? "今月の無料記録（10件）に達しました"
      : `今月あと ${remaining} 件 記録できます（無料プラン）`;
  bar.querySelector(".usage-upgrade").hidden = remaining > 3;
}

function _updatePremiumBadge() {
  const badge = $("premium-badge");
  if (!badge) return;
  badge.hidden = !isPremium();
}

async function _startCheckout() {
  const user = _getUser();
  if (!user) return;
  const btn = $("upgrade-checkout-btn");
  btn.disabled = true;
  btn.textContent = "⏳ 移動中…";
  try {
    const token = await user.getIdToken();
    const res = await fetch(`${OCR_API_BASE}/api/stripe/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ email: user.email }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${res.status}`);
    }
    const { url } = await res.json();
    location.href = url;
  } catch (err) {
    logErr("チェックアウトエラー:", err.message);
    alert("決済ページへの移動に失敗しました: " + err.message);
    btn.disabled = false;
    btn.textContent = "今すぐアップグレード";
  }
}
