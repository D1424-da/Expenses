# 🧾 レシート家計簿 (Receipt Expense Tracker)

レシートを写真で撮影し、OCR で日付・店名・金額・品目を自動で読み取って記録できる
家計簿 Web アプリです。データは **Firebase** に保存されるため、同じ Google
アカウントでログインすればスマホ・PC など**どの端末からでも同じ家計簿**を確認・
編集できます。

OCR は**ブラウザ内（PaddleOCR / PP-OCRv5）でも実行**できるため**サーバー不要**で、
GitHub Pages などの静的ホスティングだけで公開できます。バックエンドを設定した
場合の読み取り優先順位は **Gemini ＞ Vertex AI ＞ Vision API ＞ ブラウザ内 PaddleOCR** です。

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

- 🔐 Google ログイン（端末をまたいで同じデータを表示）
- 📷 レシート画像のアップロード / スマホカメラ撮影 → ブラウザ内 OCR 自動読み取り
- ✍️ 読み取り結果（日付・店名・合計・カテゴリ・明細）の確認・修正・手入力
- 🔄 Firestore のリアルタイム同期（別端末での変更が即反映）
- 📊 月ごとの合計とカテゴリ別内訳バー、月切替・カテゴリ絞り込み・編集・削除
- 📅 買い物カレンダー（日付タップで金額を直接入力、その日の合計と週間合計を表示）

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

## 公開（GitHub Pages）

`static/` を GitHub Pages に公開するワークフロー（`.github/workflows/deploy-pages.yml`）
を同梱しています。

1. GitHub リポジトリの **Settings → Pages → Source** を **「GitHub Actions」** に設定
2. `main` ブランチに push（または Actions タブから手動実行）すると自動デプロイ
3. 公開 URL（例: `https://<ユーザー名>.github.io/<リポジトリ名>/`）にアクセス

公開後の注意：**Firebase コンソール → Authentication → Settings → 承認済みドメイン**
に GitHub Pages のドメイン（`<ユーザー名>.github.io`）を追加してください
（Google ログインに必要）。

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
環境変数 `CORS_ORIGINS` に公開元 URL を指定してください。

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
   export GEMINI_MODEL="gemini-2.5-flash"   # 任意
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
export VERTEX_LOCATION=us-central1          # 任意（global も可）
export VERTEX_MODEL=gemini-2.5-flash        # 任意（未設定なら GEMINI_MODEL）
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
├── static/                  # フロントエンド（GitHub Pages / 静的ホスティングの公開対象）
│   ├── index.html
│   ├── app.js               # Firebase(Auth/Firestore/Storage) + PaddleOCR 連携
│   ├── parser.js            # OCRテキスト → 家計簿項目の抽出（ブラウザ用）
│   ├── style.css
│   └── firebase-config.js   # ← あなたの Firebase 設定に置き換える
├── .github/workflows/
│   └── deploy-pages.yml      # GitHub Pages 自動デプロイ
├── firebase.json            # Hosting / ルールの設定
├── firestore.rules          # Firestore セキュリティルール
├── .firebaserc              # ← プロジェクトID を設定
│
├── main.py                  # (任意) 高精度OCR用 FastAPI サービス
├── app/
│   ├── ocr.py               # OCR層（前処理 + エンジン切り替え）
│   ├── gemini.py            # Gemini で画像→構造化抽出（高精度）
│   ├── vision.py            # 保険: Gemini失敗時の Google Vision API フォールバック
│   └── parser.py            # OCRテキスト抽出（parser.js と同等のロジック）
├── Dockerfile               # (任意) OCRサービスのコンテナ
└── requirements.txt
```

## 精度についての注意

OCR は完璧ではありません（特に感熱紙レシートや薄い印字）。本アプリは
「OCR で下書き → 人が確認・修正して保存」という前提で設計しています。
合計金額が明細より小さく誤読された場合などは自動で補正を試みますが、
保存前に必ず内容をご確認ください。
