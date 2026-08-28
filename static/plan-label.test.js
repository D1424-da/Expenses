// アカウント画面のプラン状態の文言。
//
// ベータ付与（実質無期限）・トライアル・解約手続き済み・通常課金の
// 取り違えは、画面を見ないと気づけない壊れ方をする。
import { describe, it, expect } from "vitest";
import { planSummary } from "./plan-label.js";

const NOW = 1_767_225_600;          // 2026-01-01 00:00:00 UTC 付近
const DAY = 86400;
const PRICE = 500;

describe("planSummary", () => {
  it("未契約なら何も出さない", () => {
    expect(planSummary(null, NOW, PRICE).kind).toBe("none");
    expect(planSummary(undefined, NOW, PRICE).text).toBeNull();
  });

  it("ベータ付与は日付を出さない", () => {
    // currentPeriodEnd=9999999999 なので、日付を出すと 2286年 になる。
    const r = planSummary(
      { plan: "beta", status: "active", currentPeriodEnd: 9999999999 },
      NOW, PRICE,
    );
    expect(r.kind).toBe("beta");
    expect(r.text).not.toMatch(/\d{4}年/);
  });

  it("トライアル中は残り日数と開始額を出す", () => {
    const r = planSummary(
      { plan: "trial", status: "active", currentPeriodEnd: NOW + 3 * DAY },
      NOW, PRICE,
    );
    expect(r.kind).toBe("trial");
    expect(r.daysLeft).toBe(3);
    expect(r.text).toContain("残り3日");
    expect(r.text).toContain("¥500/月");
  });

  it("トライアルから課金へ移行した人はトライアル扱いにしない", () => {
    // サーバーは merge=True で書くため plan:'trial' が残る。
    // plan だけで見ると、課金済みの人に「残り日数」を出してしまう。
    const r = planSummary(
      {
        plan: "trial", status: "active",
        stripeSubscriptionId: "sub_1",
        currentPeriodEnd: NOW + 20 * DAY,
      },
      NOW, PRICE,
    );
    expect(r.kind).toBe("active");
    expect(r.text).toContain("次回のお支払い");
  });

  it("解約手続き済みは利用可能期限を出す", () => {
    const r = planSummary(
      {
        status: "active", stripeSubscriptionId: "sub_1",
        cancelAtPeriodEnd: true, currentPeriodEnd: NOW + 10 * DAY,
      },
      NOW, PRICE,
    );
    expect(r.kind).toBe("canceling");
    expect(r.text).toContain("解約手続き済み");
    expect(r.text).not.toContain("次回のお支払い");
  });

  it("通常の課金中は次回のお支払い日を出す", () => {
    // 以前はここが null で、課金中の人には何も出ていなかった。
    const r = planSummary(
      {
        status: "active", stripeSubscriptionId: "sub_1",
        currentPeriodEnd: NOW + 12 * DAY,
      },
      NOW, PRICE,
    );
    expect(r.kind).toBe("active");
    expect(r.text).toMatch(/^次回のお支払い/);
    expect(r.text).toMatch(/\d{4}年\d{1,2}月\d{1,2}日/);
  });

  it("期限が壊れているときは何も出さない", () => {
    for (const end of [undefined, null, 0, -1, "x", NaN]) {
      expect(planSummary({ status: "active", currentPeriodEnd: end }, NOW, PRICE).kind)
        .toBe("none");
    }
  });

  it("期限を過ぎていても残り日数は負にならない", () => {
    const r = planSummary(
      { plan: "trial", status: "active", currentPeriodEnd: NOW - 5 * DAY },
      NOW, PRICE,
    );
    expect(r.daysLeft).toBe(0);
  });
});
