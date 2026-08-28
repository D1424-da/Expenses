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

describe("予算の手がかり（T6）", () => {
  it("initBudget に fetchHistory を渡している", () => {
    // 渡さないと案内ブロックと「平均 · 先月」の行が黙って出なくなる。
    // 予算設定自体は動くので、壊れたことに気づきにくい。
    const args = initArgs("initBudget");
    expect(args, "initBudget( の呼び出しが見つからない").not.toBeNull();
    expect(args).toMatch(/\bfetchHistory\s*[,:]/);
    expect(args).not.toMatch(/\bfetchHistory:\s*null\b/);
  });
});

describe("レシピ提案ウィザード（T4）", () => {
  const html = readFileSync(new URL("./login.html", import.meta.url), "utf8");
  const view = readFileSync(new URL("./recipe-view.js", import.meta.url), "utf8");

  it("提案モーダルが3つの画面に分かれている", () => {
    const steps = [...html.matchAll(/class="recipe-step"\s+data-step="(\w+)"/g)]
      .map((m) => m[1]);
    expect(steps).toEqual(["ingredients", "options", "result"]);
  });

  it("段階の移動に必要な要素が揃っている", () => {
    // どれか1つでも欠けると、押しても進まない・現在地が出ないという
    // 「動くけれど進めない」壊れ方になる。
    for (const id of ["recipe-back-btn", "recipe-suggest-btn",
                      "recipe-step-hint", "recipe-steps-dots", "recipe-steps-count"]) {
      expect(html, `#${id} が無い`).toContain(`id="${id}"`);
    }
  });

  it("判定は recipe-steps.js に置いてある", () => {
    // recipe-view.js の中で条件を書き直すとテストできなくなる。
    expect(view).toMatch(/from "\.\/recipe-steps\.js"/);
    expect(view).toMatch(/canAdvance\(/);
  });

  it("提案ボタンは段階の振り分けを通す", () => {
    // _suggest を直接ぶら下げると、1画面目からAPIを叩いてしまう。
    expect(view).toMatch(/\$\("recipe-suggest-btn"\)\.onclick\s*=\s*_onNext/);
  });
});

describe("スマホの下部まわり", () => {
  const html = readFileSync(new URL("./login.html", import.meta.url), "utf8");
  const css  = readFileSync(new URL("./style.css", import.meta.url), "utf8");
  const app  = readFileSync(new URL("./app.js", import.meta.url), "utf8");

  it("もっと見るドロワーに閉じるボタンがある", () => {
    // 背景タップしか閉じ方が無いと、シートの上を押している限り戻れない。
    expect(html).toContain('id="bnav-more-close"');
    expect(app).toMatch(/\$\("bnav-more-close"\)\.onclick/);
  });

  it("ドロワーは Esc でも閉じる", () => {
    expect(app).toMatch(/Escape/);
  });

  it("本文下の余白が FAB の高さを超えている", () => {
    // 下部ナビ56px + FAB62px + 間隔14px = 132px。ここが足りないと
    // 「＋ 手で入力する」など最下段のボタンが FAB の下に隠れる。
    const m = css.match(/main \{[\s\S]*?padding: 14px 14px calc\((\d+)px/);
    expect(m, "main の padding-bottom が読めない").not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(132);
  });
});
