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

test.describe("ナビゲーションの現在地", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  /** 認証前はアプリシェルが hidden なので、ログイン後の状態を再現する。 */
  async function showApp(page) {
    await page.goto("/login.html");
    await page.evaluate(() => {
      document.querySelectorAll("[hidden]").forEach((el) => {
        if (el.id === "app" || el.closest("#app")) el.removeAttribute("hidden");
      });
    });
  }

  test("aria-current が付いた項目はちょうど1つ", async ({ page }) => {
    // 以前は bnav-home に静的に書かれたままで、どのタブへ移動しても
    // 「ホーム」のままだった。
    await showApp(page);
    const items = await page.$$eval(
      '[id^="bnav-"][aria-current], [id^="pcnav-"][aria-current]',
      (els) => els.map((el) => el.id),
    );
    // ボトムナビと PC ナビでそれぞれ1つ（初期値はホーム）
    expect(items.sort()).toEqual(["bnav-home", "pcnav-home"]);
  });

  test("現在地のスタイルが定義されている", async ({ page }) => {
    // .active を付ける処理を足しても、スタイルが無ければ見た目は変わらない。
    await showApp(page);
    const bnav = await page.$eval("#bnav-home", (el) => {
      el.classList.add("active");
      return getComputedStyle(el).color;
    });
    const pcnav = await page.$eval("#pcnav-home", (el) => {
      el.classList.add("active");
      return getComputedStyle(el).fontWeight;
    });
    expect(bnav).not.toBe("");
    expect(Number(pcnav)).toBeGreaterThanOrEqual(700);
  });
});

test.describe("カレンダーの金額表示（T8）", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  /** カレンダーのマス目を手で組んで、幅だけを測る。 */
  async function measure(page, amountText) {
    await page.goto("/login.html");
    return page.evaluate((amt) => {
      const cal = document.getElementById("calendar");
      cal.removeAttribute("hidden");
      cal.closest("[hidden]")?.removeAttribute("hidden");
      document.getElementById("app")?.removeAttribute("hidden");
      cal.innerHTML =
        '<div class="cal-grid">' +
        ["日","月","火","水","木","金","土"]
          .map((w) => `<div class="cal-dow">${w}</div>`).join("") +
        Array.from({ length: 7 }, (_, i) =>
          `<div class="cal-day cal-has" data-day="d${i}">` +
          `<span class="cal-num">${i + 1}</span>` +
          `<span class="cal-amt">${amt}</span></div>`).join("") +
        '<div class="cal-week cal-week-click" data-week="0">' +
        '<span class="cal-week-label">週計</span>' +
        '<span class="cal-week-amt">¥123,456</span></div>' +
        "</div>";
      const el = cal.querySelector(".cal-amt");
      const week = cal.querySelector(".cal-week");
      return {
        // scrollWidth > clientWidth なら省略記号で切れている
        clipped: el.scrollWidth > el.clientWidth + 1,
        weekClipped: week.scrollWidth > week.clientWidth + 1,
        weekHeight: week.getBoundingClientRect().height,
        columns: getComputedStyle(cal.querySelector(".cal-grid"))
          .gridTemplateColumns.split(" ").length,
      };
    }, amountText);
  }

  test("375px 幅で5桁の金額が切れない", async ({ page }) => {
    // 以前は週計を8列目に置いており、1マスが約36pxで「¥12,345」が
    // 省略記号になっていた。7列にしたうえで、マス目からは通貨記号を
    // 外している（週計の帯には「¥」が出るので単位は伝わる）。
    const r = await measure(page, "12,345");
    expect(r.clipped, "日別の金額が切れている").toBe(false);
  });

  test("週計は7列の外に出ている", async ({ page }) => {
    const r = await measure(page, "1,000");
    expect(r.columns, "グリッドが7列でない").toBe(7);
    expect(r.weekClipped, "週計が切れている").toBe(false);
    // タップ対象なので 44px を確保する
    expect(r.weekHeight).toBeGreaterThanOrEqual(44);
  });
});
