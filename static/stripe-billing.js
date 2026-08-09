// Stripe サブスクリプション管理 — プラン確認・アップグレードモーダル・チェックアウト。
//
// 無料プラン: 14日間トライアルのみ。トライアル終了後は課金が必要。
// プレミアム: 記録件数無制限（¥500/月サブスク）。
import {
  getDoc, onSnapshot, doc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { OCR_API_BASE } from "./firebase-config.js";
import { openModal, closeModal, $ } from "./dom-utils.js";
import { log, logErr } from "./log.js";

let _db, _getUser, _onSubChange;
let _sub = null;         // キャッシュ済みサブスクリプション情報
let _subLoaded = false;  // 初回スナップショット受信済みフラグ
let _unsubSub = null;    // Firestore リスナーの解除関数

export function initBilling({ db, getUser, onSubChange }) {
  _db = db;
  _getUser = getUser;
  _onSubChange = onSubChange;

  $("upgrade-close").onclick        = () => closeModal("upgrade-modal");
  $("upgrade-checkout-btn").onclick = _startCheckout;
  $("beta-code-btn").onclick        = _redeemBetaCode;
  $("beta-code-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); _redeemBetaCode(); }
  });
}

// ログイン時に呼ぶ。Firestore のサブスクリプション状態をリアルタイムで購読する。
export function startBillingSync() {
  const user = _getUser();
  if (!user) return;
  if (_unsubSub) _unsubSub();

  const ref = doc(_db, "users", user.uid, "settings", "subscription");
  _unsubSub = onSnapshot(ref, (snap) => {
    _sub = snap.exists() ? snap.data() : null;
    _subLoaded = true;
    log("課金状態更新:", _sub?.status ?? "無料");
    _updatePremiumBadge();
    // トライアル開始などでプレミアム状態が変わったら、利用状況バナーやゲートを即座に再反映する
    if (_onSubChange) _onSubChange();
  }, (err) => {
    logErr("課金状態取得エラー:", err.message);
    _sub = null;
    // エラー時もロード完了とみなしてゲートを閉じる（フェイルクローズ）。
    // _subLoaded が false のままだと checkGate が全員を楽観的に許可してしまう。
    _subLoaded = true;
    if (_onSubChange) _onSubChange();
  });
}

