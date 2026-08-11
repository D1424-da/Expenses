// Service Worker のルーティング判定のテスト。
//
// sw.js は「許可リストに無いナビゲーションはすべて /login.html を返す」
// という SPA フォールバックを持つ。このため /robots.txt を
// ブラウザで開くと LP が表示されるという不具合が実際に起きた。
// Googlebot は SW を実行しないためクロールには影響しなかったが、
// 内容を確認できず、/404.html も表示できない状態だった。
//
// sw.js は self / caches に依存して import できないため、
// ソースから判定ロジックを取り出して検証する。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dirname, "sw.js"), "utf8");

/** sw.js の navigate 分岐と同じ判定を再現する */
function fallsBackToLoginHtml(path) {
  const passthrough = [
    "/", "/index.html", "/login.html", "/lp",
    "/terms.html", "/privacy.html", "/tokushoho.html",
    "/contact.html", "/admin.html",
  ];
  if (passthrough.includes(path) || path.startsWith("/blog")) return false;
  if (/\.[a-z0-9]+$/i.test(path)) return false;
  return true;
}

describe("Service Worker のナビゲーション振り分け", () => {
  it("実ファイルを login.html にすり替えない", () => {
    for (const p of [
      "/robots.txt",
      "/sitemap.xml",
      "/404.html",
      "/manifest.json",
      "/ogp.png",
      "/favicon.svg",
    ]) {
      expect(fallsBackToLoginHtml(p), `${p} が login.html に差し替えられている`).toBe(false);
    }
  });

  it("拡張子を持たないアプリのルートは login.html にフォールバックする", () => {
    for (const p of ["/app", "/dashboard", "/settings"]) {
      expect(fallsBackToLoginHtml(p), `${p} がフォールバックしない`).toBe(true);
    }
  });

  it("LP・ブログ・法務ページはブラウザのデフォルト処理に委ねる", () => {
    for (const p of [
      "/", "/login.html", "/blog.html", "/blog/asagohan-kondate.html",
      "/terms.html", "/privacy.html", "/tokushoho.html", "/contact.html",
    ]) {
      expect(fallsBackToLoginHtml(p), `${p} が横取りされている`).toBe(false);
    }
  });

  it("sw.js 本体に拡張子チェックが残っている", () => {
    // 上の判定はソースの写しなので、本体から消えていないことを直接確認する
    expect(SRC).toMatch(/\/\\\.\[a-z0-9\]\+\$\/i\.test\(path\)/);
  });

  it("CACHE のバージョンが定義されている（更新時に上げる必要がある）", () => {
    expect(SRC).toMatch(/const CACHE = "receipt-v\d+";/);
  });
});
