// AI（Gemini / Vertex）が返す Markdown を解釈する純粋関数。
//
// なぜ独立したモジュールなのか:
//   1. これらはプロンプトやモデルを変えると出力書式が微妙に変わり、
//      **静かに壊れる**タイプのコード。recipe-view.js の中に private 関数として
//      置いていたときはテストを書くことすらできなかった。
//   2. saved-recipes.js と calendar-view.js が window.__recipeHelpers__ という
//      グローバル経由でこれらを呼んでいた。initRecipe() が未実行だと
//      undefined になり、レシピが整形されず生の Markdown が出る——という
//      沈黙する劣化が起きる作りだった。import で解決できるようにする。
//
// DOM に触れないこと。日付や期間などの外部状態は引数で受け取る。
import { escapeHtml, dayKey } from "./dom-utils.js";

export const MEAL_SLOTS = ["朝食", "昼食", "夕食"];
export const DAY_ORDER = ["月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日", "日曜日"];

/**
 * レシピ Markdown を表示用 HTML に変換する。
 *
 * AI の出力は信用できないので、**行を escapeHtml してから**書式を解釈する。
 * 順序が逆だと `<img onerror=...>` のような入力がそのまま DOM に入る。
 * `**強調**` が生き残るのは `*` がエスケープ対象外だから。
 */
