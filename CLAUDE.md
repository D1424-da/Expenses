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

npm run test:rules                         # Firestore ルール（要 Firestore Emulator）
npx playwright test                        # E2E（e2e/。通常はCIで動かさない）

python3 build_blog.py                      # ブログ一覧・カテゴリ・sitemap.xml を再生成
python3 scripts/fix_article_schema.py --check   # 記事の構造化データの欠落を検査
```

CI（`.github/workflows/test.yml`）は **PR 時のみ** pytest と vitest を実行する
（main への push では走らない。Actions の無料枠を節約するため）。
Firestore ルールのテストと E2E は CI に含まれていない。

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
- 記事のメタデータは `static/blog/articles.json`。`noindex: true` の記事は
  サイトマップから除外されるが、**HTML には noindex を入れない**
  （統合先への canonical のみ。canonical と noindex の併用は Google が非推奨）。
- 記事テンプレートは1種類ではない。`<article class="am">` の記事と、
  `<article>` を持たず `.article-wrap` で包む記事（`saving-recipe-*`）がある。
  DOM を触るスクリプトは両方を見ること。
- **記事の統合は canonical と 301 の両方**。`articles.json` で
  `noindex: true` にし、統合先への canonical を記事HTMLに置き、
  さらに `firebase.json` の `redirects` に 301 を足す。
  canonical だけだと統合元がクロール対象に残り続ける。
  HTMLは消さない（Hosting は redirects を静的ファイルより先に評価するので、
  設定を消すだけで統合を戻せる）。
- サイトマップの `priority` は `build_blog.py` の `HIGH_PRIORITY_SLUGS`
  で出し分ける。全記事を同じ値にするとクローラーに優先順位が伝わらない。
  選定基準は「10位以内でクリックがある」「内部リンクが集まるハブ」
  「統合の集約先」の3つ。
- SEO の不変条件はテストで固定してある。壊すと CI が止まる:
  `tests/test_sitemap.py` / `tests/test_article_schema.py` /
  `tests/test_article_titles.py` / `static/blog-ads.test.js`

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

### 外部ドメインを増やすときは firebase.json の CSP

`firebase.json` の `Content-Security-Policy` は `default-src 'none'` から
組み立ててある。新しい CDN・画像・API を使うときは対応するディレクティブ
（`script-src` / `img-src` / `connect-src` / `frame-src`）への追加が必須。
インライン `<script>` は動かないので、外部ファイルに切り出す。

### Service Worker のフォールバック

`static/sw.js` は、許可リストに無いナビゲーションを `/login.html` に
差し替える（SPA ルート用）。**拡張子を持つパスは除外している** ——
これが無いと `/robots.txt` をブラウザで開いたときに LP が表示される。
`static/sw-routing.test.js` が守っている。
`sw.js` を変更したら `CACHE` のバージョン番号を上げること。

### Firebase Hosting の rewrite

`firebase.json` の `"**" → /login.html` により、**未定義のパスはすべて
login.html を返す**。存在しない URL が LP として表示されるため、
`login.html` 自身に `noindex, nofollow` を入れてゴミURLのインデックスを
防いでいる。この noindex ページを sitemap に載せてはいけない。

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
- 改修の経緯は `docs/作業備忘録-*.md` に残している。

## このファイルの更新

**最終更新: 2026-08-12**

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
grep -c "" CLAUDE.md                        # 肥大化していないか（目安200行）
```

見るべきは「書いてあることが今も正しいか」で、網羅性ではない。
**古い記述を消すことも更新のうち。** 記事数やバージョン番号のような
すぐ古くなる具体値は、必要なとき以外は書かない。
