// アカウント画面に出すプラン状態の文言。DOM も Firebase も触らない純粋関数。
//
// stripe-billing.js は Firebase を CDN から import しておりテストから
// 読み込めないため、判定をここに分ける（recipe-parse.js と同じ方針）。
//
// ## なぜ切り出すか
//
// 「次回のお支払い」を出す分岐と「トライアル残り日数」を出す分岐は、
// ベータ付与（currentPeriodEnd が実質無期限）や解約手続き済みと
// 取り違えやすい。**ベータの人に「次回のお支払い 2286年…」と出す**
// ような壊れ方は、テストが無いと気づけない。

/** Unix秒 → "2026年8月11日" */
function _dateLabel(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * プラン状態を判定する。
 *
 * @param {object|null} sub users/{uid}/settings/subscription の中身
 * @param {number} nowSec 現在時刻（Unix秒）
 * @param {number} priceJpy 月額（表示用。呼び出し側の定数を渡す）
 * @returns {{ kind: string, text: string|null, daysLeft: number|null }}
 *   kind: "none" | "beta" | "trial" | "canceling" | "active"
 */
export function planSummary(sub, nowSec, priceJpy) {
  if (!sub) return { kind: "none", text: null, daysLeft: null };

  const end = sub.currentPeriodEnd;
  const hasEnd = typeof end === "number" && Number.isFinite(end) && end > 0;

  // ベータ付与は currentPeriodEnd が実質無期限。日付を出すと
  // 「次回のお支払い 2286年…」のような表示になる。
  if (sub.plan === "beta") {
    return { kind: "beta", text: "ベータ利用中（期限なし）", daysLeft: null };
  }
  if (!hasEnd) return { kind: "none", text: null, daysLeft: null };

  const daysLeft = Math.max(0, Math.ceil((end - nowSec) / 86400));
  const date = _dateLabel(end);

  if (sub.plan === "trial" && !sub.stripeSubscriptionId) {
    // トライアルから課金へ移行しても plan:'trial' が残る（サーバーが
    // merge=True で書くため）。Stripe の契約 ID の有無で見分ける。
    return {
      kind: "trial",
      text: `残り${daysLeft}日 · ${date}から ¥${priceJpy}/月`,
      daysLeft,
    };
  }
  if (sub.cancelAtPeriodEnd) {
    return { kind: "canceling", text: `${date}まで利用可能（解約手続き済み）`, daysLeft };
  }
  return { kind: "active", text: `次回のお支払い　${date}`, daysLeft };
}
