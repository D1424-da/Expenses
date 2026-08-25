// 期限切れ間近のサブスクリプションを Stripe から取り直すかの判定。
//
// DOM も通信も Firebase も触らない純粋関数だけを置く場所。
// stripe-billing.js は Firebase の CDN から import しているためテストから
// 読み込めない。判定ロジックをここに分けて、static/stripe-resync.test.js で
// 固定している（recipe-parse.js と同じ方針）。
//
// ## なぜこの仕組みが要るか
//
// Firestore の currentPeriodEnd を更新できるのは「決済直後の
// /api/stripe/sync」と「Stripe の webhook」だけ。月次更新のときは利用者が
// 居ないので webhook 頼みになるが、バックエンド（Render 無料プラン）は
// 15分アイドルでスリープし、寝ている間に届いた webhook は初回タイムアウトする。
// 届かないまま期限を過ぎると **支払っているのにプレミアムが切れる**。
//
// そこで、次にアプリを開いたときに自分で取り直して修復する。

/** 期限の何秒前から取り直しの対象にするか。 */
export const RESYNC_BEFORE_SEC = 24 * 60 * 60;

/**
 * 再取得すべきサブスクリプションかを返す。
 *
 * @param {object|null|undefined} sub users/{uid}/settings/subscription の中身
 * @param {number} nowSec 現在時刻（Unix秒）
 */
export function shouldResync(sub, nowSec) {
  if (!sub) return false;

  // beta / trial は Stripe 側に対応する契約が無いので、問い合わせても
  // not_found が返るだけで無駄になる。
  //
  // **plan では判定しないこと。** サーバーの _persist_subscription は
  // merge=True で書くため、トライアルから課金へ移行しても plan:'trial' が
  // 残る。plan で弾くと、本当に守りたい「トライアル経由の課金利用者」だけが
  // 修復対象から漏れる。Stripe の契約 ID の有無で見る。
  if (!sub.stripeSubscriptionId) return false;

  const end = sub.currentPeriodEnd;
  if (typeof end !== "number" || !Number.isFinite(end) || end <= 0) return false;
  return end - nowSec <= RESYNC_BEFORE_SEC;
}
