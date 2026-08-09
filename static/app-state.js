// アプリ全体で共有するミュータブル状態。
// オブジェクト参照を共有することで、どのモジュールからでも最新値を参照できる。
export const state = {
  currentUser:         null,
  currentMonth:        new Date(),
  currentExpenses:     [],
  unsubscribe:         null,
  allExpensesCache:    null,
  allExpensesCacheAt:  0,   // キャッシュ取得時刻 (Date.now())
};

/** allExpensesCache の有効期限（5分）を超えていたら null に戻す */
export function expireAllExpensesCache() {
  if (state.allExpensesCache && Date.now() - state.allExpensesCacheAt > 5 * 60 * 1000) {
    state.allExpensesCache = null;
    state.allExpensesCacheAt = 0;
  }
}
