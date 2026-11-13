/**
 * 最小 DOM 桩冒烟测试：在无浏览器环境跑通 app.js 的初始化、渲染、筛选、
 * 抽屉打开、承诺调整、回放等关键路径，捕获运行时异常。
 * 不是完整 DOM 实现，只覆盖应用实际用到的 API。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

class Node {
  constructor(tag) {
    this.tagName = (tag || "").toUpperCase();
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this._text = "";
    this.checked = false;
    this.classList = new Set();
    this.eventListeners = {};
    this.tabIndex = 0;
  }
  set className(v) { this._className = v; this.classList = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return this._className || ""; }
  set id(v) { this.attributes.id = v; }
  get id() { return this.attributes.id; }
  set type(v) { this.attributes.type = v; }
  get type() { return this.attributes.type; }
  set value(v) { this._value = String(v); }
  get value() { return this._value ?? ""; }
  set textContent(v) {
    this._text = v == null ? "" : String(v);
    for (const c of [...this.children]) c.parentNode = null;
    this.children.length = 0;
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this._text;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === "class") this.className = v; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  append(...kids) { for (const k of kids) this.appendChild(k); }
  appendChild(k) {
    if (typeof k === "string" || typeof k === "number") {
      const t = new Node("#text"); t._text = String(k); t.parentNode = this; this.children.push(t); return t;
    }
    k.parentNode = this; this.children.push(k); return k;
  }
  removeChild(k) { const i = this.children.indexOf(k); if (i >= 0) this.children.splice(i, 1); k.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(type, fn) { (this.eventListeners[type] ||= []).push(fn); }
  dispatch(type, evt = {}) {
    evt.preventDefault ||= () => {};
    evt.target ||= this;
    for (const fn of this.eventListeners[type] || []) fn.call(this, evt);
  }
  click() { this.dispatch("click"); }
  focus() {}
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const cls = sel.startsWith(".") ? sel.slice(1) : null;
    const idq = sel.startsWith("#") ? sel.slice(1) : null;
    const tag = !cls && !idq ? sel.toUpperCase() : null;
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (cls && c.classList.has(cls)) out.push(c);
        if (idq && c.id === idq) out.push(c);
        if (tag && c.tagName === tag) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 300 }; }
}

function buildDom() {
  // Node 24 的 Set 无 toggle（DOMTokenList 才有），补一个
  if (!Set.prototype.toggle) {
    Set.prototype.toggle = function (v, force) {
      const has = this.has(v);
      const want = force === undefined ? !has : force;
      if (want) this.add(v); else this.delete(v);
      return want;
    };
  }
  if (!Set.prototype.remove) Set.prototype.remove = function (v) { this.delete(v); };
  if (!Set.prototype.contains) Set.prototype.contains = function (v) { return this.has(v); };
  const ids = ["kpiGrid", "productTable", "rowCount", "drawer", "drawerBackdrop", "clock",
    "barChart", "lineChart", "heatmap", "barCard", "barTableBtn", "timeSlider", "playBtn",
    "resetBtn", "startBtn", "filterText", "filterLayer", "filterTier", "highImpact",
    "resetFilters", "themeBtn", "metaNote"];
  const byId = new Map();
  for (const id of ids) { const n = new Node("div"); n.id = id; byId.set(id, n); }
  byId.get("productTable").appendChild(new Node("tbody"));
  // 状态 chip 与速度按钮
  for (const s of ["all", "overdue", "warning", "on_time", "paused"]) {
    const b = new Node("button"); b.className = "status-chip" + (s === "all" ? " active" : "");
    b.dataset = { status: s };
    b.setAttribute("data-status", s); byId.set(`chip-${s}`, b);
  }
  for (const sp of [1, 2, 4]) {
    const b = new Node("button"); b.className = "speed-btn" + (sp === 1 ? " active" : "");
    b.setAttribute("data-speed", String(sp)); byId.set(`speed-${sp}`, b);
  }
  const documentListeners = {};
  const documentMock = {
    createElement: (t) => new Node(t),
    createElementNS: (_ns, t) => new Node(t),
    createTextNode: (t) => { const n = new Node("#text"); n._text = t; return n; },
    getElementById: (id) => {
      if (byId.has(id)) return byId.get(id);
      // 动态创建元素的兜底：全树按 id 查找
      for (const root of [documentMock.body, documentMock.documentElement, ...byId.values()]) {
        const found = root.querySelector && root.querySelector(`#${id}`);
        if (found) return found;
      }
      return null;
    },
    querySelector: (sel) => {
      if (sel === "#productTable tbody") return byId.get("productTable").children[0];
      if (sel === ".viz-root") return rootNode;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === ".status-chip") return ["all", "overdue", "warning", "on_time", "paused"].map((s) => byId.get(`chip-${s}`));
      if (sel === ".speed-btn") return [1, 2, 4].map((s) => byId.get(`speed-${s}`));
      return [];
    },
    addEventListener: (type, fn) => { (documentListeners[type] ||= []).push(fn); },
    dispatchLoaded: () => documentListeners.DOMContentLoaded?.forEach((fn) => fn()),
    body: new Node("body"),
    documentElement: Object.assign(new Node("html"), { dataset: {} }),
  };
  const rootNode = new Node("div");
  rootNode.className = "viz-root";
  return { documentMock, byId };
}

function loadApp() {
  const { documentMock, byId } = buildDom();
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    Date, Math, Number, String, Array, Object, Set, Map, JSON, RegExp, isFinite, parseInt,
    localStorage: { getItem: () => null, setItem: () => {} },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: () => "#000000" }),
    document: documentMock,
    window: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(path.join(root, "data", "sample-data.js"), "utf-8"), sandbox);
  // 把 ESM 源码转成可在 vm 中运行的形式：去掉 import/export，注入依赖
  const engineSrc = readFileSync(path.join(root, "js", "engine.js"), "utf-8")
    .replace(/^export /gm, "");
  const chartsSrc = readFileSync(path.join(root, "js", "charts.js"), "utf-8")
    .replace(/^import .*?;\n/gm, "").replace(/^export /gm, "");
  const appSrc = readFileSync(path.join(root, "js", "app.js"), "utf-8")
    .replace(/^import[\s\S]*?from "\.\/engine\.js";\n/m, "")
    .replace(/^import[\s\S]*?from "\.\/charts\.js";\n/m, "")
    .replace(/^export /gm, "");
  vm.runInNewContext([engineSrc, chartsSrc, appSrc].join("\n"), sandbox);
  documentMock.dispatchLoaded();
  // 触发 DOMContentLoaded
  return { sandbox, byId, documentMock };
}

describe("应用冒烟（DOM 桩）", () => {
  test("初始化后 KPI、产品行、图表均渲染且无异常", () => {
    const { byId } = loadApp();
    const kpiCount = byId.get("kpiGrid").children.length;
    assert.equal(kpiCount, 5);
    const tbody = byId.get("productTable").children[0];
    assert.equal(tbody.children.length, 8); // 8 个产品
    // KPI 中存在“已过期”瓦片且数值 >=1（dwd_trade_order_detail 逾期）
    const kpiText = byId.get("kpiGrid").textContent;
    assert.match(kpiText, /已过期/);
    // 三个图表容器都产生了 svg
    for (const id of ["barChart", "lineChart", "heatmap"]) {
      assert.ok(byId.get(id).querySelector("svg"), `${id} 应渲染 svg`);
    }
  });

  test("状态筛选只保留对应状态的行", () => {
    const { byId, documentMock } = loadApp();
    const chip = byId.get("chip-overdue");
    chip.dispatch("click");
    const tbody = byId.get("productTable").children[0];
    assert.ok(tbody.children.length >= 1);
    assert.ok(tbody.children.length < 8);
    documentMock.getElementById("resetFilters").dispatch("click");
    assert.equal(byId.get("productTable").children[0].children.length, 8);
  });

  test("点击产品行打开抽屉并包含关键信息块", () => {
    const { byId } = loadApp();
    const tbody = byId.get("productTable").children[0];
    // 找到 dwd_trade_order_detail 行并点击
    const row = tbody.children.find((r) => r.textContent.includes("dwd_trade_order_detail"));
    assert.ok(row);
    row.dispatch("click");
    const drawer = byId.get("drawer");
    assert.ok(drawer.classList.has("open"));
    const text = drawer.textContent;
    assert.match(text, /当前异常与缺失分区/);
    assert.match(text, /最近成功批次/);
    assert.match(text, /下游使用方/);
    assert.match(text, /异常历史/);
    assert.match(text, /调整 SLA 承诺/);
    // 当前逾期产品应列出 06-09 四个缺失分区
    assert.match(text, /2026-11-13 06:00/);
    assert.match(text, /2026-11-13 09:00/);
    // 受影响消费者含传递下游
    assert.match(text, /高管驾驶舱/);
  });

  test("承诺调整后状态重算并写入变更史", () => {
    const { byId } = loadApp();
    const tbody = byId.get("productTable").children[0];
    const row = tbody.children.find((r) => r.textContent.includes("dwd_trade_order_detail"));
    row.dispatch("click");
    const drawer = byId.get("drawer");
    const form = drawer.querySelector("form");
    const inputs = drawer.querySelectorAll("input");
    const delayInput = inputs.find((i) => i.id === "slaDelay");
    const reasonInput = inputs.find((i) => i.id === "slaReason");
    delayInput.value = "999";
    reasonInput.value = "冒烟测试放宽";
    form.dispatch("submit", { preventDefault() {} });
    // 抽屉重绘后仍打开，且出现变更记录
    const text = byId.get("drawer").textContent;
    assert.match(text, /冒烟测试放宽/);
    assert.match(text, /999/);
  });

  test("回放滑到起点：无当前逾期分区之外的异常状态变化可被驱动", () => {
    const { sandbox, documentMock } = loadApp();
    const demoStart = sandbox.parseTime(sandbox.FRESH_DATA.meta.demoStart);
    const slider = documentMock.getElementById("timeSlider");
    assert.ok(slider, "timeSlider 应存在");
    slider.value = String(demoStart);
    slider.dispatch("input");
    // 起点时刻产品表仍可正常渲染（行数不报错）
    const tbody = documentMock.getElementById("productTable").children[0];
    assert.ok(tbody.children.length <= 8);
    assert.match(documentMock.getElementById("clock").textContent, /2026-11-06/);
  });

  test("高影响筛选只保留影响分>=75的产品", () => {
    const { documentMock } = loadApp();
    const cb = documentMock.getElementById("highImpact");
    assert.ok(cb, "highImpact 复选框应存在");
    cb.checked = true;
    cb.dispatch("change");
    const tbody = documentMock.getElementById("productTable").children[0];
    // 数据中 impactScore>=75 的有 5 个：ods/dwd/dws/ads_sales/ads_finance
    assert.equal(tbody.children.length, 5);
  });
});
