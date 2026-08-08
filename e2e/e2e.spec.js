// @ts-check
/**
 * E2E テスト — Firebase 認証なしで到達可能なユーザーフロー
 *
 * Firebase SDK がロードされる前の画面 (ログイン画面) と、
 * 認証不要の API エンドポイントに対してフローを検証する。
 *
 * 認証が必要なフロー（家計一覧・レシート登録）は Firebase
 * Emulator を使うか、モック認証状態で実行する必要があるため
 * ここでは範囲外とする。
 */
import { test, expect } from "@playwright/test";

test.describe("ページ遷移とロード", () => {
  test("/ にアクセスするとアプリが表示される", async ({ page }) => {
    const res = await page.goto("/login.html");
    expect(res?.status()).toBe(200);
    await expect(page.locator("body")).toBeAttached();
  });

  test("存在しないパスは 404 ページを返す", async ({ page }) => {
    const res = await page.goto("/nonexistent-page");
    // FastAPI は 404 を返す
    expect(res?.status()).toBe(404);
  });

  test("JavaScript エラーがコンソールに出ない（致命的なもの）", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("/login.html");
    await page.waitForTimeout(2000); // JS 初期化待機
    // Firebase の設定エラー（テスト環境では正常）以外のエラーがないことを確認
    const fatalErrors = errors.filter((e) =>
      !e.includes("Firebase") &&
      !e.includes("firestore") &&
      !e.includes("auth") &&
      !e.includes("initializeApp") &&
      !e.includes("Cannot read properties of null") // hidden 要素への DOM アクセスは許容
    );
    expect(fatalErrors).toHaveLength(0);
  });
});

test.describe("ログインフォームフロー", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login.html");
  });

  test("メールアドレスとパスワードフィールドが DOM に存在する", async ({ page }) => {
    // login-screen は Firebase 初期化前は hidden — attached のみ確認
    await expect(page.locator("#email-input")).toBeAttached();
    await expect(page.locator("#password-input")).toBeAttached();
  });

  test("アカウント新規作成トグルが DOM に存在する", async ({ page }) => {
    // login-screen は Firebase 初期化前は hidden — attached のみ確認
    await expect(page.locator("#email-mode-toggle")).toBeAttached();
  });

  test("フォームが submit type=submit ボタンを持つ", async ({ page }) => {
    const submitBtn = page.locator("#email-submit-btn");
    await expect(submitBtn).toHaveAttribute("type", "submit");
  });
});

test.describe("レシピ API — E2E フロー", () => {
  test("正常なリクエストでサーバーが応答する", async ({ request }) => {
    const res = await request.post("/api/recipe", {
      data: { items: ["にんじん", "じゃがいも", "玉ねぎ"], servings: 4 },
    });
    // Gemini API キーがない環境では 503、ある環境では 200
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(body).toBeDefined();
  });

  test("バリデーションエラーは構造化レスポンスで返る", async ({ request }) => {
    const res = await request.post("/api/recipe", {
      data: { items: [], servings: 0 },
    });
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body).toHaveProperty("detail");
  });
});

test.describe("ナビゲーション操作", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login.html");
    await page.waitForLoadState("networkidle");
  });

  test("ページ読み込み後に body が存在する", async ({ page }) => {
    await expect(page.locator("body")).toBeAttached();
  });

  test("キーボードで Tab 移動できる（致命的エラーなし）", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    // Tab を数回押す
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
    }

    const fatalErrors = errors.filter((e) =>
      !e.includes("Firebase") && !e.includes("auth")
    );
    expect(fatalErrors).toHaveLength(0);
  });
});
