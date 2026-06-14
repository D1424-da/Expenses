# 🧾 レシート家計簿 (Receipt Expense Tracker)

レシートを写真で撮影し、OCR で日付・店名・金額・品目を自動で読み取って記録できる
家計簿 Web アプリです。読み取り結果は保存前に画面で確認・修正できます。

- **バックエンド**: FastAPI + SQLite（追加のDBサーバ不要）
- **OCR**: 既定は無料・オフラインの **Tesseract（日本語）**。画像前処理（OpenCV）で精度を補正。
- **フロント**: 依存ライブラリなしの素の HTML / CSS / JavaScript（スマホのカメラ起動に対応）

## 主な機能

- 📷 レシート画像のアップロード / スマホカメラ撮影 → OCR 自動読み取り
- ✍️ 読み取り結果（日付・店名・合計・カテゴリ・明細）の確認・修正・手入力
- 📊 月ごとの合計とカテゴリ別内訳バー
- 🗂 月の切り替え、カテゴリでの絞り込み、編集・削除
- 🖼 取り込んだレシート画像のサムネイル表示

## セットアップ

### 1. Tesseract（OCRエンジン）をインストール

```bash
# Ubuntu / Debian
sudo apt-get install -y tesseract-ocr tesseract-ocr-jpn

# macOS (Homebrew)
brew install tesseract tesseract-lang
```

### 2. Python 依存パッケージ

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. 起動

```bash
uvicorn main:app --reload
```

ブラウザで <http://localhost:8000> を開きます。
（スマホの実機カメラで使う場合は `--host 0.0.0.0` で起動し、同一ネットワークから
`http://<PCのIP>:8000` にアクセスしてください。）

## OCRエンジンの切り替え（任意）

精度をさらに上げたい場合、環境変数 `OCR_ENGINE` でエンジンを変更できます。

| 値 | エンジン | 備考 |
| --- | --- | --- |
| `tesseract`（既定） | Tesseract | 無料・オフライン |
| `claude` | Claude Vision | 高精度。`ANTHROPIC_API_KEY` と `pip install anthropic` が必要 |
| `google` | Google Cloud Vision | 高精度。`GOOGLE_APPLICATION_CREDENTIALS` と `pip install google-cloud-vision` が必要 |

```bash
OCR_ENGINE=tesseract uvicorn main:app
```

新しいエンジンを追加する場合は `app/ocr.py` に `run_ocr(image_bytes) -> str` 互換の
関数を実装し、`_ENGINES` に登録してください。

## ディレクトリ構成

```
.
├── main.py            # FastAPI エントリポイント（API + フロント配信）
├── app/
│   ├── db.py          # SQLite データアクセス
│   ├── ocr.py         # OCR 層（前処理 + エンジン切り替え）
│   └── parser.py      # OCR テキスト → 家計簿項目の抽出
├── static/            # フロントエンド（HTML / CSS / JS）
├── data/              # SQLite DB と画像（gitignore 済み）
└── requirements.txt
```

## 精度についての注意

OCR は完璧ではありません（特に感熱紙レシートや薄い印字）。本アプリは
「OCR で下書き → 人が確認・修正して保存」という前提で設計しています。
合計金額が明細より小さく誤読された場合などは自動で補正を試みますが、
保存前に必ず内容をご確認ください。
