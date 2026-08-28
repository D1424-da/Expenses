// レシピ提案ウィザードの段階管理。DOM も Firestore も触らない純粋関数。
//
// recipe-view.js は Firebase を CDN から import しておりテストから読み込めない
// ため、判定をここに分ける（recipe-parse.js と同じ方針）。
//
// ## なぜ3画面に分けるか
//
// 提案モーダルは「食材の選び方・期間・食材チップ・種類・開始日・人数・
// こだわり設定・提案ボタン・結果・保存操作」を**1画面に縦積み**していた。
// スマホでは提案ボタンが折り返しの下に隠れ、結果が出ても上のフォームが
// 残るため、どこまで進んだのかが読み取れなかった。
//
// 「① 何を使う → ② 何を作る → ③ 結果」の3段に分け、いま何段目かと
// 次へ進めるかをここで決める。**進めない理由を必ず文言で返す**こと —
// ボタンを黙って disabled にすると、利用者は何が足りないのか分からない。

/**
 * 画面の順序。結果は「提案したあとの画面」なので進捗の分母には数えない
 * （STEP 1〜3 のあとに結果が出る、という見え方にする）。
 */
export const RECIPE_STEPS = ["mode", "ingredients", "options", "result"];

/** 進捗表示の分母。結果画面を除いた入力の段数。 */
export const INPUT_STEPS = RECIPE_STEPS.length - 1;

const _META = {
  mode:        { title: "レシピを提案",     nextLabel: "次へ →" },
  ingredients: { title: "いつの食材を使う？", nextLabel: "次へ →" },
  options:     { title: "何を作る？",       nextLabel: "レシピを提案する" },
  result:      { title: "提案結果",         nextLabel: null },
};

/** 段階の位置（0始まり）。未知の値は 0 として扱う。 */
export function stepIndex(step) {
  const i = RECIPE_STEPS.indexOf(step);
  return i < 0 ? 0 : i;
}

/**
 * 見出し・進捗表示・ボタン文言。
 * @returns {{title: string, nextLabel: string|null, progress: string,
 *            canBack: boolean, index: number}}
 */
export function stepMeta(step) {
  const index = stepIndex(step);
  const key   = RECIPE_STEPS[index];
  const isResult = key === "result";
  return {
    title: _META[key].title,
    nextLabel: _META[key].nextLabel,
    // 結果画面には進捗を出さない（入力の段数に含まれないため）。
    progress: isResult ? null : `STEP ${index + 1} / ${INPUT_STEPS}`,
    canBack: index > 0,
    index,
    isResult,
  };
}

/**
 * 次へ進めるか。進めないときは理由を返す。
 *
 * @param {string} step
 * @param {{budgetMode?: boolean, ingredientCount?: number,
 *          budgetSelectedCount?: number, servings?: number|string,
 *          planRangeError?: string, busy?: boolean}} state
 * @returns {{ok: boolean, reason: string|null}}
 */
export function canAdvance(step, state) {
  const s = state || {};
  if (s.busy) return { ok: false, reason: "提案中です。しばらくお待ちください。" };

  const key = RECIPE_STEPS[stepIndex(step)];
  // 食材の選び方はどちらかが必ず選ばれている（既定は購入履歴）。
  if (key === "mode") return { ok: true, reason: null };
  if (key === "ingredients") {
    if (s.budgetMode) {
      return Number(s.budgetSelectedCount) > 0
        ? { ok: true, reason: null }
        : { ok: false, reason: "買う食材を1つ以上選んでください。" };
    }
    if (Number(s.ingredientCount) === 0) {
      return { ok: false, reason: "この期間に品目がありません。期間を変えるか、レシートに明細を追加してください。" };
    }
    // チップは1つずつ外せる。全部外すと何を材料にすればよいか決まらない。
    return Number(s.selectedCount) > 0
      ? { ok: true, reason: null }
      : { ok: false, reason: "使う食材を1つ以上選んでください。" };
  }
  if (key === "options") {
    if (s.planRangeError) return { ok: false, reason: s.planRangeError };
    const n = Number(s.servings);
    if (!Number.isFinite(n) || n < 1 || n > 20) {
      return { ok: false, reason: "人数は1〜20の間で入力してください。" };
    }
    return { ok: true, reason: null };
  }
  // 結果画面から先は無い。
  return { ok: false, reason: null };
}

/** 次／前の段階名。端では現在値を返す（範囲外に出さない）。 */
export function nextStep(step) {
  return RECIPE_STEPS[Math.min(RECIPE_STEPS.length - 1, stepIndex(step) + 1)];
}
export function prevStep(step) {
  return RECIPE_STEPS[Math.max(0, stepIndex(step) - 1)];
}
