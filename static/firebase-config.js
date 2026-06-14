// Firebase の設定（あなたのプロジェクトの値に置き換えてください）
//
// 取得方法:
//   Firebase コンソール → プロジェクトの設定 → 「マイアプリ」→ ウェブアプリ
//   を追加すると firebaseConfig が表示されるので、その内容を貼り付けます。
//
// これらの値はクライアントに公開されても問題ない公開鍵です（API キーは
// 識別子であり、データ保護は firestore.rules / storage.rules で行います）。

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

// OCR バックエンド(FastAPI)のベースURL。
//   - ローカル開発で同一オリジンから配信する場合は "" のままでOK。
//   - Firebase Hosting にデプロイした場合は、Cloud Run などにデプロイした
//     OCR サービスの URL を指定する（例: "https://ocr-xxxxx.a.run.app"）。
export const OCR_API_BASE = "";

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
