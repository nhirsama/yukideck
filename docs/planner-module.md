# Stage 3：日程与提醒模块（`planner`）详细设计方案

## 目标与定位

在 YukiDeck 中接入垂直切片模块 **`planner`（日程与提醒）**，将待办、日历与精确到分钟的定时推送完全统一为**同一个「事项（Item）」实体，不人为拆分类别**：

- **极简统一模型**：**仅标题（`title`）必填**，备注（`note`）、目标时间（精确到分钟，公历/农历）、循环周期、0~N 个提前通知时间点、指定出站渠道全部按需可选；不掺杂金额、标签、优先级等冗余字段。
- **单条独立推送**：每命中一个通知点独立向 `core/messenger` 的 `outbound` 渠道推送一条消息（干完一条删一条）。
- **零空轮询与无 NULL 索引膨胀**：采用 PostgreSQL 部分 B-Tree 索引（`WHERE status = 'pending' AND next_trigger_at IS NOT NULL`）彻底排除纯待办与已完成项，配合 Go 事件驱动单 `time.Timer` 精确唤醒。
- **TG 双向交互**：本期留空不写，保留 `Module.RegisterCommands` 扩展位供后续微调。

---

## 一、核心难点设计：闰年、大小月、农历闰月与夏令时（DST）

核心原则：**永远以「IANA 时区 + 墙上时钟（Wall-Clock）+ 原始日期锚点」计算日程，数据库存算好的 UTC `TIMESTAMPTZ` 供调度器触发，绝不做简单的 `+ 86400s` 粗暴累加。**

### 1. 闰年与大小月不漂移（Anchor Clamping）
每条周期事项单独记录**原始锚点**（例如 `anchor_month = 2, anchor_day = 29` 或 `anchor_day = 31`）：
- **每月 31 日**：1 月 31 日 → 2 月自动夹逼为 **2 月 28 日（闰年 29 日）** → 3 月依据原始锚点 `31` **自动恢复为 3 月 31 日**（绝不永久退化为 28 日，也不会溢出到 3 月 3 日）。
- **每年 2 月 29 日**：平年自动夹逼为 **2 月 28 日**，到下一个闰年**自动恢复为 2 月 29 日**。

### 2. 农历与农历闰月（`6tail/lunar-go` + `lunar-typescript`）
前后端采用同源库保证 1900–2100 推算 100% 一致：
- 记录农历锚点 `(lunar_month, lunar_day, lunar_is_leap)`。
- **大小月夹逼**：若锚点为「腊月三十」，遇到只有 29 天的农历小月自动夹逼到「腊月廿九」，下一年有三十时自动恢复。
- **闰月处理**：普通非闰月锚点始终按正月（非闰月）触发；若显式指定某闰月，下一年无该闰月时回退到对应正月的同一天。

### 3. 夏令时（DST）处理
- **按天往前推算的通知点**（如提前 `7 天`、`1 天`）：在目标时区 `time.Location` 下使用日历日期推算 `AddDate(0, 0, -N)`，保持**墙上时钟不变**（即使中间跨过 23 小时或 25 小时的 DST 切换日，提前 1 天依然是前一天同一 `HH:MM`）。
- **按小时/分钟往前推算的通知点**（如提前 `2 小时`、`30 分钟`、`准点 0 分钟`）：基于目标时刻的绝对时间戳做 `target.Add(-duration)` 精确倒推。
- **春季跳过时刻 / 秋季重复时刻**：若目标本地时间恰逢 DST 春季跳过（如 `02:30` 不存在），由 Go `time.Date` 自动顺延至有效时刻；由于 `next_trigger_at` 与 `planner_logs.trigger_key` 均绑定到具体 UTC 时刻与周期键，秋季回拨 1 小时绝不会导致重复推送。

---

## 二、极简数据模型（2 张模块自治表）

文件：`backend/internal/modules/planner/migrations/001_planner.sql`

