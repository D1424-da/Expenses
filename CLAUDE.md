# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

カケイシピ — レシート撮影 → OCR で家計簿記録 → AI 献立提案の Web アプリ。
公開URL: `get-tohon.online`

コード内のコメント・コミットメッセージ・ドキュメントはすべて**日本語**で書く。
既存のコードは「なぜそう書いたか」を残す濃いコメントスタイルなので、それに合わせる。

## コマンド

```bash
npm test                                   # vitest（フロントの純粋関数・静的検査）
npx vitest run static/stats.test.js        # 1ファイルだけ
npx vitest run -t "テスト名の一部"           # 名前で絞り込み

python3 -m pytest tests/ -q                # pytest（バックエンド）
python3 -m pytest tests/test_parser.py -q  # 1ファイルだけ
python3 -m pytest tests/ -k "rate_limit"   # 名前で絞り込み

# Firestore ルール（エミュレータは firestore と auth の両方が要る）
firebase emulators:exec --only firestore,auth --project expenses-9af61 "npm run test:rules"
npx playwright test                        # E2E（e2e/。通常はCIで動かさない）

python3 build_blog.py                      # ブログ一覧・カテゴリ・sitemap.xml を再生成
python3 scripts/fix_article_schema.py --check   # 記事の構造化データの欠落を検査
python3 scripts/merge_articles.py <統合先> <統合元>...  # 記事の統合
python3 scripts/note_plan.py               # note の投稿順を再計算
python3 scripts/indexnow.py --changed      # 更新URLを IndexNow に通知（--dry-run で確認）
```

CI（`.github/workflows/test.yml`）は **PR 時のみ** pytest と vitest を実行する
（main への push では走らない。Actions の無料枠を節約するため）。
E2E は CI に含まれていない。

### firestore.rules はテストを通さないとデプロイされない

`firestore.rules` は**利用者同士がお互いの家計簿を読めないようにしている
唯一の防壁**で、`main` への push で本番へ直行する。1行間違えると誰にも
気づかれずにデータが露出しうるため、2段構えでゲートを置いている。

- `test-rules.yml` … ルール関連ファイルを含む PR で走る（マージ前に検出）
- `deploy-firestore-rules.yml` … デプロイ直前にも同じテストを通す

**`--only firestore,auth` の auth を落とさないこと。**
`tests-rules/auth-integration.test.js` が Auth エミュレータ（9099）を使うため、
firestore だけだと ECONNREFUSED で17件が落ちる。

`isOwner()` を `request.auth != null` に緩めるといった改変で、実際に
テスト2件が落ちて停止することを確認済み。

## デプロイ

- **フロント**: `main` に push すると `deploy-firebase-hosting.yml` が自動デプロイする。
  手元から `firebase deploy --only hosting` を打つ必要は本来ない。
- **バックエンド**: Render（`render.yaml` の Blueprint）。`main` への push で自動デプロイ。
- **Firestore ルール**: `deploy-firestore-rules.yml`。

### render.yaml の `value:` と `sync: false`

`value:` を書いた環境変数は、Blueprint 同期のたびに **Render ダッシュボードの
設定を上書きする**。ダッシュボードで運用中に切り替えたい値（`OCR_ENGINE`、
API キー、`DEBUG_RETAIN_RECEIPTS` など）は必ず `sync: false` にする。
過去に `value:` のまま置いて、ダッシュボードでの変更が勝手に巻き戻る事故があった。

## アーキテクチャ

3つの実行環境に分かれている。README にディレクトリ構成があるので、ここでは
**複数ファイルを読まないと分からない関係**だけを書く。

```
Firebase Hosting (static/)          Render (FastAPI)           Firebase
  画面・ブログ・SW           ──▶     /api/ocr, /api/recipe   ──▶  Firestore
  ブラウザ内 PaddleOCR              Gemini / Vertex / Vision      Auth / Storage
```

### OCR は多段フォールバック

`app/engines.py` が `OCR_ENGINE`（gemini | vertex）を先頭にして
**もう一方の AI → Vision API** の順に試す。全滅すると `ExtractionError` を投げ、
最後は**ブラウザ内の PaddleOCR** に委ねる（`static/ocr-client.js`）。

`app/engine_breaker.py` のサーキットブレーカーが、課金切れ（429）は30分・
一時エラーは60秒そのエンジンを閉じる。クレジット枯渇時に毎回全エンジンを
叩いて遅くなるのを防いでいる。

### バックエンドで同期SDKを呼ぶときは to_thread

Stripe SDK も Firebase Admin SDK も**同期APIしか無い**。`async def` の
中で直接呼ぶとイベントループ全体が止まり、Render は単一ワーカーなので
`/api/health`（ヘルスチェック先）を含む全リクエストが待たされる。

`app/stripe_billing.py` は「同期本体 `_xxx_sync` ＋ `to_thread` の
ラッパ」に分けてある。この構造は `tests/test_backend_hardening.py` が
静的解析と実測の両方で守っている。**`async def` の中に `stripe.` /
`ref.set(` / `ref.get(` を書かないこと。**

なお `app/routes/admin.py` のように `def`（非 async）で定義すれば
FastAPI が自動でスレッドプールに逃がすので、そちらでもよい。

### Stripe Webhook は検証だけして 200 を返す

