# AI Agent 用量统计模块（`ai-usage`）设计方案

## 目标与定位

在 YukiDeck 中接入垂直切片模块 **`ai-usage`（AI Agent 用量统计）**，并在仓库顶层配套极薄的本地同步工具 **`collector/`**，实现多设备（Mac / 公司电脑 / 远程 Linux 开发机）下多个 AI Coding Agent（Claude Code、Codex、Antigravity、`pi` 等）用量的统一聚合与多维可视化。

- **本地解析、隐私安全**：原始对话内容、Prompt、代码片段与工具参数永不离开本机，仅上报脱敏后的用量指标与元数据。
- **不重造解析轮子**：采集端复用社区成熟的开源日志解析引擎（`tokscale-core`），避免在仓库内手写和维护各家 Agent 的异构日志解析器。
- **小时 × 会话 UUID 精确建模**：彻底解决跨日会话归属漂移与跨时区统计问题。
- **鉴权与接口规范**：严格复用平台统一的 `/api/v1/ai-usage/*` RESTful 接口与底座全局 API Key（见 [architecture.md](./architecture.md)），所有接口仅接受 OIDC Session Cookie 或 `Authorization: Bearer` Header。

---

## 一、核心数据粒度：小时 × 会话 UUID 切片

主事实表以 **`(user_id, device_id, agent, session_id, hour_bucket, model, is_subagent)`** 为唯一切片粒度：

- **`hour_bucket` 统一存截断到整点的 UTC `TIMESTAMPTZ`**（例如 `2026-11-25T15:00:00Z`）。
- **跨日会话精准拆分、历史零漂移**：
  - 一场横跨北京时间 11 月 24 日 23:40 ~ 次日 00:15 的会话 `S1`，按每条消息发生的小时自然落为两个切片：
    - `(..., S1, 2026-11-24T15:00:00Z, model, false)` → `100k`
    - `(..., S1, 2026-11-24T16:00:00Z, model, false)` → `80k`
  - **按天 / 周 / 月 / 热力图查询**：`GROUP BY DATE(hour_bucket AT TIME ZONE $tz)`，24 日与 25 日各自精准归属，且支持按任意时区重算；
  - **按 24 小时活跃分布**：`GROUP BY EXTRACT(HOUR FROM hour_bucket AT TIME ZONE $tz)`；
  - **按会话 UUID 聚合**：`GROUP BY device_id, agent, session_id`，汇总全部小时切片还原完整跨日总消耗、`MIN(first_event_at) ~ MAX(last_event_at)` 时间跨度、模型切换与工具调用总计。
- **存储量级**：单用户高频使用约 30 行/天（约 1 万行/年），PostgreSQL 占用极小，多维聚合保持毫秒级响应。

---

## 二、数据模型（4 张模块自治表）

迁移文件位于 `backend/internal/modules/ai_usage/migrations/001_ai_usage.sql`：

### 1. `ai_usage_hourly_sessions`（核心事实表）
- **归属与维度**：
  - `user_id`（`REFERENCES users(id) ON DELETE CASCADE`）
  - `device_id`、`agent`（`claude` / `codex` / `antigravity` / `pi` 等）、`session_id`（会话 UUID）、`hour_bucket`（UTC 整点 `TIMESTAMPTZ`）
  - `model`（原始模型名，原样落库不做有损改写）
  - `provider`（如 `anthropic` / `openai` / `google` / `openrouter`）
  - `project`（可选：脱敏后的仓库名或目录名）
  - `is_subagent`（`BOOLEAN`，区分主会话与子代理消耗）
  - `parent_session_id`（`TEXT`，可选：子代理归属的主会话 UUID，便于将子代理消耗关联回主会话详情）
- **Token、上下文水位与参考费用**：
  - `input_tokens`（非缓存输入）
  - `output_tokens`（常规输出）
  - `cache_read_tokens`（缓存命中读取）
  - `cache_write_tokens`（常规/5 分钟 TTL 缓存写入）
  - `cache_write_1h_tokens`（1 小时 TTL 缓存写入，日志未区分 TTL 时为 0）
  - `reasoning_tokens`（思考 token，未单独拆分时为 0）
  - `max_context_tokens`（该小时切片内单轮最大上下文长度 `max(input + cache_read + cache_write + cache_write_1h)`）
  - `reported_cost_usd`（可选：本地日志/工具报告的参考费用）
