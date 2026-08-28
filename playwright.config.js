// @ts-check
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  workers: 1, // CI 環境でのリソース競合を避ける

  use: {
    baseURL: "http://localhost:8765",
    headless: true,
    // プリインストール済み Chromium を使う。
    //
    // **executablePath は launchOptions の中に置くこと。** use 直下に書いても
    // Playwright は認識せず、同梱の chromium_headless_shell（この環境には
    // 入っていない）を探しに行って全ブラウザテストが数ミリ秒で落ちる。
    // 失敗が速すぎるうえ「ページが開けない」風のエラーになるので、
    // アプリ側の不具合と紛らわしい。
    // パスはバージョン番号を含まない シンボリックリンク を使う（更新で番号が変わるため）。
    launchOptions: {
      executablePath: "/opt/pw-browsers/chromium",
    },
    screenshot: "only-on-failure",
    video: "off",
    // Firebase の非同期処理を待つためタイムアウトを少し長めに
    actionTimeout: 8_000,
    navigationTimeout: 15_000,
  },

  projects: [
    // --- デスクトップ（UI / E2E / システム / 回帰 / アクセシビリティ）---
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        launchOptions: { executablePath: "/opt/pw-browsers/chromium" },
        channel: undefined,
      },
    },
    // --- モバイル（レスポンシブ）---
    {
      name: "mobile-chrome",
      use: {
        ...devices["Pixel 5"],
        launchOptions: { executablePath: "/opt/pw-browsers/chromium" },
        channel: undefined,
      },
    },
    // --- タブレット（Chromium ベースのタブレット UA）---
    {
      name: "tablet-chrome",
      use: {
        launchOptions: { executablePath: "/opt/pw-browsers/chromium" },
        channel: undefined,
        viewport: { width: 810, height: 1080 },
        userAgent:
          "Mozilla/5.0 (Linux; Android 11; SM-T510) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36",
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 1,
      },
    },
  ],

  // テスト前にローカルサーバーを起動する
  webServer: {
    command:
      "CORS_ORIGINS=http://localhost:8765 FIREBASE_PROJECT_ID='' uvicorn main:app --host 0.0.0.0 --port 8765 --log-level warning",
    url: "http://localhost:8765/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