`to_thread` でイベントループは空くが、**Stripe から見た応答時間**は
処理時間そのもの。Stripe は10秒で打ち切って再送し、5日失敗が続くと
エンドポイントを無効化する。Render の無料プランは15分無アクセスで
スリープし復帰に30〜60秒かかるため、反映まで待つ作りだと
「決済は成立したのにプレミアムにならない」が起きる。

`app/routes/stripe_routes.py` は `verify_webhook`（署名検証のみ）→
即 200 → `BackgroundTasks` で `process_webhook_event`、の順にする。
実測で応答6ms（反映1500msの設定）。**背景処理の例外は誰も受け取らない**ので、
`process_webhook_event` が `BaseException` で捕まえて logger に残す。
`tests/test_stripe_webhook.py` がこの順序を静的に固定している。

### エラーの詳細をクライアントに返さない

`app/net.py` は HTTP エラー時にプロバイダのレスポンス本文を
先頭300字まで例外に含める。原因追跡には有用だが、**それを
`HTTPException` の detail に載せない**（プロジェクトIDや内部エラーが
露出する）。`app/routes/ocr.py`・`recipe.py` のように汎用文言にし、
詳細は `logger` にだけ残す。

### フロントの司令塔は app.js

`static/app.js` が各モジュールに依存を注入する。**`db` を渡し忘れる／`null` を
渡すと、編集・更新・削除だけが `Expected first argument to collection() ...` で
落ちる**（新規追加は別経路なので気付きにくい）。
`static/app-wiring.test.js` がソースを静的解析してこれを検出する。
init 関数に依存を足すときは `NEEDS_DB` も更新する。

### GA4 の主要イベントは analytics.js の trackEvent 経由

導入当初はページビューと sign_up しか計測しておらず、アプリ本体の
操作（購入完了など）が一切計測されていなかった。特に `purchase` は
収益に直結するため、機能自体は正常でも GA4 上は売上ゼロに見えて
気付きにくい。

`purchase` は `static/app.js` の `_syncStripeSubscription` が
`/api/stripe/sync` で **サーバーに確認が取れてから** 送る。
`?checkout=success` という URL パラメータだけを根拠にすると、
URL を直接叩かれただけで発火してしまう。

金額は `PREMIUM_PLAN_JPY` にハードコードしてある。プラン価格を変えたら
`static/index.html` の表示価格（`¥500<sub>/月</sub>`）と**必ず同時に
直す**こと。`static/ga4-events.test.js` が数値の一致を検査する。

`trial_start`（14日間無料トライアルの開始）は `/api/trial/ensure` の
レスポンス `{started: true/false}` を見てから送る。このエンドポイントは
2回目以降のログインでも毎回呼ばれ、既存ユーザーには `{started: false}`
を返すだけの正常系がある。レスポンスを見ずに送ると、ログインのたびに
水増しされる。

`login` と `sign_up` は Firebase の `isNewUser` で出し分ける。
`onAuthStateChanged` はページ再読み込みのたびにも発火するため、
そちらに `login` を置くと毎回カウントされて水増しになる
（`signInWithPopup` などの明示的なログイン操作の結果だけを見ること）。

### バックエンド呼び出しは api-client.js を通す

`static/api-client.js` の `apiJson()` / `apiFetch()` を使う。URL 組み立て・
`Authorization` ヘッダ・FastAPI の `{"detail": "..."}` の取り出しが1か所に
集まっている。`fetch(\`${OCR_API_BASE}/api/...\`)` を新しく書かないこと。

- `apiJson()` … 失敗時は detail を message にして throw する
- `apiFetch()` … Response を返す。JSON でない応答（画像）や、
  throw ではなく画面表示でエラーを扱いたいときに使う

トークンは呼び出し側が渡す。この中から現在のユーザーを参照しにいくと、
どの認証状態で叩いたのかが呼び出し側から見えなくなる。

**例外が2つある**（意図的に集約していない）。どちらも Render 無料枠の
コールドスタート対策だが方式が違い、統合すると片方の挙動をもう片方に
押し付けることになる:

- `ocr-client.js` … `AbortController` で90秒打ち切り、固まったら
  ブラウザ内 PaddleOCR にフォールバックする
- `recipe-view.js` … 接続エラー時に15秒待って1回だけ再試行する

### レシピ提案は「入力3画面 ＋ 結果」のウィザード

提案モーダルは「食材の選び方・期間・食材チップ・種類・開始日・人数・
こだわり設定・提案ボタン・結果・保存操作」を1画面に縦積みしていた。
スマホでは提案ボタンが折り返しの下に隠れ、結果が出ても上のフォームが
残るため、どこまで進んだのか読み取れなかった。

`static/recipe-steps.js`（純粋関数）が段階と「次へ進めるか」を決め、
`recipe-view.js` は表示だけを担う。**進めない理由は必ず文言で返すこと** —
ボタンを黙って disabled にすると、何が足りないのか分からないまま止まる。
`static/recipe-steps.test.js` が判定を固定している。

`data-step` は `mode` / `ingredients` / `options` / `result` の4つ。
**進捗の分母は `INPUT_STEPS`（結果を除いた3）** で、結果画面には出さない。
HTML の `.recipe-step` を増減させたら `RECIPE_STEPS` も直す
（`app-wiring.test.js` が並びを検査する）。

決まりごとが3つある。

- **提案の読み込み表示は結果画面へ移してから出す。** 入力画面に出すと
  折り返しの下に隠れ、押しても何も起きないように見える。
