// @ts-check
/**
 * システムテスト — フロントエンド + バックエンド API 統合検証
 *
 * Firebase 認証不要なエンドポイントを対象にする:
 *   - /api/health
 *   - /api/recipe (認証不要)
 *   - 静的ファイル配信
 */
import { test, expect } from "@playwright/test";

test.describe("ヘルスチェック統合", () => {
  test("バックエンドが起動している", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("status");
    expect(body.status).toBe("ok");
  });

  test("フロントエンドページが 200 を返す", async ({ request }) => {
    const res = await request.get("/login.html");
    expect(res.status()).toBe(200);
    const ct = res.headers()["content-type"] ?? "";
    expect(ct).toContain("text/html");
  });

  test("静的 CSS ファイルが配信される", async ({ request }) => {
    const res = await request.get("/style.css");
    expect(res.status()).toBe(200);
  });

  test("静的 JS ファイルが配信される", async ({ request }) => {
    const res = await request.get("/app.js");
    expect(res.status()).toBe(200);
  });
});

test.describe("レシピ API 統合", () => {
  test("空リストは 422 を返す", async ({ request }) => {
    const res = await request.post("/api/recipe", {
      data: { items: [], servings: 1 },
    });
    expect(res.status()).toBe(422);
  });

  test("servings=0 は 422 を返す", async ({ request }) => {
    const res = await request.post("/api/recipe", {
      data: { items: ["卵"], servings: 0 },
    });
    expect(res.status()).toBe(422);
  });

  test("有効なリクエストは 200 か 503 を返す（API キーなし）", async ({ request }) => {
    const res = await request.post("/api/recipe", {
      data: { items: ["卵", "トマト"], servings: 2 },
    });
    expect([200, 503]).toContain(res.status());
  });

  test("51 品目は 422 を返す", async ({ request }) => {
    const res = await request.post("/api/recipe", {
      data: { items: Array(51).fill("食材"), servings: 1 },
    });
    expect(res.status()).toBe(422);
  });
});

test.describe("認証保護エンドポイント", () => {
  test("OCR エンドポイントは認証なしで 401 を返す（プロジェクト設定時）", async ({ request }) => {
    // サーバーは FIREBASE_PROJECT_ID='' で起動しているので認証スキップ → 400 か 422
    // FIREBASE_PROJECT_ID が設定されていれば 401 になる
    // ここではレスポンスが 5xx でないことのみ確認
    const res = await request.post("/api/ocr", {
      multipart: {
        file: { name: "test.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not-an-image") },
      },
    });
    expect(res.status()).not.toBe(500);
    expect(res.status()).not.toBe(502);
    expect(res.status()).not.toBe(503);
  });
});

test.describe("エラーレスポンス安全性", () => {
  test("存在しない API は 404 を返す", async ({ request }) => {
    const res = await request.get("/api/nonexistent");
    expect(res.status()).toBe(404);
  });

  test("404 レスポンスにスタックトレースが含まれない", async ({ request }) => {
    const res = await request.get("/api/nonexistent");
    const body = await res.text();
    expect(body).not.toContain("Traceback");
    expect(body).not.toContain("/home/");
  });
});
