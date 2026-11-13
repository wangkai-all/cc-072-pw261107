import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import {
  MINUTE, HOUR, DAY, STATUS, parseTime, dayKey, partitionKeyOf, nominalSlots,
  effectiveSchedule, calendarLookup, buildRunIndex, buildLineage,
  evaluateProduct, evaluateAll, buildIncidentHistory, buildDailyTrend,
  buildPartitionMatrix,
} from "../js/engine.js";

const T = (s) => parseTime(s);

function ctxOf(data) {
  return {
    isCalendarActive: calendarLookup(data.calendars),
    runIndex: buildRunIndex(data.runs),
    lineage: buildLineage(data.products),
    commitmentHistory: data.commitmentHistory || [],
  };
}

// ------------------------------------------------------------ 最小合成夹具
function fixture() {
  const calendars = [
    {
      id: "cal", name: "测试日历",
      holidays: [{ date: "2026-11-02", name: "虚构假日" }],
      maintenance: [{
        id: "mw1", start: "2026-11-05T02:00", end: "2026-11-05T04:00",
        reason: "计划维护", productScope: ["tbl_daily"],
      }],
    },
  ];
  const products = [
    {
      id: "tbl_hourly", name: "tbl_hourly", cnName: "小时表", layer: "DWD",
      owner: "x", tier: "P0", impactScore: 90, calendarId: "cal",
      visibleFrom: "2026-11-03T00:00",
      schedule: { frequency: "hourly", hour: null, minute: 0, weekday: null, dayOfMonth: null, delayMinutes: 30, warnMinutes: 10 },
      consumers: [{ id: "rpt1", name: "报表1", type: "report", criticality: "high" }],
    },
    {
      id: "tbl_daily", name: "tbl_daily", cnName: "日表", layer: "ADS",
      owner: "x", tier: "P1", impactScore: 60, calendarId: "cal",
      visibleFrom: "2026-11-03T00:00",
      schedule: { frequency: "daily", hour: 3, minute: 0, weekday: null, dayOfMonth: null, delayMinutes: 60, warnMinutes: 30 },
      consumers: [],
    },
  ];
  return { calendars, products, runs: [], commitmentHistory: [] };
}

function successRun(productId, partition, startedAt, finishedAt, attempt = 1) {
  return {
    runId: `${productId}#${partition}#${attempt}`, productId, partition, attempt,
    trigger: attempt === 1 ? "scheduled" : "retry", status: "success",
    startedAt, finishedAt, rowsLoaded: 100, errorMessage: null,
  };
}
function failedRun(productId, partition, startedAt, finishedAt, attempt = 1, error = "失败") {
  return {
    runId: `${productId}#${partition}#${attempt}`, productId, partition, attempt,
    trigger: attempt === 1 ? "scheduled" : "retry", status: "failed",
    startedAt, finishedAt, rowsLoaded: null, errorMessage: error,
  };
}
function runningRun(productId, partition, startedAt, attempt = 1) {
  return {
    runId: `${productId}#${partition}#${attempt}`, productId, partition, attempt,
    trigger: attempt === 1 ? "scheduled" : "retry", status: "running",
    startedAt, finishedAt: null, rowsLoaded: null, errorMessage: null,
  };
}

/** 为小时表填充 [当天 00:00, untilHour) 的按时成功批次，只让测试关心的分区留空 */
function fillHourlyHistory(f, productId, day, untilHour, sched) {
  for (let h = 0; h < untilHour; h += 1) {
    const part = `${day} ${String(h).padStart(2, "0")}:00`;
    const start = `${day}T${String(h).padStart(2, "0")}:02`;
    const finishMin = 2 + Math.max(4, sched.delayMinutes - 10);
    const fin = `${day}T${String(h).padStart(2, "0")}:${String(finishMin).padStart(2, "0")}`;
    f.runs.push({ ...successRun(productId, part, start, fin), runId: `fill#${productId}#${part}` });
  }
}

