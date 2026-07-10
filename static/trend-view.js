// 支出の推移グラフ（過去6ヶ月）— SVG で描画、外部ライブラリ不使用。
import { $, yen, openModal, closeModal } from "./dom-utils.js";
import { log, logErr } from "./log.js";

let _fetchMonthExpenses; // (Date) => Promise<expense[]>

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
    // 今月を含む過去6ヶ月を新しい順で収集
    const months = Array.from({ length: 6 }, (_, i) =>
      new Date(now.getFullYear(), now.getMonth() - (5 - i), 1),
    );
    const data = await Promise.all(
      months.map(async (m) => {
        const expenses = await _fetchMonthExpenses(m);
        return {
          label: `${m.getMonth() + 1}月`,
          total: expenses.reduce((s, e) => s + (e.amount || 0), 0),
        };
      }),
    );
    log("支出推移:", data.map((d) => `${d.label}:${d.total}`).join(" "));
    loading.hidden = true;
    chart.appendChild(_drawSvg(data));
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

  // バー + ラベル
  data.forEach((d, i) => {
    const x    = pad.left + step * i + (step - barW) / 2;
    const barH = max > 0 ? (d.total / max) * innerH : 0;
    const y    = pad.top + innerH - barH;
    const isLast = i === data.length - 1;

    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", x);
    rect.setAttribute("y", y);
    rect.setAttribute("width", barW);
    rect.setAttribute("height", barH);
    rect.setAttribute("fill", isLast ? "var(--accent)" : "color-mix(in srgb, var(--accent) 55%, transparent)");
    rect.setAttribute("rx", "3");
    svg.appendChild(rect);

    // 月ラベル
    _text(svg, ns, x + barW / 2, H - pad.bottom + 14, d.label, 11, "middle", "var(--muted)");

    // 金額（バー上部）
    if (d.total > 0) {
      _text(svg, ns, x + barW / 2, y - 5, _yLabel(d.total), 9, "middle", "var(--text)");
    }
  });

  return svg;
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