// 初回ログイン時に呼ぶ。サブスクリプション情報が未作成なら14日間の無料トライアルを開始する。
export async function ensureTrial() {
  const user = _getUser();
  if (!user) return;
  try {
    const token = await user.getIdToken();
    await fetch(`${OCR_API_BASE}/api/trial/ensure`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}` },
    });
  } catch (err) {
    logErr("トライアル開始エラー:", err.message);
  }
}

// ログアウト時に呼ぶ。
export function stopBillingSync() {
  if (_unsubSub) { _unsubSub(); _unsubSub = null; }
  _sub = null;
  _subLoaded = false;
}

// サブスク解約済み（期間終了後に無料プランへ戻る）なら期限の表示文字列を返す。有効期限なしなら null。
export function premiumExpiryLabel() {
  const end = _sub?.currentPeriodEnd;
  if (typeof end !== "number" || end <= 0) return null;
  const d = new Date(end * 1000);
  const dateStr = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  if (_sub?.plan === "trial") {
    return `${dateStr}まで無料トライアル中（以降は有料プランへの登録が必要です）`;
  }
  if (_sub?.cancelAtPeriodEnd) {
    return `${dateStr}まで利用可能（解約手続き済み）`;
  }
  return null;
}

// サブスクリプションが有効かどうかを返す。
export function isPremium() {
  if (!_sub) return false;
  // beta プランも status:'active' が必要（status:'cancelled' で失効できるようにする）
  if (_sub.plan === "beta" && _sub.status === "active") return true;
  if (_sub.status !== "active") return false;
  const end = _sub.currentPeriodEnd;
  if (typeof end === "number" && end > 0 && end < Date.now() / 1000) return false;
  return true;
}

// 新規保存の前に呼ぶ。プレミアムなら true、そうでなければアップグレードモーダルを開いて false。
// isEdit: 編集の場合は無条件 true。課金情報未ロード時は楽観的に許可する。
export function checkGate(_count, isEdit = false) {
  if (isEdit) return true;
  if (!_subLoaded) return true; // 課金情報読み込み中は許可（初回ロード直後の誤ブロックを防ぐ）
  if (isPremium()) return true;
  openModal("upgrade-modal");
  return false;
}

// 使用状況バナー（無料枠廃止のため何もしない）。
export function renderUsageBar(_count) {
  const bar = $("usage-bar");
  if (bar) bar.hidden = true;
}

function _updatePremiumBadge() {
  const badge = $("premium-badge");
  if (!badge) return;
  const premium = isPremium();
  badge.hidden = !premium;

  if (premium) {
    const end = _sub?.currentPeriodEnd;
    const dateStr = (typeof end === "number" && end > 0)
      ? (() => { const d = new Date(end * 1000); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; })()
      : null;
    if (_sub?.plan === "trial" && dateStr) {
      badge.textContent = `🎁 トライアル中（${dateStr}まで）`;
      badge.title = "無料トライアル期間中です。終了後は有料プランへの登録が必要になります。";
    } else if (_sub?.cancelAtPeriodEnd && dateStr) {
      badge.textContent = `✨ PRO（${dateStr}まで）`;
      badge.title = "解約手続き済み — 上記日付以降は無料プランに戻ります";
    } else {
      badge.textContent = "✨ PRO";
      badge.title = "プレミアムプラン";
    }
  }

  // トライアル・ベータユーザーには Stripe ポータルボタンを表示しない（顧客 ID 未作成のため）
  const portalWrap = $("account-portal-wrap");
  if (portalWrap) portalWrap.hidden = _sub?.plan === "beta" || _sub?.plan === "trial";
}

async function _redeemBetaCode() {
  const input = $("beta-code-input");
  const msg   = $("beta-code-msg");
  const btn   = $("beta-code-btn");
  const code  = input.value.trim();
  if (!code) return;

  btn.disabled = true;
  msg.hidden = true;

  try {
    const user = _getUser();
    if (!user) throw new Error("ログインが必要です。");
    const token = await user.getIdToken();
    const res = await fetch(`${OCR_API_BASE}/api/beta/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${res.status}`);
    }
    msg.textContent = "✅ 招待コードが適用されました！プレミアム機能が使えます。";
    msg.style.color = "var(--c-ok, green)";
    msg.hidden = false;
    input.value = "";
    setTimeout(() => closeModal("upgrade-modal"), 1500);
  } catch (err) {
    logErr("ベータコードエラー:", err.message);
    msg.textContent = "❌ " + err.message;
    msg.style.color = "var(--c-err, red)";
    msg.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

export async function openPortal() {
  const user = _getUser();
  if (!user) return;
  const btn = document.getElementById("account-portal-btn");
  const originalText = btn?.textContent ?? "";
  if (btn) { btn.disabled = true; btn.textContent = "接続中…"; }
  try {
    const token = await user.getIdToken();
    const res = await fetch(`${OCR_API_BASE}/api/stripe/portal`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${res.status}`);
    }
    const { url } = await res.json();
    if (!url || !url.startsWith("https://")) throw new Error("無効なリダイレクト先");
    location.href = url;
  } catch (err) {
    logErr("ポータルエラー:", err.message);
    alert("管理ページへの移動に失敗しました: " + err.message);
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
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
    if (!url || !url.startsWith("https://")) throw new Error("無効なリダイレクト先");
    location.href = url;
  } catch (err) {
    logErr("チェックアウトエラー:", err.message);
    alert("決済ページへの移動に失敗しました: " + err.message);
    btn.disabled = false;
    btn.textContent = "今すぐアップグレード";
  }
}
