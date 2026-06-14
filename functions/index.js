// レシート画像を Google Cloud Vision で OCR する Callable 関数。
// 文字抽出だけを行い、項目の抽出（日付・金額など）はフロントの parser.js が担当する。
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const vision = require("@google-cloud/vision");

// 東京リージョン。フロントの getFunctions(app, "asia-northeast1") と合わせる。
setGlobalOptions({ region: "asia-northeast1", maxInstances: 5 });

const client = new vision.ImageAnnotatorClient();

exports.ocrReceipt = onCall(
  { memory: "512MiB", timeoutSeconds: 60 },
  async (request) => {
    // ログイン中のユーザーのみ許可
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const imageBase64 = request.data && request.data.imageBase64;
    if (!imageBase64) {
      throw new HttpsError("invalid-argument", "画像データがありません。");
    }

    const content = Buffer.from(imageBase64, "base64");
    let result;
    try {
      [result] = await client.documentTextDetection({ image: { content } });
    } catch (err) {
      console.error("Vision API error:", err);
      throw new HttpsError("internal", "OCRに失敗しました: " + err.message);
    }

    const text =
      (result.fullTextAnnotation && result.fullTextAnnotation.text) || "";
    return { text };
  }
);
