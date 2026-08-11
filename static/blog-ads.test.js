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
    const { pickItems } = await import("./blog-ads.js");
    // blog-ads-data.js の AD_ITEMS は初期状態で空
    expect(pickItems()).toEqual([]);
  });
});