describe("调度与日历", () => {
  test("小时槽位按整点枚举", () => {
    const sched = { frequency: "hourly", delayMinutes: 30, warnMinutes: 10 };
    const slots = nominalSlots(sched, T("2026-11-03T00:10"), T("2026-11-03T03:00"));
    assert.deepEqual(slots.map((s) => new Date(s).getHours()), [0, 1, 2, 3]);
  });

  test("日/周/月槽位", () => {
    const daily = nominalSlots({ frequency: "daily", hour: 5, minute: 0 }, T("2026-11-01T00:00"), T("2026-11-03T00:00"));
    assert.equal(daily.length, 2);
    const weekly = nominalSlots({ frequency: "weekly", hour: 9, minute: 0, weekday: 1 }, T("2026-11-01T00:00"), T("2026-11-10T00:00"));
    assert.deepEqual(weekly.map((s) => dayKey(s)), ["2026-11-02", "2026-11-09"]);
    const monthly = nominalSlots({ frequency: "monthly", hour: 8, minute: 0, dayOfMonth: 1 }, T("2026-10-15T00:00"), T("2026-12-02T00:00"));
    assert.deepEqual(monthly.map((s) => dayKey(s)), ["2026-11-01", "2026-12-01"]);
  });

  test("节假日与维护窗口判定", () => {
    const f = fixture();
    const active = calendarLookup(f.calendars);
    assert.equal(active("cal", "tbl_daily", T("2026-11-02T03:00")).active, false);
    assert.equal(active("cal", "tbl_daily", T("2026-11-03T03:00")).active, true);
    const mw = active("cal", "tbl_daily", T("2026-11-05T03:00"));
    assert.equal(mw.active, false);
    assert.equal(mw.reason.type, "maintenance");
    // 维护窗口有产品范围：其他产品不受影响
    assert.equal(active("cal", "tbl_hourly", T("2026-11-05T03:00")).active, true);
  });
});

describe("状态机：按时 / 临近超时 / 已过期", () => {
  test("按时成功 -> on_time", () => {
    const f = fixture();
    fillHourlyHistory(f, "tbl_hourly", "2026-11-03", 8, f.products[0].schedule);
    f.runs.push(successRun("tbl_hourly", "2026-11-03 08:00", "2026-11-03T08:02", "2026-11-03T08:20"));
    const e = evaluateProduct(f.products[0], ctxOf(f), T("2026-11-03T08:45"));
    assert.equal(e.status, STATUS.ON_TIME);
    assert.equal(e.missing.length, 0);
    assert.equal(e.lastSuccess.partition, "2026-11-03 08:00");
  });

  test("未到 deadline 但进入预警窗口 -> warning", () => {
    const f = fixture();
    // 08:00 分区成功；09:00 分区无批次，deadline 09:30，预警 09:20
    fillHourlyHistory(f, "tbl_hourly", "2026-11-03", 8, f.products[0].schedule);
    f.runs.push(successRun("tbl_hourly", "2026-11-03 08:00", "2026-11-03T08:02", "2026-11-03T08:20"));
    const e = evaluateProduct(f.products[0], ctxOf(f), T("2026-11-03T09:25"));
    assert.equal(e.status, STATUS.WARNING);
    assert.equal(e.waiting[0].partition, "2026-11-03 09:00");
    assert.equal(e.missing.length, 0);
  });

  test("越过 deadline 无批次 -> overdue，缺失分区列出", () => {
    const f = fixture();
    fillHourlyHistory(f, "tbl_hourly", "2026-11-03", 8, f.products[0].schedule);
    f.runs.push(successRun("tbl_hourly", "2026-11-03 08:00", "2026-11-03T08:02", "2026-11-03T08:20"));
    const e = evaluateProduct(f.products[0], ctxOf(f), T("2026-11-03T09:45"));
    assert.equal(e.status, STATUS.OVERDUE);
    assert.deepEqual(e.missing.map((m) => m.partition), ["2026-11-03 09:00"]);
    assert.equal(e.currentIncident.overdueMinutes, 15);
    assert.match(e.currentIncident.reason, /上游/);
  });

  test("运行中的批次越过 deadline 仍算 overdue", () => {
    const f = fixture();
    fillHourlyHistory(f, "tbl_hourly", "2026-11-03", 9, f.products[0].schedule);
    f.runs.push(runningRun("tbl_hourly", "2026-11-03 09:00", "2026-11-03T09:05"));
    const e = evaluateProduct(f.products[0], ctxOf(f), T("2026-11-03T09:45"));
    assert.equal(e.status, STATUS.OVERDUE);
    assert.equal(e.missing[0].state, "running");
  });
});

