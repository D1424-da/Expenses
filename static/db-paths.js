// Firestore パス解決ユーティリティ。
// 個人モード（デフォルト）と世帯共有モードを一か所で切り替える。
//
// 使い方:
//   import { dbBase, dbSetUser, dbSetHousehold } from "./db-paths.js";
//   collection(db, ...dbBase(), "expenses")  →  users/{uid}/expenses  or  households/{hid}/expenses

let _uid = null;
let _hid = null;

export function dbSetUser(uid)       { _uid = uid; }
export function dbSetHousehold(hid)  { _hid = hid; }
export function dbClearHousehold()   { _hid = null; }
export function dbGetHousehold()     { return _hid; }

// Firestore コレクションパスの先頭セグメントを返す（スプレッドして使う）
// 個人: ["users", uid] / 世帯: ["households", hid]
export function dbBase() {
  return _hid ? ["households", _hid] : ["users", _uid];
}