- **交互与工具调用**：
  - `request_count`（该小时内 API 请求/回复轮次数）
  - `tool_call_count`（该小时内工具调用总次数）
  - `tool_calls`（`JSONB`，`{工具名: 次数}` 如 `{"Bash": 12, "Edit": 8, "Read": 25}`，仅存计数、不存参数）
  - `first_event_at`、`last_event_at`（该小时切片内首尾事件精确时间戳）
- **幂等键与索引**：
  - 唯一约束：`UNIQUE (user_id, device_id, agent, session_id, hour_bucket, model, is_subagent)`，上报走 `ON CONFLICT DO UPDATE` 保证重扫/补传 100% 幂等。
  - 索引：`(user_id, hour_bucket DESC)`、`(user_id, agent, hour_bucket DESC)`、`(user_id, device_id, session_id)`、`(user_id, device_id, parent_session_id)`（局部索引 `WHERE parent_session_id <> ''`）。

### 2. `ai_usage_devices`（设备与探针元信息表）
- `(user_id, device_id)` 唯一；记录 `name`（用户可重命名）、`os`、`arch`、`hostname`、`collector_version`、`last_synced_at`、`hidden`（退役设备可隐藏不删历史）。
- 首次上报未知 `device_id` 时自动 upsert 注册，每次同步更新 `last_synced_at` 与 `collector_version`。

### 3. `ai_usage_model_aliases`（用户级模型别名表）
- 字段：`(user_id, match_pattern, canonical_model, priority)`；`match_pattern` 支持精确匹配与 `*` 通配符（如 `my-relay/sonnet*` → `claude-sonnet-4.6`）。
- 读时归一化顺序：**用户自定义别名（按 `priority` 优先） → 内置默认清洗规则**（剥离常见厂商前缀及日期后缀）→ 原样保留。
- 事实表保留原始 `model`，别名规则调整后历史聚合与计费实时生效。

### 4. `ai_usage_model_prices`（用户自定义模型单价表）
- 模块内置主流标准模型默认单价表（每百万 Token 的 `input` / `output` / `cache_read` / `cache_write` / `cache_write_1h` 价格）；
- 本表仅存用户的自定义覆盖项 `(user_id, model_pattern)`；
- 查价链路：`raw_model` → 经别名解析得 `canonical_model` → 优先匹配用户自定义单价 → 匹配内置单价 → 兜底 `reported_cost_usd`；调整单价或别名后历史看板实时重算。

---

## 三、后端权限声明与 RESTful API

模块 ID：`ai-usage`，路由挂载于 `/api/v1/ai-usage`，前端页面与外部 API Key 共用同一套路径（仅认 OIDC Cookie 或 `Authorization: Bearer` Header）。

### 声明的 API Key 权限（`RegisterPermissions`）
- `ai-usage:ingest`：允许向 `POST /api/v1/ai-usage/ingest` 上报用量切片；
- `ai-usage:read`：允许读取汇总、趋势、热力图、会话与工具统计接口。

### 接口清单

| 方法与路径 | 允许鉴权 | API Key 权限 | 说明 |
| :--- | :--- | :--- | :--- |
| `POST /api/v1/ai-usage/ingest` | Cookie / Bearer | `ai-usage:ingest` | 批量幂等上报小时×会话切片（支持 Gzip，受请求体大小与单批最大条数护栏保护） |
| `GET /api/v1/ai-usage/summary` | Cookie / Bearer | `ai-usage:read` | 总览指标（总 Token、缓存命中率、等效费用、请求轮次、最大上下文、工具调用数、活跃天数/会话数） |
| `GET /api/v1/ai-usage/trends` | Cookie / Bearer | `ai-usage:read` | 趋势图数据（支持 `hour`/`day`/`week`/`month` 聚合，按 `agent`/`model`/`device`/`project` 分组） |
| `GET /api/v1/ai-usage/heatmap` | Cookie / Bearer | `ai-usage:read` | 按指定时区输出的年度每日活跃热力图 |
| `GET /api/v1/ai-usage/sessions` | Cookie / Bearer | `ai-usage:read` | 分页会话列表（跨日会话自动合并，支持包含子代理消耗，含总 Token、等效费用、最大上下文、模型与工具汇总） |
| `GET /api/v1/ai-usage/sessions/{session_id}` | Cookie / Bearer | `ai-usage:read` | 单会话逐小时消耗、关联子代理明细与模型/工具调用明细 |
| `GET /api/v1/ai-usage/tools` | Cookie / Bearer | `ai-usage:read` | 工具调用分布排行（按 Agent / 时间范围筛选） |
| `GET / PUT / DELETE /api/v1/ai-usage/devices` | 仅 OIDC Cookie | — | 设备重命名 / 隐藏与探针版本/同步状态查看 |
| `GET / PUT / DELETE /api/v1/ai-usage/aliases` | 仅 OIDC Cookie | — | 维护用户级模型别名规则 |
| `GET / PUT / DELETE /api/v1/ai-usage/prices` | 仅 OIDC Cookie | — | 查看内置单价表与维护自定义覆盖单价 |

