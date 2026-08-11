// blog-ads.js のテスト。
//
// ここで守っているのは「法令・ガイドライン上、外してはいけない属性」。
// データ側（blog-ads-data.js）の書き方に関わらず必ず付くことを固定する。
//   - PR表記      : 景品表示法のステマ規制（2023年10月施行）で明示が義務
//   - rel=sponsored: Google のガイドライン上アフィリエイトリンクに必須
import { describe, it, expect, beforeEach, vi } from "vitest";

// blog-ads.js は import 時に DOM を触るため、最小限の DOM を用意する
beforeEach(() => {
  vi.resetModules();
  global.document = undefined;
});

/** jsdom 無しでも動くよう、必要な DOM API だけを持つ簡易スタブを用意する */
function setupDom({ category = "レシピ" } = {}) {
  const created = [];
  const el = () => ({
    className: "",
    innerHTML: "",
    appendChild: vi.fn(),
    insertBefore: vi.fn(),
  });
  global.document = {
    readyState: "complete",
    querySelector: (sel) => (sel === ".am-cat" ? { textContent: category } : null),
    createElement: () => {
      const e = el();
      created.push(e);
      return e;
    },
    addEventListener: vi.fn(),
  };
  return created;
}

describe("広告カードの必須属性", () => {
  it("アフィリエイトリンクに rel=sponsored nofollow が必ず付く", async () => {
    setupDom();
    const mod = await import("./blog-ads.js");
    const html = mod.renderCard({ title: "商品", url: "https://example.com/af" });
    expect(html).toContain('rel="sponsored nofollow noopener"');
  });

  it("REQUIRED_REL から sponsored / nofollow を外していない", async () => {
    setupDom();
    const { REQUIRED_REL } = await import("./blog-ads.js");
    expect(REQUIRED_REL).toContain("sponsored");
    expect(REQUIRED_REL).toContain("nofollow");
    // 別タブで開くため noopener も必要（タブナビング対策）
    expect(REQUIRED_REL).toContain("noopener");
  });

  it("PR表記が広告ブロックに必ず含まれる", async () => {
    setupDom();
    const mod = await import("./blog-ads.js");
    const block = mod.renderBlock([{ title: "商品", url: "https://example.com/af" }]);
    expect(block.innerHTML).toContain("PR");
  });

  it("商品名・URLがHTMLエスケープされる", async () => {
    setupDom();
    const mod = await import("./blog-ads.js");
    const html = mod.renderCard({
      title: '<script>alert(1)</script>',
      url: 'https://example.com/"onerror="alert(1)',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('"onerror="');
  });
});

describe("掲載データが空のとき", () => {
  it("広告を1件も選ばない（枠ごと出さない）", async () => {
    setupDom();
    // 実際に登録済みの商品数に左右されないよう、空データで検証する
    vi.doMock("./blog-ads-data.js", () => ({ AD_ITEMS: [], MAX_ADS_PER_SLOT: 2 }));
    const { pickItems } = await import("./blog-ads.js");
    expect(pickItems()).toEqual([]);
    vi.doUnmock("./blog-ads-data.js");
  });
});

describe("登録済みの掲載データ", () => {
  it("アフィリエイトリンクが https で始まる（// のままにしない）", async () => {
    const { AD_ITEMS } = await import("./blog-ads-data.js");
    for (const it of AD_ITEMS) {
      expect(it.url, `${it.title} の url`).toMatch(/^https:\/\//);
    }
  });

  it("もしものリンクが広告主トップではなく個別ページを指している", async () => {
    const { AD_ITEMS } = await import("./blog-ads-data.js");
    for (const it of AD_ITEMS) {
      if (!it.url.includes("af.moshimo.com")) continue;
      // どこでもリンクは url= に遷移先を持つ。生成ボタンを押し忘れると
      // 広告主のトップページ（例: www.rakuten.co.jp/）のままになる。
      const m = /[?&]url=([^&]+)/.exec(it.url);
      expect(m, `${it.title} に url= が無い`).not.toBeNull();
      const dest = decodeURIComponent(m[1]);
      expect(dest, `${it.title} の遷移先がトップページ`).not.toMatch(
        /^https?:\/\/(www\.)?(rakuten\.co\.jp|amazon\.co\.jp|shopping\.yahoo\.co\.jp)\/?$/,
      );
    }
  });

  it("全記事が広告の挿入先コンテナを持っている", async () => {
    // 記事テンプレートは1種類ではない。<article> を持たない記事が5本あり、
    // そこだけ広告がPC・スマホとも表示されていなかった。
    // 新しいテンプレートを足したときに同じ穴が空くのを防ぐ。
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(import.meta.dirname, "blog");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
    expect(files.length).toBeGreaterThan(100);
    const missing = files.filter((f) => {
      const html = fs.readFileSync(path.join(dir, f), "utf8");
      return !/<article[^>]*class="[^"]*\bam\b/.test(html)
        && !/class="[^"]*\barticle-wrap\b/.test(html)
        && !/class="[^"]*\bam-wrap\b/.test(html);
    });
    expect(missing, `広告の挿入先が無い記事: ${missing.join(", ")}`).toEqual([]);
  });

  it("画像URLを設定する場合はCSP許可済みドメインを使う", async () => {
    const { AD_ITEMS } = await import("./blog-ads-data.js");
    const ALLOWED = [
      "i.moshimo.com",
      "m.media-amazon.com",
      "images-fe.ssl-images-amazon.com",
      "thumbnail.image.rakuten.co.jp",
      "r10s.jp",  // 楽天の店舗画像CDN（tshop/shop/r などサブドメイン多数）
      "hbb.afl.rakuten.co.jp",
      "item-shopping.c.yimg.jp",
    ];
    for (const it of AD_ITEMS) {
      if (!it.image) continue;
      expect(
        ALLOWED.some((d) => it.image.includes(d)),
        `${it.title} の画像がCSP未許可のドメイン: ${it.image}`,
      ).toBe(true);
    }
  });
});
