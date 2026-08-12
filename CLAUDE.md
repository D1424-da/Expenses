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

### フロントの司令塔は app.js

`static/app.js` が各モジュールに依存を注入する。**`db` を渡し忘れる／`null` を
渡すと、編集・更新・削除だけが `Expected first argument to collection() ...` で
落ちる**（新規追加は別経路なので気付きにくい）。
`static/app-wiring.test.js` がソースを静的解析してこれを検出する。
init 関数に依存を足すときは `NEEDS_DB` も更新する。

### Firestore の制限はクライアントにも複製されている

`firestore.rules` の `validExpense`（store 100字・memo 500字・items 80件・
rawText 20000字・amount 1億未満）は `static/expense-limits.js` に写してある。
**両方を必ず同時に更新する。** 片方だけだと、保存時に
「Missing or insufficient permissions」という原因の分からないエラーになる。

### ブログは事前生成された静的 HTML（135記事）

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
- SEO の不変条件はテストで固定してある。壊すと CI が止まる:
  `tests/test_sitemap.py` / `tests/test_article_schema.py` /
  `tests/test_article_titles.py` / `static/blog-ads.test.js`

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
