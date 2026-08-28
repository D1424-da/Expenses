// レシピ提案ウィザードの段階管理。
//
// 「進めない理由を返す」ことがこの層の要点。黙って disabled にすると、
// 利用者は何が足りないのか分からないまま止まる。
import { describe, it, expect } from "vitest";
import {
  RECIPE_STEPS, stepIndex, stepMeta, canAdvance, nextStep, prevStep,
} from "./recipe-steps.js";

describe("stepIndex / nextStep / prevStep", () => {
  it("3段ある", () => {
    expect(RECIPE_STEPS).toEqual(["ingredients", "options", "result"]);
  });

  it("未知の値は先頭として扱う", () => {
    expect(stepIndex("xxx")).toBe(0);
    expect(stepIndex(undefined)).toBe(0);
  });

  it("端では範囲外に出ない", () => {
    expect(prevStep("ingredients")).toBe("ingredients");
    expect(nextStep("result")).toBe("result");
    expect(nextStep("ingredients")).toBe("options");
    expect(prevStep("result")).toBe("options");
  });
});

describe("stepMeta", () => {
  it("進捗を 1 / 3 の形で返す", () => {
    expect(stepMeta("ingredients").progress).toBe("1 / 3");
    expect(stepMeta("result").progress).toBe("3 / 3");
  });

  it("最初の画面には戻る先が無い", () => {
    expect(stepMeta("ingredients").canBack).toBe(false);
    expect(stepMeta("options").canBack).toBe(true);
  });

  it("2画面目の次へは提案ボタンの文言になる", () => {
    // ここが「次へ」のままだと、いつAIに投げるのかが分からない。
    expect(stepMeta("options").nextLabel).toContain("提案");
    expect(stepMeta("result").nextLabel).toBeNull();
  });
});

describe("canAdvance", () => {
  const opts = { servings: 2 };

  it("食材が0件なら進めず、理由を返す", () => {
    const r = canAdvance("ingredients", { ingredientCount: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("期間");
  });

  it("食材があれば進める", () => {
    expect(canAdvance("ingredients", { ingredientCount: 3 }).ok).toBe(true);
  });

  it("予算モードでは選んだ食材の数で判定する", () => {
    // 購入履歴の件数が0でも、予算モードなら関係ない。
    expect(canAdvance("ingredients",
      { budgetMode: true, ingredientCount: 0, budgetSelectedCount: 2 }).ok).toBe(true);
    const r = canAdvance("ingredients",
      { budgetMode: true, ingredientCount: 9, budgetSelectedCount: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("選んで");
  });

  it("人数が範囲外なら進めない", () => {
    for (const servings of [0, -1, 21, "", "abc", null]) {
      const r = canAdvance("options", { servings });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("1〜20");
    }
    expect(canAdvance("options", { servings: "4" }).ok).toBe(true);
  });

  it("週間献立の期間エラーはそのまま理由になる", () => {
    const r = canAdvance("options", { ...opts, planRangeError: "開始日を選んでください。" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("開始日を選んでください。");
  });

  it("提案中は二重送信させない", () => {
    // 連打で同じリクエストを2回投げると、課金のかかる API を無駄に叩く。
    expect(canAdvance("options", { ...opts, busy: true }).ok).toBe(false);
    expect(canAdvance("ingredients", { ingredientCount: 3, busy: true }).ok).toBe(false);
  });

  it("結果画面から先には進めない", () => {
    const r = canAdvance("result", opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeNull();
  });
});
