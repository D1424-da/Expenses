// stats.js のテスト — 最安値比較・カテゴリ集計の純粋関数。
import { describe, it, expect } from "vitest";
import {
  normName,
  median,
  buildPriceHistory,
  lowestPriceAlerts,
  categoryBreakdown,
  summarizeByStore,
} from "./stats.js";

// ---- normName --------------------------------------------------------------
describe("normName", () => {
  it("lowercases ASCII and strips spaces/symbols", () => {
    expect(normName("リンゴ ")).toBe("リンゴ");          // カタカナは変換しない
    expect(normName("牛乳（１L）")).toBe("牛乳１l");     // 記号除去・小文字化
    expect(normName("milk.whole")).toBe("milkwhole");   // ドット除去
  });
  it("treats full-width and half-width spaces the same", () => {
    expect(normName("卵　10個")).toBe(normName("卵 10個"));
  });
  it("deduplicates entries with whitespace variation", () => {
    // 空白違いの同一商品が同じキーになることを確認
    expect(normName("牛 乳")).toBe(normName("牛乳"));
  });
});

// ---- median ----------------------------------------------------------------
describe("median", () => {
  it("returns middle value for odd-length array", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it("returns average of two middle values for even-length array", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it("handles single-element array", () => {
    expect(median([42])).toBe(42);
  });
});

// ---- buildPriceHistory -----------------------------------------------------
describe("buildPriceHistory", () => {
  it("picks the minimum price across all expenses", () => {
    const expenses = [
      { items: [{ name: "りんご", price: 200 }] },
      { items: [{ name: "りんご", price: 150 }, { name: "牛乳", price: 180 }] },
      { items: [{ name: "りんご", price: 220 }] },
    ];
    const h = buildPriceHistory(expenses);
    expect(h.get(normName("りんご"))).toBe(150);
    expect(h.get(normName("牛乳"))).toBe(180);
  });

  it("skips items without name or price", () => {
    const expenses = [
      { items: [{ name: "", price: 100 }, { name: "卵", price: 0 }, { name: "卵", price: 200 }] },
    ];
    const h = buildPriceHistory(expenses);
    expect(h.get(normName("卵"))).toBe(200);
    expect(h.size).toBe(1);
  });

  it("normalizes names before keying", () => {
    const expenses = [
      { items: [{ name: "牛 乳", price: 190 }] },
      { items: [{ name: "牛乳", price: 180 }] },
    ];
    const h = buildPriceHistory(expenses);
    expect(h.size).toBe(1);
    expect(h.get(normName("牛乳"))).toBe(180);
  });

  it("returns empty map for expenses with no items", () => {
    const h = buildPriceHistory([{ items: [] }, { store: "A", amount: 500 }]);
    expect(h.size).toBe(0);
  });
});

// ---- lowestPriceAlerts -----------------------------------------------------
describe("lowestPriceAlerts", () => {
  it("alerts when current price equals all-time minimum", () => {
    const history = new Map([[normName("りんご"), 150]]);
    const thisMonth = [{ store: "A", items: [{ name: "りんご", price: 150 }] }];
    const alerts = lowestPriceAlerts(history, thisMonth);
    expect(alerts.length).toBe(1);
    expect(alerts[0].name).toBe("りんご");
    expect(alerts[0].price).toBe(150);
  });

  it("does not alert when price is above all-time minimum", () => {
    const history = new Map([[normName("りんご"), 130]]);
    const thisMonth = [{ store: "A", items: [{ name: "りんご", price: 150 }] }];
    expect(lowestPriceAlerts(history, thisMonth)).toHaveLength(0);
  });

  it("caps alerts at 5", () => {
    const history = new Map();
    const items = Array.from({ length: 8 }, (_, i) => ({ name: `品目${i}`, price: 100 }));
    items.forEach((it) => history.set(normName(it.name), 100));
    const thisMonth = [{ store: "A", items }];
    expect(lowestPriceAlerts(history, thisMonth).length).toBe(5);
  });

  it("returns empty array when no items this month", () => {
    const history = new Map([[normName("りんご"), 100]]);
    expect(lowestPriceAlerts(history, [{ items: [] }])).toHaveLength(0);
    expect(lowestPriceAlerts(history, [])).toHaveLength(0);
  });

  it("ignores items with price 0", () => {
    const history = new Map([[normName("サンプル"), 0]]);
    const thisMonth = [{ store: "A", items: [{ name: "サンプル", price: 0 }] }];
    expect(lowestPriceAlerts(history, thisMonth)).toHaveLength(0);
  });
});

// ---- categoryBreakdown -----------------------------------------------------
describe("categoryBreakdown", () => {
  it("uses expense category when no items", () => {
    const expenses = [{ amount: 500, category: "食費", items: [] }];
    expect(categoryBreakdown(expenses)).toEqual({ 食費: 500 });
  });

  it("allocates by item ratio when items present", () => {
    const expenses = [{
      amount: 300,
      category: "食費",
      items: [
        { name: "A", price: 200, category: "食費" },
        { name: "B", price: 100, category: "日用品" },
      ],
    }];
    const bd = categoryBreakdown(expenses);
    expect(bd["食費"] + bd["日用品"]).toBe(300);
    expect(bd["食費"]).toBeGreaterThan(bd["日用品"]);
  });

  it("falls back to expense category for items without own category", () => {
    const expenses = [{
      amount: 200,
      category: "食費",
      items: [{ name: "A", price: 200 }],
    }];
    expect(categoryBreakdown(expenses)).toEqual({ 食費: 200 });
  });

  it("allocates to 未分類 when no category at all", () => {
    const expenses = [{ amount: 100, items: [] }];
    expect(categoryBreakdown(expenses)).toEqual({ 未分類: 100 });
  });

  it("total across categories always equals expense amount", () => {
    const expenses = [{
      amount: 1080,
      category: "食費",
      items: [
        { name: "A", price: 300, category: "食費" },
        { name: "B", price: 700, category: "日用品" },
      ],
    }];
    const bd = categoryBreakdown(expenses);
    const total = Object.values(bd).reduce((s, v) => s + v, 0);
    expect(total).toBe(1080);
  });
});

// ---- summarizeByStore ------------------------------------------------------
describe("summarizeByStore", () => {
  it("identifies current and historical low prices", () => {
    const entries = [
      { store: "A", branch: "", price: 200, date: "2025-01-01" },
      { store: "A", branch: "", price: 150, date: "2025-03-01" },
      { store: "A", branch: "", price: 180, date: "2025-06-01" },
    ];
    const [r] = summarizeByStore(entries);
    expect(r.current).toBe(180);
    expect(r.low).toBe(150);
    expect(r.hasLow).toBe(true);
  });

  it("groups store+branch separately", () => {
    const entries = [
      { store: "A", branch: "新宿", price: 100, date: "2025-01-01" },
      { store: "A", branch: "渋谷", price: 120, date: "2025-01-01" },
    ];
    expect(summarizeByStore(entries)).toHaveLength(2);
  });

  it("detects sale when latest price is 10%+ below median", () => {
    const entries = [
      { store: "A", branch: "", price: 200, date: "2025-01-01" },
      { store: "A", branch: "", price: 200, date: "2025-02-01" },
      { store: "A", branch: "", price: 100, date: "2025-03-01" }, // セール
    ];
    const [r] = summarizeByStore(entries);
    expect(r.saleNow).toBe(true);
  });
});
