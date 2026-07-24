// デバッグログ — 本番では false にしてユーザー情報の露出を防ぐ。
export const DEBUG = false;

export const log = (...a) =>
  DEBUG && console.log("%c[家計簿]", "color:#2f855a;font-weight:bold", ...a);

export const logErr = (...a) => DEBUG && console.error("[家計簿]", ...a);
