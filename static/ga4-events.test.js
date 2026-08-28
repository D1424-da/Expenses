// GA4 の主要イベント（sign_up / login / purchase / cta_click）が
// ソースから欠落していないかの検証。
//
// アプリ本体（app.js）は Firebase SDK を import するため単体テストで
// 実行できず、他ファイルも DOM 依存が強い。ここでは静的にソースを
// 検査して、計測コードの消失だけを検知する。
//
// 発端: GA4 導入当初はページビューと sign_up しか計測しておらず、
// アプリ本体の操作（レシート撮影・購入完了など）が一切計測されて
// いなかった。特に purchase は収益に直結するため、これを見落とすと
// 「機能は正常なのに GA4 上は売上ゼロ」に気付けない。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), "utf8");

describe("gtag の読み込み", () => {
  it("計測IDが analytics.js と一致する", () => {
    const analytics = read("analytics.js");
    const ids = [...analytics.matchAll(/G-[A-Z0-9]{6,}/g)].map((m) => m[0]);
    expect(new Set(ids).size).toBe(1);
  });
});

describe("sign_up / login イベント", () => {
  const auth = read("auth.js");

  it("新規登録時に sign_up を送る（Google・メール両方）", () => {
    expect(auth).toMatch(/trackEvent\(.*"sign_up".*method:\s*"google"/s);
    expect(auth).toMatch(/trackEvent\("sign_up",\s*\{\s*method:\s*"email"/);
  });

  it("既存ユーザーのログイン時に login を送る（Google・メール両方）", () => {
    // isNewUser の分岐で sign_up と login を出し分けている
    // （新規/既存の判定を落として両方 sign_up にする逆行を防ぐ）
    expect(auth).toMatch(/isNewUser\s*\?\s*"sign_up"\s*:\s*"login"/);
    expect(auth).toMatch(/trackEvent\("login",\s*\{\s*method:\s*"email"/);
  });
});

describe("purchase イベント", () => {
  const app = read("app.js");

  it("Stripe 同期が active/trialing を確認した後にのみ送る", () => {
    // URL パラメータ (?checkout=success) だけを根拠にすると、
    // ユーザーが URL を直接叩いても発火してしまう。
    // サーバーに確認が取れた状態でだけ送ること。
    const fn = app.slice(
      app.indexOf("async function _syncStripeSubscription"),
      app.indexOf("async function _syncStripeSubscription") + 1500
    );
    expect(fn).toMatch(/data\.status === "active"/);
    expect(fn).toMatch(/trackEvent\("purchase"/);
    expect(fn).toMatch(/currency:\s*"JPY"/);
  });

  it("価格が index.html の表示価格と一致する", () => {
    const index = read("index.html");
    const displayed = index.match(/¥(\d+)<sub>\/月<\/sub>/);
    const tracked = app.match(/PREMIUM_PLAN_JPY\s*=\s*(\d+)/);
    expect(displayed).not.toBeNull();
    expect(tracked).not.toBeNull();
    expect(tracked[1]).toBe(displayed[1]);
  });

  it("価格が login.html のアップグレードモーダルとも一致する", () => {
    // 検査対象が index.html だけだったため、アップグレードモーダルの表示だけが
    // ¥980 のまま取り残されていた（LP・GA4 は ¥500）。利用者は決済の直前に
    // 倍の金額を見ることになる。表示価格を持つ3か所をまとめて固定する。
    const login = read("login.html");
    const shown = login.match(/class="plan-price">¥([\d,]+)/);
    const tracked = app.match(/PREMIUM_PLAN_JPY\s*=\s*(\d+)/);
    expect(shown).not.toBeNull();
    expect(tracked).not.toBeNull();
    expect(shown[1].replace(/,/g, "")).toBe(tracked[1]);
  });

  it("廃止した無料枠（月10件）の文言が残っていない", () => {
    // stripe-billing.js は 14日間トライアル制で、checkGate は件数を見ない。
    // 文言だけ残ると「10件に達しました」と誤った理由が表示される。
    for (const name of ["login.html", "tokushoho.html"]) {
      expect(read(name), `${name} に月10件の記述が残っている`).not.toMatch(/月\s*10\s*件/);
    }
  });
});

describe("trial_start イベント", () => {
  it("サーバーが started:true を返したときだけ送る", () => {
    // /api/trial/ensure は2回目以降のログインでも毎回呼ばれ、既存ユーザーには
    // {started:false} を返すだけ（正常系）。レスポンスを見ずに送ると、
    // ログインのたびに trial_start が水増しされる。
    const billing = read("stripe-billing.js");
    const fn = billing.slice(
      billing.indexOf("export async function ensureTrial"),
      billing.indexOf("export async function ensureTrial") + 800
    );
    expect(fn).toMatch(/data\.started/);
    expect(fn).toMatch(/trackEvent\("trial_start"/);
  });
});

describe("cta_click イベント", () => {
  it("blog-cta.js が計測を保持している（回帰）", () => {
    const cta = read("blog-cta.js");
    expect(cta).toMatch(/trackEvent\("cta_click"/);
  });
});
