/**
 * 認証後 E2E テスト — Firebase Auth Emulator を使用
 *
 * 前提: Firebase Emulator が起動済みであること
 *   Auth:      http://127.0.0.1:9099
 *   Firestore: http://127.0.0.1:8080
 *
 * 実行: FIREBASE_EMULATOR=true npx playwright test e2e/auth-flow.spec.js
 */
import { test, expect, request } from "@playwright/test";

const AUTH_EMULATOR = "http://127.0.0.1:9099";
const PROJECT_ID    = "expenses-9af61";

const TEST_EMAIL    = "e2e-test@example.com";
const TEST_PASSWORD = "testpass123";

// ---------------------------------------------------------------------------
// ヘルパー: Auth Emulator REST API でユーザーを作成/削除する
// ---------------------------------------------------------------------------

async function createTestUser(apiContext) {
  const res = await apiContext.post(
    `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      data: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        returnSecureToken: true,
      },
    }
  );
  return res.json();
}

async function clearAllUsers(apiContext) {
  await apiContext.delete(
    `${AUTH_EMULATOR}/emulator/v1/projects/${PROJECT_ID}/accounts`
  );
}

// ---------------------------------------------------------------------------
// テスト用ページ設定: window.__USE_EMULATOR__ = true を注入する
// ---------------------------------------------------------------------------

test.use({
  baseURL: "http://localhost:8765",
});

test.beforeEach(async ({ page }) => {
  // Firebase SDK 初期化前に Emulator フラグを立てる
  await page.addInitScript(() => {
    window.__USE_EMULATOR__ = true;
  });
});

// ---------------------------------------------------------------------------
// テストスイート
// ---------------------------------------------------------------------------

test.describe("認証フロー（エミュレーター）", () => {
  let apiContext;

  test.beforeAll(async ({ playwright }) => {
    apiContext = await playwright.request.newContext();
    await clearAllUsers(apiContext);
  });

  test.afterAll(async () => {
    await clearAllUsers(apiContext);
    await apiContext.dispose();
  });

  test("メール/パスワードでログインできる", async ({ page }) => {
    // テストユーザーを作成
    await createTestUser(apiContext);

    await page.goto("/login.html");

    // ログイン画面が表示されるのを待つ（Firebase 初期化後に hidden が外れる）
    await page.waitForSelector("#login-screen:not([hidden])", { timeout: 10_000 });

    await page.fill("#email-input", TEST_EMAIL);
    await page.fill("#password-input", TEST_PASSWORD);
    await page.click("#email-submit-btn");

    // アプリ本体が表示されることを確認
    await page.waitForSelector("#app:not([hidden])", { timeout: 10_000 });
    await expect(page.locator("#app")).not.toHaveAttribute("hidden");
  });

  test("ログイン後にホーム画面の主要要素が存在する", async ({ page }) => {
    await createTestUser(apiContext);

    await page.goto("/login.html");
    await page.waitForSelector("#login-screen:not([hidden])", { timeout: 10_000 });

    await page.fill("#email-input", TEST_EMAIL);
    await page.fill("#password-input", TEST_PASSWORD);
    await page.click("#email-submit-btn");

    await page.waitForSelector("#app:not([hidden])", { timeout: 10_000 });

    // 主要 UI 要素が存在することを確認
    await expect(page.locator("h1")).toContainText("カケイシピ");
    await expect(page.locator("#summary-total")).toBeAttached();
    await expect(page.locator("#expense-list")).toBeAttached();
    await expect(page.locator("#expense-form")).toBeAttached();
    await expect(page.locator("#calendar")).toBeAttached();
  });

  test("ログアウトするとログイン画面に戻る", async ({ page }) => {
    await createTestUser(apiContext);

    await page.goto("/login.html");
    await page.waitForSelector("#login-screen:not([hidden])", { timeout: 10_000 });

    await page.fill("#email-input", TEST_EMAIL);
    await page.fill("#password-input", TEST_PASSWORD);
    await page.click("#email-submit-btn");
    await page.waitForSelector("#app:not([hidden])", { timeout: 10_000 });

    // アカウントモーダルを開いてログアウト
    await page.click("#account-btn");
    await page.waitForSelector("#account-modal:not([hidden])", { timeout: 5_000 });
    await page.click("#logout");

    // ログイン画面に戻ることを確認
    await page.waitForSelector("#login-screen:not([hidden])", { timeout: 10_000 });
    await expect(page.locator("#app")).toHaveAttribute("hidden", "");
  });

  test("新規登録してアプリを使用できる", async ({ page }) => {
    const newEmail = `new-user-${Date.now()}@example.com`;

    await page.goto("/login.html");
    await page.waitForSelector("#login-screen:not([hidden])", { timeout: 10_000 });

    // 新規登録モードに切り替え
    await page.click("#email-mode-toggle");
    await expect(page.locator("#email-submit-btn")).toHaveText("新規登録");

    await page.fill("#email-input", newEmail);
    await page.fill("#password-input", TEST_PASSWORD);
    await page.click("#email-submit-btn");

    // アプリ本体が表示されることを確認
    await page.waitForSelector("#app:not([hidden])", { timeout: 10_000 });
    await expect(page.locator("#app")).not.toHaveAttribute("hidden");
  });

  test("誤ったパスワードではログインできない", async ({ page }) => {
    await createTestUser(apiContext);

    await page.goto("/login.html");
    await page.waitForSelector("#login-screen:not([hidden])", { timeout: 10_000 });

    await page.fill("#email-input", TEST_EMAIL);
    await page.fill("#password-input", "wrongpassword");
    await page.click("#email-submit-btn");

    // エラーメッセージが表示されることを確認
    await page.waitForSelector("#email-login-error:not([hidden])", { timeout: 5_000 });
    await expect(page.locator("#email-login-error")).toBeVisible();
    await expect(page.locator("#app")).toHaveAttribute("hidden", "");
  });

  test("ログイン後に支出フォームのフィールドが入力できる", async ({ page }) => {
    await createTestUser(apiContext);

    await page.goto("/login.html");
    await page.waitForSelector("#login-screen:not([hidden])", { timeout: 10_000 });

    await page.fill("#email-input", TEST_EMAIL);
    await page.fill("#password-input", TEST_PASSWORD);
    await page.click("#email-submit-btn");
    await page.waitForSelector("#app:not([hidden])", { timeout: 10_000 });

    // フォームに入力
    const today = new Date().toISOString().slice(0, 10);
    await page.fill("#f-date", today);
    await page.fill("#f-amount", "1500");
    await page.fill("#f-store", "テストスーパー");

    await expect(page.locator("#f-date")).toHaveValue(today);
    await expect(page.locator("#f-amount")).toHaveValue("1500");
    await expect(page.locator("#f-store")).toHaveValue("テストスーパー");
  });

  test("ログイン後にアカウントモーダルにメールアドレスが表示される", async ({ page }) => {
    await createTestUser(apiContext);

    await page.goto("/login.html");
    await page.waitForSelector("#login-screen:not([hidden])", { timeout: 10_000 });

    await page.fill("#email-input", TEST_EMAIL);
    await page.fill("#password-input", TEST_PASSWORD);
    await page.click("#email-submit-btn");
    await page.waitForSelector("#app:not([hidden])", { timeout: 10_000 });

    await page.click("#account-btn");
    await page.waitForSelector("#account-modal:not([hidden])", { timeout: 5_000 });

    await expect(page.locator("#account-user-email")).toHaveText(TEST_EMAIL);
  });
});