- **食材チップは選び直せる。** 外したものを `_excluded` に覚え、
  `_suggest` は `.recipe-chip:not(.off)` だけを送る。表示と送信がずれると
  「選んだのに使われない」になる。
- **`initialPeriod` の既定は `week`。** `day` だと、その日に買い物を
  していない人には品目0件の画面が出て、いきなり行き止まりになる。

### 下部ナビと FAB の下に要素を置かない

`main` の `padding-bottom` は下部ナビ(56px)＋FAB(62px＋間隔14px)を
避けるための値。以前 90px でナビ分しか見ておらず、**最下段の
「＋ 手で入力する」が FAB の下に隠れていた**。FAB の寸法を変えたら
ここも直す（`app-wiring.test.js` が下限を検査する）。

「もっと見る」ドロワーは背景タップだけでは閉じられない
（シートの上を押している限り戻れない）。閉じるボタンと Esc を必ず残す。

### AI 出力のパーサは recipe-parse.js に置く

Gemini / Vertex が返す Markdown を正規表現で解釈するコードは、
**プロンプトやモデルを変えると出力書式が変わって静かに壊れる**。
壊れたことに気づくのが「レシピが白紙」「献立が反映されない」という
利用者の画面になりやすい。

`static/recipe-parse.js` は DOM に触れない純粋関数だけを置く場所で、
`static/recipe-parse.test.js` が書式を固定している。パーサを足すときは
**必ずここに書く**（`recipe-view.js` の private 関数にするとテストできない）。
日付や期間などの外部状態は引数で受け取ること。

`markdownToHtml()` は**行を escapeHtml してから**書式を解釈する。
順序を逆にすると AI の出力に含まれる `<img onerror=...>` がそのまま
DOM に入る。

なお `window.__recipeHelpers__` は `_attachStores`（`initRecipe()` で
注入された db / getUser に依存するため import では解決できない）専用。
**純粋なパーサをここに載せないこと** — 以前は載せており、`initRecipe()`
前に呼ばれると undefined になって整形されない生の Markdown が出る、
という沈黙する劣化が起きていた。

### 課金状態は webhook だけに頼らない

Firestore の `currentPeriodEnd` を更新できるのは、**決済直後の
`/api/stripe/sync`** と **Stripe の webhook** の2つだけ。決済直後は
`static/app.js` の `_syncStripeSubscription` が呼ぶので確実だが、
**月次更新のときは利用者が居ないので webhook 頼み**になる。

バックエンド（Render 無料プラン）は15分アイドルでスリープし、寝ている
間に届いた webhook は初回タイムアウトする。届かないまま期限を過ぎると
**支払っているのにプレミアムが切れる**。keep-alive を止めたので、
この経路は塞いでおく必要がある。

`static/stripe-resync.js` の `shouldResync()` が「期限の24時間前を
切った、または過ぎている」ものを拾い、`stripe-billing.js` が次に
アプリを開いたときに取り直す。**判定は `plan` で行わないこと** —
サーバーの `_persist_subscription` は `merge=True` で書くため、
トライアルから課金へ移行しても `plan:'trial'` が残る。plan で弾くと
本当に守りたい利用者だけが漏れる。`stripeSubscriptionId` の有無で見る。
`static/stripe-resync.test.js` がこの条件を固定している。

再取得は1セッション1回に制限する。`onSnapshot` は書き込みのたびに
発火するので、失敗時に再試行するとループになる。

### 利用者へのエラー表示は ui-feedback.js に集約する

`alert()` は使わない（`static/ui-feedback.test.js` が再混入を検出する）。
`showError(err, "保存できませんでした。")` を使うと、技術的な詳細は
`console.error` に残しつつ、画面には行動可能な文言をトーストで出す。

`toUserMessage()` が `permission-denied` や `Failed to fetch` を日本語に
翻訳する。**`err.message` をそのまま画面に出さないこと** —
`FirebaseError: Missing or insufficient permissions` と見せても
利用者は対処できない。オフライン判定を最初に行うのは、
実際にはオフラインなのに「通信に失敗」と出るのを避けるため。

### Firestore の制限はクライアントにも複製されている

`firestore.rules` の `validExpense`（store 100字・memo 500字・items 80件・
rawText 20000字・amount 1億未満）は `static/expense-limits.js` に写してある。
**両方を必ず同時に更新する。** 片方だけだと、保存時に
「Missing or insufficient permissions」という原因の分からないエラーになる。

### ブログは事前生成された静的 HTML

- **`build_blog.py` は記事HTMLを生成しない。** 生成するのは一覧ページ
  （`blog.html`, `blog-p2〜6.html`）・カテゴリページ・`sitemap.xml` だけ。
  記事本体を一括で直すときは `scripts/fix_article_schema.py` のような
  専用スクリプトを書く。
- **`build_blog.py` は不要になったページを削除する。** 記事を統合すると
  ページネーションが減り（6→4）、記事が0本になったカテゴリも出る。
  生成しなくなったページの実ファイルを消さないと、サイトマップにも
  ナビにも載らないのに存在する孤立ページになり、Google が過去に取得した
  URL としてクロールし続ける。実際に `blog-p5/p6.html` と
  `blog/cat/recipe.html` が取り残された。`tests/test_sitemap.py` の
  `test_no_orphan_generated_pages` が検出する。