---

## 四、本地探针同步工具（`collector/`）

放置于仓库顶层 `collector/` 目录，采用 **Rust + `tokscale-core`** 构建单二进制、零运行时依赖的**一次性唤醒（Oneshot）探针**，后续按需可扩展常驻模式：

1. **核心解析引擎复用 `tokscale-core`**：
   - 依赖 `tokscale-core`（锁定上游 git commit）将各家异构日志统一解析为逐条 `UnifiedMessage`。
   - `collector/` 将 `UnifiedMessage` 按 `(hour_bucket, session_id, model, is_subagent)` 归并，计算该切片的 `max_context_tokens`，填充 `parent_session_id`、`cache_write_1h_tokens`（可区分时），并附上 `device_id`、`device_name`、`os`、`arch`、`collector_version` 与脱敏 `project`。
2. **`tool_calls` 增强策略**：
   - 协议层 `tool_calls` 为可选字段（默认 `{}`）；
   - 对 JSONL 结构稳定的 Agent（如 Claude Code / Codex / `pi`）在 `collector/` 中附加一层极轻量的工具名计数提取（仅统计工具名和次数，不解析参数），其余格式由 `tokscale-core` 兜底。
3. **探针增量状态与容错机制**：
   - **纯出站单向推送**：仅向服务端发起 `POST /api/v1/ai-usage/ingest`，不监听本地端口。
   - **本地双层检查点**（`~/.local/state/yukideck-collector/state.json`）：记录已处理文件 `(path, mtime, size)` 跳过未变动文件，并缓存已上报切片哈希跳过无变化切片。
   - **Commit-after-2xx**：仅在服务端返回 `2xx` 后更新 `state.json`，断网/服务端重启后下次唤醒自动补传，无需复杂本地队列。
   - **单实例文件锁 + Gzip 分批 + 指数退避重试**：防止 cron 与 Agent Hook 并发写状态文件；按每批上限切分并启用 Gzip 压缩，`429/5xx` 退避重试，`401/403` 快速失败。
4. **配置与命令形态**：
   - 配置文件 `~/.config/yukideck-collector/config.toml`（支持环境变量覆盖）：`server_url`、`api_key`、`device_id`、`device_name`、`agents`、`project_privacy`（`name` / `hash` / `none`）、`lookback_hours`（默认增量回看 48 小时）。
   - 子命令（一次性唤醒）：
     - `init`：初始化配置并校验服务器与 `ai-usage:ingest` 权限；
     - `doctor` / `status`：自检本机发现的 Agent 日志、待同步切片数与服务器连通性；
     - `sync`：增量同步（配合 `cron` / `systemd --user timer` / `launchd` 或 Agent Hook 触发）；
     - `sync --all`：全量历史补录；
     - `sync --dry-run`：本地预览即将上报的脱敏 JSON。

---

## 五、前端页面与配置 Tab（`frontend/src/modules/ai_usage`）

- **主看板（`/ai-usage`）**：
  - 顶部筛选栏（时间范围、时区、Agent、模型、设备、项目）；
  - 核心指标卡（总 Token 与缓存命中率、等效费用、请求轮次、最大上下文、工具调用总数、活跃会话数）；
  - 多维趋势图（切换小时/天/周/月、切换按 Agent/模型/设备堆叠、切换 Token/费用）；
  - 年度每日热力图 + 24 小时活跃时段分布；
  - 会话列表与单会话详情抽屉（查看跨日会话的逐小时消耗、关联子代理与工具调用）；
  - 工具调用排行与 Agent / 模型 / 设备分布卡片。
- **统一设置页 Tab（`FrontendModule.settingsPanel`）**：
  - 设备管理（重命名、隐藏、查看探针版本与最近同步时间）；
  - 模型别名规则管理；
  - 模型自定义单价配置；
  - `collector` 基础配置说明。
- **后续可选扩展**：接入平台 `core/scheduler` 与 `core/messenger`，支持日报/周报推送、单日异常消耗提醒与 Telegram `/usage` 快捷查询。
