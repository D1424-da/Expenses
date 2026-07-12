// Service Worker — アプリシェルをキャッシュしてオフライン対応。
// 更新時は CACHE のバージョン番号を上げること。
const CACHE = "receipt-v11";

// キャッシュするローカル静的ファイル
const STATIC_ASSETS = [
  "/",
  "/login.html",
  "/style.css",
  "/app.js",
  "/firebase-config.js",
  "/db-paths.js",
  "/household.js",
  "/dom-utils.js",
  "/log.js",
  "/parser.js",
  "/expense-form.js",
  "/list-view.js",
  "/calendar-view.js",
  "/compare-view.js",
  "/ocr-client.js",
  "/recipe-view.js",
  "/saved-recipes.js",
  "/shopping-list.js",
  "/meal-plan.js",
  "/history.js",
  "/trend-view.js",
  "/budget-view.js",
  "/stats.js",
  "/redirect.js",
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
    path === "/contact.html") {
      return; // ブラウザのデフォルト処理に委ねる
    }
    // キャッシュ・ネットワークいずれも失敗した場合は必ずネットワークへ再フォールバックし、
    // Promise reject によるブラウザの内部エラーページ（chrome-error://）表示を防ぐ。
    e.respondWith(
      caches.match("/login.html")
        .then((cached) => cached || fetch(e.request))
        .catch(() => fetch(e.request)),
    );
    return;
  }

  // 静的アセット: キャッシュ優先、なければネット取得してキャッシュ
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
