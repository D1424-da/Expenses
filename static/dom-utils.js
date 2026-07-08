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
export function openModal(id) {
  $(id).hidden = false;
  document.body.classList.add("modal-open");
}

export function closeModal(id) {
  $(id).hidden = true;
  if (!document.querySelector(".modal:not([hidden])")) {
    document.body.classList.remove("modal-open");
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
