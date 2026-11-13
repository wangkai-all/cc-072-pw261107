/**
 * 轻量 SVG 图表：全部用 createElementNS + textContent 构建，无 innerHTML 拼接。
 * 遵循 dataviz 规范：2px 线、细柱圆角、hairline 网格、hover tooltip + 命中区、表格视图兜底。
 */
import { dayKey, toISO } from "./engine.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const css = (name) => getComputedStyle(document.querySelector(".viz-root")).getPropertyValue(name).trim();

function el(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") node.setAttribute("class", v);
    else node.setAttribute(k, String(v));
  }
  if (text != null) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 全局 tooltip 单例 */
let tip;
function tooltip() {
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tooltip";
    tip.setAttribute("role", "status");
    document.body.appendChild(tip);
  }
  return tip;
}
function showTip(evt, title, rows) {
  const t = tooltip();
  t.textContent = "";
  const h = document.createElement("div");
  h.className = "tt-title";
  h.textContent = title;
  t.appendChild(h);
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "tt-row";
    if (r.color) {
      const stroke = document.createElement("span");
      stroke.className = "tt-stroke";
      stroke.style.borderColor = r.color;
      row.appendChild(stroke);
    }
    const name = document.createElement("span");
    name.textContent = r.name;
    row.appendChild(name);
    const val = document.createElement("strong");
    val.textContent = r.value;
    row.appendChild(val);
    t.appendChild(row);
  }
  t.classList.add("show");
  moveTip(evt);
}
function moveTip(evt) {
  const t = tooltip();
  const pad = 14;
  const rect = t.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}
function hideTip() {
  tooltip().classList.remove("show");
}

const STATUS_COLOR = {
  on_time: "var(--status-good)",
  warning: "var(--status-warning)",
  overdue: "var(--status-critical)",
  paused: "var(--status-paused)",
};
const STATUS_LABEL = { on_time: "按时", warning: "临近超时", overdue: "已过期", paused: "计划停更" };

// ------------------------------------------------------------ 堆叠柱：每日状态分布
export function renderStatusBars(container, days) {
  clear(container);
  const W = 640, H = 240, padL = 36, padR = 12, padT = 14, padB = 46;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img", "aria-label": "每日新鲜度状态堆叠柱状图" });
  const maxTotal = Math.max(1, ...days.map((d) => d.total));
  const niceMax = Math.ceil(maxTotal / 2) * 2;
  const band = plotW / days.length;
  const barW = Math.min(24, band * 0.62);

  // y 网格（0 / 半量 / 满量，整数刻度）
  for (let i = 0; i <= 2; i += 1) {
    const v = Math.round((niceMax / 2) * i);
    const y = padT + plotH - (plotH * v) / niceMax;
    svg.appendChild(el("line", { x1: padL, y1: y, x2: W - padR, y2: y, class: "grid-line" }));
    const lbl = el("text", { x: padL - 6, y: y + 4, "text-anchor": "end" }, String(v));
    svg.appendChild(lbl);
  }
  svg.appendChild(el("line", { x1: padL, y1: padT + plotH, x2: W - padR, y2: padT + plotH, class: "axis-line" }));

  days.forEach((d, i) => {
    const x = padL + band * i + (band - barW) / 2;
    let yCursor = padT + plotH;
    const segs = [
      ["overdue", d.counts.overdue || 0],
      ["warning", d.counts.warning || 0],
      ["paused", d.counts.paused || 0],
      ["on_time", d.counts.on_time || 0],
    ].filter(([, v]) => v > 0);
    for (const [status, v] of segs) {
      const h = (plotH * v) / niceMax;
      yCursor -= h;
      const rect = el("rect", {
        x, y: yCursor, width: barW, height: Math.max(0, h - 2), rx: 4,
        fill: STATUS_COLOR[status], class: `bar-${status === "on_time" ? "ok" : status === "warning" ? "warn" : status === "overdue" ? "bad" : "paused"}`,
      });
      // 段之间 2px 表面间隙：用透明间隔（height-2 已留 gap）
      rect.addEventListener("pointermove", (e) => {
        showTip(e, d.date, [
          { color: css(`--status-${status === "on_time" ? "good" : status}`), name: STATUS_LABEL[status], value: `${v} 个` },
          { name: "SLA 达成率", value: `${(d.onTimeRate * 100).toFixed(0)}%` },
        ]);
      });
      rect.addEventListener("pointerleave", hideTip);
      svg.appendChild(rect);
    }
    // x 标签（MM-DD）
    const lbl = el("text", { x: x + barW / 2, y: padT + plotH + 18, "text-anchor": "middle" }, d.date.slice(5));
    svg.appendChild(lbl);
  });
  container.appendChild(svg);
  renderLegend(container, [
    ["on_time", "按时"], ["warning", "临近超时"], ["overdue", "已过期"], ["paused", "计划停更"],
  ]);
}

