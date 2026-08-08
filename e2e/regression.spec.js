// @ts-check
/**
 * 回帰テスト — 過去に修正されたバグが再発しないことを確認
 *
 * 修正済みバグ一覧:
 *   REG-001: --primary CSS トークン未定義でログインボタンが透明になる
 *   REG-002: input:focus に outline:none が設定されキーボードフォーカスが不可視
 *   REG-003: モバイル専用ボタンがデスクトップで表示されてしまう
 *   REG-004: empty-state が古いテキスト ("まだレシートがありません") のまま
 *   REG-005: today-month ボタンが存在しない
 *   REG-006: prefers-reduced-motion 対応がない
 */
import { test, expect } from "@playwright/test";

test.describe("REG-001: --primary トークン定義", () => {
  test("--primary CSS カスタムプロパティが定義されている", async ({ page }) => {
    await page.goto("/login.html");
    const primary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()
    );
    expect(primary).not.toBe("");
    expect(primary).not.toBe("undefined");
  });
});

test.describe("REG-002: フォーカス可視性", () => {
  test("email input の outline がグローバルで none に上書きされていない", async ({ page }) => {
    await page.goto("/login.html");
    // ページ全体の style を取得して outline:none の誤った上書きがないか確認
    // input のフォーカス時 style を直接検証
    const hasOutlineNoneOnFocus = await page.evaluate(() => {
      const sheets = [...document.styleSheets];
      for (const sheet of sheets) {
        try {
          const rules = [...sheet.cssRules];
          for (const rule of rules) {
            if (rule instanceof CSSStyleRule) {
              const sel = rule.selectorText ?? "";
              if ((sel.includes("input") || sel.includes("select")) &&
                  sel.includes(":focus") && !sel.includes(":focus-visible")) {
                const outline = rule.style.getPropertyValue("outline");
                if (outline === "none" || outline === "0") return true;
              }
            }
          }
        } catch { /* cross-origin */ }
      }
      return false;
    });
    expect(hasOutlineNoneOnFocus).toBe(false);
  });
});

test.describe("REG-003: モバイル専用ボタンのデスクトップ表示", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("shopping-btn がデスクトップで表示されない", async ({ page }) => {
    await page.goto("/login.html");
    await expect(page.locator("#shopping-btn")).toBeHidden();
  });

  test("saved-recipes-btn がデスクトップで表示されない", async ({ page }) => {
    await page.goto("/login.html");
    await expect(page.locator("#saved-recipes-btn")).toBeHidden();
  });
});

test.describe("REG-004: empty-state コピー", () => {
  test("empty-state に正しいコピーが設定されている", async ({ page }) => {
    await page.goto("/login.html");
    const title = await page.locator("#empty-msg .empty-state-title").textContent();
    // 古いコピーが残っていないことを確認
    expect(title).not.toContain("まだレシートがありません");
    // 新しいコピーが設定されていることを確認
    expect(title).toBeTruthy();
  });

  test("empty-state に CTA ボタンが存在する", async ({ page }) => {
    await page.goto("/login.html");
    await expect(page.locator("#empty-cta-btn")).toBeAttached();
  });
});

test.describe("REG-005: today-month ボタン", () => {
  test("today-month ボタンが DOM に存在する", async ({ page }) => {
    await page.goto("/login.html");
    await expect(page.locator("#today-month")).toBeAttached();
    await expect(page.locator("#today-month")).toHaveAttribute("aria-label", "今月に戻る");
  });
});

test.describe("REG-006: prefers-reduced-motion", () => {
  test("reduced-motion メディアクエリが CSS に存在する", async ({ page }) => {
    await page.goto("/login.html");
    const hasReducedMotion = await page.evaluate(() => {
      const sheets = [...document.styleSheets];
      for (const sheet of sheets) {
        try {
          const rules = [...sheet.cssRules];
          for (const rule of rules) {
            if (rule instanceof CSSMediaRule) {
              if (rule.conditionText?.includes("prefers-reduced-motion")) {
                return true;
              }
            }
          }
        } catch { /* cross-origin */ }
      }
      return false;
    });
    expect(hasReducedMotion).toBe(true);
  });
});
