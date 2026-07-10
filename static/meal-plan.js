// 週間献立プラン — Firestore に1日ずつ保存・リアルタイム購読。
import {
  collection, doc, setDoc, deleteDoc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { logErr } from "./log.js";

let _db, _getUser;
let _unsub = null;

export function initMealPlan({ db, getUser }) {
  _db = db;
  _getUser = getUser;
}

// ログイン後に呼ぶ。onUpdate(map: {date → {朝食,昼食,夕食}}) を毎回呼び出す。
export function startMealPlanSync(onUpdate) {
  if (_unsub) return;
  const user = _getUser();
  if (!user) return;
  _unsub = onSnapshot(
    collection(_db, "users", user.uid, "mealPlans"),
    (snap) => {
      const map = {};
      snap.forEach((d) => { map[d.id] = d.data(); });
      onUpdate(map);
    },
    (err) => logErr("献立購読エラー:", err.message),
  );
}

export function stopMealPlanSync() {
  if (_unsub) { _unsub(); _unsub = null; }
}

// meals: { 朝食: string, 昼食: string, 夕食: string }
export async function saveMealPlan(date, meals) {
  const user = _getUser();
  if (!user) return;
  await setDoc(
    doc(_db, "users", user.uid, "mealPlans", date),
    { ...meals, date, savedAt: new Date().toISOString() },
  );
}

export async function deleteMealPlan(date) {
  const user = _getUser();
  if (!user) return;
  await deleteDoc(doc(_db, "users", user.uid, "mealPlans", date));
}