// ------------------------------------------------------------ 折线：SLA 达成率
export function renderRateLine(container, days) {
  clear(container);
  const W = 640, H = 240, padL = 40, padR = 12, padT = 14, padB = 46;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img", "aria-label": "每日 SLA 达成率折线图" });
  const x = (i) => padL + (days.length === 1 ? plotW / 2 : (plotW * i) / (days.length - 1));
  const y = (rate) => padT + plotH - plotH * rate;

  [0, 0.5, 1].forEach((rate) => {
    const yy = y(rate);
    svg.appendChild(el("line", { x1: padL, y1: yy, x2: W - padR, y2: yy, class: "grid-line" }));
    svg.appendChild(el("text", { x: padL - 6, y: yy + 4, "text-anchor": "end" }, `${rate * 100}%`));
  });
  svg.appendChild(el("line", { x1: padL, y1: padT + plotH, x2: W - padR, y2: padT + plotH, class: "axis-line" }));

  const pts = days.map((d, i) => [x(i), y(d.onTimeRate)]);
  const lineD = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const areaD = `${lineD} L${x(days.length - 1)},${padT + plotH} L${x(0)},${padT + plotH} Z`;
  svg.appendChild(el("path", { d: areaD, class: "area-fill" }));
  svg.appendChild(el("path", { d: lineD, class: "line-path" }));

  pts.forEach(([px, py], i) => {
    const dot = el("circle", { cx: px, cy: py, r: 4.5, class: "marker" });
    dot.addEventListener("pointermove", (e) => {
      const d = days[i];
      showTip(e, d.date, [
        { color: css("--series-1"), name: "SLA 达成率", value: `${(d.onTimeRate * 100).toFixed(1)}%` },
        { name: "按时 / 受评产品", value: `${d.counts.on_time} / ${d.total - (d.counts.paused || 0)}` },
      ]);
    });
    dot.addEventListener("pointerleave", hideTip);
    svg.appendChild(dot);
    svg.appendChild(el("text", { x: px, y: padT + plotH + 18, "text-anchor": "middle" }, days[i].date.slice(5)));
  });

  // 十字线 + 整列命中层
  const cross = el("line", { y1: padT, y2: padT + plotH, class: "grid-line", visibility: "hidden" });
  svg.appendChild(cross);
  const hit = el("rect", { x: padL, y: padT, width: plotW, height: plotH, class: "svg-hit" });
  hit.addEventListener("pointermove", (e) => {
    const rect = hit.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width * plotW;
    const i = Math.max(0, Math.min(days.length - 1, Math.round((rel - 0) / (plotW / Math.max(1, days.length - 1)))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
    cross.setAttribute("visibility", "visible");
    const d = days[i];
    showTip(e, d.date, [
      { color: css("--series-1"), name: "SLA 达成率", value: `${(d.onTimeRate * 100).toFixed(1)}%` },
      { name: "按时", value: `${d.counts.on_time} 个` },
      { name: "临近超时", value: `${d.counts.warning || 0} 个` },
      { name: "已过期", value: `${d.counts.overdue || 0} 个` },
    ]);
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  svg.appendChild(hit);
  container.appendChild(svg);
}

// ------------------------------------------------------------ 热力图：产品 × 日期 分区健康
export function renderHeatmap(container, matrix, productsById, onSelectProduct) {
  clear(container);
  const dates = matrix[0]?.row.map((c) => c.date) || [];
  const cell = 26, labelW = 168, headH = 28, rowH = 30;
  const W = labelW + dates.length * (cell + 2) + 10;
  const H = headH + matrix.length * rowH + 8;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img", "aria-label": "数据产品分区健康热力图" });

  dates.forEach((d, i) => {
    const x = labelW + i * (cell + 2);
    const t = el("text", { x: x + cell / 2, y: 16, "text-anchor": "middle", transform: `rotate(-40 ${x + cell / 2} 16)` }, d.slice(5));
    svg.appendChild(t);
  });

  matrix.forEach((row, ri) => {
    const product = productsById.get(row.productId);
    const y = headH + ri * rowH;
    const name = el("text", { x: 6, y: y + 17, "text-anchor": "start" }, product ? product.name : row.productId);
    svg.appendChild(name);
    row.row.forEach((cell0, ci) => {
      const x = labelW + ci * (cell + 2);
      let fill = "var(--surface-2)";
      if (cell0.expected === 0 && cell0.paused === 0) fill = "var(--surface-2)";
      else if (cell0.paused > 0 && cell0.expected === 0) fill = "var(--status-paused)";
      else if (cell0.bad > 0) fill = "var(--status-critical)";
      else if (cell0.ok > 0) fill = "var(--status-good)";
      const rect = el("rect", { x, y: y + 2, width: cell, height: cell, class: "heat-cell", fill, opacity: cell0.paused > 0 && cell0.expected === 0 ? 0.55 : 1 });
      rect.style.cursor = "pointer";
      rect.addEventListener("pointermove", (e) => {
        showTip(e, `${product ? product.name : row.productId} · ${cell0.date}`, [
          { color: css("--status-good"), name: "按时分区", value: `${cell0.ok}` },
          { color: css("--status-critical"), name: "异常/缺失分区", value: `${cell0.bad}` },
          { color: css("--status-paused"), name: "计划停更槽位", value: `${cell0.paused}` },
        ]);
      });
      rect.addEventListener("pointerleave", hideTip);
      rect.addEventListener("click", () => onSelectProduct(row.productId));
      svg.appendChild(rect);
    });
  });
  container.appendChild(svg);
  renderLegend(container, [
    ["good", "全部按时"], ["bad", "存在异常分区"], ["paused", "全天计划停更"], ["surface", "无调度"],
  ]);
}

// ------------------------------------------------------------ 图例
function renderLegend(container, items) {
  const old = container.querySelector(".legend");
  if (old) old.remove();
  const wrap = document.createElement("div");
  wrap.className = "legend";
  for (const [key, label] of items) {
    const k = document.createElement("span");
    k.className = "key";
    const sw = document.createElement("span");
    sw.className = "swatch";
    const colorVar = key === "good" ? "var(--status-good)"
      : key === "bad" ? "var(--status-critical)"
      : key === "paused" ? "var(--status-paused)"
      : key === "warning" ? "var(--status-warning)"
      : "var(--surface-2)";
    sw.style.background = colorVar;
    const txt = document.createElement("span");
    txt.textContent = label;
    k.append(sw, txt);
    wrap.appendChild(k);
  }
  container.appendChild(wrap);
}

// ------------------------------------------------------------ 图表的表格视图（无障碍兜底）
export function renderTableView(container, columns, rows) {
  const old = container.querySelector(".data-table-view");
  if (old) { old.remove(); return; }
  const wrap = document.createElement("div");
  wrap.className = "data-table-view";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const c of columns) {
    const th = document.createElement("th");
    th.textContent = c.label;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    for (const c of columns) {
      const td = document.createElement("td");
      td.textContent = r[c.key];
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}