describe("计划停更不得误报", () => {
  test("维护窗口内的日槽位不产生缺失，状态为 paused", () => {
    const f = fixture();
    // tbl_daily 11-05 03:00 槽位落在 02:00-04:00 维护窗口；隔离掉更早的槽位
    f.products[1].visibleFrom = "2026-11-05T00:00";
    const e = evaluateProduct(f.products[1], ctxOf(f), T("2026-11-05T03:30"));
    assert.equal(e.status, STATUS.PAUSED);
    assert.equal(e.missing.length, 0);
    assert.equal(e.pausedReason.type, "maintenance");
    // 维护结束后：该槽位仍不构成缺失（计划停更无调度义务）
    const after = evaluateProduct(f.products[1], ctxOf(f), T("2026-11-05T05:00"));
    assert.equal(after.missing.length, 0);
  });

  test("节假日槽位不产生事件", () => {
    const f = fixture();
    const incidents = buildIncidentHistory(f.products, f.runs, f.calendars, [],
      T("2026-11-01T00:00"), T("2026-11-03T12:00"));
    const holidayIncidents = incidents.filter((i) => i.partition === "2026-11-02");
    assert.equal(holidayIncidents.length, 0);
  });
});

describe("重试去重与迟到补齐", () => {
  test("同一分区多次重试只产生一个成功分区，按时则无事件", () => {
    const f = fixture();
    fillHourlyHistory(f, "tbl_hourly", "2026-11-03", 8, f.products[0].schedule); // 00-07 成功
    f.runs.push(
      failedRun("tbl_hourly", "2026-11-03 08:00", "2026-11-03T08:03", "2026-11-03T08:10", 1),
      successRun("tbl_hourly", "2026-11-03 08:00", "2026-11-03T08:12", "2026-11-03T08:25", 2),
    );
    const idx = buildRunIndex(f.runs);
    const rec = idx.get("tbl_hourly").get("2026-11-03 08:00");
    assert.equal(rec.state, "success");
    assert.equal(rec.attempts.length, 2);
    const e = evaluateProduct(f.products[0], ctxOf(f), T("2026-11-03T08:45"));
    assert.equal(e.status, STATUS.ON_TIME);
    assert.equal(e.lastSuccess.attempts, 2);
    assert.equal(e.lastSuccess.retryRuns, 1);
    const incidents = buildIncidentHistory(f.products, f.runs, f.calendars, [],
      T("2026-11-03T00:00"), T("2026-11-03T09:00"))
      .filter((i) => i.productId === "tbl_hourly");
    assert.equal(incidents.length, 0);
  });

  test("迟到补齐：事件关闭但历史保留，消费者保留", () => {
    const f = fixture();
    // deadline 09:30；09:50 才补齐
    fillHourlyHistory(f, "tbl_hourly", "2026-11-03", 9, f.products[0].schedule); // 00-08 成功
    f.runs.push(
      failedRun("tbl_hourly", "2026-11-03 09:00", "2026-11-03T09:03", "2026-11-03T09:10", 1),
      successRun("tbl_hourly", "2026-11-03 09:00", "2026-11-03T09:40", "2026-11-03T09:50", 2),
    );
    // 观测窗口在 10:00 槽位进入预警（10:20）前结束，避免无关槽位干扰
    const incidents = buildIncidentHistory(f.products, f.runs, f.calendars, [],
      T("2026-11-03T00:00"), T("2026-11-03T10:15"))
      .filter((i) => i.productId === "tbl_hourly");
    assert.equal(incidents.length, 1);
    const inc = incidents[0];
    assert.equal(inc.open, false);
    assert.equal(inc.recoveredAt, T("2026-11-03T09:50"));
    assert.equal(inc.durationMinutes, 20);
    assert.equal(inc.affectedConsumers[0].id, "rpt1");
    // 补齐后当前状态恢复 on_time
    const e = evaluateProduct(f.products[0], ctxOf(f), T("2026-11-03T10:15"));
    assert.equal(e.status, STATUS.ON_TIME);
    assert.equal(e.missing.length, 0);
  });

  test("回放可见性：未来才完成的批次在历史时刻不可见，补齐后状态恢复且历史保留", () => {
    const f = fixture();
    // 09:00 分区 deadline 09:30；09:50 才成功补齐
    fillHourlyHistory(f, "tbl_hourly", "2026-11-03", 9, f.products[0].schedule);
    f.runs.push(
      failedRun("tbl_hourly", "2026-11-03 09:00", "2026-11-03T09:03", "2026-11-03T09:10", 1),
      successRun("tbl_hourly", "2026-11-03 09:00", "2026-11-03T09:40", "2026-11-03T09:50", 2),
    );
    // 09:20：成功批次尚未发生，即使数据集中已含该记录也必须视为缺失 -> 预警
    const before = evaluateProduct(f.products[0], ctxOfAt(f, T("2026-11-03T09:20")), T("2026-11-03T09:20"));
    assert.equal(before.status, STATUS.WARNING);
    // 09:40：越过 deadline 但补齐批次未完成 -> 逾期
    const overdue = evaluateProduct(f.products[0], ctxOfAt(f, T("2026-11-03T09:40")), T("2026-11-03T09:40"));
    assert.equal(overdue.status, STATUS.OVERDUE);
    // 10:00：补齐已发生 -> 恢复按时，违约事实留在 lateRecovered
    const recovered = evaluateProduct(f.products[0], ctxOfAt(f, T("2026-11-03T10:00")), T("2026-11-03T10:00"));
    assert.equal(recovered.status, STATUS.ON_TIME);
    assert.equal(recovered.lateRecovered[0].partition, "2026-11-03 09:00");
  });

  test("分区矩阵中同分区重试只计一次", () => {
    const f = fixture();
    f.runs.push(
      failedRun("tbl_hourly", "2026-11-03 08:00", "2026-11-03T08:03", "2026-11-03T08:10", 1),
      failedRun("tbl_hourly", "2026-11-03 08:00", "2026-11-03T08:12", "2026-11-03T08:18", 2),
      successRun("tbl_hourly", "2026-11-03 08:00", "2026-11-03T08:20", "2026-11-03T08:25", 3),
    );
    const matrix = buildPartitionMatrix(f.products, f.runs, f.calendars, [],
      T("2026-11-03T00:00"), T("2026-11-04T00:00"));
    const cell = matrix[0].row[0];
    assert.equal(cell.expected, 24);
    assert.equal(cell.ok, 1);          // 重试三次仍只计一个成功分区
    assert.ok(!cell.badParts.includes("2026-11-03 08:00"));
  });
});

