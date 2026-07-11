// CSV エクスポートの行生成ロジックを純粋関数として切り出してテスト。
// app.js の _exportCsv から DOM 依存を取り除いた等価ロジック。
import { describe, it, expect } from "vitest";

function buildCsvRows(expenses) {
  const rows = [
    ["日付", "店名", "支店名", "金額", "カテゴリ", "メモ", "品目名", "品目価格", "OCRエンジン"],
  ];
  for (const e of expenses) {
    const items = e.items || [];
    if (!items.length) {
      rows.push([e.date, e.store || "", e.branch || "", e.amount, e.category || "", e.memo || "", "", "", e.ocrEngine || ""]);
    } else {
      items.forEach((it, i) => {
        rows.push([e.date, e.store || "", e.branch || "", i === 0 ? e.amount : "", e.category || "", e.memo || "", it.name || "", it.price || "", i === 0 ? e.ocrEngine || "" : ""]);
      });
    }
  }
  return rows;
}

describe("buildCsvRows", () => {
  it("outputs one row for a receipt with no items", () => {
    const rows = buildCsvRows([
      { date: "2025-06-01", store: "A", branch: "", amount: 500, category: "食費", memo: "", items: [], ocrEngine: "gemini" },
    ]);
    expect(rows).toHaveLength(2); // header + 1 data row
    expect(rows[1][3]).toBe(500);
  });

  it("outputs amount only on the first item row (not N× inflated)", () => {
    const rows = buildCsvRows([{
      date: "2025-06-01", store: "イオン", branch: "", amount: 1000, category: "食費", memo: "", ocrEngine: "gemini",
      items: [
        { name: "りんご", price: 400 },
        { name: "牛乳",   price: 300 },
        { name: "卵",     price: 300 },
      ],
    }]);
    // header + 3 item rows
    expect(rows).toHaveLength(4);
    expect(rows[1][3]).toBe(1000); // first row: amount
    expect(rows[2][3]).toBe("");   // second row: empty
    expect(rows[3][3]).toBe("");   // third row: empty
  });

  it("sum of amount column equals total amount (not N× inflated)", () => {
    const amount = 800;
    const rows = buildCsvRows([{
      date: "2025-06-01", store: "B", branch: "", amount, category: "", memo: "", ocrEngine: "",
      items: [{ name: "A", price: 400 }, { name: "B", price: 400 }],
    }]);
    const amountCol = rows.slice(1).map((r) => r[3]).filter((v) => v !== "");
    const total = amountCol.reduce((s, v) => s + v, 0);
    expect(total).toBe(amount);
  });

  it("outputs ocrEngine only on the first item row", () => {
    const rows = buildCsvRows([{
      date: "2025-06-01", store: "A", branch: "", amount: 500, category: "", memo: "", ocrEngine: "gemini",
      items: [{ name: "A", price: 250 }, { name: "B", price: 250 }],
    }]);
    expect(rows[1][8]).toBe("gemini");
    expect(rows[2][8]).toBe("");
  });

  it("handles a mix of itemless and item receipts", () => {
    const expenses = [
      { date: "2025-06-01", store: "A", branch: "", amount: 300, category: "", memo: "", items: [], ocrEngine: "" },
      { date: "2025-06-02", store: "B", branch: "", amount: 600, category: "", memo: "", ocrEngine: "", items: [{ name: "X", price: 600 }] },
    ];
    const rows = buildCsvRows(expenses);
    expect(rows).toHaveLength(3); // header + 1 + 1
    const amounts = rows.slice(1).map((r) => r[3]).filter((v) => v !== "");
    expect(amounts).toEqual([300, 600]);
  });
});