- 記事のメタデータは `static/blog/articles.json`。`noindex: true` の記事は
  サイトマップから除外されるが、**HTML には noindex を入れない**
  （統合先への canonical のみ。canonical と noindex の併用は Google が非推奨）。
- 記事テンプレートは1種類ではない。`<article class="am">` の記事と、
  `<article>` を持たず `.article-wrap` で包む記事（`saving-recipe-*`）がある。
  DOM を触るスクリプトは両方を見ること。
- **記事の統合は `scripts/merge_articles.py` を使う。手作業でやらない。**
  1件の統合で6か所を同時に直す必要があり、手でやると必ずどれかを忘れる:
  統合先への本文追記／統合元の canonical／`articles.json` の `noindex` と
  `canonical`／`firebase.json` の 301／内部リンクの張り替え
  （`--fix-links`）／`HIGH_PRIORITY_SLUGS`。最後に `build_blog.py`。
  canonical だけだと統合元がクロール対象に残り続ける。
  HTMLは消さない（Hosting は redirects を静的ファイルより先に評価するので、
  設定を消すだけで統合を戻せる）。
- **統合の目的は「数を減らす」ではなく「薄い記事を厚くする」**。
  Search Console で74ページが「クロール済み - インデックス未登録」に
  なったとき、記事64本の本文が全部 3,900〜5,200字に収まっていた。
  テンプレート量産の均質な記事は Google に読まれた上で却下される。
  だから統合元の本文は捨てず、固有セクションだけ統合先へ移す。
- サイトマップの `lastmod` は `date`（公開日）ではなく `updated` を優先する。
  統合で本文が3倍になっても公開日のままだと「変わっていない」と伝わる。
- サイトマップの `priority` は `build_blog.py` の `HIGH_PRIORITY_SLUGS`
  で出し分ける。全記事を同じ値にするとクローラーに優先順位が伝わらない。
  選定基準は「10位以内でクリックがある」「内部リンクが集まるハブ」
  「統合の集約先」の3つ。**noindex の記事を残さないこと** —
  サイトマップに載らないため優先度が誰にも効かない（統合後に20件中
  5件がこうなった）。`tests/test_sitemap.py` が検出する。
- **URL は `.html` 付きを正規形とする。** `/blog` と `/blog/` はどちらも
  `/blog.html` へ 301。以前 `/blog` は rewrite だったが、同じ内容が2つの
  URL で見える状態だった（`/blog/` に至っては `"**"` に落ちて noindex の
  login.html を返し、GA4 に表示2回・1.0位が記録されていた）。
  redirects は rewrites より先に評価されるので、両方に同じ source を
  書くと rewrite が死に設定になる。
- **記事を統合したら note 側も直す。** `note_posts/posted/` は再生成で
  上書きしないので、統合前に投稿したものは古い URL を指したまま残る
  （7本中5本がこうなった）。301 で評価は引き継がれるが、note 本文の
  記事名と着地先の見出しが食い違う。`tests/test_note_posts.py` が検出する。
- note の投稿順は `python3 scripts/note_plan.py` で決める。統合の集約先を
  先に出す。被リンクは本数より**どこに集めるか**で効きが変わる。
- **IndexNow は Bing / Yandex / Naver 向けで、Google は非対応。**
  `sitemap.xml` が変わると `indexnow.yml` が差分URLだけを通知する
  （全件送ると「更新した」という通知の意味が薄れるため `--changed`）。
  所有権は `static/<鍵>.txt` の名前と中身の一致で確認される。**これは
  公開前提の値で秘密ではない**（知られてもそのドメインのURLを送れるだけ）。
  消すと送信が 403 になるがサイトは正常に動くため気づきにくい。
  `tests/test_sitemap.py` が鍵ファイルの存在と名前／中身の一致を検査する。
- SEO の不変条件はテストで固定してある。壊すと CI が止まる:
  `tests/test_sitemap.py` / `tests/test_article_schema.py` /
  `tests/test_article_titles.py` / `static/blog-ads.test.js`

### スクリプトのパスは `__file__` から解決する

`build_blog.py` は `STATIC = Path("/home/user/Expenses/static")` と絶対パスを
埋め込んでいた。**`CLAUDE.md` のコマンド一覧に載っているのに、書いた本人の
1台以外では `FileNotFoundError` で落ちる**状態だった。`test.yml` は pytest と
vitest しか回さないので CI でも走らず、2026-09-02 にデプロイ前の検証で
実行するまで誰も気づかなかった。同じ埋め込みが `fix_article_ids.py` /
`add_related_nav.py` / `fix_factcheck.py` にもあった。

```python
STATIC = Path(__file__).resolve().parent / "static"
```

**相対パス（`Path("static")`）も不可。** CLAUDE.md は cwd を指定せずに
コマンドを載せているので、リポジトリ外から呼ぶと落ちる。

`tests/test_script_paths.py` が3つを固定する——個人のホームを指す絶対パスが
無いこと、`build_blog.py` が cwd に依存せず走ること、そして
**生成物が最新であること**（`articles.json` を触って `build_blog.py` を
流し忘れると、一覧・カテゴリ・サイトマップが実態とずれる）。

### 記事は「とは・違い・仕組み」型で書く。「〜選」型を増やさない

