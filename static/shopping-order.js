// 買い物リストの並び替え。DOM も Firestore も触らない純粋関数。
//
// shopping-list.js は Firebase を CDN から import しておりテストから
// 読み込めないため、判定をここに分ける（recipe-parse.js と同じ方針）。
//
// ## 誤タップ対策として「すぐには動かさない」
//
// チェックした品目を即座に下へ送ると、**押し間違えたときに何が動いたのか
// 分からなくなる**。店頭で片手で操作する画面なので、隣を押す事故は起きる。
// チェック直後のしばらくは元の位置に留め、それから移動させる。
//
// その「留めている品目」を pending として受け取り、並びの上では
// **チェック前の状態**として扱う（表示上のチェックは入ったままにする）。

/** チェック直後に元の位置へ留めておく時間（ミリ秒）。 */
export const MOVE_DELAY_MS = 2000;

/**
 * 並び替えの上で「完了扱い」かどうか。
 * pending にある品目は、チェック前の状態で位置を決める。
 */
export function effectiveDone(item, pending) {
  const p = pending?.get?.(item.id);
  return p ? Boolean(p.prevDone) : Boolean(item.done);
}

/**
 * 未完了・完了済みに分け、未完了は店舗ごとにまとめる。
 *
 * @param {Array<{id: string, name: string, store?: string, done?: boolean}>} items
 * @param {Map<string, {prevDone: boolean}>} [pending] 移動を待たせている品目
 * @returns {{
 *   pendingItems: Array<{store: string, items: object[]}>, // 未完了（店舗別）
 *   doneItems: object[],                                    // 完了済み
 *   remaining: number,
 *   doneCount: number,
 * }}
 */
export function splitShoppingItems(items, pending) {
  // 件数も並びも同じ集合から数える。ここで弾いた壊れたデータが
  // 件数にだけ残ると、「残り3点」なのに2件しか並ばない状態になる。
  const list = (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it.id === "string");
  const notDone = [];
  const done    = [];
  for (const it of list) {
    (effectiveDone(it, pending) ? done : notDone).push(it);
  }

  // 未完了は店舗ごとにまとめる。店舗なしは最後。
  const groups = new Map();
  for (const it of notDone) {
    const key = it.store || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const storeKeys = [...groups.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b, "ja");
  });

  return {
    pendingItems: storeKeys.map((store) => ({ store, items: groups.get(store) })),
    doneItems: done,
    // 件数は「実際にチェックが入っているか」で数える。位置は留めていても、
    // 残り点数はすぐ減らさないと操作した手応えが無い。
    remaining: list.filter((it) => !it.done).length,
    doneCount: list.filter((it) => it.done).length,
  };
}

/** ヘッダーに出す文言。0点のときは触れない。 */
export function summaryLabel(remaining, doneCount) {
  const parts = [`残り${remaining}点`];
  if (doneCount > 0) parts.push(`${doneCount}点カゴに入れた`);
  return parts.join(" · ");
}
