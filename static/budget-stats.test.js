// 予算設定の手がかり（平均・先月）の計算。
//
// 根拠の薄い数字を「平均」として見せると、利用者は**それを正しい基準だと
// 受け取る**。記録を始めたばかりの月は数日分しか無いこともあるので、
// 月数が足りないときに出さない判定をここで固定する。
import { describe, it, expect } from "vitest";
import { summarizeHistory, targetMonthKeys, sumLimits } from "./budget-stats.js";

const NOW = new Date(2026, 7, 15); // 2026-08-15
const e = (date, amount, category = "食費") => ({ date, amount, category });

describe("targetMonthKeys", () => {
  it("当月は含めず、直前の3か月を新しい順に返す", () => {
    // 当月は途中なので平均の材料にしない。
    expect(targetMonthKeys(NOW)).toEqual(["2026-07", "2026-06", "2026-05"]);
  });

  it("年をまたいでも正しい", () => {
    expect(targetMonthKeys(new Date(2026, 0, 10))).toEqual([
      "2025-12", "2025-11", "2025-10",
    ]);
  });
});

describe("summarizeHistory", () => {
  it("3か月そろっていれば平均を出す", () => {
    const r = summarizeHistory(
      [e("2026-07-02", 30000), e("2026-06-02", 30000), e("2026-05-02", 30000)],
      NOW,
    );
    expect(r.hasAverage).toBe(true);
    expect(r.average["食費"]).toBe(30000);
    expect(r.averageTotal).toBe(30000);
  });

  it("2か月しか実績が無ければ平均を出さない", () => {
    // 根拠の薄い平均を見せるほうが害になる。
    const r = summarizeHistory([e("2026-07-02", 30000), e("2026-06-02", 30000)], NOW);
    expect(r.monthsWithData).toBe(2);
    expect(r.hasAverage).toBe(false);
  });

  it("先月だけ実績があるときは先月の額を返す", () => {
    const r = summarizeHistory([e("2026-07-02", 28000)], NOW);
    expect(r.hasAverage).toBe(false);
    expect(r.hasLastMonth).toBe(true);
    expect(r.lastMonth["食費"]).toBe(28000);
  });

  it("先月に実績が無ければ hasLastMonth は false", () => {
    const r = summarizeHistory([e("2026-06-02", 28000), e("2026-05-02", 28000)], NOW);
    expect(r.hasLastMonth).toBe(false);
  });

  it("当月の支出は平均に含めない", () => {
    // 月の途中なので、含めると平均が低く出る。
    const r = summarizeHistory(
      [e("2026-08-14", 99999), e("2026-07-02", 30000),
       e("2026-06-02", 30000), e("2026-05-02", 30000)],
      NOW,
    );
    expect(r.average["食費"]).toBe(30000);
  });

  it("3か月より前の支出も含めない", () => {
    const r = summarizeHistory(
      [e("2026-04-02", 99999), e("2026-07-02", 30000),
       e("2026-06-02", 30000), e("2026-05-02", 30000)],
      NOW,
    );
    expect(r.average["食費"]).toBe(30000);
  });

  it("実績が無かった月は0として割る", () => {
    // 使わなかった月を分母から外すと、たまたま記録の少ない月がある人の
    // 平均が跳ね上がり、予算の目安として高すぎる値になる。
    const r = summarizeHistory(
      [e("2026-07-02", 30000), e("2026-06-02", 30000), e("2026-05-02", 30000),
       e("2026-07-03", 30000)],
      NOW,
    );
    expect(r.average["食費"]).toBe(40000); // 120000 / 3
  });

  it("カテゴリごとに分ける。未設定は その他 にまとめる", () => {
    const r = summarizeHistory(
      [e("2026-07-02", 10000, "日用品"), e("2026-06-02", 20000, "日用品"),
       e("2026-05-02", 30000, "日用品"), { date: "2026-07-05", amount: 3000 }],
      NOW,
    );
    expect(r.average["日用品"]).toBe(20000);
    expect(r.average["その他"]).toBe(1000);
  });

  it("壊れたデータで落ちない", () => {
    const r = summarizeHistory(
      [null, {}, { date: 123, amount: 1 }, { date: "2026-07-02", amount: "x" },
       { date: "2026-07-02", amount: -500 }, e("2026-07-02", 1000)],
      NOW,
    );
    expect(r.lastMonth["食費"]).toBe(1000);
  });

  it("空でも例外にならない", () => {
    const r = summarizeHistory([], NOW);
    expect(r.hasAverage).toBe(false);
    expect(r.hasLastMonth).toBe(false);
    expect(r.averageTotal).toBe(0);
  });
});

describe("sumLimits", () => {
  it("空欄・0・不正値は 0 として合計する", () => {
    expect(sumLimits(["10000", "", "0", "abc", null, undefined, "-5", 2000]))
      .toBe(12000);
  });

  it("空配列は 0", () => {
    expect(sumLimits([])).toBe(0);
  });
});
