// 支出データの上限チェック（純粋関数）。
//
// firestore.rules の validExpense() と同じ制約をクライアント側でも持つ。
// ここで弾かないと Firestore に拒否され、ユーザーには原因のわからない
// "Missing or insufficient permissions" とだけ表示されてしまう。
// ルールを変更したら必ずこちらの LIMITS も合わせること。

export const LIMITS = {
  store:   100,
  branch:  100,
  memo:    500,
  items:    80,
  rawText: 20000,
  amount:  100000000, // 未満（1億円）
};

/**
 * 保存前に payload を検証し、通せるものは切り詰めて整える。
 *
 * - 店名・支店名・メモ: 超過分を切り捨てる（識別性は保たれるため保存を優先）
 * - 明細・金額: 切り捨てるとデータの意味が壊れるのでエラーにする
 *
 * @param {object} payload - 破壊的に変更される
 * @returns {string|null} エラーメッセージ。問題なければ null
 */
export function validateExpense(payload) {
  const amount = payload.amount;
  if (typeof amount !== "number" || Number.isNaN(amount) || amount < 0) {
    return "金額を正しく入力してください。";
  }
  if (amount >= LIMITS.amount) {
    return `金額が大きすぎます（${LIMITS.amount.toLocaleString()}円未満で入力してください）。`;
  }

  const items = payload.items ?? [];
  if (items.length > LIMITS.items) {
    return `明細が${items.length}件あります。1件のレシートに保存できる明細は${LIMITS.items}件までです。`
      + `不要な明細を削除するか、レシートを分けて登録してください。`;
  }

  // 表示用の文字列は切り詰めて保存を通す（OCRの誤認識で極端に長くなる場合がある）
  if (typeof payload.store  === "string") payload.store  = payload.store.slice(0, LIMITS.store);
  if (typeof payload.branch === "string") payload.branch = payload.branch.slice(0, LIMITS.branch);
  if (typeof payload.memo   === "string") payload.memo   = payload.memo.slice(0, LIMITS.memo);

  return null;
}

/** OCR生テキストを保存上限に収める（内部データなので黙って切り詰めてよい）。 */
export function clampRawText(rawText) {
  return typeof rawText === "string" ? rawText.slice(0, LIMITS.rawText) : "";
}
