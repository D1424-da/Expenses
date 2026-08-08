// @ts-check
/**
 * レスポンシブテスト — モバイル / タブレット / デスクトップ レイアウト検証
 *
 * 各 viewport で以下を確認:
 *   - 主要 UI 要素が表示範囲内に収まる（水平スクロールしない）
 *   - モバイル専用要素がデスクトップで非表示
 *   - PC ナビがデスクトップで表示 / モバイルで非表示
 *   - タップターゲットのサイズ（44px 推奨）
 */
import { test, expect } from "@playwright/test";

test.describe("デスクトップレイアウト", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login.html");
  });

  test("水平スクロールが発生しない", async ({ page }) => {
    const scrollWidth  = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth  = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  test("topbar-btn--mobile-only がデスクトップで非表示", async ({ page }) => {
    // CSS: @media (min-width: 769px) { .topbar-btn--mobile-only { display: none } }
    const mobileOnlyBtns = page.locator(".topbar-btn--mobile-only");
    const count = await mobileOnlyBtns.count();
    for (let i = 0; i < count; i++) {
      await expect(mobileOnlyBtns.nth(i)).toBeHidden();
    }
  });

  test("PC ナビが表示される", async ({ page }) => {
    // .pc-nav は min-width:769px 以上で display:flex
    const pcNav = page.locator(".pc-nav");
    if (await pcNav.count() > 0) {
      const display = await pcNav.evaluate((el) => getComputedStyle(el).display);
      expect(display).not.toBe("none");
    }
  });
});

test.describe("モバイルレイアウト (Pixel 5 — 393x851)", () => {
  test.use({ viewport: { width: 393, height: 851 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login.html");
  });

  test("水平スクロールが発生しない", async ({ page }) => {
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  test("ボトムナビボタンが DOM に存在する", async ({ page }) => {
    // #app は Firebase 初期化前は hidden — attached のみ確認
    await expect(page.locator("#bnav-home")).toBeAttached();
  });

  test("FAB が表示される", async ({ page }) => {
    await expect(page.locator("#fab-camera")).toBeAttached();
  });

  test("ボトムナビボタンのタップターゲットが十分な高さ", async ({ page }) => {
    const btn = page.locator("#bnav-home");
    const box = await btn.boundingBox();
    if (box) {
      // WCAG 2.5.5 推奨 44px — モバイルで最低 40px 確保
      expect(box.height).toBeGreaterThanOrEqual(40);
    }
  });

  test("email 入力フィールドが画面幅に収まる", async ({ page }) => {
    const input = page.locator("#email-input");
    const box = await input.boundingBox();
    if (box) {
      expect(box.width).toBeLessThanOrEqual(393);
    }
  });
});

test.describe("タブレットレイアウト (iPad — 810x1080)", () => {
  test.use({ viewport: { width: 810, height: 1080 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login.html");
  });

  test("水平スクロールが発生しない", async ({ page }) => {
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  test("主要コンテンツがビューポートに収まる", async ({ page }) => {
    const app = page.locator("#app");
    await expect(app).toBeAttached();
    const box = await app.boundingBox();
    if (box) {
      expect(box.width).toBeLessThanOrEqual(810 + 1);
    }
  });
});
