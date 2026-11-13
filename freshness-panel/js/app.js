/**
 * 新鲜度面板主逻辑：回放、筛选、渲染、详情抽屉、承诺调整。
 * 所有外部数据（产品名/错误信息）一律 textContent 注入，不拼 innerHTML。
 */
import {
  MINUTE, HOUR, STATUS, parseTime, toISO, dayKey,
  evaluateAll, buildIncidentHistory, buildDailyTrend, buildPartitionMatrix,
  buildLineage, effectiveSchedule,
} from "./engine.js";
import { renderStatusBars, renderRateLine, renderHeatmap, renderTableView } from "./charts.js";

const D = globalThis.FRESH_DATA;
const PRODUCTS_BY_ID = new Map(D.products.map((p) => [p.id, p]));
const LINEAGE = buildLineage(D.products);

// 运行期可调整的承诺（深拷贝，不改原始登记；历史保留）
const runtime = {
  overrides: new Map(), // productId -> {delayMinutes, warnMinutes, reason}
  commitmentHistory: [...D.commitmentHistory],
};
function scheduleWithOverrides(product, atMs) {
  const sched = effectiveSchedule(product, runtime.commitmentHistory, atMs);
  const ov = runtime.overrides.get(product.id);
  if (ov) {
    sched.delayMinutes = ov.delayMinutes;
    sched.warnMinutes = Math.min(ov.warnMinutes, ov.delayMinutes);
  }
  return sched;
}
// 让引擎读到运行期承诺：构造带覆盖值的产品视图
function productsAt(atMs) {
  return D.products.map((p) => ({ ...p, schedule: scheduleWithOverrides(p, atMs) }));
}

const state = {
  atMs: parseTime(D.meta.demoEnd),
  playing: false,
  speed: 1,
  timer: null,
  filters: { text: "", status: "all", layer: "all", tier: "all", highImpactOnly: false },
  selected: null,
  tableViews: new Set(),
};

const FREQ_LABEL = { hourly: "每小时", daily: "每日", weekly: "每周", monthly: "每月" };
const STATUS_META = {
  on_time: { label: "按时", cls: "on_time", icon: "✓" },
  warning: { label: "临近超时", cls: "warning", icon: "!" },
  overdue: { label: "已过期", cls: "overdue", icon: "✕" },
  paused: { label: "计划停更", cls: "paused", icon: "Ⅱ" },
};
const CRIT_LABEL = { critical: "关键", high: "高", medium: "中", low: "低" };
const HIGH_IMPACT_THRESHOLD = 75;

