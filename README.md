# 🧾 カケイシピ (Receipt Expense Tracker × AI レシピ提案)

レシートを写真で撮影し、OCR で日付・店名・金額・品目を自動で読み取って記録できる
家計簿 Web アプリです。データは **Firebase** に保存されるため、同じ Google
アカウントでログインすればスマホ・PC など**どの端末からでも同じ家計簿**を確認・
編集できます。家計簿だけでなく、**買った食材からAIが献立・レシピを提案**する
機能や、買い物リスト・予算管理・Stripeによるプレミアム課金も備えています。

OCR は**ブラウザ内（PaddleOCR / PP-OCRv5）でも実行**できるため**サーバー不要**で、
Firebase Hosting だけでも公開できます。バックエンド（FastAPI）を設定した場合の
読み取り優先順位は **Gemini ＞ Vertex AI ＞ Vision API ＞ ブラウザ内 PaddleOCR** です。

公開URL: `get-tohon.online`（ランディングページ `index.html` → ログイン後は
`login.html` がアプリ本体のエントリポイント）

## アーキテクチャ

```
GitHub Pages (静的ホスティング)          Firebase (無料 Spark プラン)
┌────────────────────────┐           ┌──────────────────┐
│ 画面 + PaddleOCR         │ ───────▶  │ Authentication    │
│ （ブラウザ内でOCR + 抽出）  │  読み書き  │ Firestore(データ)  │
│                         │ ◀───────  │                  │
└────────────────────────┘           └──────────────────┘
```

- **OCR**: ブラウザ内の PaddleOCR（ppu-paddle-ocr + onnxruntime-web / PP-OCRv5、無料・
  サーバー不要）。`static/parser.js` で日付・店名・金額・品目を抽出。モデル（約21MB）は
  初回利用時に CDN から取得し、以降はブラウザのキャッシュが効きます。
- **データ・認証・同期**: Firebase（Firestore + Authentication）。フロントが SDK で
  直接アクセス。**カード登録不要の無料 Spark プランで動きます**
  （レシート画像は保存せず、読み取った金額などのデータのみ保存）。

> 💡 より高精度・高速にしたい場合は、付属の FastAPI + Tesseract バックエンドを使う
> こともできます（「高精度OCR（任意）」参照）。

## 主な機能

### 家計簿
- 🔐 Google / メールログイン（端末をまたいで同じデータを表示）
- 📷 レシート画像のアップロード / スマホカメラ撮影 → OCR 自動読み取り
- ✍️ 読み取り結果（日付・店名・合計・カテゴリ・明細）の確認・修正・手入力
- 🔄 Firestore のリアルタイム同期（別端末での変更が即反映。タブ非表示時は自動で購読停止しコスト削減）
- 📊 月ごとの合計とカテゴリ別内訳バー、月切替・編集・削除、CSVエクスポート
- 🏬 店舗別一覧（店舗→支店→明細でグループ表示）、最安値比較
- 📅 買い物カレンダー（日付タップで金額を直接入力、週計タップでカテゴリ別内訳）
- 💰 カテゴリ別の月次予算設定・進捗バー表示
- 📈 支出トレンド表示

### AIレシピ・献立
- 🍳 買った食材リストから AI（Gemini）が「今夜の1品」または「週間献立」を自動提案
- 🛒 買い物リストの自動生成・複数端末での同期
- 📝 献立プランの保存・カレンダー連携
- ⭐ お気に入りレシピの保存

### 課金・その他
- 💳 Stripe によるプレミアムプラン（トライアル・使用量ゲート・カスタマーポータル）
- 📖 SEOブログ（節約・レシピ関連記事、Note連携）

---

## セットアップ

### 1. Firebase プロジェクトを用意

