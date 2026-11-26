# Stage 3：日程与提醒模块（`planner`）详细设计方案

## 目标与定位

在 YukiDeck 中接入垂直切片模块 **`planner`（日程与提醒）**，将待办、日历与精确到分钟的定时推送完全统一为**同一个「事项（Item）」实体，不人为拆分类别**：

- **极简统一模型**：**仅标题（`title`）必填**，备注（`note`）、目标时间（精确到分钟，公历/农历）、循环周期、0~N 个提前通知时间点、逾期持续催办、指定出站渠道全部按需可选；不掺杂金额、标签、优先级等冗余字段。
- **单条独立推送**：每命中一个通知点（含逾期催办）独立向 `core/messenger` 的 `outbound` 渠道推送一条消息（干完一条删一条）。
- **零空轮询与可靠送达**：采用 PostgreSQL 部分 B-Tree 索引（`WHERE status = 'pending' AND next_trigger_at IS NOT NULL`）配合 Go 事件驱动单 `time.Timer` 精确唤醒；将**正常提醒、失败退避重试、逾期催办、定时暂停恢复**全部统一收敛至 `next_trigger_at`，保持常数级调度开销与 0% 空轮询。
- **可观测诊断留痕**：推送日志与终态去重解耦，完整记录成功、退避重试、最终失败与各类跳过原因，避免黑盒静默丢失。
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
- **按天推算的通知点与逾期催办**（如提前 `7 天`、`1 天`，或逾期每 `1 天` 催办）：在目标时区 `time.Location` 下使用日历日期推算 `AddDate(0, 0, ±N)`，保持**墙上时钟不变**（即使中间跨过 23 小时或 25 小时的 DST 切换日，依然落在同一 `HH:MM`）。
- **按小时/分钟推算的通知点与逾期催办**（如提前 `2 小时`、`30 分钟`、`准点 0 分钟`，或逾期每 `3 小时` 催办）：基于目标时刻的绝对时间戳做 `target.Add(±duration)` 精确推算。
- **春季跳过时刻 / 秋季重复时刻**：若目标本地时间恰逢 DST 春季跳过（如 `02:30` 不存在），由 Go `time.Date` 自动顺延至有效时刻；由于 `next_trigger_at` 与 `planner_logs.trigger_key` 均绑定到具体 UTC 时刻与周期键，秋季回拨 1 小时绝不会导致重复推送。

---

## 二、数据模型（2 张模块自治表）

保持极简 2 表结构，通过增量迁移演进：
- 初始表结构：`backend/internal/modules/planner/migrations/001_planner.sql`
- 可靠性与催办/暂停演进：`backend/internal/modules/planner/migrations/002_planner_reliability.sql`

### 1. 主表 `planner_items`

```sql
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
    repeat_config   JSONB NOT NULL DEFAULT '{}'::jsonb,-- 原始锚点、weekdays、interval、cron_expr
    auto_advance    BOOLEAN NOT NULL DEFAULT TRUE,     -- 未开催办：通知后自动推进；开启催办：达到催办上限后自动推进

    -- 多个提前通知时间点（为空数组则不推送提前/准点提醒）
    remind_offsets  JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- 逾期未完成持续催办配置（002 新增）
    -- 结构：{ "enabled": bool, "interval_unit": "hour"|"day", "interval_value": int, "max_count": int(默认3, 上限10) }
    overdue_config  JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- 暂停状态（002 新增）
    -- paused=TRUE & paused_until IS NULL  -> 一直暂停直到手动恢复（next_trigger_at = NULL）
    -- paused=TRUE & paused_until NOT NULL -> 暂停至指定时刻自动恢复（next_trigger_at = paused_until）
    paused          BOOLEAN NOT NULL DEFAULT FALSE,
    paused_until    TIMESTAMPTZ,

    -- 失败退避重试瞬时态（002 新增，无待重试任务时为 NULL）
    -- 结构：{ "trigger_key", "trigger_label", "event_type", "attempt", "next_retry_at", "last_error" }
    retry_state     JSONB,

    -- 推送出站渠道（空数组 = 走 core/messenger 默认 outbound 渠道；非空 = 指定 1~N 个 outbound 渠道）
    channel_ids     BIGINT[] NOT NULL DEFAULT '{}',

    -- 统一收敛的下一次待唤醒时刻（正常提醒 / 退避重试 / 逾期催办 / 定时暂停到期），走部分 B-Tree 索引
    next_trigger_at TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_items_user_id ON planner_items(user_id);
CREATE INDEX IF NOT EXISTS idx_planner_items_due ON planner_items(next_trigger_at)
    WHERE status = 'pending' AND next_trigger_at IS NOT NULL;
```

