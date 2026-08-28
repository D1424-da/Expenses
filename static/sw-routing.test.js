// Service Worker のルーティング判定のテスト。
//
// かつて sw.js は「許可リストに無いナビゲーションはすべて /login.html を返す」
// という SPA フォールバックを持っていた。しかし SPA ルートは存在せず
// （アプリの全画面は login.html 上のモーダル）、未知の URL に 200 を返して
// /404.html を表示できなくしていた。/robots.txt をブラウザで開くと LP が
// 出るという不具合も、この設計から派生したものだった。
//
// firebase.json のワイルドカード rewrite 撤去と対にしてフォールバックを外し、
// 代わりに「アプリ本体だけオフライン用にキャッシュから返す」形にした。
// このテストは、その2点が逆戻りしないように固定する。
//
// sw.js は self / caches に依存して import できないため、ソースを検査する。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dirname, "sw.js"), "utf8");

/** navigate 分岐だけを取り出す */
const NAV = SRC.slice(
  SRC.indexOf('if (e.request.mode === "navigate")'),
  SRC.indexOf("// ブログ用CSS・トークンは"),
);

describe("Service Worker のナビゲーション振り分け", () => {
  it("未知のパスを login.html にすり替えない", () => {
    // これが復活すると、Hosting 側で 404 を返せるようにしても
    // SW を持つ利用者にだけ 200 の login.html が返り続ける。
    expect(NAV).not.toMatch(/fetch\(\s*["']\/login\.html["']\s*\)/);
  });

  it("アプリ本体はオフライン時にキャッシュから返す", () => {
    // /login.html は STATIC_ASSETS に載っているのに参照経路が無く、
    // オフラインではアプリが開けなかった。
    expect(NAV).toMatch(/path === "\/login\.html"/);
    expect(NAV).toMatch(/caches\.match\("\/login\.html"\)/);
    expect(NAV).toMatch(/OFFLINE_RESPONSE\(\)/);
  });

  it("アプリ本体以外のナビゲーションには介入しない", () => {
    // 以前は「LP・ブログ・法務ページ」を許可リストで素通しし、
    // それ以外を login.html にすり替えていた。フォールバックを外した今、
    // 許可リストは不要になっている（列挙が復活したら設計が戻った合図）。
    expect(NAV).not.toMatch(/path\.startsWith\("\/blog"\)/);
    // 介入するのは /login.html の1か所だけ。
    expect(NAV.match(/e\.respondWith\(/g) || []).toHaveLength(1);
  });

  it("CACHE のバージョンが定義されている（更新時に上げる必要がある）", () => {
    expect(SRC).toMatch(/const CACHE = "receipt-v\d+";/);
  });
});
