// ブログ記事へのアフィリエイト広告の挿入。
//
// 記事HTMLは135本あるため、1本ずつ広告タグを埋め込むと保守できない。
// blog-cta.js と同じく、全記事が読み込むこのスクリプトから動的に挿入する。
//
// 掲載する商品は blog-ads-data.js に定義する（このファイルは触らなくてよい）。
//
// ── このモジュールが自動で担保すること ────────────────────────
//  1. 「PR」表記の付与
//     景品表示法のステマ規制（2023年10月施行）により、広告であることの
//     明示が義務。データ側の書き忘れで違反しないよう、ここで必ず描画する。
//  2. rel="sponsored nofollow" の付与
//     Google のガイドライン上アフィリエイトリンクに必須。欠けると
//     手動対策（順位下落）の対象になりうる。
//  3. target="_blank" 時の rel="noopener"（タブナビング対策）
//
// 挿入位置:
//   A) 記事中 … 「まとめ」見出しの直前（読者の離脱直前で最も見られる）
//   B) 記事末 … 関連記事セクションの直前
// どちらも該当要素が無い記事では静かにスキップする。

import { AD_ITEMS, MAX_ADS_PER_SLOT } from "./blog-ads-data.js";

/** 広告リンクに必須の rel。ここを緩めないこと（SEOペナルティの原因になる） */
const REQUIRED_REL = "sponsored nofollow noopener";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** 記事のカテゴリ（パンくずの am-cat）を取得する。タグ絞り込み用。 */
function currentCategory() {
  const el = document.querySelector(".am-cat");
  return el ? el.textContent.trim() : "";
}

/** この記事に出す広告を選ぶ。tags 指定があればカテゴリ一致を優先する。 */
function pickItems() {
  if (!Array.isArray(AD_ITEMS) || AD_ITEMS.length === 0) return [];
  const cat = currentCategory();
  const matched = AD_ITEMS.filter(
    (it) => Array.isArray(it.tags) && it.tags.some((t) => cat.includes(t)),
  );
  const pool = matched.length > 0 ? matched : AD_ITEMS;
  return pool.slice(0, MAX_ADS_PER_SLOT);
}

function renderCard(item) {
  const img = item.image
    ? `<img class="ad-card-img" src="${escapeHtml(item.image)}" alt="" loading="lazy" decoding="async" />`
    : "";
  const note = item.note
    ? `<span class="ad-card-note">${escapeHtml(item.note)}</span>`
    : "";
  return `<a class="ad-card" href="${escapeHtml(item.url)}" rel="${REQUIRED_REL}" target="_blank">`
    + img
    + `<span class="ad-card-body">`
    + `<span class="ad-card-title">${escapeHtml(item.title)}</span>`
    + note
    + `</span></a>`;
}

function renderBlock(items) {
  const box = document.createElement("aside");
  box.className = "ad-block";
  // ステマ規制対応。広告の直近に必ず表示する（データ側で消せないようここで固定）。
  box.innerHTML = `<p class="ad-label">PR・広告</p>`
    + `<div class="ad-cards">${items.map(renderCard).join("")}</div>`;
  return box;
}

function insertAds() {
  const items = pickItems();
  if (items.length === 0) return; // 掲載データが無いあいだは枠ごと出さない

  const article = document.querySelector("article.am");
  if (!article) return;

  // A) 「まとめ」見出しの直前
  const matome = [...article.querySelectorAll("h2")]
    .find((h) => h.textContent.trim().startsWith("まとめ"));
  if (matome) matome.parentNode.insertBefore(renderBlock(items), matome);

  // B) 関連記事の直前（無ければ記事の末尾）
  const related = article.querySelector(".am-related");
  const tail = renderBlock(items);
  if (related) related.parentNode.insertBefore(tail, related);
  else article.appendChild(tail);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", insertAds);
} else {
  insertAds();
}

// テスト用にエクスポート（本番の動作には影響しない）
export { pickItems, renderCard, renderBlock, REQUIRED_REL };