### 2. 推送与诊断日志表 `planner_logs`

将「**可观测日志**」与「**终态幂等去重**」解耦：
- 重试中的记录（`status = 'retrying'`）**不占用去重位**，允许同一 `(item_id, trigger_key)` 完整记录多次尝试；
- 仅当该触发点进入终态（`status IN ('ok', 'failed', 'skipped')`）时受部分唯一索引约束，确保永不重复送达。

```sql
CREATE TABLE IF NOT EXISTS planner_logs (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id       BIGINT REFERENCES planner_items(id) ON DELETE SET NULL,
    item_title    TEXT NOT NULL,
    trigger_key   TEXT NOT NULL,
    trigger_label TEXT NOT NULL DEFAULT '',
    event_type    TEXT NOT NULL DEFAULT 'reminder',    -- 'reminder' | 'overdue' | 'pause'
    status        TEXT NOT NULL,                       -- 'ok' | 'retrying' | 'failed' | 'skipped'
    reason        TEXT NOT NULL DEFAULT '',            -- 诊断原因码（见下表）
    attempt       INT NOT NULL DEFAULT 1,              -- 当前尝试序号（1=首次，2~4=第1~3次重试）
    next_retry_at TIMESTAMPTZ,                         -- status='retrying' 时的计划下次重试时刻
    error         TEXT NOT NULL DEFAULT '',
    sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planner_logs_user_sent ON planner_logs(user_id, sent_at DESC, id DESC);
-- 002 迁移：移除旧的全状态唯一索引 idx_planner_logs_dedup，替换为终态部分唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_planner_logs_settled
    ON planner_logs(item_id, trigger_key)
    WHERE item_id IS NOT NULL AND status IN ('ok', 'failed', 'skipped');
```

每用户自动裁剪保留最近 **200 条**日志。

---

## 三、可靠性、催办、暂停与调度状态机

### 1. 事件驱动单 `time.Timer` 统一调度（零空轮询）
- 后台运行单一轻量调度协程：处理所有 `next_trigger_at <= now` 的待办事项后，执行 `SELECT next_trigger_at FROM planner_items WHERE status = 'pending' AND next_trigger_at IS NOT NULL ORDER BY next_trigger_at ASC LIMIT 1`（直接命中部分索引最左端）。
- `next_trigger_at` 统一取以下候选中的最早时刻：
  1. 若 `paused == true`：一直暂停（`paused_until == nil`）则强制为 `NULL`；定时暂停则设为 `paused_until`。
  2. 若存在待退避重试（`retry_state != nil`）：纳入 `retry_state.next_retry_at`。
  3. 当前周期内最早的未终结正常提醒点（`remind_offsets`）。
  4. 当前周期内最早的未终结逾期催办点（`overdue_config.enabled == true`）。
- 任何创建、编辑、通知配置变更、完成、恢复、暂停/取消暂停、删除操作均向 `wakeCh` 发送非阻塞信号，立刻重算最近唤醒点。

### 2. 发送失败自动重试（Retry with Backoff）
- **退避阶梯**：最多自动重试 **3 次**，间隔 **`1 分钟 → 5 分钟 → 15 分钟`**（共尝试 4 次，约覆盖 21 分钟短时网络或渠道抖动；服务端有界保护，防止失效凭证导致死循环）。
- **无手动补发**：通知的目的是在时间节点获知事件，重试耗尽后标记为最终 `failed` 即止，不提供手动补发入口。
- **多渠道部分失败策略**：向多个出站渠道发送时，只要**至少 1 个渠道发送成功**即视为该点已送达（状态记 `ok`，`reason = 'partial_channel_failure'`，`error` 附带失败渠道明细），不对已成功渠道重复轰炸；仅当所有渠道均失败时进入重试。
- **不可重试错误快速终结**：例如未配置任何可用出站渠道（`no_channel`）时直接写入终态 `failed`，不浪费重试。
- **周期推进保护**：当前周期仍有进行中的 `retry_state` 时，**暂缓推进到下一周期**；直到重试成功或耗尽后再决定是否推进。若下一次重试时刻已晚于下一周期的 `target_at`，则放弃旧周期重试，记录 `skipped / cycle_superseded` 并直接推进。

### 3. 逾期未完成持续催办（Overdue Nagging）
- **配置参数（`overdue_config`）**：
  - `enabled`：布尔开关，默认关闭；**一次性事项与周期事项均可开启**。
  - `interval_unit` + `interval_value`：支持按 **`每 N 小时`** 或 **`每 N 天`**（`>= 1`），无夜间免打扰逻辑，保持极简。
  - `max_count`：默认 **`3` 次**，最大上限 **`10` 次**；前后端输入超过 `10` 时自动静默回落为 `10`（无多余报错提示）。
