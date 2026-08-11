// デバッグログ — 本番では false にしてユーザー情報の露出を防ぐ。
// （log() は保存内容などを含むため DEBUG 時のみ）
export const DEBUG = false;

export const log = (...a) =>
  DEBUG && console.log("%c[家計簿]", "color:#2f855a;font-weight:bold", ...a);

// エラーは DEBUG に関わらず常に出す。これを止めると不具合の報告を受けても
// ブラウザのコンソールに何も残らず、原因が追えなくなる。
export const logErr = (...a) => console.error("[家計簿]", ...a);
