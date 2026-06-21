// parser.js（ブラウザ内OCRの抽出ロジック）の純粋関数テスト。
// Python 版(app/parser.py)と挙動を揃える意図のケースを含む。
import { describe, it, expect } from "vitest";
import {
  parseDate,
  parseTotal,
  parseItems,
  guessCategory,
  normalizeAmount,
} from "./parser.js";

describe("parseTotal", () => {
  it("prefers 合計 over 小計/お預り/お釣り", () => {
    expect(parseTotal("小計 900\n合計 1080\nお預り 2000\nお釣り 920")).toBe(1080);
  });
  it("excludes cash/change in fallback", () => {
    expect(parseTotal("りんご 100\nお預り 5000\nお釣り 4900")).toBe(100);
  });
  it("reads amount on the next line", () => {
    expect(parseTotal("合計\n¥1,280")).toBe(1280);
  });
});

describe("parseDate", () => {
  it("expands 2-digit year", () => {
    expect(parseDate("24/01/02 のレシート")).toBe("2024-01-02");
  });
  it("rejects rollover dates", () => {
    expect(parseDate("2024/02/30")).toBeNull();
  });
  it("parses Japanese format", () => {
    expect(parseDate("2026年6月21日")).toBe("2026-06-21");
  });
});

describe("guessCategory", () => {
  it("matches store/keyword", () => {
    expect(guessCategory("", "イオン")).toBe("食費");
    expect(guessCategory("映画チケット", "")).toBe("娯楽");
    expect(guessCategory("", "謎の店")).toBe("その他");
  });
});

describe("normalizeAmount", () => {
  it("parses full-width and commas", () => {
    expect(normalizeAmount("１，２８０円")).toBe(1280);
    expect(normalizeAmount("なし")).toBeNull();
  });
});

describe("parseItems", () => {
  it("extracts name+price lines", () => {
    const items = parseItems("合計 500\nりんご 248\nぶどう 252");
    const names = items.map((it) => it.name);
    expect(names.length).toBeGreaterThan(0);
  });
});