- **周期长度严格约束（强校验）**：
  - 对所有周期任务（`repeat_type != 'none'`），必须满足 **`催办次数 × 催办间隔 < 周期长度`**（严格小于），避免上一周期的催办与下一周期碰撞：
    - `daily`：周期长度 = `24 小时`
    - `interval_days`：周期长度 = `interval × 24 小时`
    - `weekly`：单选或未选星期几为 `7 天`；多选星期几取相邻选中日之间的**最短间隔天数**
    - `monthly`：取保守最短月长（公历 `28 天`，农历 `29 天`）
    - `yearly`：取保守最短年长（公历 `365 天`，农历 `353 天`）
    - `cron`：向前推算连续 10 次触发，取相邻两次的**最小时间间隔**
    - `none`（一次性事项）：无周期长度限制（仅受 `max_count <= 10` 约束）
- **与自动推进（`auto_advance`）的协同**：
  - **未开启逾期催办**：`auto_advance` 语义为「通知后自动推进至下一周期」（默认开启，发完本周期最后一个提醒点立即推进）。
  - **开启逾期催办**：周期任务到点后**不再立即推进**，进入逾期催办阶段等待用户手动确认（点击对钩立即完成本期并推进）；`auto_advance` 选项文案自动变为「**确认后自动推进**」并附带感叹号提示（`InfoTooltip`）：*“达到逾期通知上限后也会自动推进至下一周期”*：
    - 保持勾选（`auto_advance = true`）：催满上限次数后自动推进到下一周期（同时记录 `skipped / overdue_limit_reached`）。
    - 取消勾选（`auto_advance = false`）：催满上限次数后停止催办并记录 `skipped / overdue_limit_reached`，停在当前周期直到用户手动点对钩。
- **催办触发键与消息文案**：
  - 每轮催办独立生成 `trigger_key = "<occKey>|overdue#<index>"`（`index = 1..max_count`），天然复用**单条独立推送 + 终态去重 + 退避重试 + 诊断日志**。
  - 推送标题示例：`[逾期催办 2/3] 交房租（已逾期 2 天）`。
- **停止条件**：用户点对钩完成/推进、修改 `target_at` 到未来、关闭催办开关、暂停事项、删除事项，或达到 `max_count` 上限。

### 4. 暂停与自动恢复（Pause / Resume）
- **两种暂停模式**：
  - **定时暂停**（`paused = true, paused_until = T`）：快捷预设 `1 小时`、`3 小时`、`1 天`、`3 天`、`7 天` 或自定义恢复时刻；`next_trigger_at` 直接指向 `T`，到点由单 `time.Timer` 精确唤醒并自动恢复。
  - **一直暂停**（`paused = true, paused_until = NULL`）：`next_trigger_at` 置为 `NULL`，彻底休眠直到用户手动点击恢复。
- **暂停期间与恢复行为**：
  - 暂停期间**不发送任何正常提醒、重试或逾期催办**，同时清空未完成的 `retry_state`。
  - 到点自动恢复或用户手动提前恢复时：暂停期间错过的触发点**直接跳过不补发**，写入诊断日志 `skipped`（`reason = 'paused'`）；周期任务若当前周期已过期则自动对齐推进至当前时刻之后的下一周期，然后按正常节奏重算 `next_trigger_at`。

### 5. 诊断日志状态与原因码一览

| `status` | `reason` | 含义 |
| --- | --- | --- |
| `ok` | `""` | 推送成功（含重试后成功，通过 `attempt > 1` 体现） |
| `ok` | `partial_channel_failure` | 多渠道中至少 1 个成功，其余失败详情见 `error` |
| `retrying` | `retry_scheduled` | 推送失败，已按退避阶梯安排下次重试（`next_retry_at` 非空） |
| `failed` | `retry_exhausted` | 达到最大重试次数（3 次）后最终失败 |
| `failed` | `no_channel` | 未配置可用的出站推送渠道，不可重试 |
| `skipped` | `missed_grace_window` | 服务停机或延迟超过 15 分钟容错窗口，跳过补发 |
| `skipped` | `paused` | 事项处于暂停期，跳过该触发点不补发 |
| `skipped` | `overdue_limit_reached` | 逾期催办已达设定上限次数，停止继续催办 |
| `skipped` | `cycle_superseded` | 旧周期重试点晚于下一周期目标时间，放弃旧周期并推进 |

---

## 四、API 与前端交互设计