1. [Firebase コンソール](https://console.firebase.google.com/) でプロジェクトを作成
2. **Authentication** → ログイン方法 → **Google** を有効化
3. **Firestore Database** を作成
4. プロジェクトの設定 → 「マイアプリ」→ **ウェブアプリ**を追加し、表示される
   `firebaseConfig` を控える

> Cloud Storage は使いません（レシート画像を保存しないため）。Blaze プランへの
> アップグレードやカード登録は不要です。

`static/firebase-config.js` の各値を、控えた `firebaseConfig` に置き換えます。
（`OCR_API_BASE` は空文字のままにすると、ブラウザ内 OCR を使います。）

### 2. セキュリティルールを反映

`firestore.rules` は「各ユーザーは自分のデータだけにアクセス可能」というルールです。
Firebase CLI で反映できます。

```bash
npm install -g firebase-tools
firebase login
# .firebaserc の project id が自分のプロジェクトID（全部小文字）になっていることを確認
firebase deploy --only firestore:rules
```

### 3. ローカルで試す

OCR がブラウザ内で完結するため、`static/` を静的サーバーで配信するだけで動きます。

```bash
cd static
python3 -m http.server 8000   # → http://localhost:8000
```

---

## 公開（Firebase Hosting の自動デプロイ）

`main` に push（マージ）すると Firebase Hosting に自動デプロイするワークフロー
（`.github/workflows/deploy-firebase-hosting.yml`）を同梱しています。利用には、
Firebase のサービスアカウント鍵を GitHub のシークレット `FIREBASE_SERVICE_ACCOUNT`
に登録してください（Firebase コンソール → プロジェクトの設定 → サービスアカウント →
「新しい秘密鍵を生成」で得た JSON の中身をそのまま登録）。登録後は `main` への
マージだけで `expenses-9af61.firebaseapp.com` が最新になります。

---

## GitHub Actions ワークフロー一覧

| ファイル | トリガー | 役割 |
|---|---|---|
| `deploy-firebase-hosting.yml` | `main` への push | Firebase Hosting に自動デプロイ |
| `deploy-firestore-rules.yml` | `firestore.rules` / `firebase.json` 変更時 | Firestore ルールを自動デプロイ |
| `test.yml` | PR 時のみ | pytest（Python）・vitest（JS）を実行 |
| `lighthouse.yml` | 手動実行のみ（`workflow_dispatch`） | パフォーマンス/アクセシビリティ/SEOスコア計測 |
| `keep-alive.yml` | 10分ごと（スケジュール） | Render 無料プランのスリープ防止（`/api/health` に ping） |

複数リポジトリで Actions の無料枠を共有しているため、push のたびに毎回全部
走らせず、必要最小限（デプロイ + PRテストのみ自動）に絞っています。Lighthouse
などは Actions タブから手動実行してください。

---

## 高精度OCR（任意：FastAPI バックエンドを使う）

ブラウザ内 OCR は手軽ですが、感熱紙レシートではやや精度が落ちます。より高精度・
高速にしたい場合は、付属の FastAPI + Tesseract サービスを使えます。

```bash
sudo apt-get install -y tesseract-ocr tesseract-ocr-jpn   # Ubuntu/Debian
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload      # http://localhost:8000
```

`static/firebase-config.js` の `OCR_API_BASE` にこのサービスの URL を設定すると、
ブラウザ内 OCR の代わりにバックエンドを使います。コンテナ用 `Dockerfile` も同梱
（Cloud Run / Render などにデプロイ可能）。別オリジンから呼ぶ場合はサーバー側の
環境変数 `CORS_ORIGINS` に公開元 URL を指定してください（**未設定だとクロスオリジン
呼び出しは拒否＝フェイルクローズ**）。

`/api/ocr` は公開エンドポイントのため、以下の保護を備えています。

- **レート制限**: `RATE_PER_IP`（IP/分・既定10）, `RATE_GLOBAL`（全体/分・既定60）
- **任意の認証**: `FIREBASE_PROJECT_ID` を設定すると Firebase ID トークン必須に
  なります（フロントは自動で `Authorization: Bearer <token>` を付与）。未設定なら
  認証はスキップしレート制限のみで保護します。
- 画像はマジックバイトで実体を検証し、最大 8MB に制限します。

OCR エンジンは環境変数 `OCR_ENGINE` で切替可能（`tesseract` 既定 / `gemini` / `vertex` / `claude` / `google`）。

### 高精度AI（Gemini）をバックエンド経由で使う（推奨）

Gemini で画像から直接「日付・店名・支店名・合計・カテゴリ・明細」を構造化抽出できます。
**API キーはフロント（公開される静的ファイル）には置かず、必ずバックエンドの環境変数に
保持してください。** フロントに書くと GitHub 等で公開され、Google に「漏洩キー」として
自動的に無効化されます（`403 PERMISSION_DENIED: Your API key was reported as leaked`）。

1. [Google AI Studio](https://aistudio.google.com/apikey) で API キーを発行
2. バックエンドに環境変数を設定して起動

   ```bash
   export OCR_ENGINE=gemini
   export GEMINI_API_KEY="（発行したキー）"
   export GEMINI_MODEL="gemini-flash-latest"   # 任意（最新Flashを自動追従）
   export CORS_ORIGINS="https://<ユーザー名>.github.io"   # 公開元
   uvicorn main:app --host 0.0.0.0 --port 8000
   ```

   Cloud Run / Render などにデプロイする場合も、これらを環境変数（シークレット）として設定します。
3. `static/firebase-config.js` の `OCR_API_BASE` にバックエンドの URL を設定

> 旧版はフロントから直接 Gemini を呼んでいましたが、キーが公開され無効化されるため、
> バックエンド経由に変更しました。`OCR_API_BASE` が空のときはブラウザ内 PaddleOCR を使います。

### Vertex AI で動かす（Google Cloud 課金＝無料トライアル等を使う）

`OCR_ENGINE=vertex` にすると、同じ Gemini モデルを **Vertex AI**
(`aiplatform.googleapis.com`) 経由で呼びます。課金が **Google Cloud のプロジェクト**
に紐づくため、**無料トライアルの $300 クレジット**などをそのまま消費できます
（Developer API の AI Studio 課金とは別枠）。プロンプト・抽出結果は `gemini` と同じです。

必要な環境変数:

```bash
export OCR_ENGINE=vertex
export GOOGLE_CLOUD_PROJECT="（課金が紐づくGCPプロジェクトID）"
export VERTEX_LOCATION=global               # 任意（既定 global。特定リージョンに固定するなら us-central1 等）
# VERTEX_MODEL は通常不要。設定すると候補リストを使わずそのモデルだけを試すため、
# 未設定のままにして gemini-flash-latest を自動選択させるのが安全。
# 認証（いずれか）:
export GOOGLE_SERVICE_ACCOUNT_JSON='{...}'  # SA鍵のJSON文字列（Render向け）
# もしくは GOOGLE_APPLICATION_CREDENTIALS=鍵ファイルパス / 実行環境のADC
```

- 事前に Console で **Vertex AI API を有効化**し、サービスアカウントに
  **`Vertex AI User`（roles/aiplatform.user）** を付与してください。
- `requirements-gemini.txt` の `google-auth` / `requests` が必要です。
- Vertex 失敗時も `VISION_API_KEY` があれば Vision にフォールバックします。

### 保険: AI 失敗時の Vision API フォールバック（任意）

読み取りの優先順位は **Gemini ＞ Vertex AI ＞ Vision API ＞ ブラウザ内 PaddleOCR** です。
`OCR_ENGINE=vertex` のときは先頭が Vertex AI になります（設定エンジンを先頭に多段試行）。
Gemini が失敗し、`VISION_API_KEY` があれば Vision で再試行、それも失敗すると
最後にブラウザ内 PaddleOCR にフォールバックします。

`OCR_ENGINE=gemini` のとき、Gemini がレート制限・障害などで失敗すると、
`VISION_API_KEY` が設定されていれば自動的に Google Cloud Vision API で OCR を
やり直します。Vision は**文字起こし（OCR）専用**で、構造化（日付・金額・カテゴリ等）は
既存の正規表現パーサ（`app/parser.py`）が担当します。

- サービスアカウントの JSON 鍵は不要。API キー1個で `images:annotate` を呼びます。
- [Google Cloud Console](https://console.cloud.google.com/) で **Cloud Vision API を有効化**し、
  API キーを発行してください。
- 環境変数 `VISION_API_KEY` に設定（未設定ならフォールバックは無効＝従来どおり）。

  ```bash
  export VISION_API_KEY="（発行したキー）"
  ```

  Render では `render.yaml` に `sync:false` の枠を用意済みなので、ダッシュボードの
  Environment で入力します（キーは Git に残りません）。

---

## Firestore データ構造

```
users/{uid}/expenses/{expenseId}
  date:      "YYYY-MM-DD"
  store:     string
  branch:    string          # 支店名（〇〇店）
  amount:    number          # 円
  category:  string
  memo:      string
  items:     [{ name, price, category }]   # 明細ごとにカテゴリを保持
  rawText:   string           # OCR生テキスト
  ocrEngine: string           # 抽出元(gemini/vertex/vision/paddle/manual)。正解辞書の判定に使用
  createdAt: serverTimestamp
```

## ディレクトリ構成

```
.
├── static/                  # フロントエンド（Firebase Hosting の公開対象）
│   ├── index.html           # ランディングページ（LP）
│   ├── login.html           # アプリ本体のエントリポイント（ログイン後の画面）
│   ├── blog.html, blog-p2〜6.html, blog/*.html  # SEOブログ（135記事）
│   ├── app.js                # エントリポイント（司令塔・画面のオーケストレーション）
│   ├── auth.js                # 認証（Google / メール / インアプリブラウザ）
│   ├── firestore-data.js      # Firestore データアクセス
│   ├── ocr-client.js          # 画像縮小・バックエンドOCR呼び出し・PaddleOCR
│   ├── recipe-view.js         # AIレシピ・献立提案UI
│   ├── shopping-list.js       # 買い物リスト（複数端末同期）
│   ├── meal-plan.js           # 献立プラン
│   ├── saved-recipes.js       # お気に入りレシピ
│   ├── budget-view.js         # カテゴリ別予算管理
│   ├── trend-view.js          # 支出トレンド
│   ├── stripe-billing.js      # Stripe プレミアム課金
│   ├── history.js             # 履歴正規化（Gemini基準の正解辞書）
│   ├── stats.js               # カテゴリ内訳・最安値比較の集計（純粋関数）
│   ├── parser.js              # OCRテキスト → 家計簿項目の抽出（ブラウザ用）
│   ├── sw.js                  # Service Worker（アプリシェルのオフラインキャッシュ）
│   ├── style.css, blog-*.css, landing.css, tokens.css
│   └── firebase-config.js     # ← あなたの Firebase 設定に置き換える
├── .github/workflows/
│   ├── deploy-firebase-hosting.yml  # Firebase Hosting 自動デプロイ
│   ├── deploy-firestore-rules.yml   # Firestore ルール自動デプロイ
│   ├── test.yml                     # pytest / vitest（PR時のみ）
│   ├── lighthouse.yml               # パフォーマンス計測（手動実行）
│   └── keep-alive.yml               # Render スリープ防止（定期ping）
├── firebase.json            # Hosting / ルールの設定（ブログはキャッシュ長め・アプリ本体はno-cache）
├── firestore.rules          # Firestore セキュリティルール
├── storage.rules            # Storage セキュリティルール
├── .firebaserc              # ← プロジェクトID を設定
├── render.yaml               # Render Blueprint（バックエンドのデプロイ設定）
│
├── main.py                  # 高精度OCR・レシピ提案用 FastAPI サービス（ルーティングのみ）
├── app/
│   ├── routes/
│   │   ├── ocr.py            # OCR・ヘルスチェック
│   │   ├── recipe.py         # レシピ・献立提案エンドポイント
│   │   └── stripe_routes.py  # Stripe Webhook・サブスクリプション
│   ├── engines.py            # OCRエンジンの選択と多段フォールバック
│   ├── security.py           # 画像検証・レート制限・Firebase認証
│   ├── recipe.py             # Gemini によるレシピ・献立提案ロジック
│   ├── stripe_billing.py     # Stripe 連携・Firebase Admin 初期化
│   ├── gemini.py             # Gemini で画像→構造化抽出（高精度OCR）
│   ├── vertex.py             # Vertex AI 版 Gemini（Google Cloud 課金で動かす）
│   ├── vision.py             # 保険: Gemini失敗時の Google Vision API フォールバック
│   └── parser.py             # OCRテキスト抽出（parser.js と同等のロジック）
├── docs/                     # 作業備忘録（改修の経緯・意思決定の記録）
├── Dockerfile                # (任意) OCRサービスのコンテナ（Cloud Run向け）
├── requirements*.txt         # base / gemini / dev 用途別に分割
└── tests/, e2e/              # pytest / Playwright E2E テスト
```

## 精度についての注意

OCR は完璧ではありません（特に感熱紙レシートや薄い印字）。本アプリは
「OCR で下書き → 人が確認・修正して保存」という前提で設計しています。
合計金額が明細より小さく誤読された場合などは自動で補正を試みますが、
保存前に必ず内容をご確認ください。
