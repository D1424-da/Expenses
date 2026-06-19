export const firebaseConfig = {
  apiKey: "AIzaSyCJanik_5LtvXqDCVahBSPgF4vpWvlf72o",
  authDomain: "expenses-9af61.firebaseapp.com",
  projectId: "expenses-9af61",
  storageBucket: "expenses-9af61.firebasestorage.app",
  messagingSenderId: "277005147489",
  appId: "1:277005147499:web:f605c0e9b3d669a795b920",
};

// 高精度OCR(Gemini)を使う場合は、デプロイした OCR バックエンドの URL を設定する。
// 例: "https://receipt-ocr-xxxx.a.run.app"
// 空文字のままならブラウザ内 Tesseract OCR を使う（キー不要）。
// ※ Gemini の API キーはバックエンドの環境変数 GEMINI_API_KEY に保持する。
//    フロント（この公開ファイル）に書くと Google に漏洩キーとして無効化される。
export const OCR_API_BASE = "https://expenses-ft54.onrender.com";

export const CATEGORIES = [
  "食費", "日用品", "外食", "交通費", "医療費",
  "娯楽", "衣服", "光熱費", "通信費", "その他",
];