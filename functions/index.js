// レシート画像を Gemini（Vertex AI）で読み取り、構造化データを返す Callable 関数。
// 画像から直接「店名・日付・合計・カテゴリ・明細」をJSONで抽出する（OCR＋意味理解を一括）。
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { GoogleGenAI } = require("@google/genai");

// 東京リージョン。フロントの getFunctions(app, "asia-northeast1") と合わせる。
setGlobalOptions({ region: "asia-northeast1", maxInstances: 5 });

// Vertex AI 経由（APIキー不要。関数のサービスアカウントで認証）。
const PROJECT_ID =
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  "expenses-9af61"; // 取得できない環境向けの保険
const ai = new GoogleGenAI({
  vertexai: true,
  project: PROJECT_ID,
  location: "global",
});

const PROMPT = `あなたは日本のレシートを読み取るアシスタントです。
画像のレシートを読み取り、次の形式のJSONだけを出力してください（説明文やマークダウンは不要）。

{
  "date": "YYYY-MM-DD",
  "store": "店舗・チェーン名",
  "total": 整数,
  "category": "食費|日用品|外食|交通費|医療費|娯楽|衣服|光熱費|通信費|その他",
  "items": [ { "name": "商品名", "price": 整数 } ]
}

ルール:
- store は店名（チェーン名や屋号）。「毎度ありがとうございます」等の挨拶、住所、電話、登録番号は含めない。
- total は税込の支払い合計（「合計」の金額）。お預り・お釣り・小計・ポイントは total にしない。
- items は購入した商品のみ。税・値引・小計・合計・ポイント・クレジット控え・電話番号などは含めない。
- price と total は数値のみ（カンマや¥や円は付けない）。
- 読み取れない項目は空文字または空配列にする。`;

exports.ocrReceipt = onCall(
  { memory: "1GiB", timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const imageBase64 = request.data && request.data.imageBase64;
    if (!imageBase64) {
      throw new HttpsError("invalid-argument", "画像データがありません。");
    }

    let textOut = "";
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
              { text: PROMPT },
            ],
          },
        ],
        config: { responseMimeType: "application/json", temperature: 0 },
      });
      textOut = response.text || "";
    } catch (err) {
      console.error("Gemini error:", err);
      throw new HttpsError("internal", "AI読み取りに失敗しました: " + err.message);
    }

    // 念のためコードフェンスを除去してJSONをパース
    let structured = null;
    try {
      const clean = textOut.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      structured = JSON.parse(clean);
    } catch (e) {
      console.error("JSON parse failed. raw=", textOut);
    }

    return { structured, text: textOut };
  }
);
