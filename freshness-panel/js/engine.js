/**
 * 数据产品新鲜度引擎
 * 纯函数、无 DOM 依赖，可在 Node 测试与浏览器中共用。
 *
 * 核心概念：
 *  - nominal slot（计划槽位）：按频率在日历上应产出的分区时刻
 *  - 日历（节假日 / 计划维护）内的槽位不产生调度义务，不记缺失
 *  - 状态：on_time（按时）/ warning（临近超时）/ overdue（已过期）/ paused（计划停更）
 *  - 事件（incident）：同一分区的一次异常生命周期，补齐后关闭但永久保留
 *  - 重试：同一分区的多次 attempt 只产生一个分区结果，新鲜度不重复计算
 */

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const STATUS = Object.freeze({
  ON_TIME: "on_time",
  WARNING: "warning",
  OVERDUE: "overdue",
  PAUSED: "paused",
});

// ---------------------------------------------------------------- 时间工具
export function parseTime(s) {
  if (s == null) return null;
  // 数据均为本地时区的无时区字符串：手工解析，避免 Date 把无后缀串当 UTC
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return new Date(s).getTime();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] || 0), 0).getTime();
}
export function toISO(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function partitionKeyOf(frequency, slotMs) {
  const d = new Date(slotMs);
  const p = (n) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (frequency === "hourly") return `${day} ${p(d.getHours())}:00`;
  return day;
}

// ---------------------------------------------------------------- 承诺（SLA）调整
/** 承诺历史按生效时间作用于评估时刻；当前登记值为最新值 */
export function effectiveSchedule(product, commitmentHistory, atMs) {
  const base = { ...product.schedule };
  const changes = (commitmentHistory || [])
    .filter((c) => c.productId === product.id && parseTime(c.effectiveFrom) <= atMs)
    .sort((a, b) => parseTime(a.effectiveFrom) - parseTime(b.effectiveFrom));
  for (const c of changes) {
    if (c.field in base) base[c.field] = c.newValue;
  }
  // 预警窗口不能大于容忍延迟
  base.warnMinutes = Math.max(0, Math.min(base.warnMinutes, base.delayMinutes));
  return base;
}

// ---------------------------------------------------------------- 日历
export function calendarLookup(calendars) {
  const map = new Map(calendars.map((c) => [c.id, c]));
  return (calendarId, productId, atMs) => {
    const cal = map.get(calendarId);
    if (!cal) return { active: true, reason: null };
    const d = new Date(atMs);
    const p = (n) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    for (const h of cal.holidays || []) {
      if (h.date === day) {
        return { active: false, reason: { type: "holiday", message: h.name, calendarName: cal.name } };
      }
    }
    for (const w of cal.maintenance || []) {
      const scope = w.productScope;
      const inScope = !scope || scope.includes(productId);
      if (inScope && parseTime(w.start) <= atMs && atMs < parseTime(w.end)) {
        return { active: false, reason: { type: "maintenance", message: w.reason, calendarName: cal.name, windowId: w.id } };
      }
    }
    return { active: true, reason: null };
  };
}

/** 枚举 [fromMs, toMs] 内的计划槽位（只按频率，不考虑日历） */
export function nominalSlots(schedule, fromMs, toMs) {
  const out = [];
  const f = schedule.frequency;
  const d = new Date(fromMs);
  if (f === "hourly") {
    d.setMinutes(0, 0, 0);
    for (let t = d.getTime(); t <= toMs; t += HOUR) out.push(t);
    return out;
  }
  if (f === "daily" || f === "weekly") {
    const first = new Date(fromMs);
    first.setHours(schedule.hour, schedule.minute, 0, 0);
    let t = first.getTime();
    if (f === "weekly") {
      while (new Date(t).getDay() !== schedule.weekday) t += DAY; // getDay: 0=周日
    }
    const step = f === "weekly" ? 7 * DAY : DAY;
    while (t <= toMs) {
      out.push(t);
      t += step;
    }
    return out;
  }
  if (f === "monthly") {
    let y = d.getFullYear();
    let m = d.getMonth();
    let t = new Date(y, m, schedule.dayOfMonth, schedule.hour, schedule.minute, 0, 0).getTime();
    if (t < fromMs) {
      m += 1;
      if (m > 11) { m = 0; y += 1; }
      t = new Date(y, m, schedule.dayOfMonth, schedule.hour, schedule.minute, 0, 0).getTime();
    }
    while (t <= toMs) {
      out.push(t);
      t = new Date(new Date(t).getFullYear(), new Date(t).getMonth() + 1, schedule.dayOfMonth,
        schedule.hour, schedule.minute, 0, 0).getTime();
    }
    return out;
  }
  throw new Error(`unknown frequency: ${f}`);
}

// ---------------------------------------------------------------- 运行索引
/**
 * 按产品聚合运行记录。
 * 每个分区只保留一个 PartitionResult（重试不重复计算新鲜度）：
 * 成功 -> 取该分区首次成功的完成时间与行数；失败/运行中 -> 最新 attempt 状态
 *
 * visibleAtMs：观测时刻。晚于该时刻才结束的批次属于“未来记录”，
 * 回放历史时刻时必须忽略（running 批次的 startedAt 已发生则仍可见）。
 */
export function buildRunIndex(runs, visibleAtMs = Infinity) {
  const byProduct = new Map();
  for (const r of runs) {
    if (r.status === "success" && r.finishedAt && parseTime(r.finishedAt) > visibleAtMs) {
      continue; // 未来才完成的成功批次，此刻尚不存在
    }
    if (r.status === "failed" && r.finishedAt && parseTime(r.finishedAt) > visibleAtMs) {
      continue; // 未来才结束的失败批次，此刻仍在运行
    }
    if (!byProduct.has(r.productId)) byProduct.set(r.productId, new Map());
    const byPart = byProduct.get(r.productId);
    if (!byPart.has(r.partition)) {
      byPart.set(r.partition, {
        partition: r.partition,
        attempts: [],
        state: "missing",
        successAt: null,
        rowsLoaded: null,
        latestRunId: null,
      });
    }
    const rec = byPart.get(r.partition);
    rec.attempts.push(r);
    rec.latestRunId = r.runId;
    if (r.status === "success") {
      if (rec.state !== "success") {
        rec.state = "success";
        rec.successAt = parseTime(r.finishedAt);
        rec.rowsLoaded = r.rowsLoaded;
      }
    } else if (r.status === "running" && rec.state !== "success") {
      rec.state = "running"; // failed -> running（重试中）也允许转移
    } else if (r.status === "failed" && (rec.state === "missing" || rec.state === "running")) {
      rec.state = "failed";
    }
  }
  for (const byPart of byProduct.values()) {
    for (const rec of byPart.values()) {
      rec.attempts.sort((a, b) => parseTime(a.startedAt) - parseTime(b.startedAt));
    }
  }
  return byProduct;
}

// ---------------------------------------------------------------- 下游血缘
/** 直接下游 + 传递下游（表 -> 表 -> 报表/看板），用于评估受影响消费者 */
export function buildLineage(products) {
  const direct = new Map();
  for (const p of products) {
    direct.set(p.id, (p.consumers || []).map((c) => ({ ...c, via: p.id })));
  }
  const productIds = new Set(products.map((p) => p.id));
  const transitive = new Map();
  function walk(id, seen, path) {
    const out = [];
    for (const c of direct.get(id) || []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ ...c, path: [...path, c.id] });
      if (productIds.has(c.id)) out.push(...walk(c.id, seen, [...path, c.id]));
    }
    return out;
  }
  for (const p of products) {
    transitive.set(p.id, walk(p.id, new Set(), [p.id]));
  }
  return { direct, transitive };
}

