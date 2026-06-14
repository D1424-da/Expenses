# 🧾 レシート家計簿 (Receipt Expense Tracker)

レシートを写真で撮影し、OCR で日付・店名・金額・品目を自動で読み取って記録できる
家計簿 Web アプリです。データは **Firebase** に保存されるため、同じ Google
アカウントでログインすればスマホ・PC など**どの端末からでも同じ家計簿**を確認・
編集できます。

OCR は**ブラウザ内（Tesseract.js）で実行**するため**サーバー不要**で、
GitHub Pages などの静的ホスティングだけで公開できます。

## アーキテクチャ

```
GitHub Pages (静的ホスティング)          Firebase
┌────────────────────────┐           ┌──────────────────┐
│ 画面 + Tesseract.js       │ ───────▶  │ Authentication    │
│ （ブラウザ内でOCR + 抽出）  │  読み書き  │ Firestore(データ)  │
│                         │ ◀───────  │ Cloud Storage(画像) │
└────────────────────────┘           └──────────────────┘
```

- **OCR**: ブラウザ内の Tesseract.js（無料・サーバー不要）。`static/parser.js` で
  日付・店名・金額・品目を抽出。
- **データ・画像・認証・同期**: Firebase（フロントが SDK で直接アクセス）。

> 💡 より高精度・高速にしたい場合は、付属の FastAPI + Tesseract バックエンドを使う
> こともできます（「高精度OCR（任意）」参照）。

## 主な機能

- 🔐 Google ログイン（端末をまたいで同じデータを表示）
- 📷 レシート画像のアップロード / スマホカメラ撮影 → ブラウザ内 OCR 自動読み取り
- ✍️ 読み取り結果（日付・店名・合計・カテゴリ・明細）の確認・修正・手入力
- 🔄 Firestore のリアルタイム同期（別端末での変更が即反映）
- 📊 月ごとの合計とカテゴリ別内訳バー、月切替・カテゴリ絞り込み・編集・削除
- 🖼 レシート画像を Cloud Storage に保存しサムネイル表示

---

## セットアップ

### 1. Firebase プロジェクトを用意

1. [Firebase コンソール](https://console.firebase.google.com/) でプロジェクトを作成
2. **Authentication** → ログイン方法 → **Google** を有効化
3. **Firestore Database** を作成
4. **Storage** を有効化
5. プロジェクトの設定 → 「マイアプリ」→ **ウェブアプリ**を追加し、表示される
   `firebaseConfig` を控える

`static/firebase-config.js` の各値を、控えた `firebaseConfig` に置き換えます。
（`OCR_API_BASE` は空文字のままにすると、ブラウザ内 OCR を使います。）

### 2. セキュリティルールを反映

`firestore.rules` / `storage.rules` は「各ユーザーは自分のデータだけにアクセス可能」
というルールです。Firebase CLI で反映できます。

```bash
npm install -g firebase-tools
firebase login
# .firebaserc の "your-firebase-project-id" を自分のプロジェクトID（全部小文字）に変更
firebase deploy --only firestore:rules,storage
```

### 3. ローカルで試す

OCR がブラウザ内で完結するため、`static/` を静的サーバーで配信するだけで動きます。

```bash
cd static
python3 -m http.server 8000   # → http://localhost:8000
```

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

OCR エンジンは環境変数 `OCR_ENGINE` で切替可能（`tesseract` 既定 / `claude` / `google`）。

---

## Firestore データ構造

```
users/{uid}/expenses/{expenseId}
  date:      "YYYY-MM-DD"
  store:     string
  amount:    number          # 円
  category:  string
  memo:      string
  items:     [{ name, price }]
  imageUrl:  string           # Cloud Storage のダウンロードURL
  rawText:   string           # OCR生テキスト
  createdAt: serverTimestamp
```

## ディレクトリ構成

```
.
├── static/                  # フロントエンド（GitHub Pages / 静的ホスティングの公開対象）
│   ├── index.html
│   ├── app.js               # Firebase(Auth/Firestore/Storage) + Tesseract.js 連携
│   ├── parser.js            # OCRテキスト → 家計簿項目の抽出（ブラウザ用）
│   ├── style.css
│   └── firebase-config.js   # ← あなたの Firebase 設定に置き換える
├── .github/workflows/
│   └── deploy-pages.yml      # GitHub Pages 自動デプロイ
├── firebase.json            # Hosting / ルールの設定
├── firestore.rules          # Firestore セキュリティルール
├── storage.rules            # Storage セキュリティルール
├── .firebaserc              # ← プロジェクトID を設定
│
├── main.py                  # (任意) 高精度OCR用 FastAPI サービス
├── app/
│   ├── ocr.py               # OCR層（前処理 + エンジン切り替え）
│   └── parser.py            # OCRテキスト抽出（parser.js と同等のロジック）
├── Dockerfile               # (任意) OCRサービスのコンテナ
└── requirements.txt
```

## 精度についての注意

OCR は完璧ではありません（特に感熱紙レシートや薄い印字）。本アプリは
「OCR で下書き → 人が確認・修正して保存」という前提で設計しています。
合計金額が明細より小さく誤読された場合などは自動で補正を試みますが、
保存前に必ず内容をご確認ください。
