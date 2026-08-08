// DOM・表示まわりの小さな共通ユーティリティ。

export const $ = (id) => document.getElementById(id);

export const yen = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP");
export const pad = (n) => String(n).padStart(2, "0");
export const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const monthLabel = (d) => `${d.getFullYear()}年${d.getMonth() + 1}月`;
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => dayKey(new Date());

export const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---- モーダル共通（開閉・背景タップ/Escで閉じる・背景スクロール抑止） --------
// モーダルIDごとの計測用タイトル（CMSサイトのページタイトルに相当）
const MODAL_TITLES = {
  "recipe-modal": "レシピ提案",
  "budget-modal": "予算設定",
  "shopping-modal": "買い物リスト",
  "compare-modal": "最安値比較",
  "household-modal": "世帯設定",
  "saved-recipes-modal": "保存したレシピ",
  "trend-modal": "推移グラフ",
  "week-modal": "週の内訳",
  "day-modal": "日別内訳",
  "account-modal": "アカウント",
  "upgrade-modal": "プレミアムプラン",
};

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// モーダルを開いたトリガー要素を記憶する（閉じた後にフォーカスを戻すため）
const _triggerMap = new Map();

export function openModal(id, trigger) {
  const modal = $(id);
  modal.hidden = false;
  document.body.classList.add("modal-open");
  if (typeof window.trackPageview === "function") {
    window.trackPageview(`/app/${id}`, MODAL_TITLES[id] || id);
  }
  // トリガーを記録（引数未指定時はフォーカス中の要素）
  _triggerMap.set(id, trigger ?? document.activeElement);
  // モーダル内の最初のフォーカス可能要素へ移動
  const first = modal.querySelector(FOCUSABLE);
  if (first) first.focus();
  // フォーカストラップ
  modal._trapHandler = (e) => _trapFocus(e, modal);
  modal.addEventListener("keydown", modal._trapHandler);
}

export function closeModal(id) {
  const modal = $(id);
  if (modal._trapHandler) {
    modal.removeEventListener("keydown", modal._trapHandler);
    modal._trapHandler = null;
  }
  modal.hidden = true;
  if (!document.querySelector(".modal:not([hidden])")) {
    document.body.classList.remove("modal-open");
  }
  // トリガーにフォーカスを戻す
  const trigger = _triggerMap.get(id);
  if (trigger && typeof trigger.focus === "function") trigger.focus();
  _triggerMap.delete(id);
}

function _trapFocus(e, modal) {
  if (e.key !== "Tab") return;
  const focusable = [...modal.querySelectorAll(FOCUSABLE)].filter(
    (el) => !el.closest("[hidden]")
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) { e.preventDefault(); last.focus(); }
  } else {
    if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
  }
}

export function bindModalDismiss() {
  document.querySelectorAll(".modal").forEach((m) => {
    // 背景（オーバーレイ）クリックで閉じる。中身(.modal-box)クリックは無視。
    m.addEventListener("click", (e) => { if (e.target === m) closeModal(m.id); });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = document.querySelector(".modal:not([hidden])");
    if (open) closeModal(open.id);
  });
}

// { カテゴリ: 金額 } をバーで描画する（サマリーと週計内訳で共用）
export function renderCatBars(container, byCat) {
  const entries = Object.entries(byCat)
    .filter(([, a]) => a > 0)
    .sort((a, b) => b[1] - a[1]);
  const max = entries.reduce((m, [, a]) => Math.max(m, a), 0);
  container.innerHTML = "";
  for (const [cat, amt] of entries) {
    const row = document.createElement("div");
    row.className = "cat-row";
    const pct = max > 0 ? Math.max(0, (amt / max) * 100) : 0;
    row.innerHTML = `
      <span class="cat-name">${escapeHtml(cat)}</span>
      <span class="cat-bar-wrap"><span class="cat-bar" style="width:${pct}%"></span></span>
      <span class="cat-amount">${yen(amt)}</span>`;
    container.appendChild(row);
  }
}