// ---------------------------------------------------------------- 单产品评估
/**
 * 在 atMs 时刻评估一个数据产品。
 * 返回状态、最近成功批次、缺失/等待中的分区、滞后分钟数、当前事件等。
 */
export function evaluateProduct(product, ctx, atMs) {
  const { isCalendarActive, runIndex, lineage, commitmentHistory } = ctx;
  const sched = effectiveSchedule(product, commitmentHistory, atMs);
  const byPart = runIndex.get(product.id) || new Map();

  // 枚举已进入预警窗口的槽位（未到 warnAt 的槽位尚无任何义务）
  const horizon = atMs;
  const slots = nominalSlots(sched, parseTime(product.visibleFrom), horizon).filter(
    (t) => t + (sched.delayMinutes - sched.warnMinutes) * MINUTE <= horizon
  );

  const missing = [];
  const waiting = [];
  const lateRecovered = [];
  let currentIncident = null;
  let pausedNow = null;

  for (const slot of slots) {
    const cal = isCalendarActive(product.calendarId, product.id, slot);
    if (!cal.active) continue; // 计划停更：无调度义务
    const key = partitionKeyOf(sched.frequency, slot);
    const rec = byPart.get(key);
    const deadline = slot + sched.delayMinutes * MINUTE;
    const warnAt = deadline - sched.warnMinutes * MINUTE;
    const base = { partition: key, slot, deadline, warnAt };

    if (rec && rec.state === "success") {
      if (rec.successAt > deadline) {
        // 迟到补齐：当前状态已恢复，不计入当前缺失；违约事实由 incidentHistory 保留
        lateRecovered.push({
          ...base, state: "recovered", latestRunId: rec.latestRunId,
          successAt: rec.successAt,
          overdueMinutes: Math.round((rec.successAt - deadline) / MINUTE),
        });
      }
      continue;
    }
    // 未成功的分区
    if (atMs >= deadline) {
      missing.push({ ...base, state: rec ? rec.state : "missing", latestRunId: rec ? rec.latestRunId : null });
      if (!currentIncident) {
        currentIncident = {
          partition: key,
          slot,
          deadline,
          overdueMinutes: Math.round((atMs - deadline) / MINUTE),
          state: rec ? rec.state : "missing",
          reason: rec && rec.attempts && rec.attempts.length
            ? (rec.attempts[rec.attempts.length - 1].errorMessage || "批次执行失败")
            : "未收到任何批次（可能为上游断流）",
        };
      }
    } else if (atMs >= warnAt) {
      waiting.push({ ...base, state: rec ? rec.state : "missing", latestRunId: rec ? rec.latestRunId : null });
    }
  }

  // 当前时刻是否处于停更窗口（用于面板展示 paused 状态）
  const calNow = isCalendarActive(product.calendarId, product.id, atMs);
  if (!calNow.active) pausedNow = calNow.reason;

  // 最近成功批次
  let lastSuccess = null;
  for (const rec of byPart.values()) {
    if (rec.state === "success" && rec.successAt <= atMs) {
      if (!lastSuccess || rec.successAt > lastSuccess.successAt) {
        const attempts = rec.attempts.filter((a) => a.status === "success");
        lastSuccess = {
          partition: rec.partition,
          successAt: rec.successAt,
          rowsLoaded: rec.rowsLoaded,
          attempts: rec.attempts.length,
          retryRuns: rec.attempts.length - 1,
          firstError: rec.attempts.find((a) => a.status === "failed")?.errorMessage || null,
          runId: attempts[0]?.runId || rec.latestRunId,
        };
      }
    }
  }

  // 新鲜度滞后：当前时刻相对最近成功数据分区的时间
  let lagMinutes = null;
  if (lastSuccess) {
    const slotOfLast = parseTime(lastSuccess.partition.length === 10 ? `${lastSuccess.partition}T00:00` : lastSuccess.partition.replace(" ", "T"));
    lagMinutes = Math.max(0, Math.round((atMs - slotOfLast) / MINUTE));
  }

  // 状态判定
  let status;
  if (missing.length > 0) status = STATUS.OVERDUE;
  else if (waiting.length > 0) status = STATUS.WARNING;
  else if (pausedNow) status = STATUS.PAUSED;
  else status = STATUS.ON_TIME;

  return {
    productId: product.id,
    status,
    pausedReason: pausedNow,
    schedule: sched,
    missing,
    waiting,
    lateRecovered,
    currentIncident,
    lastSuccess,
    lagMinutes,
    affectedConsumers: (lineage.transitive.get(product.id) || []).map((c) => ({
      id: c.id, name: c.name, type: c.type, criticality: c.criticality, path: c.path,
    })),
    evaluatedAt: atMs,
  };
}

