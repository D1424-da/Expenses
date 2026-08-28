// 買い物リストの並び替え。
//
// 店頭で片手で使う画面なので、押し間違いは起きる前提で組む。
// チェック直後に即座へ動かすと、何が動いたのか分からなくなる。
import { describe, it, expect } from "vitest";
import {
  splitShoppingItems, effectiveDone, summaryLabel,
} from "./shopping-order.js";

const it_ = (id, name, done = false, store = "") => ({ id, name, done, store });

describe("splitShoppingItems", () => {
  it("未完了と完了済みに分ける", () => {
    const r = splitShoppingItems([
      it_("1", "牛乳"), it_("2", "卵", true), it_("3", "パン"),
    ]);
    expect(r.pendingItems[0].items.map((x) => x.name)).toEqual(["牛乳", "パン"]);
    expect(r.doneItems.map((x) => x.name)).toEqual(["卵"]);
  });

  it("未完了を店舗ごとにまとめ、店舗なしを最後に置く", () => {
    const r = splitShoppingItems([
      it_("1", "牛乳", false, ""),
      it_("2", "卵", false, "スーパーA"),
      it_("3", "パン", false, "ベーカリー"),
    ]);
    expect(r.pendingItems.map((g) => g.store)).toEqual(["スーパーA", "ベーカリー", ""]);
  });

  it("チェック直後の品目は元の位置に留まる", () => {
    // 押し間違いに気づけるようにするための猶予。
    const pending = new Map([["2", { prevDone: false }]]);
    const r = splitShoppingItems(
      [it_("1", "牛乳"), it_("2", "卵", true), it_("3", "パン")],
      pending,
    );
    expect(r.pendingItems[0].items.map((x) => x.name)).toEqual(["牛乳", "卵", "パン"]);
    expect(r.doneItems).toEqual([]);
  });

  it("チェックを外した直後の品目も元の位置に留まる", () => {
    const pending = new Map([["2", { prevDone: true }]]);
    const r = splitShoppingItems(
      [it_("1", "牛乳"), it_("2", "卵", false)],
      pending,
    );
    expect(r.pendingItems[0].items.map((x) => x.name)).toEqual(["牛乳"]);
    expect(r.doneItems.map((x) => x.name)).toEqual(["卵"]);
  });

  it("残り点数は位置を留めていても即座に減る", () => {
    // 位置は動かさないが、点数まで据え置くと操作した手応えが無い。
    const pending = new Map([["2", { prevDone: false }]]);
    const r = splitShoppingItems(
      [it_("1", "牛乳"), it_("2", "卵", true)],
      pending,
    );
    expect(r.remaining).toBe(1);
    expect(r.doneCount).toBe(1);
  });

  it("壊れたデータを飛ばす", () => {
    const r = splitShoppingItems([null, {}, { id: 1 }, it_("1", "牛乳")]);
    expect(r.pendingItems[0].items).toHaveLength(1);
    expect(r.remaining).toBe(1);
  });

  it("空でも例外にならない", () => {
    const r = splitShoppingItems([]);
    expect(r.pendingItems).toEqual([]);
    expect(r.doneItems).toEqual([]);
    expect(r.remaining).toBe(0);
  });

  it("items が配列でなくても落ちない", () => {
    expect(splitShoppingItems(undefined).remaining).toBe(0);
    expect(splitShoppingItems(null).remaining).toBe(0);
  });
});

describe("effectiveDone", () => {
  it("pending が無ければ done をそのまま使う", () => {
    expect(effectiveDone(it_("1", "x", true))).toBe(true);
    expect(effectiveDone(it_("1", "x", false), new Map())).toBe(false);
  });
});

describe("summaryLabel", () => {
  it("完了が0点なら残りだけ出す", () => {
    expect(summaryLabel(5, 0)).toBe("残り5点");
  });

  it("完了があれば併記する", () => {
    expect(summaryLabel(5, 3)).toBe("残り5点 · 3点カゴに入れた");
  });
});
