// デバッグログ — 問題の切り分け用。安定したら DEBUG = false にする。
export const DEBUG = true;

export const log = (...a) =>
  DEBUG && console.log("%c[家計簿]", "color:#2f855a;font-weight:bold", ...a);

export const logErr = (...a) => DEBUG && console.error("[家計簿]", ...a);
