// 期限切れ間近のサブスクリプションを Stripe から取り直すかの判定。
//
// この判定を間違えると、**支払っているのにプレミアムが切れる**という
// 最も印象の悪い形で表面化する。しかも発覚するのは「最初の有料利用者の
// 最初の更新」なので、開発中には気づけない。
import { describe, it, expect } from "vitest";
import { shouldResync } from "./stripe-resync.js";

const NOW = 1_700_000_000;
const DAY = 86400;

/** Stripe の実契約（_persist_subscription が書く形） */
const paid = (endOffsetSec, extra = {}) => ({
  status: "active",
  stripeSubscriptionId: "sub_123",
  currentPeriodEnd: NOW + endOffsetSec,
  ...extra,
});

describe("shouldResync", () => {
  it("期限まで十分あるときは問い合わせない", () => {
    expect(shouldResync(paid(20 * DAY), NOW)).toBe(false);
  });

  it("期限の24時間前を切ったら問い合わせる", () => {
    expect(shouldResync(paid(23 * 3600), NOW)).toBe(true);
  });

  it("期限を過ぎていたら問い合わせる（webhook が届かなかったケース）", () => {
    expect(shouldResync(paid(-3 * DAY), NOW)).toBe(true);
  });

  it("未契約（ドキュメントが無い）なら問い合わせない", () => {
    expect(shouldResync(null, NOW)).toBe(false);
    expect(shouldResync(undefined, NOW)).toBe(false);
  });

  it("ベータコードによる付与は Stripe に契約が無いので問い合わせない", () => {
    // beta は currentPeriodEnd=9999999999 で実質無期限。
    expect(shouldResync(
      { status: "active", plan: "beta", currentPeriodEnd: 9999999999 }, NOW,
    )).toBe(false);
  });

  it("トライアル中は Stripe に契約が無いので問い合わせない", () => {
    // トライアル終了直前でも、問い合わせ先が無いので呼ばない。
    expect(shouldResync(
      { status: "active", plan: "trial", currentPeriodEnd: NOW + 3600 }, NOW,
    )).toBe(false);
  });

  it("トライアルから課金へ移行した利用者を取りこぼさない", () => {
    // サーバーの _persist_subscription は merge=True で書くため、
    // 課金に移行しても plan:'trial' が残る。plan で弾く実装にすると、
    // **本当に守りたい利用者だけが修復対象から漏れる**。
    expect(shouldResync(paid(-1 * DAY, { plan: "trial" }), NOW)).toBe(true);
  });

  it("解約予約中でも期限が近ければ取り直す（実際に切れたかを確認するため）", () => {
    expect(shouldResync(paid(2 * 3600, { cancelAtPeriodEnd: true }), NOW)).toBe(true);
  });

  it("currentPeriodEnd が壊れているときは問い合わせない", () => {
    for (const end of [undefined, null, 0, -1, "1700000000", NaN]) {
      expect(shouldResync(
        { stripeSubscriptionId: "sub_123", currentPeriodEnd: end }, NOW,
      )).toBe(false);
    }
  });
});
