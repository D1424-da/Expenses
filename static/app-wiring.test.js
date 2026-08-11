// app.js の結線（各モジュールへ渡す依存）の検証。
//
// 2026-08-07 のリファクタリングで initForm に db: null が渡され、
// 編集・更新・削除が「Expected first argument to collection() to be ...」で
// 全て失敗する不具合が本番に4日間入り込んだ。
// app.js は Firebase SDK を import するため単体テストで実行できないので、
// ソースを静的に検査して同種の渡し忘れを検知する。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, "app.js"), "utf8");

/** init系呼び出しの引数部分を粗く取り出す */
function initArgs(name) {
  const i = appSrc.indexOf(`${name}({`);
  if (i === -1) return null;
  // 対応する閉じ括弧まで（ネストは浅いので括弧の数で追う）
  let depth = 0;
  for (let p = appSrc.indexOf("{", i); p < appSrc.length; p++) {
    if (appSrc[p] === "{") depth++;
    else if (appSrc[p] === "}") {
      depth--;
      if (depth === 0) return appSrc.slice(i, p + 1);
    }
  }
  return null;
}

// Firestore の db 実体を必要とするモジュール（doc(db, ...) を内部で組み立てる）
const NEEDS_DB = [
  "initForm",
  "initBudget",
  "initSavedRecipes",
  "initShoppingList",
  "initMealPlan",
  "initBilling",
  "initRecipe",
];

describe("app.js の依存結線", () => {
  for (const name of NEEDS_DB) {
    it(`${name} に db の実体を渡している（null を渡さない）`, () => {
      const args = initArgs(name);
      expect(args, `${name}( の呼び出しが見つからない`).not.toBeNull();
      expect(args).not.toMatch(/\bdb:\s*null\b/);
      // `db,`（短縮記法）か `db: <何か>` のどちらかで渡っていること
      expect(args).toMatch(/\bdb\s*[,:]/);
    });
  }

  it("init系に null を渡している引数が無い", () => {
    // 依存の渡し忘れは実行時まで気づけないため、null 直渡し自体を禁止する
    const offenders = [];
    for (const name of NEEDS_DB) {
      const args = initArgs(name);
      if (args && /:\s*null\b/.test(args)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
