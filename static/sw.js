// Service Worker — アプリシェルをキャッシュしてオフライン対応。
// 更新時は CACHE のバージョン番号を上げること。
const CACHE = "receipt-v34";

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
  "/api-client.js",
  "/recipe-parse.js",
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
    // アプリ本体はネットワーク優先＋オフライン時のみキャッシュ。
    // STATIC_ASSETS に /login.html を載せていたのに、ここで早期 return して
    // ブラウザ既定に委ねていたため参照する経路が無く、オフラインでは
    // アプリが開けなかった（キャッシュしているのに使われていなかった）。
    if (path === "/login.html") {
      e.respondWith(
        fetch(e.request)
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
    // それ以外のナビゲーションはすべてブラウザ既定に委ねる。
    // 以前は「許可リストに無いパスを login.html に差し替える」SPAフォールバックを
    // 持っていたが、SPAルートは存在せず（全画面が login.html 上のモーダル）、
    // 未知のURLに 200 を返して 404 を表示できなくしていた。
    // 拡張子チェック（/robots.txt がLPになる不具合の回避）も、
    // フォールバック自体が無くなったので不要になった。
    // firebase.json のワイルドカード rewrite 撤去と対になる変更なので、
    // 必ず同じデプロイに含めること。
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
