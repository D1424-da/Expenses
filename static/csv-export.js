// CSVエクスポート機能。
import { $, monthKey } from "./dom-utils.js";
import { fetchAllExpensesUnlimited } from "./firestore-data.js";
import { log, logErr } from "./log.js";

export async function exportCsv() {
  const btn = $("export-btn");
  btn.disabled = true;
  btn.textContent = "⏳ 準備中…";
  try {
    const all = await fetchAllExpensesUnlimited();
    const rows = [
      ["日付", "店名", "支店名", "金額", "カテゴリ", "メモ", "品目名", "品目価格", "OCRエンジン"],
    ];
    for (const e of all) {
      const items = e.items || [];
      if (!items.length) {
        rows.push([e.date, e.store || "", e.branch || "", e.amount, e.category || "", e.memo || "", "", "", e.ocrEngine || ""]);
      } else {
        items.forEach((it, i) => {
          rows.push([e.date, e.store || "", e.branch || "", i === 0 ? e.amount : "", e.category || "", e.memo || "", it.name || "", it.price || "", i === 0 ? e.ocrEngine || "" : ""]);
        });
      }
    }
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM付きでExcel対応
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `家計簿_${monthKey(new Date())}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    log("CSVエクスポート:", all.length, "件");
  } catch (err) {
    logErr("CSVエクスポートエラー:", err.message, err);
    alert("エクスポートに失敗しました: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "📥 CSV";
  }
}
