// アプリ全体で共有するミュータブル状態。
// オブジェクト参照を共有することで、どのモジュールからでも最新値を参照できる。
export const state = {
  currentUser:       null,
  currentMonth:      new Date(),
  currentExpenses:   [],
  unsubscribe:       null,
  allExpensesCache:  null,
};
