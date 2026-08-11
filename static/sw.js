// Service Worker — アプリシェルをキャッシュしてオフライン対応。
// 更新時は CACHE のバージョン番号を上げること。
const CACHE = "receipt-v21";

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
        .catch(() => caches.match("/login.html").then((cached) => cached || fetch(e.request))),
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
        .catch(() => caches.match(e.request)),
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
      .catch(() => fetch(e.request)),
  );
});
