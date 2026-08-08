// @ts-check
/**
 * UIテスト — 画面要素のレンダリング・インタラクション検証
 *
 * Firebase 認証は不要なページ（静的シェル）を対象にする。
 * 認証が必要なフローはモックページを使って検証する。
 */
import { test, expect } from "@playwright/test";

// ログイン画面は Firebase SDK が初期化されるまで hidden
// このテストでは直接 HTML ファイルをロードして DOM 構造のみ検証する

test.describe("ログイン画面 — 静的構造", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login.html");
  });

  test("ページタイトルが設定されている", async ({ page }) => {
    await expect(page).toHaveTitle(/カケイシピ|家計|Expenses/i);
  });

  test("ログイン画面の主要要素が存在する", async ({ page }) => {
    // Firebase SDK がロードされるまで login-screen は hidden だが DOM に存在する
    await expect(page.locator("#login-screen")).toBeAttached();
    await expect(page.locator("#google-login")).toBeAttached();
    await expect(page.locator("#email-login-form")).toBeAttached();
    await expect(page.locator("#email-input")).toBeAttached();
    await expect(page.locator("#password-input")).toBeAttached();
  });

  test("アプリシェルの主要要素が存在する", async ({ page }) => {
    await expect(page.locator("#app")).toBeAttached();
    await expect(page.locator("#fab-camera")).toBeAttached();
    await expect(page.locator("#bnav-home")).toBeAttached();
    await expect(page.locator("#bnav-calendar")).toBeAttached();
  });

  test("全モーダルが初期状態で hidden", async ({ page }) => {
    const modals = [
      "#budget-modal",
      "#trend-modal",
      "#account-modal",
      "#upgrade-modal",
      "#shopping-modal",
      "#saved-recipes-modal",
    ];
    for (const selector of modals) {
      await expect(page.locator(selector)).toBeHidden();
    }
  });

  test("empty-state 要素が存在する", async ({ page }) => {
    await expect(page.locator("#empty-msg")).toBeAttached();
    await expect(page.locator("#empty-msg .empty-state-title")).toBeAttached();
    await expect(page.locator("#empty-cta-btn")).toBeAttached();
  });

  test("today-month ボタンが存在する", async ({ page }) => {
    await expect(page.locator("#today-month")).toBeAttached();
  });

  test("モバイル専用ボタンが存在する", async ({ page }) => {
    await expect(page.locator("#shopping-btn")).toBeAttached();
    await expect(page.locator("#saved-recipes-btn")).toBeAttached();
  });
});

test.describe("フォームインタラクション", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login.html");
  });

  test("メールアドレス入力フィールドが存在し正しい型である", async ({ page }) => {
    // login-screen は Firebase 初期化前は hidden — attached と属性のみ確認
    const input = page.locator("#email-input");
    await expect(input).toBeAttached();
    await expect(input).toHaveAttribute("type", "email");
    await expect(input).toHaveAttribute("placeholder");
  });

  test("パスワード入力フィールドが type=password", async ({ page }) => {
    await expect(page.locator("#password-input")).toHaveAttribute("type", "password");
  });

  test("アカウント新規作成トグルが存在する", async ({ page }) => {
    await expect(page.locator("#email-mode-toggle")).toBeAttached();
  });

  test("パスワードリセットボタンが存在する", async ({ page }) => {
    await expect(page.locator("#email-reset-btn")).toBeAttached();
  });
});

test.describe("ナビゲーション構造", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login.html");
  });

  test("ボトムナビの全アイテムが存在する", async ({ page }) => {
    await expect(page.locator("#bnav-home")).toBeAttached();
    await expect(page.locator("#bnav-calendar")).toBeAttached();
    await expect(page.locator("#bnav-shopping")).toBeAttached();
    await expect(page.locator("#bnav-recipe")).toBeAttached();
  });

  test("PC ナビの全アイテムが存在する", async ({ page }) => {
    await expect(page.locator("#pcnav-home")).toBeAttached();
    await expect(page.locator("#pcnav-calendar")).toBeAttached();
    await expect(page.locator("#pcnav-recipe")).toBeAttached();
    await expect(page.locator("#pcnav-budget")).toBeAttached();
    await expect(page.locator("#pcnav-trend")).toBeAttached();
  });

  test("FAB カメラボタンが存在する", async ({ page }) => {
    const fab = page.locator("#fab-camera");
    await expect(fab).toBeAttached();
    await expect(fab).toHaveAttribute("aria-label", "レシートを撮影");
  });
});