// ---------------------------------------------------------------- 事件时间线
/**
 * 全量扫描演示窗口，产出每个产品的异常生命周期。
 * 每个逾期分区对应一个 incident：
 *  - openedAt：首次越过 deadline 的检查点
 *  - recoveredAt：该分区首次成功的完成时间（迟到补齐）；窗口结束仍未成功则保持 open
 * 计划停更窗口内的槽位永不产生事件。
 */
export function buildIncidentHistory(products, runs, calendars, commitmentHistory, demoStart, demoEnd, stepMinutes = 30) {
  const isCalendarActive = calendarLookup(calendars);
  const runIndex = buildRunIndex(runs);
  const lineage = buildLineage(products);
  const ctx = { isCalendarActive, runIndex, lineage, commitmentHistory };
  const incidents = [];

  for (const product of products) {
    const sched = effectiveSchedule(product, commitmentHistory, demoEnd);
    const byPart = runIndex.get(product.id) || new Map();
    const slots = nominalSlots(sched, parseTime(product.visibleFrom), demoEnd)
      .filter((t) => t + sched.delayMinutes * MINUTE <= demoEnd);
    for (const slot of slots) {
      const cal = isCalendarActive(product.calendarId, product.id, slot);
      if (!cal.active) continue;
      const key = partitionKeyOf(sched.frequency, slot);
      const rec = byPart.get(key);
      if (rec && rec.state === "success" && rec.successAt <= slot + sched.delayMinutes * MINUTE) {
        continue; // 按时成功，无事件
      }
      const deadline = slot + sched.delayMinutes * MINUTE;
      if (deadline > demoEnd) continue; // 窗口内尚未到点，不构成历史事件
      const attempts = rec ? rec.attempts : [];
      const lastFail = [...attempts].reverse().find((a) => a.status === "failed");
      const incident = {
        id: `${product.id}::${key}`,
        productId: product.id,
        partition: key,
        slot,
        deadline,
        openedAt: deadline,
        recoveredAt: rec && rec.state === "success" ? rec.successAt : null,
        durationMinutes: rec && rec.state === "success"
          ? Math.round((rec.successAt - deadline) / MINUTE)
          : Math.round((demoEnd - deadline) / MINUTE),
        open: !(rec && rec.state === "success"),
        attempts: attempts.length,
        retryRuns: Math.max(0, attempts.length - 1),
        reason: lastFail?.errorMessage || (rec ? "批次未成功完成" : "未收到任何批次（上游断流）"),
        affectedConsumers: (lineage.transitive.get(product.id) || []).map((c) => ({
          id: c.id, name: c.name, type: c.type, criticality: c.criticality, path: c.path,
        })),
        rowsLoaded: rec && rec.state === "success" ? rec.rowsLoaded : null,
      };
      incidents.push(incident);
    }
  }
  incidents.sort((a, b) => b.openedAt - a.openedAt);
  return incidents;
}

