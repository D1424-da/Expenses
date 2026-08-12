// Service Worker — アプリシェルをキャッシュしてオフライン対応。
// 更新時は CACHE のバージョン番号を上げること。
const CACHE = "receipt-v27";

// キャッシュするローカル静的ファイル
const STATIC_ASSETS = [
  "/",
  "/login.html",
  "/style.css",
  "/app.js",
  "/firebase-config.js",
  "/firebase-init.js",
  "/db-paths.js",
  "/app-state.js",
  "/dom-utils.js",
  "/ui-feedback.js",
  "/log.js",
  "/auth.js",
  "/firestore-data.js",
  "/parser.js",
  "/expense-form.js",
  "/expense-limits.js",
  "/list-view.js",
  "/calendar-view.js",
  "/compare-view.js",
  "/ocr-client.js",
  "/ocr-queue.js",
  "/recipe-view.js",
  "/saved-recipes.js",
  "/shopping-list.js",
  "/meal-plan.js",
  "/history.js",
  "/trend-view.js",
  "/budget-view.js",
  "/stats.js",
  "/summary.js",
  "/csv-export.js",
  "/stripe-billing.js",
  "/redirect.js",
  "/analytics.js",
  "/blog-cta.js",
  "/blog-ads.js",
  "/blog-ads-data.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// respondWith() に「拒否されたPromise」や undefined を渡すと、ブラウザは
// ページ全体をネットワークエラーにしてしまう（chrome-error:// 相当）。
// 最終手段として必ず Response を返し、SWが原因で真っ白になるのを防ぐ。
const OFFLINE_RESPONSE = () =>
  new Response("オフラインのため読み込めませんでした。通信状況をご確認ください。", {
    status: 503,
    statusText: "Service Unavailable",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // 外部リクエスト（Firebase SDK・API・CDN）はネットワーク優先でパススルー
  if (url.origin !== self.location.origin) return;

  // Firebase Auth ハンドラ（/__/auth/）はSWを介さずネットワークから直接取得
  if (url.pathname.startsWith('/__/')) return;

  // ナビゲーション（ページ遷移）はルートに応じて振り分ける
  if (e.request.mode === "navigate") {
    const path = url.pathname;
    // LP・ブログはネットワークから取得（SSR不要だがキャッシュに乗せない）
    if (path === "/" || path === "/index.html" || path === "/login.html" || path === "/lp" || path.startsWith("/blog") || path === "/terms.html" ||
    path === "/privacy.html" ||
    path === "/tokushoho.html" ||
    path === "/contact.html" ||
    path === "/admin.html") {
      return; // ブラウザのデフォルト処理に委ねる
    }
    // 拡張子を持つパスは実ファイル（/robots.txt, /sitemap.xml, /404.html,
    // /ogp.png など）。SPAフォールバックの対象にすると login.html が返り、
    // ブラウザで robots.txt を開くとLPが表示されてしまう（実際に起きた）。
    // Googlebot は SW を実行しないためクロールには影響しないが、
    // 内容の確認ができず、404ページも表示できなくなる。
    if (/\.[a-z0-9]+$/i.test(path)) return;
    // /app 等のSPAフォールバック先はネットワーク優先（常に最新のlogin.htmlを取得）。
    // オフライン時のみキャッシュへフォールバックする。
    e.respondWith(
      fetch("/login.html")
        .then((resp) => {
          if (resp && resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put("/login.html", clone));
          }
          return resp;
        })
        .catch(() => caches.match("/login.html"))
        .then((resp) => resp || OFFLINE_RESPONSE()),
    );
    return;
  }

  // ブログ用CSS・トークンはSWキャッシュを使わずネットワーク直取得（更新即反映）
  if (url.pathname === '/blog-article.css' || url.pathname === '/tokens.css') return;

  // CSS/JS: ネットワーク優先（更新をCACHEバージョン上げ忘れでも即反映）。
  // オフライン時のみキャッシュにフォールバックする。
  if (url.pathname.endsWith(".css") || url.pathname.endsWith(".js")) {
    e.respondWith(
      fetch(e.request)
        .then((resp) => {
          if (resp && resp.ok && resp.type === "basic") {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return resp;
        })
        // オフラインでキャッシュにも無い場合、caches.match は undefined を返す。
        // そのまま respondWith に渡すとネットワークエラーになるため必ず Response にする。
        .catch(() => caches.match(e.request))
        .then((resp) => resp || OFFLINE_RESPONSE()),
    );
    return;
  }

  // その他の静的アセット: キャッシュ優先、なければネット取得してキャッシュ
  e.respondWith(
    caches.match(e.request)
      .then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((resp) => {
          if (resp && resp.ok && resp.type === "basic") {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return resp;
        });
      })
      .catch(() => fetch(e.request))
      .catch(() => OFFLINE_RESPONSE()),
  );
});