// ------------------------------------------------ 工具
function fmtTime(ms) {
  if (ms == null) return "—";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtMinutes(m) {
  if (m == null) return "—";
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}
function fmtRows(n) {
  if (n == null) return "—";
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return n.toLocaleString("zh-CN");
}
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function badge(status) {
  const meta = STATUS_META[status];
  const b = el("span", `badge ${meta.cls}`);
  b.append(el("span", "dot", ""), document.createTextNode(`${meta.icon} ${meta.label}`));
  return b;
}

// ------------------------------------------------ 计算
function currentEvals() {
  return evaluateAll(productsAt(state.atMs), D.runs, D.calendars, runtime.commitmentHistory, state.atMs);
}
function incidentsAll() {
  return buildIncidentHistory(productsAt(state.atMs), D.runs, D.calendars, runtime.commitmentHistory,
    parseTime(D.meta.demoStart), state.atMs);
}
function trendAll() {
  return buildDailyTrend(productsAt(state.atMs), D.runs, D.calendars, runtime.commitmentHistory,
    parseTime(D.meta.demoStart), state.atMs);
}
function matrixAll() {
  return buildPartitionMatrix(productsAt(state.atMs), D.runs, D.calendars, runtime.commitmentHistory,
    parseTime(D.meta.demoStart), state.atMs);
}

// ------------------------------------------------ KPI
function renderKpis(evals) {
  const grid = document.getElementById("kpiGrid");
  grid.textContent = "";
  const counts = { on_time: 0, warning: 0, overdue: 0, paused: 0 };
  let impactedConsumers = new Set();
  for (const e of evals) {
    counts[e.status] += 1;
    if (e.status === STATUS.OVERDUE || e.status === STATUS.WARNING) {
      for (const c of e.affectedConsumers) impactedConsumers.add(c.id);
    }
  }
  const active = evals.length - counts.paused;
  const rate = active ? Math.round((counts.on_time / active) * 100) : 100;
  const tiles = [
    { label: "受评数据产品", value: evals.length, foot: `其中计划停更 ${counts.paused} 个`, cls: "" },
    { label: "已过期", value: counts.overdue, foot: "越过承诺延迟仍未交付", cls: counts.overdue ? "danger" : "" },
    { label: "临近超时", value: counts.warning, foot: "进入预警窗口", cls: counts.warning ? "warn" : "" },
    { label: "SLA 按时达成率", value: `${rate}%`, foot: `按时 ${counts.on_time} / 受评 ${active}`, cls: rate === 100 ? "good" : "" },
    { label: "受影响下游消费方", value: impactedConsumers.size, foot: "去重后的报表/看板/表", cls: impactedConsumers.size ? "danger" : "good" },
  ];
  for (const t of tiles) {
    const card = el("div", `kpi ${t.cls}`);
    card.append(el("p", "kpi-label", t.label), el("div", "kpi-value", String(t.value)), el("div", "kpi-foot", t.foot));
    grid.appendChild(card);
  }
}

// ------------------------------------------------ 产品表
function applyFilters(evals) {
  const f = state.filters;
  const q = f.text.trim().toLowerCase();
  return evals.filter((e) => {
    const p = PRODUCTS_BY_ID.get(e.productId);
    if (f.status !== "all" && e.status !== f.status) return false;
    if (f.layer !== "all" && p.layer !== f.layer) return false;
    if (f.tier !== "all" && p.tier !== f.tier) return false;
    if (f.highImpactOnly && p.impactScore < HIGH_IMPACT_THRESHOLD) return false;
    if (q && !`${p.name} ${p.cnName} ${p.owner}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderProductTable(evals) {
  const tbody = document.querySelector("#productTable tbody");
  tbody.textContent = "";
  const rows = applyFilters(evals);
  // 排序：逾期 > 预警 > 停更 > 按时；同级按影响分降序
  const rank = { overdue: 0, warning: 1, paused: 2, on_time: 3 };
  rows.sort((a, b) => (rank[a.status] - rank[b.status]) ||
    (PRODUCTS_BY_ID.get(b.productId).impactScore - PRODUCTS_BY_ID.get(a.productId).impactScore));

  for (const e of rows) {
    const p = PRODUCTS_BY_ID.get(e.productId);
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-label", `查看 ${p.name} 详情`);

    const nameTd = el("td");
    nameTd.append(el("div", "row-name", p.name), el("div", "row-cn", `${p.cnName} · ${p.owner}`));
    const tierTd = el("td");
    tierTd.append(el("span", `tier-tag ${p.tier}`, p.tier));

    const freqTd = el("td", "muted", `${FREQ_LABEL[p.schedule.frequency]} · 容忍 ${p.schedule.delayMinutes} 分钟`);
    const statusTd = el("td");
    statusTd.appendChild(badge(e.status));
    if (e.status === "paused" && e.pausedReason) {
      statusTd.appendChild(el("div", "row-cn", e.pausedReason.message));
    }
    if (e.currentIncident) {
      statusTd.appendChild(el("div", "row-cn", `超期 ${fmtMinutes(e.currentIncident.overdueMinutes)}`));
    }

    const lastTd = el("td", "mono");
    lastTd.textContent = e.lastSuccess
      ? `${e.lastSuccess.partition}　${fmtTime(e.lastSuccess.successAt).slice(5)}`
      : "暂无成功批次";

    const missingTd = el("td", "num", String(e.missing.length));
    if (e.missing.length) missingTd.style.color = "var(--critical-text)";
    const lagTd = el("td", "num", e.lagMinutes == null ? "—" : fmtMinutes(e.lagMinutes));
    const consTd = el("td", "num", String(e.affectedConsumers.length));

    tr.append(nameTd, tierTd, freqTd, statusTd, lastTd, missingTd, lagTd, consTd);
    tr.addEventListener("click", () => openDrawer(e.productId));
    tr.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") { evt.preventDefault(); openDrawer(e.productId); }
    });
    tbody.appendChild(tr);
  }
  document.getElementById("rowCount").textContent = `显示 ${rows.length} / ${evals.length} 个产品`;
}

// ------------------------------------------------ 详情抽屉
function openDrawer(productId) {
  state.selected = productId;
  const p = PRODUCTS_BY_ID.get(productId);
  const evals = currentEvals();
  const e = evals.find((x) => x.productId === productId);
  const incidents = incidentsAll().filter((i) => i.productId === productId);
  const runs = D.runs.filter((r) => r.productId === productId)
    .sort((a, b) => parseTime(b.startedAt) - parseTime(a.startedAt));

  const drawer = document.getElementById("drawer");
  drawer.textContent = "";

  // 头部
  const head = el("div", "drawer-head");
  const titleBox = el("div");
  const h3 = el("h3");
  h3.textContent = p.name;
  const sub = el("div", "row-cn", `${p.cnName} · ${p.layer} 层 · ${p.owner}`);
  titleBox.append(h3, sub);
  const closeBtn = el("button", "btn", "关闭 ✕");
  closeBtn.addEventListener("click", closeDrawer);
  head.append(titleBox, closeBtn);
  drawer.appendChild(head);

  const statusSec = el("section");
  const statusLine = el("div");
  statusLine.style.display = "flex";
  statusLine.style.gap = "10px";
  statusLine.style.alignItems = "center";
  statusLine.style.marginBottom = "10px";
  statusLine.append(badge(e.status), el("span", "tier-tag", p.tier));
  statusSec.appendChild(statusLine);

  const dl = el("dl", "kv");
  const kv = (k, v) => { dl.append(el("dt", null, k), el("dd", null, v)); };
  kv("调度频率", FREQ_LABEL[p.schedule.frequency]);
  kv("承诺容忍延迟", `${e.schedule.delayMinutes} 分钟`);
  kv("预警窗口", `到期前 ${e.schedule.warnMinutes} 分钟`);
  kv("关联日历", D.calendars.find((c) => c.id === p.calendarId)?.name || p.calendarId);
  kv("数据新鲜度滞后", e.lagMinutes == null ? "—" : fmtMinutes(e.lagMinutes));
  kv("影响分", `${p.impactScore}（${p.impactScore >= HIGH_IMPACT_THRESHOLD ? "高影响" : "一般影响"}）`);
  statusSec.appendChild(dl);
  drawer.appendChild(statusSec);

  // 当前异常
  const incSec = el("section");
  incSec.appendChild(el("h4", null, "当前异常与缺失分区"));
  if (e.currentIncident) {
    const ci = e.currentIncident;
    const box = el("div", "empty-note");
    box.style.borderLeft = "3px solid var(--status-critical)";
    box.textContent = `分区 ${ci.partition} 已超期 ${fmtMinutes(ci.overdueMinutes)}：${ci.reason}`;
    incSec.appendChild(box);
  }
  const problemList = el("ul", "mini-list");
  for (const m of [...e.missing, ...e.waiting].sort((a, b) => b.deadline - a.deadline)) {
    const li = el("li", m.deadline < state.atMs ? "overdue" : "warning");
    const left = el("div");
    left.append(el("div", "mono", m.partition));
    const stateText = m.state === "running" ? "批次运行中" : m.state === "failed" ? "批次失败" : m.state === "recovered" ? "迟到已补齐" : "无任何批次";
    left.append(el("div", "row-cn", `${stateText} · 截止 ${fmtTime(m.deadline).slice(5)}`));
    li.appendChild(left);
    li.appendChild(el("span", `badge ${m.deadline < state.atMs ? "overdue" : "warning"}`,
      m.deadline < state.atMs ? "✕ 已过期" : "! 临近超时"));
    problemList.appendChild(li);
  }
  if (!problemList.children.length) incSec.appendChild(el("div", "empty-note", "当前无缺失或等待中的分区 ✓"));
  else incSec.appendChild(problemList);
  drawer.appendChild(incSec);

  // 最近成功批次
  const lsSec = el("section");
  lsSec.appendChild(el("h4", null, "最近成功批次"));
  if (e.lastSuccess) {
    const ls = el("div", "empty-note");
    ls.textContent = `分区 ${e.lastSuccess.partition} · 完成于 ${fmtTime(e.lastSuccess.successAt)} · 载入 ${fmtRows(e.lastSuccess.rowsLoaded)} 行`
      + (e.lastSuccess.retryRuns ? ` · 含 ${e.lastSuccess.retryRuns} 次重试（同分区只计一次新鲜度）` : " · 一次成功");
    lsSec.appendChild(ls);
  } else lsSec.appendChild(el("div", "empty-note", "窗口内暂无成功批次"));
  // 最近运行记录（前 6 条）
  const runList = el("ul", "mini-list");
  for (const r of runs.slice(0, 6)) {
    const li = el("li", r.status === "failed" ? "overdue" : r.status === "running" ? "warning" : r.status === "success" ? "recovered" : "");
    const left = el("div");
    left.append(el("div", "mono", `${r.partition} · 第 ${r.attempt} 次（${r.trigger === "retry" ? "重试" : "调度"}）`));
    left.append(el("div", "row-cn", r.errorMessage || `${fmtTime(parseTime(r.startedAt)).slice(5)} 开始 · ${r.rowsLoaded == null ? "—" : fmtRows(r.rowsLoaded) + " 行"}`));
    li.appendChild(left);
    const stMap = { success: ["recovered", "✓ 成功"], failed: ["overdue", "✕ 失败"], running: ["warning", "… 运行中"] };
    const [cls, txt] = stMap[r.status] || ["", r.status];
    li.appendChild(el("span", `badge ${cls}`, txt));
    runList.appendChild(li);
  }
  lsSec.appendChild(runList);
  drawer.appendChild(lsSec);

  // 受影响消费者（含传递下游与血缘路径）
  const consSec = el("section");
  consSec.appendChild(el("h4", null, `下游使用方（${e.affectedConsumers.length} 个，含传递依赖）`));
  const consList = el("ul", "mini-list");
  for (const c of e.affectedConsumers) {
    const li = el("li");
    const left = el("div");
    left.append(el("div", null, c.name));
    left.append(el("div", "row-cn mono", c.path.join(" → ")));
    li.appendChild(left);
    li.appendChild(el("span", `criticality ${c.criticality}`, CRIT_LABEL[c.criticality] || c.criticality));
    consList.appendChild(li);
  }
  if (!consList.children.length) consSec.appendChild(el("div", "empty-note", "未登记下游使用方"));
  else consSec.appendChild(consList);
  drawer.appendChild(consSec);

  // 异常历史（补齐后保留）
  const histSec = el("section");
  histSec.appendChild(el("h4", null, `异常历史（${incidents.length} 条，补齐后仍保留）`));
  const tl = el("ol", "timeline");
  for (const inc of incidents.slice(0, 12)) {
    const li = el("li", inc.open ? "bad" : "ok");
    li.append(el("div", "t-time", `${fmtTime(inc.openedAt)} 起 · 分区 ${inc.partition}`));
    const main = el("div", null, inc.open
      ? `未恢复，已持续 ${fmtMinutes(inc.durationMinutes)}：${inc.reason}`
      : `迟到 ${fmtMinutes(inc.durationMinutes)} 后于 ${fmtTime(inc.recoveredAt)} 补齐：${inc.reason}`);
    li.appendChild(main);
    li.append(el("div", "row-cn", `重试 ${inc.retryRuns} 次 · 影响 ${inc.affectedConsumers.length} 个消费方`));
    tl.appendChild(li);
  }
  if (!tl.children.length) histSec.appendChild(el("div", "empty-note", "窗口内无异常记录"));
  else histSec.appendChild(tl);
  drawer.appendChild(histSec);

  // 承诺调整
  const slaSec = el("section");
  slaSec.appendChild(el("h4", null, "调整 SLA 承诺"));
  const form = el("form", "sla-form");
  const mkField = (labelText, inputId, value, type = "number") => {
    const lab = el("label");
    lab.append(el("span", null, labelText));
    const inp = document.createElement("input");
    inp.id = inputId; inp.type = type; inp.value = value; inp.min = 1;
    lab.appendChild(inp);
    return [lab, inp];
  };
  const [delayLab, delayInput] = mkField("容忍延迟(分钟)", "slaDelay", e.schedule.delayMinutes);
  const [warnLab, warnInput] = mkField("预警提前(分钟)", "slaWarn", e.schedule.warnMinutes);
  const reasonLab = el("label");
  reasonLab.append(el("span", null, "变更原因"));
  const reasonInput = document.createElement("input");
  reasonInput.id = "slaReason"; reasonInput.type = "text"; reasonInput.placeholder = "如：上游链路改造";
  reasonInput.style.width = "200px";
  reasonLab.appendChild(reasonInput);
  const submit = document.createElement("button");
  submit.className = "btn btn-primary"; submit.type = "submit"; submit.textContent = "保存承诺调整";
  form.append(delayLab, warnLab, reasonLab, submit);
  form.addEventListener("submit", (evt) => {
    evt.preventDefault();
    saveCommitment(productId, Number(delayInput.value), Number(warnInput.value), reasonInput.value || "面板临时调整");
  });
  slaSec.appendChild(form);
  // 该产品的承诺变更史
  const histList = el("ol", "timeline");
  for (const c of runtime.commitmentHistory.filter((x) => x.productId === productId)) {
    const li = el("li");
    li.append(el("div", "t-time", `${fmtTime(parseTime(c.effectiveFrom))} 生效 · ${c.operator}`));
    li.append(el("div", null, `${c.field}：${c.oldValue} → ${c.newValue}`));
    li.append(el("div", "row-cn", c.reason));
    histList.appendChild(li);
  }
  const ov = runtime.overrides.get(productId);
  if (ov) {
    const li = el("li");
    li.append(el("div", "t-time", `${fmtTime(state.atMs)} 生效 · 面板临时调整`));
    li.append(el("div", null, `容忍延迟 → ${ov.delayMinutes} 分钟，预警提前 → ${ov.warnMinutes} 分钟`));
    li.append(el("div", "row-cn", ov.reason));
    histList.appendChild(li);
  }
  if (histList.children.length) slaSec.appendChild(histList);
  drawer.appendChild(slaSec);

  document.getElementById("drawerBackdrop").classList.add("open");
  drawer.classList.add("open");
  closeBtn.focus();
}

function closeDrawer() {
  state.selected = null;
  document.getElementById("drawerBackdrop").classList.remove("open");
  document.getElementById("drawer").classList.remove("open");
}

function saveCommitment(productId, delayMinutes, warnMinutes, reason) {
  if (!Number.isFinite(delayMinutes) || delayMinutes < 1) return;
  const p = PRODUCTS_BY_ID.get(productId);
  const oldSched = effectiveSchedule(p, runtime.commitmentHistory, state.atMs);
  runtime.overrides.set(productId, {
    delayMinutes,
    warnMinutes: Math.max(0, Math.min(warnMinutes || 0, delayMinutes)),
    reason,
  });
  runtime.commitmentHistory.push({
    id: `ch_runtime_${Date.now()}`,
    productId,
    effectiveFrom: toISO(state.atMs),
    field: "delayMinutes",
    oldValue: oldSched.delayMinutes,
    newValue: delayMinutes,
    reason: `[面板调整] ${reason}`,
    operator: "当前用户",
  });
  renderAll();
  openDrawer(productId); // 用新承诺重绘抽屉
}

// ------------------------------------------------ 图表
function renderCharts() {
  const trend = trendAll();
  renderStatusBars(document.getElementById("barChart"), trend);
  renderRateLine(document.getElementById("lineChart"), trend);
  renderHeatmap(document.getElementById("heatmap"), matrixAll(), PRODUCTS_BY_ID, openDrawer);

  // 表格视图开关
  document.getElementById("barTableBtn").onclick = () => {
    const btn = document.getElementById("barTableBtn");
    const on = state.tableViews.has("bar");
    if (on) { state.tableViews.delete("bar"); btn.classList.remove("active"); }
    else {
      state.tableViews.add("bar"); btn.classList.add("active");
      renderTableView(document.getElementById("barCard"),
        [{ key: "date", label: "日期" }, { key: "on_time", label: "按时" },
         { key: "warning", label: "临近超时" }, { key: "overdue", label: "已过期" },
         { key: "paused", label: "停更" }, { key: "rate", label: "SLA 达成率" }],
        trend.map((d) => ({
          date: d.date, on_time: d.counts.on_time, warning: d.counts.warning || 0,
          overdue: d.counts.overdue || 0, paused: d.counts.paused || 0,
          rate: `${(d.onTimeRate * 100).toFixed(1)}%`,
        })));
    }
  };
}

// ------------------------------------------------ 全量渲染
function renderAll() {
  document.getElementById("clock").textContent = fmtTime(state.atMs);
  const evals = currentEvals();
  renderKpis(evals);
  renderProductTable(evals);
  renderCharts();
  if (state.selected) openDrawer(state.selected);
}

// ------------------------------------------------ 回放
const demoStart = parseTime(D.meta.demoStart);
const demoEnd = parseTime(D.meta.demoEnd);
const step = D.meta.replayStepMinutes * MINUTE;

function setClock(ms) {
  state.atMs = Math.max(demoStart, Math.min(demoEnd, ms));
  const slider = document.getElementById("timeSlider");
  slider.min = demoStart; slider.max = demoEnd; slider.value = state.atMs;
  renderAll();
}
function tick() {
  const next = state.atMs + step * state.speed;
  if (next >= demoEnd) {
    setClock(demoEnd);
    pause();
    return;
  }
  setClock(next);
}
function play() {
  if (state.atMs >= demoEnd) setClock(demoStart);
  state.playing = true;
  document.getElementById("playBtn").textContent = "暂停 ⏸";
  state.timer = setInterval(tick, 1200);
}
function pause() {
  state.playing = false;
  document.getElementById("playBtn").textContent = "播放 ▶";
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

// ------------------------------------------------ 筛选器
function initFilters() {
  const layerSel = document.getElementById("filterLayer");
  ["all", ...new Set(D.products.map((p) => p.layer))].forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = v === "all" ? "全部层级" : v;
    layerSel.appendChild(opt);
  });
  const tierSel = document.getElementById("filterTier");
  ["all", "P0", "P1", "P2"].forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = v === "all" ? "全部等级" : v;
    tierSel.appendChild(opt);
  });
  document.getElementById("filterText").addEventListener("input", (e) => {
    state.filters.text = e.target.value; renderProductTable(currentEvals());
  });
  layerSel.addEventListener("change", (e) => { state.filters.layer = e.target.value; renderProductTable(currentEvals()); });
  tierSel.addEventListener("change", (e) => { state.filters.tier = e.target.value; renderProductTable(currentEvals()); });
  document.querySelectorAll(".status-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".status-chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.filters.status = btn.dataset.status;
      renderProductTable(currentEvals());
    });
  });
  document.getElementById("highImpact").addEventListener("change", (e) => {
    state.filters.highImpactOnly = e.target.checked; renderProductTable(currentEvals());
  });
  document.getElementById("resetFilters").addEventListener("click", () => {
    state.filters = { text: "", status: "all", layer: "all", tier: "all", highImpactOnly: false };
    document.getElementById("filterText").value = "";
    layerSel.value = "all"; tierSel.value = "all";
    document.getElementById("highImpact").checked = false;
    document.querySelectorAll(".status-chip").forEach((b, i) => b.classList.toggle("active", i === 0));
    renderProductTable(currentEvals());
  });
}

// ------------------------------------------------ 主题
function initTheme() {
  const btn = document.getElementById("themeBtn");
  const saved = localStorage.getItem("freshness-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  const sync = () => {
    const dark = document.documentElement.dataset.theme === "dark"
      || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    btn.textContent = dark ? "☀ 浅色" : "🌙 深色";
  };
  sync();
  btn.addEventListener("click", () => {
    const dark = btn.textContent.includes("深色");
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("freshness-theme", dark ? "dark" : "light");
    sync();
    renderAll();
  });
}

// ------------------------------------------------ 启动
function init() {
  initTheme();
  initFilters();
  document.getElementById("playBtn").addEventListener("click", () => (state.playing ? pause() : play()));
  document.getElementById("resetBtn").addEventListener("click", () => { pause(); setClock(demoEnd); });
  document.getElementById("startBtn").addEventListener("click", () => { pause(); setClock(demoStart); });
  document.getElementById("timeSlider").addEventListener("input", (e) => { pause(); setClock(Number(e.target.value)); });
  document.querySelectorAll(".speed-btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".speed-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.speed = Number(b.dataset.speed);
    });
  });
  document.getElementById("drawerBackdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  document.getElementById("metaNote").textContent =
    `${D.meta.note} · 数据生成于 ${fmtTime(parseTime(D.meta.generatedAt))}`;
  setClock(demoEnd);
}

document.addEventListener("DOMContentLoaded", init);