function ctxOfAt(f, atMs) {
  return {
    isCalendarActive: calendarLookup(f.calendars),
    runIndex: buildRunIndex(f.runs, atMs),
    lineage: buildLineage(f.products),
    commitmentHistory: f.commitmentHistory,
  };
}

describe("承诺调整", () => {
  test("SLA 历史按生效时间改变 delayMinutes", () => {
    const f = fixture();
    f.commitmentHistory = [{
      id: "c1", productId: "tbl_daily", effectiveFrom: "2026-11-04T00:00",
      field: "delayMinutes", oldValue: 60, newValue: 120, reason: "评审", operator: "治理组",
    }];
    const before = effectiveSchedule(f.products[1], f.commitmentHistory, T("2026-11-03T00:00"));
    const after = effectiveSchedule(f.products[1], f.commitmentHistory, T("2026-11-04T00:00"));
    assert.equal(before.delayMinutes, 60);
    assert.equal(after.delayMinutes, 120);
  });

  test("放宽承诺后原逾期分区恢复按时", () => {
    const f = fixture();
    // 隔离：产品 11-04 才上线，窗口内只有一个日槽位（03:00，原 deadline 04:00，04:20 成功）
    f.products[1].visibleFrom = "2026-11-04T00:00";
    f.runs.push(successRun("tbl_daily", "2026-11-04", "2026-11-04T03:10", "2026-11-04T04:20"));
    // 04:10 观测：04:20 才完成的批次尚不存在（模拟当时的运行记录视图）-> 逾期
    const visibleRuns = f.runs.filter((r) => T(r.finishedAt) <= T("2026-11-04T04:10"));
    const ctxBefore = { ...ctxOf(f), runIndex: buildRunIndex(visibleRuns) };
    const during = evaluateProduct(f.products[1], ctxBefore, T("2026-11-04T04:10"));
    assert.equal(during.status, STATUS.OVERDUE);
    // 04:20 补齐后：当前状态恢复，违约事实保留在 lateRecovered
    const recovered = evaluateProduct(f.products[1], ctxOf(f), T("2026-11-04T05:00"));
    assert.equal(recovered.status, STATUS.ON_TIME);
    assert.equal(recovered.lateRecovered[0].partition, "2026-11-04");
    // 放宽承诺至 120 分钟后，同一批次连历史违约都不再成立
    f.commitmentHistory = [{
      id: "c1", productId: "tbl_daily", effectiveFrom: "2026-11-04T00:00",
      field: "delayMinutes", oldValue: 60, newValue: 120, reason: "评审", operator: "治理组",
    }];
    const after = evaluateProduct(f.products[1], ctxOf(f), T("2026-11-04T05:00"));
    assert.equal(after.status, STATUS.ON_TIME);
    assert.equal(after.lateRecovered.length, 0);
  });
});

