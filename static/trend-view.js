// 支出の推移グラフ（過去6ヶ月）— カテゴリ別積み上げ棒グラフ、SVG描画。
import { $, yen, openModal, closeModal, monthKey } from "./dom-utils.js";
import { CATEGORIES } from "./firebase-config.js";
import { categoryBreakdown } from "./stats.js";
import { log, logErr } from "./log.js";

let _fetchMonthExpenses;
// 過去月のデータをキャッシュ（当月は随時更新されるのでキャッシュ対象外）
const _monthCache = new Map();

// CATEGORIES の順番に対応したパレット（10色）
const CAT_COLORS = [
  "#4B7A5E", // 食費       — セージグリーン
  "#7C6FAC", // 日用品     — パープル
  "#E07060", // 外食       — コーラル
  "#4A90C4", // 交通費     — ブルー
  "#E8A44A", // 医療費     — アンバー
  "#C47DB8", // 娯楽       — モーブ
  "#6DB8B8", // 衣服       — ティール
  "#D4B84A", // 光熱費     — ゴールド
  "#7C9AC4", // 通信費     — スチールブルー
  "#9E9E9E", // その他     — グレー
];

function _catColor(cat) {
  const idx = CATEGORIES.indexOf(cat);
  return idx >= 0 ? CAT_COLORS[idx] : "#AAAAAA";
}

export function initTrend({ fetchMonthExpenses }) {
  _fetchMonthExpenses = fetchMonthExpenses;
  $("trend-close").onclick = () => closeModal("trend-modal");
  $("trend-btn").onclick   = _open;
}

async function _open() {
  openModal("trend-modal");
  const chart = $("trend-chart");
  chart.innerHTML = "";
  const loading = $("trend-loading");
  loading.hidden = false;

  try {
    const now = new Date();
    const months = Array.from({ length: 6 }, (_, i) =>
      new Date(now.getFullYear(), now.getMonth() - (5 - i), 1),
    );
    const currentKey = monthKey(now);
    const data = await Promise.all(
      months.map(async (m) => {
        const key = monthKey(m);
        if (key !== currentKey && _monthCache.has(key)) return _monthCache.get(key);
        const expenses = await _fetchMonthExpenses(m);
        const byCat = categoryBreakdown(expenses);
        const total = expenses.reduce((s, e) => s + (e.amount || 0), 0);
        const entry = { label: `${m.getMonth() + 1}月`, total, byCat };
        if (key !== currentKey) _monthCache.set(key, entry);
        return entry;
      }),
    );
    log("支出推移:", data.map((d) => `${d.label}:${d.total}`).join(" "));
    loading.hidden = true;

    // SVG積み上げ棒グラフ
    chart.appendChild(_drawSvg(data));

    // カテゴリ凡例（使われているカテゴリのみ）
    const usedCats = CATEGORIES.filter((c) =>
      data.some((d) => (d.byCat[c] || 0) > 0),
    );
    if (usedCats.length) chart.appendChild(_drawLegend(usedCats, data));
  } catch (err) {
    logErr("推移グラフエラー:", err.message, err);
    loading.hidden = true;
    chart.innerHTML = "<p class='empty'>データの取得に失敗しました。</p>";
  }
}

function _drawSvg(data) {
  const W = 340, H = 220;
  const pad = { top: 24, right: 12, bottom: 36, left: 58 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top  - pad.bottom;
  const max    = Math.max(...data.map((d) => d.total), 1);
  const barW   = (innerW / data.length) * 0.55;
  const step   = innerW / data.length;

  const ns  = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "trend-svg");

  // グリッド線 + Y軸ラベル（4段階）
  for (let i = 0; i <= 4; i++) {
    const y   = pad.top + (innerH / 4) * i;
    const val = Math.round(max * (1 - i / 4));
    _line(svg, ns, pad.left, y, pad.left + innerW, y, "var(--border)", i === 4 ? 1.5 : 0.5);
    _text(svg, ns, pad.left - 6, y + 4, _yLabel(val), 9, "end", "var(--muted)");
  }

  // 積み上げバー + ラベル
  data.forEach((d, i) => {
    const x = pad.left + step * i + (step - barW) / 2;
    const isLast = i === data.length - 1;

    // カテゴリを積み上げ（使用額のあるものだけ）
    let stackY = pad.top + innerH; // 下から積み上げ
    const segments = CATEGORIES
      .map((cat) => ({ cat, amt: d.byCat[cat] || 0 }))
      .filter((s) => s.amt > 0);

    // 未分類があれば末尾に追加（CATEGORIES に含まれない場合のみ）
    const uncatAmt = d.byCat["未分類"] || 0;
    if (uncatAmt > 0 && !CATEGORIES.includes("未分類")) segments.push({ cat: "未分類", amt: uncatAmt });

    for (const { cat, amt } of segments) {
      const segH = max > 0 ? (amt / max) * innerH : 0;
      stackY -= segH;
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", stackY);
      rect.setAttribute("width", barW);
      rect.setAttribute("height", segH);
      const base = _catColor(cat);
      rect.setAttribute("fill", isLast ? base : base + "99"); // 過去月は半透明
      rect.setAttribute("rx", "2");
      svg.appendChild(rect);
    }

    // 月ラベル
    _text(svg, ns, x + barW / 2, H - pad.bottom + 14, d.label, 11, "middle", "var(--muted)");

    // 合計金額（バー上部）
    if (d.total > 0) {
      const topY = pad.top + innerH - (d.total / max) * innerH;
      _text(svg, ns, x + barW / 2, topY - 5, _yLabel(d.total), 9, "middle", "var(--text)");
    }
  });

  return svg;
}

function _drawLegend(usedCats, data) {
  // 最終月の金額を凡例に添える
  const last = data[data.length - 1];
  const wrap = document.createElement("div");
  wrap.className = "trend-legend";
  for (const cat of usedCats) {
    const amt = last.byCat[cat] || 0;
    const item = document.createElement("div");
    item.className = "trend-legend-item";
    item.innerHTML = `
      <span class="trend-legend-dot" style="background:${_catColor(cat)}"></span>
      <span class="trend-legend-cat">${cat}</span>
      <span class="trend-legend-amt">${amt > 0 ? yen(amt) : "—"}</span>`;
    wrap.appendChild(item);
  }
  return wrap;
}

function _yLabel(v) {
  if (v >= 10000) return `¥${Math.round(v / 1000)}k`;
  return v === 0 ? "" : yen(v);
}

function _line(svg, ns, x1, y1, x2, y2, stroke, width) {
  const el = document.createElementNS(ns, "line");
  el.setAttribute("x1", x1); el.setAttribute("y1", y1);
  el.setAttribute("x2", x2); el.setAttribute("y2", y2);
  el.setAttribute("stroke", stroke);
  el.setAttribute("stroke-width", width);
  svg.appendChild(el);
}

function _text(svg, ns, x, y, content, size, anchor, fill) {
  const el = document.createElementNS(ns, "text");
  el.setAttribute("x", x); el.setAttribute("y", y);
  el.setAttribute("text-anchor", anchor);
  el.setAttribute("font-size", size);
  el.setAttribute("fill", fill);
  el.textContent = content;
  svg.appendChild(el);
}