同じ人が同じ時期に取得したドメイン（`tohon`、登記簿・地積測量図の
専門ツール）と比較して分かったこと。あちらは Google 検索から流入が
あるのに、カケイシピはほぼゼロだった。**技術面の差ではない**
（robots.txt・sitemap・canonical・構造化データはどちらも正常で、
カケイシピは Bing には問題なくインデックスされている）。

差はタイトルの型にあった。

  tohon 167本   … 「とは」24本・「違い」22本・「見方」9本（27%）
  カケイシピ88本 … 定義/比較型はわずか6本（6%）、「〜選/コツ/術」が32本（36%）

**「とは」「違い」型は検索意図と答えが一意に定まる**ので、競合が
少なければ新しいサイトでも選ばれる。「〜選」「コツ」は誰が書いても
似た内容になり、大手が既に大量に持っている領域なので、Google が
新しいサイトを追加する理由がない。

実際、カケイシピで唯一クリックを獲得している記事はすべて定義/比較型:

  family-recipe-share（仕組み）      22表示・2クリック
  recipe-app-compare（違い・比較）   21表示・2クリック
  food-budget-app（違い）            18表示・1クリック

「〜選」型からのクリックはゼロ。**新規記事はこの型に絞ること。**

核キーワードは**「レシート家計簿」**（5,000/月・競合中）。記事1本あたりの
成績はアプリ・ツール系がレシピ・献立系の3.2倍で、上位に入っているのも
レシート関連。**どの語をどの順で狙うか・何本書けたか・次に何をするかは
`docs/記事設計-レシート家計簿.md` に集約してある**（進捗と残りの語もそこ）。

**この「型」の仮説は確認できていない。** 2026-08-25 に Search Console を
詳しく見たところ、インデックス済み14件の大半がレシピ・献立系だった。
型の偏りは見られず、**約100ページ中14ページしか登録されていない**という
状態だった。手動による対策は無し。テンプレート量産としてサイト単位で
低く評価されていると判断し、**76記事を noindex にした**（下の節を参照）。

定義・課題型で書くこと自体は続ける（実際にクリックがあるのはその型）が、
**それだけでインデックスされるようになるとは考えないこと。**

**競合他社名＋レシートの語**（マネーフォワード / Zaim / レシーピ など61語・
合計6,550件/月）は競合指数がほぼ0で、核キーワードより検索数が多く競合は
50分の1以下。数字の上では最も効率が良い。

ただし **2026-08 以降、新規記事で他社との比較は書かない**（運営者の判断）。
自社アプリへの確信が持てるまでは、他社名を出さず**仕組みの説明だけで
成立する記事**に絞る。既存の比較記事（`kakeibo-app-compare` など）は
数少ないクリック実績があるので**消さない**。新規だけこの方針にする。

比較を使わずに書けた切り口の例:

- **2つの意味に分かれる語を定義する** … 「レシートスキャン」は撮影と
  スキャナ取り込みの両方を指す（`receipt-scan-vs-photo`）
- **工程に分解する** … 読み取り精度は「文字認識」と「意味の解釈」の
  2段階（`receipt-ocr-accuracy`）
- **誤解を解く** … 電子レシートは店とアプリの両方が対応しないと
  自動にならない（`denshi-receipt-kakeibo`）

### 検索対象から外した記事は searchExclude で管理する

2026-08、Google のインデックス数が 18→14 と減り続け、登録をリクエストしても
入らない状態になった（手動による対策は無し）。公開94記事のうち76%が
3,500〜5,500字の狭い帯に収まるテンプレート量産で、サイト単位で低く
評価されていると判断し、**76記事を検索対象から外した**（運営者の承認済み）。
**記事は削除していない。** 直接URLで読めるし、フラグを戻せば元に戻る。

`static/blog/articles.json` のフラグを2種類使い分ける。

- `noindex` … 統合で消えた記事。**301 と canonical で処理済みなので
  HTML に meta robots は入れない**（canonical との併用は Google が非推奨）
- `searchExclude` … 公開したまま検索対象から外す記事。
  **HTML に `meta robots noindex, follow` を入れる**
  （`follow` は記事内リンクを辿ってほしいため）

`scripts/apply_search_exclude.py` がフラグと meta robots を同期する
（`--check` で差分だけ確認できる）。**片方だけ直すとサイトマップから
消えただけで noindex が入らない**中途半端な状態になり、Google からは
今までどおり量産ページに見える。`tests/test_sitemap.py` の
`test_search_excluded_articles_have_noindex_meta` が検出する。

フラグを足したら `build_blog.py` を実行すること（一覧・カテゴリ・
サイトマップから外れる）。`HIGH_PRIORITY_SLUGS` に書いたスラッグを
外した場合は、そちらも消すこと（サイトマップに載らない記事の優先度は
誰にも効かない）。

経過観察の見方と結果ごとの分岐は `docs/記事設計-レシート家計簿.md` に
書いてある。**効果が出ないからといって施策を重ねないこと** —
何が効いたか分からなくなる。

除外した76本から、残す18本へは**内部リンクを引いてある**（2026-09-02・PR #355）。
`noindex, follow` は「検索結果には出ないが、リンクは配れる」ので、除外記事は
残す記事へのリンク資産として使う。束の中心は `receipt-kakeibo-basics`
（受け19本・出7本）で、深掘りへは中心を経由させる——全記事から全記事へ引くと
同じ文言が並んで量産に戻る。**301 の付け替えはしない**（301元はレシピ記事で、
レシート系へ向けると話題が食い違い評価が引き継がれない）。経緯と数字は
`docs/作業備忘録-2026-08-29.md` §4。

