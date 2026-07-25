// Firestore パス解決ユーティリティ。

let _uid = null;

export function dbSetUser(uid) { _uid = uid; }

export function dbBase() {
  return ["users", _uid];
}