export function markdownToHtml(md) {
  const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const lines = String(md ?? "").split("\n");
  const out = [];
  let listTag = ""; // 現在開いているリストタグ ("ol"|"ul"|"")

  const closeList = () => { if (listTag) { out.push(`</${listTag}>`); listTag = ""; } };

  for (const raw of lines) {
    const line = escapeHtml(raw);
    let m;
    if ((m = line.match(/^## (.+)$/))) {
      closeList();
      out.push(`<h3>${bold(m[1])}</h3>`);
    } else if ((m = line.match(/^### (.+)$/))) {
      closeList();
      out.push(`<h4>${bold(m[1])}</h4>`);
    } else if ((m = line.match(/^(\d+)\. (.+)$/))) {
      if (listTag !== "ol") { closeList(); out.push("<ol>"); listTag = "ol"; }
      out.push(`<li>${bold(m[2])}</li>`);
    } else if ((m = line.match(/^- (.+)$/))) {
      if (listTag !== "ul") { closeList(); out.push("<ul>"); listTag = "ul"; }
      out.push(`<li>${bold(m[1])}</li>`);
    } else if ((m = line.match(/^\*\*難易度\*\*[：:]\s*(.+)$/))) {
      // ★の数で色を変える
      closeList();
      const stars = m[1].trim();
      const level = (stars.match(/★/g) || []).length;
      const cls = level === 1 ? "diff-easy" : level === 2 ? "diff-mid" : "diff-hard";
      out.push(`<div class="recipe-difficulty"><span class="diff-badge ${cls}">${stars}</span> 難易度</div>`);
    } else if (line.trim()) {
      closeList();
      out.push(`<p>${bold(line)}</p>`);
    } else {
      closeList();
    }
  }
  closeList();
  return out.join("\n");
}

/** Markdown から最初の ## 見出しをタイトルとして取り出す。無ければ "レシピ"。 */
export function extractTitle(md) {
  const m = String(md ?? "").match(/^##\s+(.+)$/m);
  return m ? m[1].replace(/\*\*/g, "").trim() : "レシピ";
}

/**
 * 「**使う食材**:」行から食材名を抽出する（「玉ねぎ 1個」→「玉ねぎ」）。
 *
 * 買い物リストに入れるため、分量表記は落として名前だけにする。
 * 重複は除く（複数の料理で同じ食材を使うことが多い）。
 */
export function extractIngredients(md) {
  const items = [];
  const rx = /\*\*使う食材\*\*[：:]\s*([^\n]+)/g;
  let m;
  while ((m = rx.exec(String(md ?? ""))) !== null) {
    m[1].split(/[、，,]/).forEach((raw) => {
      const name = raw
        .replace(/\s*[\d一二三四五六七八九十百]+\s*[gGkKmlg個本枚杯食片束パック袋缶大小さじtsp]+[程度くらい以上以下]*\s*/g, "")
        .replace(/\*\*/g, "")
        .trim();
      if (name.length >= 1) items.push(name);
    });
  }
  return [...new Set(items)];
}

/**
 * 料理ごとに Markdown を切り分ける。
 *
 * 週間献立（rtype==="weekly"）は "## 月曜日" が日付の見出しなので、
 * 料理の見出しは1段下がって "###" になる。それ以外は "##" が料理名。
 */
export function extractDishes(md, rtype) {
  const headingRe = rtype === "weekly" ? /^### (.+)$/gm : /^## (.+)$/gm;
  const text = String(md ?? "");
  const dishes = [];
  let match;
  while ((match = headingRe.exec(text)) !== null) {
    const title = match[1].replace(/\*\*/g, "").trim();
    dishes.push({ title, start: match.index });
  }
  // 各料理の本文は「次の見出しの直前まで」
  return dishes.map((d, i) => {
    const end = i + 1 < dishes.length ? dishes[i + 1].start : text.length;
    return { title: d.title, markdown: text.slice(d.start, end).trim() };
  });
}

/**
 * 3択提案の Markdown を { 朝食: [{title, markdown}], ... } に変換する。
 *
 * "## 朝食" のように MEAL_SLOTS の語を含む見出しで区切り、
 * その中の "### ①〜" を選択肢として拾う。
 */
export function parseSelectResult(md) {
  const result = {};
  const sections = String(md ?? "").split(/^## /m).slice(1);
  for (const section of sections) {
    const nl = section.indexOf("\n");
    if (nl === -1) continue;
    const heading = section.slice(0, nl).trim();
    const mealTime = MEAL_SLOTS.find((m) => heading.includes(m));
    if (!mealTime) continue;
    const body = section.slice(nl);
    const options = body.split(/^### /m).slice(1).map((opt) => {
      const onl = opt.indexOf("\n");
      const rawTitle = onl === -1 ? opt.trim() : opt.slice(0, onl).trim();
      // ① ② ③ などの番号プレフィックスを除去
      const title = rawTitle.replace(/^[①②③④⑤\d][.．\s]*/, "").trim();
      return { title, markdown: opt.trim() };
    }).filter((o) => o.title);
    if (options.length) result[mealTime] = options;
  }
  return result;
}

/**
 * 週間献立 Markdown を {date, 朝食, お弁当, 夕食, 夕食レシピ}[] に変換する。
 *
 * "## 月曜日" セクションごとに3食を抽出し、planStart を起点に日付を割り当てる
 * （月曜日=+0日, 火曜日=+1日 … 日曜日=+6日）。
 *
 * @param {string} md
 * @param {object} opts
 * @param {Date}   opts.planStart  献立の開始日
 * @param {number} [opts.maxOffset=6] 開始日からの最大オフセット（日数-1）。
 *   終了日を指定した場合に、範囲外の曜日を捨てるために使う。
 */
export function extractWeeklyMeals(md, { planStart, maxOffset = 6 } = {}) {
  if (!(planStart instanceof Date) || Number.isNaN(planStart.getTime())) return [];
  const results = [];

  const sections = String(md ?? "").split(/^## /m).slice(1);
  for (const section of sections) {
    const headingEnd = section.indexOf("\n");
    if (headingEnd === -1) continue;
    const dayName = section.slice(0, headingEnd).trim();
    const dayIdx = DAY_ORDER.indexOf(dayName);
    if (dayIdx === -1 || dayIdx > maxOffset) continue;

    const date = new Date(planStart);
    date.setDate(planStart.getDate() + dayIdx);

    const body = section.slice(headingEnd);
    const breakfastM = body.match(/- \*\*朝食\*\*[：:]\s*(.+)/);
    const lunchM     = body.match(/- \*\*昼食\*\*[：:]\s*(.+)/);
    const dinnerM    = body.match(/^### 夕食[：:]\s*(.+)$/m);
    // 夕食セクション全体（### 夕食: から末尾まで）をレシピとして保存
    const dinnerSectionM = body.match(/### 夕食[：:][\s\S]*/);

    results.push({
      date: dayKey(date),
      朝食:   breakfastM ? breakfastM[1].trim() : "",
      お弁当: lunchM     ? lunchM[1].trim()     : "",
      夕食:   dinnerM    ? dinnerM[1].trim()    : "",
      夕食レシピ: dinnerSectionM ? dinnerSectionM[0].trim() : "",
    });
  }
  return results;
}

/**
 * 献立の終了日から maxOffset（開始日からの日数-1）を求める。
 *
 * 呼び出し側が DOM から読んだ文字列をそのまま渡せるよう、
 * 日付計算だけをここに切り出してテストできるようにしている。
 */
export function maxOffsetFromRange(planStart, planEndStr) {
  if (!planEndStr) return 6;
  const end = new Date(planEndStr);
  if (Number.isNaN(end.getTime())) return 6;
  return Math.max(0, Math.round((end - planStart) / 86400000));
}