### 記事はアプリの実装を根拠に書いている。機能を変えたら記事も直す

2026-08 に全記事を実装と突き合わせたところ、**存在しない機能を
「特化している」「対応しています」と書いた記述が18記事で見つかった**
（世帯共有、収入の記録、週単位の予算、AIへの自由記述の要望、
旬食材・栄養バランスの考慮、難易度でのフィルタ、通知、支出パターン分析）。
読者が目的の機能を求めて登録し、無いと分かって離脱する。景表法の面でも
望ましくない。

現在は逆に、**実装の細部を根拠に書いた記事**があるため、実装を変えると
記事が嘘になる。同時に直す対応は次のとおり。

| 変更する場所 | 見直す記事 |
|---|---|
| `static/ocr-client.js` の `UPLOAD_MAX_DIM` | `long-receipt-ocr` |
| `app/routes/ocr.py` の `MAX_BYTES` / `ALLOWED_TYPES` | `long-receipt-ocr` / `receipt-scan-vs-photo` / `denshi-receipt-kakeibo` |
| `app/parser.py` の `_TOTAL_KEYWORDS` ほか各キーワード表 | `receipt-ocr-accuracy` |
| `app/engines.py` の多段フォールバック | `receipt-ocr-accuracy` / `receipt-ocr-how-it-works` |
| `static/csv-export.js` の列・BOM・品目行の構造 | `receipt-kakeibo-excel` |
| `#file-input` の `multiple` / `.cam-only` の表示条件 | `receipt-scan-vs-photo` |
| `firebase-config.js` の `CATEGORIES` | `spending-analysis` |
| 予算の保存単位（`settings/budget_{monthKey}`） | `family4-food-cost` ほか |

**共有機能を再実装したら、9記事の「共有機能は現在ありません」を戻すこと**
（`couple-share-kakeibo` / `family-kakeibo` / `family-recipe-share` /
`couple-food-cost` / `family4-food-cost` / `futari-gurashi-kyoudoukirabi` /
`recipe-record-app` / `shopping-list-auto` / `rinyushoku-kondate`）。

### 架空の利用者の声・実績値を載せない

「ユーザーの声」として体験談を9記事とLPに載せていたが、**すべて架空**
だった。5つ星の評価表示と「平均¥12,400の節約額」「92%が継続」も
裏づけが無く、2026-08 に削除した。

実在しない感想を推奨表示として出すのは景表法（ステマ規制・不当表示）に
触れうる。**実際の感想が集まるまで載せない。**載せるときは許諾を得て、
出典（回答時期・属性）が分かる形にする。数値も集計方法と期間を書けるもの
だけにする。

なお `Review` / `AggregateRating` の構造化データは元から入れていない。
入れると検索結果に星が出て、削除しても再クロールまで残る。**架空の
評価で入れないこと。**

### 文字数を増やしてもインデックスされるようにはならない

上の比較で分かったもう一つのこと。tohon の記事は 1,474〜9,727字と
自然にばらついているが、カケイシピは135本すべてが 3,900〜5,200字の
狭い帯に収まっていた。

これを「薄いから」と誤診し、35本を統合して統合先の本文を14,000字前後まで
厚くしたが、**統合先15本は15本とも「クロール済み - インデックス未登録」の
まま**だった（統合から1週間後の実測）。一方 tohon は 1,500〜2,500字の
記事が大半でインデックスされている。

**問題は文字数ではなく、テンプレートで量産した均質さと、記事の型。**
統合をこれ以上進めても効果は見込めない（実施済みの301は正しく張れて
いるので戻す必要はない）。

### ブログのCTAは PC とスマホで別物

`static/blog-cta.js` は **PC のときだけ** 記事内CTA（`.am-cta-box`）と
サイドCTA（`.sb-cta`）の `innerHTML` を丸ごと差し替える。
そのため記事HTML側のCTA文言はスマホでしか出ない。

`.am-sidebar` は `@media (max-width: 1024px)` で `display: none` になる。
モバイルの受け皿は本文下の `.am-cta-box` なので、**両方を必ず置く**
（片方しか無い記事があり、モバイルでCTAが消えた事故がある）。

CTAクリックは位置別に `cta_click` イベントを送る。計測は
`if (isMobile) return;` より**前**に登録すること（後ろだとモバイルの
クリックが1件も取れない）。差し替えで要素ごと入れ替わるため、
個別要素ではなくイベント委譲で拾う。

### GitHub Actions はジョブ1回につき最低1分課金される

短い処理でも1分に切り上げられる。10秒の curl を10分ごとに回すと、
**720分/月ではなく4,320分/月**を消費する（プライベートリポジトリの
無料枠は2,000分）。

2026-08、`keep-alive.yml` をこの見積もりのまま24時間・10分ごとで
回していて枠を使い切り、**pytest・vitest・Firebase Hosting への
デプロイまで全ワークフローが起動不能**になった。ジョブが3秒で失敗し
ログも残らないため、テストの失敗と紛らわしい。**全ワークフローが
数秒で落ちていたら、まず課金枠を疑うこと。**

