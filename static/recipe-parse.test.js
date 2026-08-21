// AI 出力パーサの検証。
//
// これらはプロンプトやモデルを変えると出力書式が微妙に変わり、静かに壊れる。
// 「壊れた」と分かるのが利用者の画面（レシピが白紙・献立が反映されない）
// になる前に、CI で気づけるようにする。
//
// recipe-view.js に private 関数として置いていたときは、そもそもテストを
// 書くことができなかった。純粋関数として切り出したのはこのため。
import { describe, it, expect } from "vitest";
import {
  MEAL_SLOTS, DAY_ORDER,
  markdownToHtml, extractTitle, extractIngredients,
  extractDishes, parseSelectResult, extractWeeklyMeals, maxOffsetFromRange,
} from "./recipe-parse.js";

describe("markdownToHtml", () => {
  it("見出し・リスト・強調を変換する", () => {
    const html = markdownToHtml("## 肉じゃが\n- じゃがいも\n- 玉ねぎ\n\n1. 切る\n2. 煮る");
    expect(html).toContain("<h3>肉じゃが</h3>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>じゃがいも</li>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>切る</li>");
  });

  it("**強調** を <strong> にする", () => {
    expect(markdownToHtml("**大事**な工程")).toContain("<strong>大事</strong>");
  });

  it("リストの種類が変わったら閉じてから開き直す", () => {
    const html = markdownToHtml("- あ\n1. い");
    expect(html.indexOf("</ul>")).toBeLessThan(html.indexOf("<ol>"));
  });

  it("難易度行を★の数でクラス分けする", () => {
    expect(markdownToHtml("**難易度**: ★")).toContain("diff-easy");
    expect(markdownToHtml("**難易度**: ★★")).toContain("diff-mid");
    expect(markdownToHtml("**難易度**: ★★★")).toContain("diff-hard");
  });

  // AI の出力は信用できない。書式解釈より先にエスケープすること。
  it("HTML を含む出力をエスケープする（XSS対策）", () => {
    const html = markdownToHtml('## <img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("スクリプトタグを実行可能な形で通さない", () => {
    const html = markdownToHtml("- <script>alert(1)</script>");
    expect(html).not.toContain("<script>");
  });

  it("null / undefined でも落ちない", () => {
    expect(markdownToHtml(null)).toBe("");
    expect(markdownToHtml(undefined)).toBe("");
  });
});

describe("extractTitle", () => {
  it("最初の ## 見出しを取る", () => {
    expect(extractTitle("前置き\n## 肉じゃが\n## カレー")).toBe("肉じゃが");
  });

  it("** を除去する", () => {
    expect(extractTitle("## **肉じゃが**")).toBe("肉じゃが");
  });

  it("見出しが無ければ既定値", () => {
    expect(extractTitle("見出しなし")).toBe("レシピ");
  });
});

describe("extractIngredients", () => {
  it("分量を落として食材名だけにする", () => {
    const names = extractIngredients("**使う食材**: じゃがいも 2個、玉ねぎ 1個、豚肉 200g");
    expect(names).toEqual(["じゃがいも", "玉ねぎ", "豚肉"]);
  });

  it("複数の料理をまたいで集め、重複を除く", () => {
    const md = "**使う食材**: 玉ねぎ 1個\n## 別の料理\n**使う食材**: 玉ねぎ 2個、人参 1本";
    expect(extractIngredients(md)).toEqual(["玉ねぎ", "人参"]);
  });

  it("読点の表記ゆれ（、，,）を吸収する", () => {
    expect(extractIngredients("**使う食材**: 米，卵,塩")).toEqual(["米", "卵", "塩"]);
  });

  it("該当行が無ければ空配列", () => {
    expect(extractIngredients("## 肉じゃが\n手順だけ")).toEqual([]);
  });
});

describe("extractDishes", () => {
  it("## 見出しごとに本文を切り分ける", () => {
    const dishes = extractDishes("## 肉じゃが\n本文A\n## カレー\n本文B", "meal");
    expect(dishes.map((d) => d.title)).toEqual(["肉じゃが", "カレー"]);
    expect(dishes[0].markdown).toContain("本文A");
    expect(dishes[0].markdown).not.toContain("本文B");
  });

  // 週間献立は ## が曜日なので、料理は1段下がって ### になる
  it("weekly では ### を料理の見出しとして扱う", () => {
    const md = "## 月曜日\n### 肉じゃが\n本文";
    expect(extractDishes(md, "weekly").map((d) => d.title)).toEqual(["肉じゃが"]);
    expect(extractDishes(md, "meal").map((d) => d.title)).toEqual(["月曜日"]);
  });

  it("最後の料理は末尾までを本文にする", () => {
    const dishes = extractDishes("## A\n1行目\n2行目", "meal");
    expect(dishes[0].markdown).toContain("2行目");
  });
});

describe("parseSelectResult", () => {
  const md = `## 朝食
### ① トースト
本文1
### ② おにぎり
本文2

## 夕食
### ① カレー
本文3`;

  it("食事帯ごとに選択肢をまとめる", () => {
    const r = parseSelectResult(md);
    expect(Object.keys(r)).toEqual(["朝食", "夕食"]);
    expect(r.朝食.map((o) => o.title)).toEqual(["トースト", "おにぎり"]);
    expect(r.夕食).toHaveLength(1);
  });

  it("①②③ の番号プレフィックスを除去する", () => {
    expect(parseSelectResult("## 朝食\n### ③ パン\n本文").朝食[0].title).toBe("パン");
  });

  it("食事帯に該当しない見出しは無視する", () => {
    expect(parseSelectResult("## おやつ\n### ケーキ\n本文")).toEqual({});
  });

  it("MEAL_SLOTS が3食ぶんある", () => {
    expect(MEAL_SLOTS).toEqual(["朝食", "昼食", "夕食"]);
  });
});

describe("extractWeeklyMeals", () => {
  const md = `## 月曜日
- **朝食**: トースト
- **昼食**: おにぎり
### 夕食: 肉じゃが
**使う食材**: じゃがいも

## 火曜日
- **朝食**: ごはん
### 夕食: カレー`;

  const planStart = new Date("2026-08-24T00:00:00"); // 月曜日

  it("曜日を開始日からのオフセットで日付に割り当てる", () => {
    const meals = extractWeeklyMeals(md, { planStart });
    expect(meals.map((m) => m.date)).toEqual(["2026-08-24", "2026-08-25"]);
  });

  it("3食と夕食レシピ本文を取り出す", () => {
    const [mon] = extractWeeklyMeals(md, { planStart });
    expect(mon.朝食).toBe("トースト");
    expect(mon.お弁当).toBe("おにぎり");
    expect(mon.夕食).toBe("肉じゃが");
    expect(mon.夕食レシピ).toContain("じゃがいも");
  });

  // 終了日を指定したときに範囲外の曜日を捨てるための制限
  it("maxOffset を超える曜日は捨てる", () => {
    const meals = extractWeeklyMeals(md, { planStart, maxOffset: 0 });
    expect(meals.map((m) => m.date)).toEqual(["2026-08-24"]);
  });

  it("欠けている食事は空文字にする", () => {
    const [, tue] = extractWeeklyMeals(md, { planStart });
    expect(tue.お弁当).toBe("");
    expect(tue.夕食).toBe("カレー");
  });

  it("planStart が不正なら空配列（落とさない）", () => {
    expect(extractWeeklyMeals(md, { planStart: new Date("なにこれ") })).toEqual([]);
    expect(extractWeeklyMeals(md, {})).toEqual([]);
  });

  it("DAY_ORDER が月曜始まり", () => {
    expect(DAY_ORDER[0]).toBe("月曜日");
    expect(DAY_ORDER).toHaveLength(7);
  });
});

describe("maxOffsetFromRange", () => {
  const start = new Date("2026-08-24T00:00:00");

  it("終了日未指定なら6（1週間）", () => {
    expect(maxOffsetFromRange(start, "")).toBe(6);
  });

  it("終了日までの日数-1を返す", () => {
    expect(maxOffsetFromRange(start, "2026-08-26")).toBe(2);
  });

  it("終了日が開始日より前でも負にならない", () => {
    expect(maxOffsetFromRange(start, "2026-08-20")).toBe(0);
  });

  it("解釈できない日付は既定の6に落とす", () => {
    expect(maxOffsetFromRange(start, "なにこれ")).toBe(6);
  });
});
