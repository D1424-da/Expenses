// UX 修正の回帰テスト。
//
// ここで守っているのは「利用者が次に何をすればいいか分かる状態」。
// 実際に見つかった問題:
//   - 失敗を全て alert() で出しており、操作をブロックしていた
//   - err.message をそのまま見せていた（FirebaseError 等の英語）
//   - PC のブログ記事に /login.html への導線が1本も無かった
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dirname;
const read = (f) => readFileSync(join(DIR, f), "utf8");

describe("エラーメッセージの翻訳", () => {
  // Node 22 の navigator は getter しか無いため代入できない。
  // defineProperty で上書きする。
  const setOnline = (v) =>
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: v }, configurable: true, writable: true,
    });

  beforeEach(() => {
    vi.resetModules();
    setOnline(true);
  });

  it("オフライン時は通信状況の確認を促す", async () => {
    setOnline(false);
    const { toUserMessage } = await import("./ui-feedback.js");
    expect(toUserMessage(new Error("Failed to fetch"))).toContain("オフライン");
  });

  it("Firestore の権限エラーを利用者向けの文言に変える", async () => {
    const { toUserMessage } = await import("./ui-feedback.js");
    const msg = toUserMessage({ code: "permission-denied" });
    expect(msg).not.toContain("permission");
    expect(msg).toContain("入力内容");
  });

  it("通信エラーを利用者向けの文言に変える", async () => {
    const { toUserMessage } = await import("./ui-feedback.js");
    expect(toUserMessage(new Error("Failed to fetch"))).toContain("通信");
  });

  it("認証切れは再ログインを案内する", async () => {
    const { toUserMessage } = await import("./ui-feedback.js");
    expect(toUserMessage({ code: "auth/id-token-expired" })).toContain("ログイン");
  });

  it("未知のエラーでも英語の生メッセージを見せない", async () => {
    const { toUserMessage } = await import("./ui-feedback.js");
    const msg = toUserMessage(new Error("ECONNRESET at socket.js:42"));
    expect(msg).not.toContain("ECONNRESET");
    expect(msg).toBe("処理に失敗しました。");
  });
});

describe("alert() を使っていない", () => {
  it("画面用のJSに alert(/confirm( が残っていない", () => {
    // alert はブラウザの操作を完全にブロックし、スマホでは特に煩わしい。
    // 代わりに ui-feedback.js のトーストを使う。
    const skip = new Set(["ui-feedback.js"]);
    const offenders = [];
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith(".js") || f.endsWith(".test.js") || skip.has(f)) continue;
      const src = read(f).replace(/\/\/[^\n]*/g, "");     // 行コメントを除く
      if (/(^|[^.\w])alert\s*\(/.test(src)) offenders.push(f);
    }
    expect(offenders, `alert() が残っている: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("PC向けブログCTA", () => {
  // コメントは判定対象外（経緯の説明で語句に触れているため）
  const src = read("blog-cta.js").replace(/\/\/[^\n]*/g, "");

  it("PCの読者にもアプリへの導線がある", () => {
    // 以前は QR コードと「ブログ一覧へ」しか無く、PCからは登録できなかった。
    // Search Console 上、ブログの表示は PC がモバイルの3倍以上ある。
    expect(src).toContain('href="/login.html"');
  });

  it("本文中CTAとサイドCTAの両方に導線がある", () => {
    const occurrences = src.match(/href="\/login\.html"/g) || [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("「スマホアプリです」と言い切らない", () => {
    // PC利用を勧める記事（pc-kakeibo-browser / windows-mac-kakeibo）から
    // 流入した読者と矛盾するため。実体はブラウザで動く Web アプリ。
    expect(src).not.toContain("スマホアプリです");
  });

  it("表示される日本語が壊れていない", () => {
    // 「献立テAI」という誤字が全記事のPC表示に出ていた
    expect(src).not.toContain("献立テAI");
  });
});

describe("フォームのラベル", () => {
  const html = read("login.html");

  it("ログイン欄が placeholder だけに頼っていない", () => {
    // placeholder は入力を始めると消えるため、ラベルの代わりにならない。
    for (const id of ["email-input", "password-input"]) {
      const hasLabel = new RegExp(`<label[^>]*for="${id}"`).test(html);
      expect(hasLabel, `#${id} にラベルが無い`).toBe(true);
    }
  });

  it("ラベルを置けない入力には aria-label がある", () => {
    for (const id of ["list-search", "compare-search", "shopping-add-input"]) {
      const tag = new RegExp(`<(?:input|select)[^>]*id="${id}"[^>]*>`).exec(html);
      expect(tag, `#${id} が見つからない`).not.toBeNull();
      expect(tag[0], `#${id} に aria-label が無い`).toContain("aria-label");
    }
  });

  it("非同期処理の結果が読み上げられる", () => {
    // OCR も AI 献立も完了まで数秒かかる。aria-live が無いと
    // スクリーンリーダー利用者に終了が伝わらない。
    for (const id of ["ocr-status", "recipe-status"]) {
      const tag = new RegExp(`<div[^>]*id="${id}"[^>]*>`).exec(html);
      expect(tag[0], `#${id} に aria-live が無い`).toContain("aria-live");
    }
  });
});

describe("キーボード操作", () => {
  it("LP・ブログにもフォーカス表示がある", () => {
    for (const f of ["landing.css", "blog-article.css", "blog-index.css", "style.css"]) {
      expect(read(f), `${f} に :focus-visible が無い`).toMatch(/:focus(-visible)?/);
    }
  });
});

describe("CTAクリックの計測", () => {
  const src = read("blog-cta.js");

  it("位置別のイベントを送っている", () => {
    // どの位置のCTAが効いているか分からないと改善できない。
    // 以前は blog-cta.js から trackEvent を1度も呼んでいなかった。
    expect(src).toContain("trackEvent");
    for (const pos of ["blog_header", "blog_post_end", "blog_sidebar"]) {
      expect(src, `${pos} を送っていない`).toContain(pos);
    }
  });

  it("スマホでも計測する（PC差し替えより前に仕掛ける）", () => {
    // isMobile の early return より前に計測を登録していないと、
    // モバイルからのクリックが1件も取れない。
    const trackAt = src.indexOf("addEventListener(\"click\"");
    const returnAt = src.indexOf("if (isMobile) return;");
    expect(trackAt).toBeGreaterThan(-1);
    expect(returnAt).toBeGreaterThan(-1);
    expect(trackAt, "計測が early return より後ろにある").toBeLessThan(returnAt);
  });

  it("PC/スマホを区別して送る", () => {
    expect(src).toContain("device");
  });
});