**keep-alive は最終的に停止した**（`keep-alive.yml` は手動実行のみ）。
`static/app.js` の初期化で `prewarmOcr()` が /api/health を叩き、
アプリを開いた時点で起動が始まるため、keep-alive が守れるのは
「開いた直後に即撮影する人」だけだった。費用に見合わない。

なお「間隔を延ばす」だけでは意味がない。Render は15分アイドルで
スリープするので、15分を超える間隔では毎回スリープ済みを起こすだけになる。
24時間起こす必要が出たら、**Actions ではなく外部の無料監視サービス**
（UptimeRobot・cron-job.org など）を使うこと。

定期実行を足すときは **実行回数 × 1分** で見積もること。

### JS/CSS のデプロイ反映は最大1時間かかる

`firebase.json` の `**/*.@(js|css)` は `public, max-age=3600`。
以前は `no-cache, max-age=0` だったが、Googlebot が記事1本の
クロールごとに JS/CSS の再確認を出し、少ないクロール予算の29%を
アセットが消費していた（クロール統計で JS 20% + CSS 9%）。

**JS を直しても利用者に届くまで最大1時間かかる。** 急ぐときは
記事HTML側の `?v=YYYYMMDD` を上げる（ブログのCSSは既にこの形式）。
アプリ本体は `sw.js` が JS/CSS をネットワーク優先で取得するため、
この遅延の影響を受けない。

### 外部ドメインを増やすときは firebase.json の CSP

`firebase.json` の `Content-Security-Policy` は `default-src 'none'` から
組み立ててある。新しい CDN・画像・API を使うときは対応するディレクティブ
（`script-src` / `img-src` / `connect-src` / `frame-src`）への追加が必須。
インライン `<script>` は動かないので、外部ファイルに切り出す。

### 未定義URLは 404 を返す（フォールバックは撤去済み）

以前は2段構えで未定義URLに `login.html` を返していた。

- `firebase.json` の `"**" → /login.html` rewrite
- `static/sw.js` の「許可リストに無いナビゲーションを差し替える」処理

SPA ルートは実在せず（全画面が `login.html` 上のモーダル）、**存在しない
URL に 200 を返して 404 を表示できなくしていた**。実際 Bing は
`savings-recipe-tips-pro.html` という**リポジトリに一度も存在しない
スラッグ**を 200 として登録している（2026-08-24 クロール）。2026-08-28 に
両方を撤去したので、いまは `static/404.html` が返る。

**この2つは対になっている。片方だけ戻さないこと** — rewrite を戻すと
SW が素通しした未定義URLに Hosting が 200 を返し、SW を戻すと
`/robots.txt` をブラウザで開いたときに LP が表示される。
`static/sw-routing.test.js` が SW 側を守っている。

`sw.js` を変更したら `CACHE` のバージョン番号を上げること。

`login.html` の `noindex, nofollow` は残す。ゴミURLのフォールバック先では
なくなったが、LP 自体を検索対象にしない方針は変えていない。この noindex
ページを sitemap に載せてはいけない。

### APIキーは用途ごとに分ける。公開前提の値だけがコードに入る

2026-06、Gemini の API キー3つが `static/firebase-config.js` と `.env` に
入ったままコミットされ、**公開リポジトリの git 履歴に約2か月半残った**
（2026-08-29 に運営者が Console で無効化）。現在のファイルから消しても
**履歴は誰でも読める。**

原因は**同じキーを Firebase の `apiKey` と `GEMINI_API_KEY` の両方に
使っていた**こと。Gemini が有効なキーがブラウザに配信されていたので、
公開リポジトリでなくても漏れていた。

- **Firebase の `apiKey` は秘密ではない。** ブラウザに配信されるので隠せない。
  安全性は Firestore のセキュリティルールと Authentication が担保する。
  **消すと動かなくなるだけなので消さないこと。**
- **それ以外のキーはコードに書かない。** サーバ側の環境変数から読む
  （`os.environ.get("GEMINI_API_KEY")`）。`gyosei-quiz-app` がこの形。
- **1つのキーを2用途に使わない。** 公開して良い用途と、してはいけない用途が
  同じキーに乗ると、厳しい側に合わせられなくなる。

`scripts/scan_secrets.py` が既知の形（`AIza` / `sk_live_` / `whsec_` /
`ghp_` / `AKIA` / `xox?-` / 秘密鍵 / 資格情報つき接続URL）を検査する。
`.github/workflows/secret-scan.yml` が **PR の追加行**に対して走り、
入る前に止める。`tests/test_scan_secrets.py` が判定を固定している。

**`static/firebase-config.js` の `apiKey:` 行だけが例外**（`ALLOW`）。
同じ値でも他のファイルに現れれば止まる——用途ごとに分ける決まりだから、
他所に出ること自体が間違い。公開前提の値を足すときは `ALLOW` に**理由つきで**
書く。値そのものは出力しない（記録が漏洩の再生産になる）。

**リポジトリを公開に切り替える前に、必ず全履歴を走査すること。**

```
python3 scripts/scan_secrets.py --history
```

Actions の「秘密情報スキャン」を `full_history` で手動実行しても同じ。
**一度公開すると取り消せない**し、フォークやキャッシュに残るので、
履歴を書き換えても「もう見られていない」ことにはならない。
**漏れたら、まず発行元で無効化する**（書き換えより先）。

