// 利用者へのフィードバック表示（トースト・エラーメッセージの整形）。
//
// 以前は失敗を全て alert() で出していた。alert() には2つの問題がある。
//   1. ブラウザの操作を完全にブロックする。スマホでは特に煩わしい。
//   2. 中身が技術的だった（例: "保存に失敗しました: FirebaseError:
//      Missing or insufficient permissions"）。利用者は対処のしようがない。
//
// ここでは「利用者が次に何をすればいいか」が分かる文言に翻訳し、
// 技術的な詳細は console.error にだけ残す。
//
// .toast のスタイルは style.css にある（Stripe の決済結果表示で先に
// 使われていたものを、アプリ全体で使うようにした）。

/** 表示時間（ミリ秒）。エラーは読む時間が要るので長め。 */
const DURATION = { success: 3000, error: 6000 };

/**
 * 画面下部にトーストを出す。
 * @param {string} message 利用者向けの文言
 * @param {"success"|"error"|"info"} kind
 */
export function showToast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = kind === "success" ? "toast toast-success"
    : kind === "error" ? "toast toast-error"
    : "toast";
  // スクリーンリーダーにも伝える。エラーは即座に読ませたいので assertive。
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), DURATION[kind] || DURATION.success);
  return el;
}

/**
 * 例外を利用者向けの文言に翻訳する。
 *
 * err.message をそのまま出さない。Firebase や fetch のメッセージは
 * 英語の内部エラーで、利用者が読んでも次の行動が決まらないため。
 */
export function toUserMessage(err, fallback = "処理に失敗しました。") {
  // オフラインは最も多い原因。通信エラーより先に判定する。
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "オフラインのようです。通信状況を確認してから、もう一度お試しください。";
  }
  const raw = String((err && (err.code || err.message)) || "");

  if (/permission-denied|insufficient permissions/i.test(raw)) {
    // Firestore のルール違反。入力値が上限を超えている場合が大半。
    return "保存できませんでした。入力内容が長すぎないかご確認ください。";
  }
  if (/unauthenticated|auth\/|ID token/i.test(raw)) {
    return "ログインの有効期限が切れました。お手数ですが再度ログインしてください。";
  }
  if (/failed to fetch|network|NetworkError|timeout|aborted/i.test(raw)) {
    return "通信に失敗しました。電波の良い場所でもう一度お試しください。";
  }
  if (/quota|resource-exhausted|429/i.test(raw)) {
    return "アクセスが集中しています。少し時間をおいてからお試しください。";
  }
  if (/unavailable|503|502/i.test(raw)) {
    return "サーバーが一時的に応答していません。少し待って再度お試しください。";
  }
  return fallback;
}

/**
 * 失敗をまとめて処理する。console に技術的詳細、画面には翻訳した文言。
 * @param {unknown} err   捕捉した例外
 * @param {string} fallback 原因を特定できなかったときの文言
 */
export function showError(err, fallback = "処理に失敗しました。") {
  console.error(fallback, err);
  return showToast(toUserMessage(err, fallback), "error");
}

/** 成功時の短いフィードバック。 */
export function showSuccess(message) {
  return showToast(message, "success");
}