// ---------------------------------------------------------------- 全量评估（某时刻快照）
export function evaluateAll(products, runs, calendars, commitmentHistory, atMs) {
  const ctx = {
    isCalendarActive: calendarLookup(calendars),
    runIndex: buildRunIndex(runs, atMs),
    lineage: buildLineage(products),
    commitmentHistory,
  };
  return products.map((p) => evaluateProduct(p, ctx, atMs));
}

// ---------------------------------------------------------------- 每日趋势
/** 每日结束时刻（或 demoEnd 对当天）的状态与 SLA 达成率序列 */
export function buildDailyTrend(products, runs, calendars, commitmentHistory, demoStart, demoEnd) {
  const days = [];
  const startDay = new Date(demoStart);
  startDay.setHours(0, 0, 0, 0);
  for (let t = startDay.getTime(); t <= demoEnd; t += DAY) {
    const end = Math.min(t + DAY - MINUTE, demoEnd);
    const evals = evaluateAll(products, runs, calendars, commitmentHistory, end);
    const counts = { on_time: 0, warning: 0, overdue: 0, paused: 0 };
    let onTimeContracts = 0;
    let totalContracts = 0;
    for (const e of evals) {
      counts[e.status] = (counts[e.status] || 0) + 1;
      if (e.status !== STATUS.PAUSED) {
        totalContracts += 1;
        if (e.status === STATUS.ON_TIME) onTimeContracts += 1;
      }
    }
    days.push({
      date: dayKey(end),
      atMs: end,
      counts,
      total: evals.length,
      onTimeRate: totalContracts ? onTimeContracts / totalContracts : 1,
    });
  }
  return days;
}

// ---------------------------------------------------------------- 分区健康矩阵（热力图）
/** 每个产品 × 每天：成功分区数 / 应到分区数 / 异常分区数 */
export function buildPartitionMatrix(products, runs, calendars, commitmentHistory, demoStart, demoEnd) {
  const isCalendarActive = calendarLookup(calendars);
  const runIndex = buildRunIndex(runs);
  const days = [];
  const startDay = new Date(demoStart);
  startDay.setHours(0, 0, 0, 0);
  for (let t = startDay.getTime(); t < demoEnd; t += DAY) days.push(dayKey(t));

  return products.map((product) => {
    const sched = effectiveSchedule(product, commitmentHistory, demoEnd);
    const byPart = runIndex.get(product.id) || new Map();
    const row = days.map((d) => {
      const dayStart = parseTime(`${d}T00:00`);
      const dayEnd = Math.min(dayStart + DAY, demoEnd);
      const slots = nominalSlots(sched, dayStart, dayEnd - MINUTE);
      let expected = 0;
      let ok = 0;
      let bad = 0;
      let paused = 0;
      const badParts = [];
      for (const slot of slots) {
        const cal = isCalendarActive(product.calendarId, product.id, slot);
        if (!cal.active) { paused += 1; continue; }
        expected += 1;
        const key = partitionKeyOf(sched.frequency, slot);
        const rec = byPart.get(key);
        const deadline = slot + sched.delayMinutes * MINUTE;
        if (rec && rec.state === "success") {
          if (rec.successAt <= deadline || deadline > demoEnd) ok += 1;
          else { bad += 1; badParts.push(key); }
        } else if (deadline <= demoEnd) {
          bad += 1;
          badParts.push(key);
        }
      }
      return { date: d, expected, ok, bad, paused, badParts };
    });
    return { productId: product.id, row };
  });
}
