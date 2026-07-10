// 履歴正規化 — Gemini/Vertex の抽出結果を正解として Vision/PaddleOCR を補正する。
// 過去に保存したデータ（店名・支店・商品名・カテゴリ）を辞書化し、精度の低い
// エンジンの結果があいまい一致したら、その正解表記に揃える。
import { log, logErr } from "./log.js";

// 正解として信頼する高精度AIエンジン。これ以外（vision/tesseract/paddle）は正規化対象。
// "edited" = ユーザーが手動で修正した記録。次回正規化の基準として採用する。
export const TRUSTED_ENGINES = ["gemini", "vertex", "edited"];

// 照合用にゆらぎを吸収したキーへ正規化（全角半角・大小・記号/空白除去）。
function normKey(s) {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s,.。・･\-_/\\()'"`*※&]/g, "")
    .trim();
}

// レーベンシュタイン距離（OCRの誤字に強い類似度の土台）。
// 行バッファを再利用して呼び出しごとの Array アロケーションを排除する。
let _levPrev = [];
let _levCur = [];
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  if (_levPrev.length <= n) { _levPrev = new Array(n + 1); _levCur = new Array(n + 1); }
  for (let i = 0; i <= n; i++) _levPrev[i] = i;
  for (let i = 1; i <= m; i++) {
    _levCur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      _levCur[j] = Math.min(_levPrev[j] + 1, _levCur[j - 1] + 1, _levPrev[j - 1] + cost);
    }
    const tmp = _levPrev; _levPrev = _levCur; _levCur = tmp;
  }
  return _levPrev[n];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

// 辞書（[{key, canonical, category?}]）から最も近い候補を返す（しきい値未満は null）。
function bestMatch(raw, entries, threshold) {
  const k = normKey(raw);
  if (!k || !entries.length) return null;
  // 完全一致は levenshtein なしで確定
  const exact = entries.find((e) => e.key === k);
  if (exact) return { entry: exact, score: 1 };
  let best = null, bestScore = 0;
  for (const e of entries) {
    const maxLen = Math.max(k.length, e.key.length);
    const contained = maxLen > 0 && (e.key.includes(k) || k.includes(e.key));
    // 文字列長の差だけで threshold を下回ることが確実なら levenshtein をスキップ
    if (!contained && maxLen > 0 && Math.abs(k.length - e.key.length) / maxLen > 1 - threshold) continue;
    // どちらかが他方を含む（OCRで一部欠落/混入）場合は高めに評価する。
    const score = contained ? Math.max(0.9, similarity(k, e.key)) : similarity(k, e.key);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best && bestScore >= threshold ? { entry: best, score: bestScore } : null;
}

function bump(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function argmax(map) {
  let top = "", n = -1;
  for (const [k, c] of map) if (c > n) { n = c; top = k; }
  return top;
}

// Gemini/Vertex保存データから作る正解辞書（セッション内キャッシュ）。
let historyDict = null;

// 保存で正解辞書が変わったときに呼び、次回作り直させる。
export function invalidateHistoryDict() {
  historyDict = null;
}

// 全期間の支出（fetchExpenses が返す配列）から正解辞書を構築する。
async function loadHistoryDict(fetchExpenses) {
  if (historyDict) return historyDict;
  const stores = new Map();   // key -> {key, spellings:Map}
  const branches = new Map();
  const products = new Map();  // key -> {key, spellings:Map, cats:Map}
  const storeCat = new Map();  // storeKey -> Map(category->count)

  const add = (map, value) => {
    const k = normKey(value);
    if (!k) return;
    let e = map.get(k);
    if (!e) { e = { key: k, spellings: new Map() }; map.set(k, e); }
    bump(e.spellings, value);
  };

  const expenses = await fetchExpenses();
  for (const e of expenses) {
    // 正解辞書は Gemini/Vertex で抽出したデータのみ採用する。
    // 旧データ（ocrEngine 無し）は主に Gemini 由来なので含める。
    // vision/tesseract/paddle/manual で保存したものは除外（正解にしない）。
    if (e.ocrEngine && !TRUSTED_ENGINES.includes(e.ocrEngine)) continue;
    if (e.store) add(stores, e.store);
    if (e.branch) add(branches, e.branch);
    if (e.store && e.category) {
      const sk = normKey(e.store);
      if (!storeCat.has(sk)) storeCat.set(sk, new Map());
      bump(storeCat.get(sk), e.category);
    }
    (e.items || []).forEach((it) => {
      if (!it || !it.name) return;
      const k = normKey(it.name);
      if (!k) return;
      let p = products.get(k);
      if (!p) { p = { key: k, spellings: new Map(), cats: new Map() }; products.set(k, p); }
      bump(p.spellings, it.name);
      if (it.category) bump(p.cats, it.category);
    });
  }

  const finalize = (map) =>
    [...map.values()].map((e) => ({ key: e.key, canonical: argmax(e.spellings) }));

  historyDict = {
    stores: finalize(stores),
    branches: finalize(branches),
    products: [...products.values()].map((p) => ({
      key: p.key,
      canonical: argmax(p.spellings),
      category: p.cats.size ? argmax(p.cats) : "",
    })),
    storeCat,
  };
  log("正解辞書を構築:", `店${historyDict.stores.length} 支店${historyDict.branches.length} 商品${historyDict.products.length}`);
  return historyDict;
}

// Vision/PaddleOCR の結果を、Gemini 由来の正解辞書で正規化する。
export async function normalizeWithHistory(data, fetchExpenses) {
  try {
    const dict = await loadHistoryDict(fetchExpenses);
    const STORE_TH = 0.6, BRANCH_TH = 0.6, PROD_TH = 0.62;

    const sm = bestMatch(data.store, dict.stores, STORE_TH);
    let storeKey = data.store ? normKey(data.store) : null;
    if (sm) { data.store = sm.entry.canonical; storeKey = sm.entry.key; }

    const bm = bestMatch(data.branch, dict.branches, BRANCH_TH);
    if (bm) data.branch = bm.entry.canonical;

    // 全体カテゴリは弱い（空/その他）ときだけ、その店の最頻カテゴリで補う。
    if ((!data.category || data.category === "その他") && storeKey && dict.storeCat.has(storeKey)) {
      const top = argmax(dict.storeCat.get(storeKey));
      if (top) data.category = top;
    }

    if (Array.isArray(data.items)) {
      data.items = data.items.map((it) => {
        if (!it || !it.name) return it;
        const pm = bestMatch(it.name, dict.products, PROD_TH);
        if (pm) {
          it.name = pm.entry.canonical;
          // 商品名が一致したら、Gemini 由来のカテゴリを採用（強一致 or 元が弱いとき）。
          if (pm.entry.category && (pm.score >= 0.85 || !it.category || it.category === "その他")) {
            it.category = pm.entry.category;
          }
        }
        return it;
      });
    }
    log("履歴正規化を適用しました（Gemini基準）");
  } catch (err) {
    logErr("履歴正規化に失敗（生の結果を使用）:", err.message, err);
  }
  return data;
}
