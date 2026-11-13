#!/usr/bin/env python3
"""生成新鲜度面板的虚构任务运行记录（确定性数据，固定随机种子）。

场景覆盖：
  - 正常按时交付
  - 上游延迟导致的当前未恢复异常（P0 高影响）
  - 迟到批次补齐后恢复（异常历史保留）
  - 计划维护 / 节假日停更（不得误报）
  - 同一分区多次重试（新鲜度只计一次）
  - 运行中批次、临近超时、月/周/小时/日多种频率
  - SLA 承诺调整历史

输出：data/sample-data.js （globalThis.FRESH_DATA = {...}）
"""
import json
import os
import random
from datetime import datetime, timedelta

random.seed(20261113)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "sample-data.js")

WINDOW_START = datetime(2026, 10, 25, 0, 0)
DEMO_START = datetime(2026, 11, 6, 0, 0)
DEMO_END = datetime(2026, 11, 13, 10, 0)


def iso(d):
    return d.strftime("%Y-%m-%dT%H:%M")


def parse(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M")


def pkey(freq, d):
    if freq == "hourly":
        return d.strftime("%Y-%m-%d %H:00")
    return d.strftime("%Y-%m-%d")


# ---------------------------------------------------------------- 日历
calendars = [
    {
        "id": "cal_7x24",
        "name": "7×24 实时日历",
        "description": "无停更窗口，实时链路全年按小时调度",
        "holidays": [],
        "maintenance": [],
    },
    {
        "id": "cal_cn",
        "name": "中国大陆工作日日历",
        "description": "含法定节假日与平台计划维护窗口",
        "holidays": [
            {"date": "2026-10-01", "name": "国庆节"},
            {"date": "2026-10-02", "name": "国庆节"},
            {"date": "2026-10-03", "name": "国庆节"},
            {"date": "2026-10-04", "name": "国庆节"},
            {"date": "2026-10-05", "name": "国庆节"},
            {"date": "2026-10-06", "name": "国庆节"},
            {"date": "2026-10-07", "name": "国庆节"},
            {"date": "2026-11-02", "name": "公司年度盘点假（虚构）"},
        ],
        "maintenance": [
            {
                "id": "mw_sales_patch",
                "start": "2026-11-05T04:00",
                "end": "2026-11-05T07:30",
                "reason": "ADS 库补丁升级（计划维护）",
                "productScope": ["ads_sales_dashboard"],
            },
            {
                "id": "mw_report_platform",
                "start": "2026-11-13T00:00",
                "end": "2026-11-14T02:00",
                "reason": "报表平台升级（计划维护）",
                "productScope": ["ads_management_dashboard"],
            },
        ],
    },
    {
        "id": "cal_finance",
        "name": "财务结算日历",
        "description": "财务域专用，节假日与月结冻结期不调度",
        "holidays": [
            {"date": "2026-11-02", "name": "公司年度盘点假（虚构）"},
        ],
        "maintenance": [],
    },
]

CAL_BY_ID = {c["id"]: c for c in calendars}


def window_applies(win, product_id):
    scope = win.get("productScope")
    return not scope or product_id in scope


def calendar_active(cal_id, product_id, d):
    """返回 (active, reason)。reason 描述停更类型。"""
    cal = CAL_BY_ID[cal_id]
    day = d.strftime("%Y-%m-%d")
    for h in cal["holidays"]:
        if h["date"] == day:
            return False, {"type": "holiday", "message": h["name"]}
    for win in cal["maintenance"]:
        s = datetime.strptime(win["start"], "%Y-%m-%dT%H:%M")
        e = datetime.strptime(win["end"], "%Y-%m-%dT%H:%M")
        if s <= d < e and window_applies(win, product_id):
            return False, {"type": "maintenance", "message": win["reason"]}
    return True, None


# ---------------------------------------------------------------- 产品登记
products = [
    {
        "id": "ods_mysql_orders",
        "name": "ods_mysql_orders",
        "cnName": "订单 MySQL 抽取层",
        "layer": "ODS",
        "owner": "数据平台组 · 阿宁",
        "tier": "P0",
        "impactScore": 95,
        "calendarId": "cal_7x24",
        "visibleFrom": "2026-10-25T00:00",
        "schedule": {
            "frequency": "hourly",
            "hour": None, "minute": 0, "weekday": None, "dayOfMonth": None,
            "delayMinutes": 40,
            "warnMinutes": 15,
        },
        "baseRows": 128000,
        "consumers": [
            {"id": "rpt_realtime_trade", "name": "实时交易大屏", "type": "dashboard", "criticality": "critical"},
            {"id": "tbl_dwd_trade", "name": "dwd_trade_order_detail", "type": "table", "criticality": "critical"},
            {"id": "rpt_risk_alert", "name": "风控告警报表", "type": "report", "criticality": "high"},
        ],
    },
    {
        "id": "dwd_trade_order_detail",
        "name": "dwd_trade_order_detail",
        "cnName": "交易明细宽表",
        "layer": "DWD",
        "owner": "交易域组 · 思远",
        "tier": "P0",
        "impactScore": 92,
        "calendarId": "cal_7x24",
        "visibleFrom": "2026-10-25T00:00",
        "schedule": {
            "frequency": "hourly",
            "hour": None, "minute": 0, "weekday": None, "dayOfMonth": None,
            "delayMinutes": 50,
            "warnMinutes": 20,
        },
        "baseRows": 265000,
        "consumers": [
            {"id": "rpt_exec_cockpit", "name": "高管驾驶舱", "type": "dashboard", "criticality": "critical"},
            {"id": "rpt_sales_daily", "name": "销售日清单", "type": "report", "criticality": "high"},
            {"id": "tbl_dws_user_act", "name": "dws_user_act_daily", "type": "table", "criticality": "high"},
            {"id": "tbl_ads_sales", "name": "ads_sales_dashboard", "type": "table", "criticality": "high"},
        ],
    },
    {
        "id": "dws_user_act_daily",
        "name": "dws_user_act_daily",
        "cnName": "用户活跃日汇总",
        "layer": "DWS",
        "owner": "用户增长组 · 知秋",
        "tier": "P1",
        "impactScore": 78,
        "calendarId": "cal_cn",
        "visibleFrom": "2026-10-25T00:00",
        "schedule": {
            "frequency": "daily",
            "hour": 3, "minute": 0, "weekday": None, "dayOfMonth": None,
            "delayMinutes": 180,
            "warnMinutes": 60,
        },
        "baseRows": 4200000,
        "consumers": [
            {"id": "rpt_retention", "name": "用户留存报表", "type": "report", "criticality": "high"},
            {"id": "rpt_member_board", "name": "会员分析看板", "type": "dashboard", "criticality": "medium"},
            {"id": "tbl_ads_mgmt", "name": "ads_management_dashboard", "type": "table", "criticality": "medium"},
        ],
    },
    {
        "id": "ads_sales_dashboard",
        "name": "ads_sales_dashboard",
        "cnName": "销售看板 ADS",
        "layer": "ADS",
        "owner": "BI 组 · 望舒",
        "tier": "P0",
        "impactScore": 90,
        "calendarId": "cal_cn",
        "visibleFrom": "2026-10-25T00:00",
        "schedule": {
            "frequency": "daily",
            "hour": 5, "minute": 0, "weekday": None, "dayOfMonth": None,
            "delayMinutes": 120,
            "warnMinutes": 45,
        },
        "baseRows": 86000,
        "consumers": [
            {"id": "rpt_sales_daily2", "name": "销售日清单", "type": "report", "criticality": "critical"},
            {"id": "rpt_exec_cockpit2", "name": "高管驾驶舱", "type": "dashboard", "criticality": "critical"},
        ],
    },
    {
        "id": "ads_management_dashboard",
        "name": "ads_management_dashboard",
        "cnName": "经营管理看板 ADS",
        "layer": "ADS",
        "owner": "BI 组 · 望舒",
        "tier": "P1",
        "impactScore": 72,
        "calendarId": "cal_cn",
        "visibleFrom": "2026-10-25T00:00",
        "schedule": {
            "frequency": "daily",
            "hour": 6, "minute": 0, "weekday": None, "dayOfMonth": None,
            "delayMinutes": 120,
            "warnMinutes": 45,
        },
        "baseRows": 12400,
        "consumers": [
            {"id": "rpt_monthly_review", "name": "经营分析月报", "type": "report", "criticality": "high"},
            {"id": "rpt_store_ops", "name": "门店运营看板", "type": "dashboard", "criticality": "medium"},
        ],
    },
    {
        "id": "dim_store_daily",
        "name": "dim_store_daily",
        "cnName": "门店维度日表",
        "layer": "DIM",
        "owner": "供应链组 · 南星",
        "tier": "P2",
        "impactScore": 58,
        "calendarId": "cal_cn",
        "visibleFrom": "2026-10-25T00:00",
        "schedule": {
            "frequency": "daily",
            "hour": 10, "minute": 30, "weekday": None, "dayOfMonth": None,
            "delayMinutes": 30,
            "warnMinutes": 60,
        },
        "baseRows": 9800,
        "consumers": [
            {"id": "rpt_store_ops2", "name": "门店运营看板", "type": "dashboard", "criticality": "medium"},
            {"id": "rpt_replenish", "name": "库存补货报表", "type": "report", "criticality": "medium"},
        ],
    },
    {
        "id": "ads_finance_monthly",
        "name": "ads_finance_monthly",
        "cnName": "财务月结 ADS",
        "layer": "ADS",
        "owner": "财务域组 · 锦书",
        "tier": "P1",
        "impactScore": 80,
        "calendarId": "cal_finance",
        "visibleFrom": "2026-10-25T00:00",
        "schedule": {
            "frequency": "monthly",
            "hour": 8, "minute": 0, "weekday": None, "dayOfMonth": 1,
            "delayMinutes": 360,
            "warnMinutes": 90,
        },
        "baseRows": 5300,
        "consumers": [
            {"id": "rpt_finance_close", "name": "财务月结表", "type": "report", "criticality": "critical"},
            {"id": "rpt_budget", "name": "预算执行看板", "type": "dashboard", "criticality": "high"},
        ],
    },
    {
        "id": "dwd_click_stream",
        "name": "dwd_click_stream",
        "cnName": "点击流明细",
        "layer": "DWD",
        "owner": "数据平台组 · 阿宁",
        "tier": "P2",
        "impactScore": 45,
        "calendarId": "cal_7x24",
        "visibleFrom": "2026-10-25T00:00",
        "schedule": {
            "frequency": "hourly",
            "hour": None, "minute": 0, "weekday": None, "dayOfMonth": None,
            "delayMinutes": 60,
            "warnMinutes": 20,
        },
        "baseRows": 1890000,
        "consumers": [
            {"id": "rpt_traffic_source", "name": "流量来源分析", "type": "report", "criticality": "medium"},
            {"id": "rpt_funnel", "name": "实时转化漏斗", "type": "dashboard", "criticality": "medium"},
        ],
    },
]

# ---------------------------------------------------------------- 场景脚本
# 键为分区键；值为该分区的运行剧本
scenarios = {
    "ods_mysql_orders": {
        # 同分区失败后重试成功：截止 14:40，成功在 14:33，仍按时
        "2026-11-12 14:00": {
            "attempts": [
                {"status": "failed", "startOffset": 3, "duration": 15, "error": "MySQL 主从延迟，抽取超时"},
                {"status": "success", "startOffset": 20, "duration": 13},
            ]
        },
    },
    "dwd_trade_order_detail": {
        # 11-05 凌晨短暂异常，04:35 补齐（截止 03:50），已恢复的历史异常
        "2026-11-05 03:00": {
            "attempts": [
                {"status": "failed", "startOffset": 4, "duration": 18, "error": "Kafka 消费积压"},
                {"status": "success", "startOffset": 80, "duration": 15},
            ]
        },
        # 当前未恢复的上游延迟：06/07/08 分区缺失，09 分区运行中
        "2026-11-13 06:00": "skip",
        "2026-11-13 07:00": "skip",
        "2026-11-13 08:00": "skip",
        "2026-11-13 09:00": {"attempts": [{"status": "running", "startOffset": 55}]},
    },
    "dws_user_act_daily": {
        # 11-10 分区上游延迟：06:00 超期，09:40 补齐恢复
        "2026-11-10": {
            "attempts": [
                {"status": "failed", "startOffset": 10, "duration": 42, "error": "上游 dwd 分区未就绪"},
                {"status": "success", "startOffset": 390, "duration": 10},
            ]
        },
    },
    "dwd_click_stream": {
        # 两次失败后第三次成功，成功时刻 22:35 晚于截止 22:00，异常恢复
        "2026-11-08 21:00": {
            "attempts": [
                {"status": "failed", "startOffset": 5, "duration": 35, "error": "Executor OOM"},
                {"status": "failed", "startOffset": 60, "duration": 50, "error": "Executor OOM"},
                {"status": "success", "startOffset": 80, "duration": 15},
            ]
        },
    },
}

# ---------------------------------------------------------------- 调度枚举
def iter_nominal(sched, start, end):
    freq = sched["frequency"]
    if freq == "hourly":
        cur = start.replace(minute=0, second=0, microsecond=0)
        step = timedelta(hours=1)
    elif freq == "daily":
        cur = start.replace(hour=sched["hour"], minute=sched["minute"], second=0, microsecond=0)
        if cur < start:
            cur += timedelta(days=1)
        step = timedelta(days=1)
    elif freq == "weekly":
        cur = start.replace(hour=sched["hour"], minute=sched["minute"], second=0, microsecond=0)
        while cur.weekday() != sched["weekday"]:
            cur += timedelta(days=1)
        step = timedelta(days=7)
    elif freq == "monthly":
        cur = datetime(start.year, start.month, sched["dayOfMonth"], sched["hour"], sched["minute"])
        if cur < start:
            if cur.month == 12:
                cur = cur.replace(year=cur.year + 1, month=1)
            else:
                cur = cur.replace(month=cur.month + 1)
        while cur <= end:
            yield cur
            y, m = cur.year, cur.month
            if m == 12:
                y, m = y + 1, 1
            else:
                m += 1
            cur = cur.replace(year=y, month=m)
        return
    else:
        raise ValueError(freq)
    while cur <= end:
        yield cur
        cur += step


# ---------------------------------------------------------------- 运行记录生成
def make_runs(product):
    out = []
    sched = product["schedule"]
    prod_scenarios = scenarios.get(product["id"], {})
    seq = 0
    for nom in iter_nominal(sched, WINDOW_START, DEMO_END):
        active, _ = calendar_active(product["calendarId"], product["id"], nom)
        if not active:
            continue  # 计划停更：不产生任何批次，也不应被记为缺失
        key = pkey(sched["frequency"], nom)
        spec = prod_scenarios.get(key)
        # 普通槽位在演示截止时刻之后才会启动：不生成（剧本内的运行由脚本手工保证时刻合法）
        if spec is None and nom + timedelta(minutes=2) > DEMO_END:
            continue
        if spec is None:
            duration = random.randint(max(4, sched["delayMinutes"] - 22), sched["delayMinutes"] - 6)
            started = nom + timedelta(minutes=2)
            seq += 1
            out.append({
                "runId": f"{product['id']}#{seq:05d}",
                "productId": product["id"],
                "partition": key,
                "attempt": 1,
                "trigger": "scheduled",
                "status": "success",
                "startedAt": iso(started),
                "finishedAt": iso(started + timedelta(minutes=duration)),
                "rowsLoaded": int(product["baseRows"] * random.uniform(0.92, 1.08)),
                "errorMessage": None,
            })
            continue
        if spec == "skip":
            continue  # 上游断流：无任何批次
        attempt_no = 0
        for att in spec["attempts"]:
            attempt_no += 1
            seq += 1
            started = nom + timedelta(minutes=att["startOffset"])
            run = {
                "runId": f"{product['id']}#{seq:05d}",
                "productId": product["id"],
                "partition": key,
                "attempt": attempt_no,
                "trigger": "scheduled" if attempt_no == 1 else "retry",
                "status": att["status"],
                "startedAt": iso(started),
                "finishedAt": None,
                "rowsLoaded": None,
                "errorMessage": att.get("error"),
            }
            if att["status"] in ("failed", "success"):
                run["finishedAt"] = iso(started + timedelta(minutes=att["duration"]))
            if att["status"] == "success":
                run["rowsLoaded"] = int(product["baseRows"] * random.uniform(0.9, 1.05))
            out.append(run)
    return out


def main():
    runs = []
    for p in products:
        runs.extend(make_runs(p))
    runs.sort(key=lambda r: (r["startedAt"], r["runId"]))

    payload = {
        "meta": {
            "generatedAt": iso(datetime(2026, 11, 13, 10, 5)),
            "demoStart": iso(DEMO_START),
            "demoEnd": iso(DEMO_END),
            "replayStepMinutes": 30,
            "note": "全部为虚构数据，仅用于演示数据产品新鲜度面板",
        },
        "calendars": calendars,
        "products": products,
        "runs": runs,
        "commitmentHistory": [
            {
                "id": "ch_0001",
                "productId": "dws_user_act_daily",
                "effectiveFrom": "2026-11-01T00:00",
                "field": "delayMinutes",
                "oldValue": 120,
                "newValue": 180,
                "reason": "上游 ods 切换小时级链路，预留重算缓冲（变更评审 SLA-2026-031）",
                "operator": "数据治理组",
            }
        ],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("// 由 tools/generate_data.py 生成，请勿手工编辑\n")
        f.write("globalThis.FRESH_DATA = ")
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write(";\n")
    print(f"wrote {OUT}: {len(products)} products, {len(runs)} runs, "
          f"{len(calendars)} calendars")


if __name__ == "__main__":
    main()
