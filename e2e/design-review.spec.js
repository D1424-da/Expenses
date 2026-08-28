// @ts-check
/**
 * デザインレビュー（2026-08）で入れた修正が戻らないことを確認する。
 *
 * ここで見るのは「実際にブラウザで測らないと分からないもの」だけにする。
 * 文字列の有無なら vitest（ga4-events.test.js など）のほうが速い。
 *
 * ## この環境の制約
 *
 * login.html は Firebase SDK を www.gstatic.com から読み込む。サンドボックスの
 * プロキシが外部接続を遮断するため、**アプリの初期化は完了しない**
 * （#login-screen は hidden のまま）。そのため「ログイン後の画面」は
 * 検証できず、ここでは DOM 構造と計算後スタイルに絞っている。
 * 同じ理由で e2e/auth-flow.spec.js もこの環境では動かない。
 */
import { test, expect } from "@playwright/test";

test.describe("入力欄と操作対象の寸法", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("入力欄の font-size が 16px 未満にならない", async ({ page }) => {
    // 16px を下回ると iOS Safari がフォーカス時にページを自動拡大し、
    // 指で戻すまで縮まらない。見た目を詰めたいときは padding で調整する。
    await page.goto("/login.html");

    const small = await page.$$eval(
      "input:not([type=hidden]):not([type=file]), select, textarea",
      (els) =>
        els
          .map((el) => ({
            id: el.id || el.className || el.tagName,
            px: parseFloat(getComputedStyle(el).fontSize),
          }))
          .filter((x) => x.px > 0 && x.px < 16),
    );
    expect(small, `16px 未満の入力欄: ${JSON.stringify(small)}`).toEqual([]);
  });
});

test.describe("撮影ボタンのキーボード操作", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("撮影・写真選択が button で、フォーカスを受けられる", async ({ page }) => {
    // 以前は <label> の中に hidden な input を置いていた。label 自身は
    // フォーカスを受けず、hidden の input も受けないため、キーボードだけでは
    // アプリの中心操作（レシート撮影）に到達できなかった。
    await page.goto("/login.html");
    // 認証前はアプリシェルごと hidden で、中の要素はフォーカスできない。
    // ログイン後の状態を再現してから確かめる（Firebase はこの環境では
    // 初期化できないので、hidden を外すことで代用する）。
    await page.evaluate(() => {
      document.querySelectorAll("[hidden]").forEach((el) => {
        if (el.closest("#app") || el.id === "app") el.removeAttribute("hidden");
      });
    });

    for (const id of ["camera-btn", "pick-btn"]) {
      const el = page.locator(`#${id}`);
      await expect(el, `#${id} が無い`).toHaveCount(1);
      expect(await el.evaluate((n) => n.tagName)).toBe("BUTTON");
      // hidden 属性や display:none だとフォーカスできないので、
      // 実際に focus() が通ることまで確認する。
      await el.evaluate((n) => n.focus());
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(id);
    }
  });

  test("ファイル入力は画面から隠れているが支援技術には残る", async ({ page }) => {
    await page.goto("/login.html");
    for (const id of ["camera-input", "file-input"]) {
      const el = page.locator(`#${id}`);
      await expect(el).toHaveCount(1);
      // hidden 属性に戻すと、button から click() しても発火しない環境がある。
      expect(await el.evaluate((n) => n.hasAttribute("hidden"))).toBe(false);
    }
  });
});

test.describe("読み上げのための属性", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("絵文字だけのボタンに aria-label がある", async ({ page }) => {
    await page.goto("/login.html");

    // title だけだと読み上げは絵文字名を発話する。
    // テキストを併記しているボタン（「💰 予算」など）は対象外。
    const bad = await page.$$eval("button", (els) =>
      els
        .filter((el) => {
          if (el.getAttribute("aria-hidden") === "true") return false;
          const text = (el.textContent || "").replace(
            /[\p{Extended_Pictographic}️‍\s]/gu,
            "",
          );
          return text === "" && !el.getAttribute("aria-label");
        })
        .map((el) => el.id || el.className),
    );
    expect(bad, `aria-label が無い絵文字ボタン: ${JSON.stringify(bad)}`).toEqual([]);
  });
});

test.describe("LP（index.html）", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("PC でも登録の導線が消えない", async ({ page }) => {
    // 以前は PC 幅のときに JS で CTA を「スマホ専用アプリ」の案内に
    // 差し替えていた（CSP に阻まれて production では動いていなかったが、
    // CSP を緩めた瞬間に効き始める死んだコードだった）。
    await page.goto("/index.html");
    await expect(page.locator("#hero-pc-note")).toHaveCount(0);
    await expect(page.locator(".hero-actions a.btn-primary").first()).toBeVisible();
  });

  test("所有権確認メタが meta として成立している", async ({ page }) => {
    // login.html にあったものは name= も content= も引用符が無く、
    // meta として解釈されていなかった。
    await page.goto("/index.html");
    const content = await page.getAttribute(
      'meta[name="google-site-verification"]',
      "content",
    );
    expect(content).toBeTruthy();
  });
});
