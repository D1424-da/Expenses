# 🧾 レシート家計簿 (Receipt Expense Tracker)

レシートを写真で撮影し、OCR で日付・店名・金額・品目を自動で読み取って記録できる
家計簿 Web アプリです。データは **Firebase** に保存されるため、同じ Google
アカウントでログインすればスマホ・PC など**どの端末からでも同じ家計簿**を確認・
編集できます。

## アーキテクチャ

```
┌────────────┐   レシート画像     ┌──────────────────────┐
│  ブラウザ   │ ───────────────▶ │ OCRサービス (FastAPI)  │
│ (フロント)  │ ◀─────────────── │  Tesseract で文字抽出  │
└─────┬──────┘   抽出した項目      └──────────────────────┘
      │ 直接読み書き（ログイン中ユーザーのデータのみ）
      ▼
┌──────────────────────────────────────────┐
│ Firebase                                  │
│  ・Authentication … Google ログイン        │
│  ・Firestore       … 支出データ(端末間同期)  │
│  ・Cloud Storage   … レシート画像           │
└──────────────────────────────────────────┘
```

- **データ・画像・同期・認証**: Firebase（フロントが SDK で直接アクセス）
- **OCR**: FastAPI の OCR 専用サービス（無料・オフラインの Tesseract）。データは保存しない。

## 主な機能

- 🔐 Google ログイン（端末をまたいで同じデータを表示）
- 📷 レシート画像のアップロード / スマホカメラ撮影 → OCR 自動読み取り
- ✍️ 読み取り結果（日付・店名・合計・カテゴリ・明細）の確認・修正・手入力
- 🔄 Firestore のリアルタイム同期（別端末での変更が即反映）
- 📊 月ごとの合計とカテゴリ別内訳バー、月切替・カテゴリ絞り込み・編集・削除
- 🖼 レシート画像を Cloud Storage に保存しサムネイル表示

---

## セットアップ

### 1. Firebase プロジェクトを用意

1. [Firebase コンソール](https://console.firebase.google.com/) でプロジェクトを作成
2. **Authentication** → ログイン方法 → **Google** を有効化
3. **Firestore Database** を作成（本番モードでOK。ルールは後述）
4. **Storage** を有効化
5. プロジェクトの設定 → 「マイアプリ」→ **ウェブアプリ**を追加し、表示される
   `firebaseConfig` を控える

`static/firebase-config.js` の各値を、控えた `firebaseConfig` に置き換えます。

### 2. セキュリティルールを反映

本リポジトリの `firestore.rules` / `storage.rules` は「各ユーザーは自分のデータ
だけにアクセス可能」というルールです。Firebase CLI で反映できます。

```bash
npm install -g firebase-tools
firebase login
# .firebaserc の "YOUR_FIREBASE_PROJECT_ID" を自分のプロジェクトIDに置き換え
firebase deploy --only firestore:rules,storage
```

### 3. OCR サービス（FastAPI）を起動

```bash
# Tesseract（OCRエンジン）をインストール
sudo apt-get install -y tesseract-ocr tesseract-ocr-jpn   # Ubuntu/Debian
# brew install tesseract tesseract-lang                    # macOS

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload      # http://localhost:8000
```

ローカルでは FastAPI がフロント（`static/`）も配信するので、
<http://localhost:8000> を開けばそのまま使えます。
（`firebase-config.js` の `OCR_API_BASE` は空文字のままでOK。）

---

## デプロイ（任意：どこからでもアクセスしたい場合）

### フロントエンド → Firebase Hosting

```bash
firebase deploy --only hosting
```

`firebase.json` は公開ディレクトリを `static/` に設定済みです。

### OCR サービス → Cloud Run など

OCR サービスは Tesseract が必要なため、コンテナで動かすのが簡単です
（`Dockerfile` に `apt-get install tesseract-ocr tesseract-ocr-jpn` を含める）。
デプロイ後の URL を `static/firebase-config.js` の `OCR_API_BASE` に設定し、
サーバ側は環境変数 `CORS_ORIGINS` に Hosting の URL を指定してください。

```bash
# 例: OCRサービス側
CORS_ORIGINS="https://YOUR_PROJECT_ID.web.app" uvicorn main:app --host 0.0.0.0 --port 8080
```

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

## OCRエンジンの切り替え（任意）

環境変数 `OCR_ENGINE` でエンジンを変更できます。

| 値 | エンジン | 備考 |
| --- | --- | --- |
| `tesseract`（既定） | Tesseract | 無料・オフライン |
| `claude` | Claude Vision | 高精度。`ANTHROPIC_API_KEY` と `pip install anthropic` が必要 |
| `google` | Google Cloud Vision | 高精度。`GOOGLE_APPLICATION_CREDENTIALS` と `pip install google-cloud-vision` が必要 |

## ディレクトリ構成

```
.
├── main.py              # FastAPI（OCR専用サービス + ローカル用フロント配信）
├── app/
│   ├── ocr.py           # OCR 層（前処理 + エンジン切り替え）
│   └── parser.py        # OCR テキスト → 家計簿項目の抽出
├── static/              # フロントエンド（Firebase Hosting の公開ディレクトリ）
│   ├── index.html
│   ├── app.js           # Firebase(Auth/Firestore/Storage) 連携
│   ├── style.css
│   └── firebase-config.js  # ← あなたの Firebase 設定に置き換える
├── firebase.json        # Hosting / ルールの設定
├── firestore.rules      # Firestore セキュリティルール
├── storage.rules        # Storage セキュリティルール
├── .firebaserc          # ← プロジェクトID を設定
└── requirements.txt
```

## 精度についての注意

OCR は完璧ではありません（特に感熱紙レシートや薄い印字）。本アプリは
「OCR で下書き → 人が確認・修正して保存」という前提で設計しています。
合計金額が明細より小さく誤読された場合などは自動で補正を試みますが、
保存前に必ず内容をご確認ください。