なお**「見つからなかった」は「無い」ではない。** 既知の形しか検出できず、
`dummy` `example` `your-` などを含む行は設定例として飛ばすので、そういう語を
含む本物は見逃す。経緯は `docs/作業備忘録-2026-08-29-秘密情報の棚卸し.md`。

### アフィリエイト広告

`static/blog-ads-data.js` に商品を足すだけで全記事に反映される。
`static/blog-ads.js` が **「PR」表記**（景表法のステマ規制）と
**`rel="sponsored nofollow noopener"`**（Google のガイドライン）を
描画側で強制する。データ側から外せない設計なので、この構造を崩さない。

## テストの注意

- `tests/test_ocr_engines.py` は `sys.modules` に PIL のモックを注入する。
  実物の PIL が必要なテストは `tests/test_debug_storage.py` の `real_pil`
  フィクスチャを使う（PIL 系モジュールを purge して再 init する）。
- `tests/test_performance.py` は絶対時間ではなく**計算量の悪化**を見る
  （少数IPと多数IPの1回あたりの所要時間を比較する）。CI ランナーの
  速度差で落ちないようにするためで、絶対値の閾値に戻さないこと。
  レイテンシ系は **`_measure()` のウォームアップを必ず通す**。1回目の
  リクエストには遅延 import と httpx の初期化で30ms前後かかり、
  これを含めると「最悪ケース」が起動コストそのものになる。
  裾は `max` ではなく `p95` で見る（共有ランナーでは単発のスパイクが
  必ず起き、実装と無関係に落ちるため。実際に max=111.9ms で失敗した）。
  スループットは絶対 rps ではなく、**同一プロセス上の最小構成アプリ
  （`baseline_rps`）との比**で見る。絶対値はマシン速度そのもので、
  実測190〜311rps と閾値200をまたいでいた。比なら速度に影響されず、
  「ヘルスチェックが I/O を始めた」退行は検出できる
  （10ms の I/O を入れると比が 0.20 まで落ちることを確認済み）。
- `tests/test_parser.py` の停止性テストは、`pytest-timeout` を導入して
  いないため別スレッドで実行して時間を測る。パーサに「進まないループ」を
  作り込むと、1行の入力でワーカーが永久に固まる事故が実際に起きた。
- pyo3 由来の `PanicException` は `Exception` を継承しないため、
  ベストエフォートで握りつぶす箇所は `except BaseException` を使う
  （`app/stripe_billing.py`・`app/debug_storage.py` に前例あり）。

## 運用メモ

- レシート画像の一時保存は既定で無効。`DEBUG_RETAIN_RECEIPTS=true` のときだけ
  Firebase Storage に保存し、**GCS のライフサイクルルール**（`storage-lifecycle.json`）
  で3日後に自動削除する。`DEBUG_RETAIN_DAYS` を変えたら
  `storage-lifecycle.json` も合わせて更新すること。
- `/admin.html` は `ADMIN_UIDS`（Firebase UID のカンマ区切り）でのみ閲覧できる。
- `/admin.html` の登録ユーザー一覧は、Firestore にユーザー台帳が無いため
  Firebase Authentication（`auth.list_users()`）を名簿の正とし、
  `users/{uid}/settings/subscription` を突き合わせてプラン状態を出している。
  プレミアム判定（`app/routes/admin.py` の `_is_premium`）は
  `static/stripe-billing.js` の `isPremium()` と**同じ判定式を維持すること**。
  ずれると管理画面とアプリ本体でプレミアム表示が食い違う。
- 改修の経緯は `docs/作業備忘録-*.md` に残している。

## このファイルの更新

**最終更新: 2026-09-03**

このファイルは「README を読んでも分からない、事故につながる決まりごと」を
集めたもの。放っておくと実態とずれて、かえって誤った判断を招く。

### 更新するタイミング

次のどれかに当てはまる変更を入れたら、同じ PR で CLAUDE.md も直す。

- **同時に直さないと壊れる場所を増やした／減らした**
  （例: `firestore.rules` と `static/expense-limits.js` の二重管理）
- **一度踏んだ事故の再発防止を入れた**
  （何が起きたか・なぜその形にしたかを1〜2行で残す）
- **既存のパターンから外れる書き方を許容した／禁止した**
  （例: `async def` の中で同期SDKを呼ばない）
- **コマンド・デプロイ経路・環境変数の扱いが変わった**

逆に、**ファイルを1つ増やした・関数を1つ足した程度では書かない。**
README のディレクトリ構成と重複する内容も書かない。

### 定期的な棚卸し

月に一度、次を確認して古くなった記述を直す。

```bash
git log --oneline --since="1 month ago"     # 何が変わったか
python3 -m pytest tests/ -q && npm test     # 記述どおりに動くか
grep -c "" CLAUDE.md                        # どれだけ増えたか
```

見るべきは「書いてあることが今も正しいか」で、網羅性ではない。
**古い記述を消すことも更新のうち。** 記事数やバージョン番号のような
すぐ古くなる具体値は、必要なとき以外は書かない。

行数に上限は置かない。以前は「目安200行」と書いていたが、事故の再発防止を
積み上げると自然に超える（2026-08 時点で400行超）。**行数を守るために
価値のある記述を消すのは本末転倒**なので、判断基準は行数ではなく
「この1行が無いと事故が起きるか」に置く。棚卸しで削るのは、
実装と食い違った記述・コードを読めば分かる記述の2つだけ。
