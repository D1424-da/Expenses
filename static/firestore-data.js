// Firestore データアクセス層: 支出コレクションの CRUD・購読。
import {
  collection, addDoc, query, where, orderBy,
  onSnapshot, getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { db } from "./firebase-init.js";
import { state } from "./app-state.js";
import { dbBase } from "./db-paths.js";
import { monthKey } from "./dom-utils.js";
import { log, logErr } from "./log.js";

export function expensesCol() {
  return collection(db, ...dbBase(), "expenses");
}

export async function fetchAllExpenses() {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 2);
  const q = query(expensesCol(), where("date", ">=", cutoff.toISOString().slice(0, 10)));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

export async function fetchAllExpensesUnlimited() {
  const snap = await getDocs(expensesCol());
  return snap.docs.map((d) => d.data());
}

export async function fetchMonthExpenses(month) {
  const start = monthKey(month) + "-01";
  const next  = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const end   = monthKey(next) + "-01";
  const q = query(
    expensesCol(),
    where("date", ">=", start),
    where("date", "<",  end),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

/**
 * 現在月の支出を Firestore でリアルタイム購読する。
 * @param {Function} onUpdate - (expenses) => void
 */
export function subscribeMonth(onUpdate) {
  if (state.unsubscribe) state.unsubscribe();
  const month = state.currentMonth;
  const start = monthKey(month) + "-01";
  const next  = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const end   = monthKey(next) + "-01";
  const q = query(
    expensesCol(),
    where("date", ">=", start),
    where("date", "<",  end),
    orderBy("date", "desc"),
  );
  log("Firestore購読開始:", monthKey(month), "uid:", state.currentUser.uid);
  state.unsubscribe = onSnapshot(
    q,
    (snap) => {
      state.currentExpenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      log("Firestore更新:", state.currentExpenses.length, "件");
      onUpdate(state.currentExpenses);
    },
    (err) => {
      logErr("Firestore購読エラー:", err.code, err.message, err);
      const s = document.getElementById("ocr-status");
      s.hidden = false;
      s.className = "status error";
      s.textContent = "データ取得に失敗しました（Firebaseの設定/ルールを確認してください）: " + err.message;
    },
  );
}

/** カレンダーから直接1件追加する。 */
export async function addCalendarExpense({ date, store, amount, category }) {
  await addDoc(expensesCol(), {
    date, store, branch: "", amount, category,
    memo: "", items: [], rawText: "", ocrEngine: "manual",
    createdAt: serverTimestamp(),
  });
  log("カレンダーから追加:", date, amount);
  if (state.allExpensesCache) {
    state.allExpensesCache.push({ date, store, branch: "", amount, category, memo: "", items: [], ocrEngine: "manual" });
  }
}
