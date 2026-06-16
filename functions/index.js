const functions = require("firebase-functions/v1");
const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

exports.ocrReceipt = functions
  .region("asia-northeast1")
  .runWith({ memory: "1GB", timeoutSeconds: 120 })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "ログインが必要です。");
    }
    const imageBase64 = data && data.imageBase64;
    if (!imageBase64) {
      throw new functions.https.HttpsError("invalid-argument", "画像データがありません。");
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
      throw new functions.https.HttpsError("internal", "AI読み取りに失敗しました: " + err.message);
    }

    let structured = null;
    try {
      const clean = textOut.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      structured = JSON.parse(clean);
    } catch (e) {
      console.error("JSON parse failed. raw=", textOut);
    }

    return { structured, text: textOut };
  });
