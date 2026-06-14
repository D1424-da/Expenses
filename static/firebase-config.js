// Firebase の設定（あなたのプロジェクトの値に置き換えてください）
//
// 取得方法:
//   Firebase コンソール → プロジェクトの設定 → 「マイアプリ」→ ウェブアプリ
//   を追加すると firebaseConfig が表示されるので、その内容を貼り付けます。
//
// これらの値はクライアントに公開されても問題ない公開鍵です（API キーは
// 識別子であり、データ保護は firestore.rules / storage.rules で行います）。

export const firebaseConfig = {
  apiKey: "AIzaSyDwEtOmYVP7bjmjnDsKOuAIWWJx6FFV2os",
  authDomain: "expenses-9af61.firebaseapp.com",
  projectId: "expenses-9af61",
  storageBucket: "expenses-9af61.firebasestorage.app",
  messagingSenderId: "277005147489",
  appId: "1:277005147489:web:f605c0e9b3d669a795b920",
};

// OCR の方式。
//   - "" (既定): ブラウザ内で Tesseract.js を使って OCR する（サーバー不要。
//     GitHub Pages などの静的ホスティングだけで動く）。
//   - URL を指定: その FastAPI バックエンド(/api/ocr)を使う。高精度・高速だが
//     サーバーが必要（例: "https://ocr-xxxxx.a.run.app"）。
export const OCR_API_BASE = "";

// 高精度OCR（Google Cloud Vision を Cloud Functions 経由で使う）。
//   true : クラウドOCRを使う（要 Blaze プラン + Vision API 有効化 + functions デプロイ）。
//          失敗時は自動でブラウザ内OCRにフォールバックする。
//   false: ブラウザ内 Tesseract.js のみを使う。
export const USE_CLOUD_VISION = true;

// 家計簿カテゴリ
export const CATEGORIES = [
  "食費",
  "日用品",
  "外食",
  "交通費",
  "医療費",
  "娯楽",
  "衣服",
  "光熱費",
  "通信費",
  "その他",
];
