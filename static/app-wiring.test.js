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

  it("提案モーダルが4つの画面に分かれている", () => {
    const steps = [...html.matchAll(/class="recipe-step"\s+data-step="(\w+)"/g)]
      .map((m) => m[1]);
    expect(steps).toEqual(["mode", "ingredients", "options", "result"]);
  });

  it("段階の移動に必要な要素が揃っている", () => {
    // どれか1つでも欠けると、押しても進まない・現在地が出ないという
    // 「動くけれど進めない」壊れ方になる。
    for (const id of ["recipe-back-btn", "recipe-suggest-btn", "recipe-step-hint",
                      "recipe-steps-dots", "recipe-steps-count", "recipe-steps-bar",
                      "recipe-servings-minus", "recipe-servings-plus"]) {
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

describe("ホームの残額表示（T2-2）", () => {
  // サマリーの「予算まで あと ¥○○」とカテゴリバーは getBudget() の値で描く。
  // 予算は settings/budget_{monthKey} に月ごとに保存されているので、月を
  // 動かしたら読み直さないと**前の月の予算に対する残額**を見せてしまう。
  // 支出だけが切り替わるので、数字が動いている分だけ気づきにくい。

  it("月を動かす経路がすべて予算を読み直す", () => {
    // state.currentMonth を書き換えている箇所（代入と setMonth）を全部拾う。
    const writes = [...appSrc.matchAll(/state\.currentMonth(?:\s*=|\.setMonth\()[^\n]*/g)];
    expect(writes.length, "月を書き換える箇所が見つからない").toBeGreaterThanOrEqual(3);

    const offenders = [];
    for (const m of writes) {
      // 書き換えを囲むブロックの終わり（行頭が } または }) の行）までを見る。
      // 固定幅で切ると次の関数まで覗いてしまい、読み直しの有無を取り違える。
      const rest  = appSrc.slice(m.index);
      const end   = rest.search(/\n\s*\}\)?;?\s*(\n|$)/);
      const block = end === -1 ? rest : rest.slice(0, end);
      if (!/_reloadBudgetForMonth\(\)/.test(block)) offenders.push(m[0].trim());
    }
    expect(offenders, "月を動かした後に _reloadBudgetForMonth() が無い").toEqual([]);
  });

  it("読み直しは予算の再取得とサマリーの再描画を両方行う", () => {
    const i = appSrc.indexOf("async function _reloadBudgetForMonth");
    expect(i, "_reloadBudgetForMonth が無い").toBeGreaterThan(-1);
    const body = appSrc.slice(i, i + 300);
    expect(body).toMatch(/await loadBudget\(\)/);
    expect(body).toMatch(/renderSummary\(\)/);
  });
});

describe("フォームへのスクロール（T2-1）", () => {
  const ocr = readFileSync(new URL("./ocr-queue.js", import.meta.url), "utf8");
  const form = readFileSync(new URL("./expense-form.js", import.meta.url), "utf8");

  it("openForm は window.scrollTo で位置を合わせる", () => {
    // scrollIntoView だと sticky なヘッダーの裏にフォームの先頭が隠れる。
    expect(form).toMatch(/window\.scrollTo\(/);
    // 「使わない」と書いた説明のコメントは残るので、呼び出しの形だけを見る。
    expect(form).not.toMatch(/\.scrollIntoView\(/);
  });

  it("OCR完了後のスクロールも openForm を通す", () => {
    // #ocr-status はフォームより上にあり、簡易読み取りの注意文で3行に伸びる。
    // fillForm 内の openForm() はその前に位置を計算しているため、文言が
    // 確定したあとに開き直す必要がある。ここで scrollIntoView に戻すと
    // ヘッダーの裏に隠れる不具合が復活する。
    expect(ocr).toMatch(/openForm\(\)/);
    expect(ocr).not.toMatch(/form-card"\)\.scrollIntoView/);
  });
});

describe("レシピ提案の初期期間（T4）", () => {
  it("提案モーダルは「今週」で開く", () => {
    // 未選択だと「選ばないと進めない」状態になり、2タップで提案まで
    // 届かない。「今月」だと献立に使うには古い食材まで候補に混ざる。
    const opens = [...appSrc.matchAll(/openRecipeModal\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
    expect(opens.length, "openRecipeModal の呼び出しが見つからない").toBeGreaterThan(0);
    for (const call of opens) {
      expect(call, "initialPeriod が week でない").toMatch(/initialPeriod:\s*"week"/);
    }
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
