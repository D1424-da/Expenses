// expense-limits.js のテスト — firestore.rules の validExpense と同じ上限を守れているか。
import { describe, it, expect } from "vitest";
import { validateExpense, clampRawText, LIMITS } from "./expense-limits.js";

const base = () => ({
  date: "2026-08-11",
  store: "スーパーA",
  branch: "本店",
  amount: 1200,
  category: "食費",
  memo: "",
  items: [{ name: "牛乳", price: 200, category: "食費" }],
});

describe("validateExpense", () => {
  it("通常のデータは通す", () => {
    expect(validateExpense(base())).toBeNull();
  });

  it("明細が上限ちょうどなら通す", () => {
    const p = base();
    p.items = Array.from({ length: LIMITS.items }, () => ({ name: "x", price: 1 }));
    expect(validateExpense(p)).toBeNull();
  });

  it("明細が上限を超えるとエラーにする（切り捨てない）", () => {
    const p = base();
    p.items = Array.from({ length: LIMITS.items + 1 }, () => ({ name: "x", price: 1 }));
    const err = validateExpense(p);
    expect(err).toContain(String(LIMITS.items));
    expect(p.items).toHaveLength(LIMITS.items + 1); // 破棄しない
  });

  it("金額が1億円以上ならエラー", () => {
    const p = base();
    p.amount = LIMITS.amount;
    expect(validateExpense(p)).toContain("大きすぎます");
  });

  it("金額が数値でなければエラー", () => {
    const p = base();
    p.amount = NaN;
    expect(validateExpense(p)).toContain("正しく入力");
  });

  it("負の金額はエラー", () => {
    const p = base();
    p.amount = -1;
    expect(validateExpense(p)).toContain("正しく入力");
  });

  it("長すぎる店名・支店名・メモは切り詰めて保存を通す", () => {
    const p = base();
    p.store  = "あ".repeat(LIMITS.store + 50);
    p.branch = "い".repeat(LIMITS.branch + 50);
    p.memo   = "う".repeat(LIMITS.memo + 50);
    expect(validateExpense(p)).toBeNull();
    expect(p.store).toHaveLength(LIMITS.store);
    expect(p.branch).toHaveLength(LIMITS.branch);
    expect(p.memo).toHaveLength(LIMITS.memo);
  });

  it("items が未定義でも落ちない", () => {
    const p = base();
    delete p.items;
    expect(validateExpense(p)).toBeNull();
  });
});

describe("clampRawText", () => {
  it("上限を超えるOCRテキストは切り詰める", () => {
    expect(clampRawText("x".repeat(LIMITS.rawText + 100))).toHaveLength(LIMITS.rawText);
  });

  it("文字列以外は空文字にする", () => {
    expect(clampRawText(undefined)).toBe("");
    expect(clampRawText(null)).toBe("");
  });
});