describe("血缘", () => {
  test("传递下游包含隔层报表且去重", () => {
    const f = fixture();
    f.products[0].consumers.push({ id: "tbl_daily", name: "日表", type: "table", criticality: "high" });
    const lineage = buildLineage(f.products);
    const all = lineage.transitive.get("tbl_hourly").map((c) => c.id);
    assert.ok(all.includes("rpt1"));
    assert.ok(all.includes("tbl_daily"));
    assert.equal(new Set(all).size, all.length);
  });
});

// ------------------------------------------------------------ 演示数据集端到端
// sample-data.js 是浏览器全局脚本（globalThis.FRESH_DATA = ...），用 vm 沙箱加载
const _dataPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "sample-data.js");
const _sandbox = { globalThis: {} };
_sandbox.globalThis = _sandbox;
vm.runInNewContext(readFileSync(_dataPath, "utf-8"), _sandbox);
const D = _sandbox.FRESH_DATA;
const demoEnd = T(D.meta.demoEnd);
const demoStart = T(D.meta.demoStart);

describe("演示数据端到端", () => {
  test("当前快照：dwd_trade_order_detail 逾期且列出 06-09 四个缺失分区", () => {
    const evals = evaluateAll(D.products, D.runs, D.calendars, D.commitmentHistory, demoEnd);
    const e = evals.find((x) => x.productId === "dwd_trade_order_detail");
    assert.equal(e.status, STATUS.OVERDUE);
    assert.deepEqual(e.missing.map((m) => m.partition),
      ["2026-11-13 06:00", "2026-11-13 07:00", "2026-11-13 08:00", "2026-11-13 09:00"]);
    // 受影响消费者含传递下游（ads 表之上的驾驶舱）
    const names = e.affectedConsumers.map((c) => c.name);
    assert.ok(names.includes("高管驾驶舱"));
  });

  test("计划维护的 ads_sales_dashboard 不报故障", () => {
    const incidents = buildIncidentHistory(D.products, D.runs, D.calendars, D.commitmentHistory, demoStart, demoEnd);
    const sales = incidents.filter((i) => i.productId === "ads_sales_dashboard");
    assert.equal(sales.length, 0);
    // 11-13 00:00-02:00 维护中的 management 看板同样无事件
    const mgmt = incidents.filter((i) => i.productId === "ads_management_dashboard");
    assert.equal(mgmt.length, 0);
  });

  test("节假日 11-02 不产生任何事件", () => {
    const incidents = buildIncidentHistory(D.products, D.runs, D.calendars, D.commitmentHistory, demoStart, demoEnd);
    assert.equal(incidents.some((i) => i.partition.startsWith("2026-11-02")), false);
  });

  test("历史异常：11-05 / 11-08 / 11-10 的迟到补齐事件均已关闭并保留", () => {
    const incidents = buildIncidentHistory(D.products, D.runs, D.calendars, D.commitmentHistory, demoStart, demoEnd);
    const closed = incidents.filter((i) => !i.open);
    const keys = closed.map((i) => `${i.productId}@${i.partition}`);
    assert.ok(keys.includes("dwd_trade_order_detail@2026-11-05 03:00"));
    assert.ok(keys.includes("dwd_click_stream@2026-11-08 21:00"));
    assert.ok(keys.includes("dws_user_act_daily@2026-11-10"));
    for (const i of closed) {
      assert.ok(i.recoveredAt > i.deadline);
      assert.ok(i.affectedConsumers.length > 0);
    }
  });

  test("ods 重试分区按时成功，无事件且重试数被记录", () => {
    const incidents = buildIncidentHistory(D.products, D.runs, D.calendars, D.commitmentHistory, demoStart, demoEnd);
    assert.equal(incidents.some((i) => i.productId === "ods_mysql_orders"), false);
    const evals = evaluateAll(D.products, D.runs, D.calendars, D.commitmentHistory, demoEnd);
    const e = evals.find((x) => x.productId === "ods_mysql_orders");
    assert.equal(e.status, STATUS.ON_TIME);
  });

  test("回放：11-13 09:35 时 09:00 分区处于预警，06-08 已逾期", () => {
    const evals = evaluateAll(D.products, D.runs, D.calendars, D.commitmentHistory, T("2026-11-13T09:35"));
    const e = evals.find((x) => x.productId === "dwd_trade_order_detail");
    assert.equal(e.status, STATUS.OVERDUE); // 已有逾期分区，整体取最严重状态
    assert.deepEqual(e.missing.map((m) => m.partition), ["2026-11-13 06:00", "2026-11-13 07:00", "2026-11-13 08:00"]);
    assert.equal(e.waiting.map((m) => m.partition)[0], "2026-11-13 09:00");
  });

  test("每日趋势与分区矩阵可计算且数字自洽", () => {
    const trend = buildDailyTrend(D.products, D.runs, D.calendars, D.commitmentHistory, demoStart, demoEnd);
    assert.ok(trend.length >= 7);
    for (const d of trend) {
      const c = d.counts;
      assert.equal(c.on_time + c.warning + c.overdue + c.paused, d.total);
      assert.ok(d.onTimeRate >= 0 && d.onTimeRate <= 1);
    }
    const matrix = buildPartitionMatrix(D.products, D.runs, D.calendars, D.commitmentHistory, demoStart, demoEnd);
    assert.equal(matrix.length, D.products.length);
    for (const row of matrix) {
      for (const cell of row.row) {
        assert.ok(cell.ok + cell.bad <= cell.expected + cell.paused + 1);
      }
    }
  });

  test("月结表 11-01 唯一槽位按时，无事件", () => {
    const incidents = buildIncidentHistory(D.products, D.runs, D.calendars, D.commitmentHistory, demoStart, demoEnd);
    assert.equal(incidents.some((i) => i.productId === "ads_finance_monthly"), false);
  });
});