```sql
-- 1. 日程 / 待办 / 定时提醒主表
CREATE TABLE IF NOT EXISTS planner_items (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,                     -- 通知名 / 待办名
    note            TEXT NOT NULL DEFAULT '',          -- 备注
    status          TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'done'

    -- 目标时间（纯 Todo 时可为 NULL）
    target_at       TIMESTAMPTZ,                       -- 当前周期目标时刻（精确到分钟）
    timezone        TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    calendar_type   TEXT NOT NULL DEFAULT 'solar',     -- 'solar' | 'lunar'

    -- 统一周期配置（一次性 / 每天 / 每周 / 每月 / 每年 / 每隔N天 / 自定义Cron）
    repeat_type     TEXT NOT NULL DEFAULT 'none',      -- none|daily|weekly|monthly|yearly|interval_days|cron
    repeat_config   JSONB NOT NULL DEFAULT '{}'::jsonb,-- 存原始锚点(anchor_month/day/is_leap/hour/minute)、weekdays、interval、cron_expr
    auto_advance    BOOLEAN NOT NULL DEFAULT TRUE,     -- 周期任务到点后自动推算下一周期（false 则等手动点完成再推进）

    -- 多个提前通知时间点（为空数组则不推送）
    remind_offsets  JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- 推送出站渠道（空数组 = 走 core/messenger 默认 outbound 渠道；非空 = 指定 1~N 个 outbound 渠道）
    channel_ids     BIGINT[] NOT NULL DEFAULT '{}',

    -- 预计算的下一次待触发时刻（走部分 B-Tree 索引）
    next_trigger_at TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_items_user_id ON planner_items(user_id);
CREATE INDEX IF NOT EXISTS idx_planner_items_due ON planner_items(next_trigger_at)
    WHERE status = 'pending' AND next_trigger_at IS NOT NULL;

-- 2. 轻量推送历史表（兼作幂等去重，每用户自动保留最近 100 条）
CREATE TABLE IF NOT EXISTS planner_logs (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id       BIGINT REFERENCES planner_items(id) ON DELETE SET NULL,
    item_title    TEXT NOT NULL,
    trigger_key   TEXT NOT NULL,
    trigger_label TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL,                       -- 'ok' | 'failed'
    error         TEXT NOT NULL DEFAULT '',
    sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_logs_user_sent ON planner_logs(user_id, sent_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_planner_logs_dedup ON planner_logs(item_id, trigger_key)
    WHERE item_id IS NOT NULL;
```

---

## 三、调度、触发与去重机制（事件驱动零空轮询）

1. **事件驱动单 `time.Timer` 精确唤醒（无空轮询）**：
   - 后台运行单一轻量调度协程：先拉取并触发当前所有已到期任务，随后执行一次 `SELECT MIN(next_trigger_at) FROM planner_items WHERE status = 'pending' AND next_trigger_at IS NOT NULL`（直接命中部分 B-Tree 索引最左端，无论总任务数多少均为常数级 `< 0.1ms`）。
   - 若存在未来任务，用单个 `time.Timer` 精确睡眠到该时刻醒来；若无任何未来任务则彻底休眠（**0 次 DB 查询、0% CPU**）。
   - 每当用户新建 / 编辑 / 删除 / 完成任务时，向带缓冲信号通道 `wakeCh` 发送非阻塞通知，立刻唤醒协程重新计算最近睡眠点。
2. **单条独立推送 + 幂等去重**：
   - 计算该事项当前周期内所有已到期（且在 15 分钟容错窗口内，避免停机数天重启后疯狂补发）且未在 `planner_logs` 出现过的通知点；
   - **每个命中的通知点独立调用一次 `messenger.Send(ctx, userID, channelIDs, msg)`**（单条独立推送，方便干完即删）；
   - 写入 `planner_logs`（按用户自动裁剪保留最新 100 条）；
   - 若当前周期的最后一个通知点已发完：
     - `repeat_type != 'none' && auto_advance == true` → 依据锚点自动推进 `target_at` 到下一周期，并重算 `next_trigger_at`；
     - 否则保持当前状态，将 `next_trigger_at` 置为 `NULL`。
3. **手动勾选完成（Todo 闭环）**：
   - 一次性任务：置 `status = 'done'`、`next_trigger_at = NULL`，剩余未触发通知自动取消；
   - 周期任务：点击「完成本期」立即按锚点推进至下一周期并重算 `next_trigger_at`（跳过本期剩余提醒），保持 `status = 'pending'`。

---

## 四、API 与前端页面结构

### 后端路由（挂载于 `/api/v1/planner`，全受 Auth 保护）
- `GET /items`：列表查询（返回 `items` 及已算好的下一次触发时间、农历展示文本）
- `GET /calendar?start=&end=`：按日历视图区间展开当前月/周内的全部事件实例（包含周期任务投影）
- `POST /items`、`PUT /items/{id}`、`DELETE /items/{id}`：新建/编辑/删除
- `POST /items/{id}/complete`：勾选完成（一次性置完成 / 周期任务推进下一期）
- `POST /items/{id}/reopen`：将已完成的一次性任务恢复为待办
- `POST /items/{id}/test`：立即向绑定的 `outbound` 渠道发一条预览测试推送
- `GET /logs`：查询最近推送历史（最多 100 条）

### 前端界面（`frontend/src/modules/planner/`，按模块懒加载）
采用顶部 3 个页签切换：
1. **清单视图**：支持回车快速新建纯 Todo，筛选 `全部待办 / 今日 / 有时间计划 / 无日期 Todo / 已完成`，一键勾选完成或推进下一周期。
2. **日历视图（FullCalendar）**：月 / 周 / 日切换，日期格同时渲染公历日期与农历/节气（`lunar-typescript`），点击日期新建、点击事件编辑。
3. **推送历史**：展示最近单条发送记录、触发档位、发送时间与状态。