### 后端路由（挂载于 `/api/v1/planner`，受 `planner:read` / `planner:write` 保护）
- `GET /items`：列表查询（返回 `items`，包含 `overdue_config`、`paused`、`paused_until`、`retry_state`、`next_trigger_at`、`lunar_label` 等）
- `GET /calendar?start=&end=`：按日历视图区间展开事件实例（包含周期任务投影）
- `POST /items`、`PUT /items/{id}`、`DELETE /items/{id}`：新建 / 更新（完整更新或仅更新通知配置均走统一校验逻辑）/ 删除
- `POST /items/{id}/complete`：确认完成（一次性置完成 / 周期任务清零当前逾期与重试状态并推进下一期）
- `POST /items/{id}/reopen`：将已完成的一次性任务恢复为待办
- `POST /items/{id}/pause`：暂停通知（支持 `{ "until": RFC3339 }` 或 `{ "indefinite": true }`）
- `POST /items/{id}/resume`：立即恢复已暂停事项的通知
- `POST /items/{id}/test`：立即向绑定的 `outbound` 渠道发一条预览测试推送
- `GET /logs?status=&limit=`：查询推送与诊断日志（支持按 `status` 筛选：`ok` / `retrying` / `failed` / `skipped`，最多 200 条）

### 前端界面（`frontend/src/modules/planner/`，按模块懒加载）

顶部维持 3 个页签切换（不额外增加独立诊断页签）：

#### 1. 清单视图
- 顶部回车快速添加纯 Todo 输入栏。
- 筛选分段器：`全部` / `今日` / `已逾期` / `有时间` / `无日期` / `已完成`。
- **卡片布局与操作区重构**：
  - **移除最左侧勾选框**，保持卡片信息清爽。
  - 状态角标：支持显示时间/农历、循环周期、提前提醒档位、下次推送时刻，以及醒目的「已逾期 X 天/小时」「已暂停至 MM-DD HH:MM / 一直暂停」「重试中」徽标。
  - **右侧操作区**：
    - **外露按钮**：
      - **`✓` 确认按钮**（仅对**需要确认**的待办项展示：纯 Todo、一次性日程、未开启自动推进的周期日程、开启了逾期催办的周期日程；未开催办且自动推进的纯循环提醒不显示）
      - **`🔔` 通知配置按钮**（有目标时间的待办项展示，点击打开独立的**通知配置弹窗**，快速修改提前提醒、逾期催办与推送渠道）
      - **`⏸` 暂停 / `▶` 恢复按钮**（有目标时间的待办项展示；未暂停时点击弹出**暂停时长弹窗**，已暂停时点击立即恢复）
      - **`✏️` 修改按钮**（打开**编辑弹窗**，仅编辑标题、备注、时间/历法/时区、循环周期等非通知配置）
      - **`⋯` 更多菜单**：收口 `测试通知`、`删除`（已完成项菜单内含 `恢复待办`、`删除`）
- **居中弹窗职责拆分**（统一复用 `@/components/Select`、`@/components/InfoTooltip` 与 `.yd-*` 样式体系）：
  1. **新建事项弹窗**：一次填写名称、备注、可选时间/历法/时区/周期，以及可选的通知与逾期催办配置。
  2. **编辑事项弹窗（✏️）**：专注编辑名称、备注、目标时间/历法/时区、循环周期（与未开催办时的自动推进）。
  3. **通知配置弹窗（🔔）**：专注配置提前提醒时间点（`remind_offsets`）、逾期催办（`overdue_config`：默认 3 次、输入 >10 自动归 10、`次数 × 间隔 < 周期长度` 校验；周期任务勾选催办时自动展示「确认后自动推进」+ `InfoTooltip` 提示）及推送渠道。
  4. **暂停弹窗（⏸）**：提供 `1 小时`、`3 小时`、`1 天`、`3 天`、`7 天`、`一直暂停（手动恢复）` 快捷选项与自定义恢复时间选择器。
- **时区选择修复**：所有内置时区选项均补齐 `UTC±X` 标注（夏令时地区标注标准/夏令时双偏移，如 `Europe/London (伦敦 UTC+0/+1)`、`America/New_York (纽约 UTC-5/-4)`、`UTC (协调世界时 UTC+0)`；浏览器探测到的列表外时区也动态附带当前 `UTC±X` 偏移）。

#### 2. 日历视图（FullCalendar）
- 月 / 周 / 日切换，日期格同时渲染公历日期与农历/节气（`lunar-typescript`），点击日期新建、点击事件编辑。

#### 3. 推送记录（推送与诊断日志）
- 顶部提供状态筛选分段器：`全部` / `成功` / `重试中` / `失败` / `已跳过`。
- 列表清晰展示事项标题、事件标签（提前档位 / 逾期催办序号 / 暂停跳过）、状态徽标、尝试次数（重试时标明第 N 次）、中文诊断原因、错误详情及下次重试时间（如有）。
