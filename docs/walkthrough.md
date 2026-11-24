# YukiDeck 阶段实施与验证记录

## 一、Stage 1：平台框架与底座

### 1. 工程与构建体系
- [Makefile](../Makefile)：提供 `dev-backend`、`dev-frontend`、`test`、`build-api`（分离纯 API 二进制）、`build-embed`（单二进制内嵌 React 前端）。
- [Dockerfile](../Dockerfile)：Node → Go (`-tags embed_ui`) → Alpine 三阶段单容器构建（仅通过 `DATABASE_URL` 连接外部 PostgreSQL）。
- [.env.example](../.env.example) 与 [README.md](../README.md)：完整列出内嵌与分离双部署配置项与模块扩展指引。

### 2. Go 后端核心框架（`chi/v5` + `pgx/v5` + `slog`）
- **应用装配与插件注册**：
  - [app.go](../backend/internal/app/app.go) & [registry.go](../backend/internal/app/registry.go)：统一按模块加载迁移、注册受鉴权路由、挂载 `CommandBus` 指令、支持 `DISABLED_MODULES` 按需裁剪并暴露 `/api/v1/meta`。
  - [module.go](../backend/internal/core/module/module.go)：定义 `Module` 生命周期接口与 `BaseModule` 辅助基类，约束模块间禁止横向耦合。
- **双部署模式前端托管**：
  - [embed.go](../backend/internal/webui/embed.go)、[noembed.go](../backend/internal/webui/noembed.go)、[handler.go](../backend/internal/webui/handler.go)：通过 `-tags embed_ui` 与 `UI_ENABLED` 控制内嵌/分离双模式；严格保证 `/api/*` 未命中永远返回 JSON `404` 而非 SPA HTML。
- **平台稳定底座**：
  - [config.go](../backend/internal/config/config.go)：支持分离部署 CORS / `FRONTEND_BASE_URL` / Cookie 域及服务器保护护栏配置（`REQUEST_MAX_BODY_BYTES`、`EXTERNAL_HTTP_TIMEOUT`、`STORAGE_PROXY_MAX_MB`）。
  - [crypto.go](../backend/internal/core/crypto/crypto.go)：AES-256-GCM 凭证静态加密与 HMAC 会话签名。
  - [httpx.go](../backend/internal/core/httpx/httpx.go)：统一错误信封、带大小护栏的 `DecodeJSON`（超限返回 `413`）、凭据化 CORS、结构化日志与 Panic 恢复。
  - [migrator.go](../backend/internal/core/db/migrator.go)：按 `(module_id, version)` 自治版本化的事务迁移器。
  - [auth.go](../backend/internal/core/auth/auth.go)：标准 OIDC（含 PKCE + `state` 校验）、按 `oidc_sub` 自动建号、无状态签名 Cookie 会话与 `UserID` 上下文中间件。
  - [scheduler.go](../backend/internal/core/scheduler/scheduler.go)：基于 `robfig/cron/v3` 的按 Key 动态热增删全局调度引擎。
- **对称能力消息中枢 + 归一化 PushURL**：
  - [driver.go](../backend/internal/core/messenger/driver.go)、[service.go](../backend/internal/core/messenger/service.go)、[handler.go](../backend/internal/core/messenger/handler.go)、[command_bus.go](../backend/internal/core/messenger/command_bus.go)：
    - 每个渠道实现统一 `Driver`，显式声明 `outbound` / `inbound` 能力并支持按能力对称筛选（`?capability=outbound|inbound`）；
    - 提供归一化 `GET/POST /api/v1/push/{token}`（兼容 Query/JSON/Form 及常见字段别名），支持路由到默认或 1 对 N 扇出至选定 `outbound` 渠道；
    - 提供平台无关的 `CommandBus`（内置 `/help`、`/ping`）。
  - [telegram.go](../backend/internal/core/messenger/drivers/telegram.go)：首期内置双向驱动（支持单向推送、自动 `setWebhook`、`X-Telegram-Bot-Api-Secret-Token` 与 `chat_id` 双重校验、文本指令与带大小护栏的媒体下载句柄）。

### 3. React 前端外壳与模块底座
- [api.ts](../frontend/src/core/api.ts)：统一请求封装，支持 `VITE_API_BASE_URL` 适配内嵌同源与分离跨域部署。
- [module.ts](../frontend/src/core/module.ts) & [index.ts](../frontend/src/modules/index.ts)：与后端对称的 `FrontendModule` 插件清单（支持与 `/api/v1/meta` 联动过滤及设置面板自动聚合）。
- [AppShell.tsx](../frontend/src/core/layout/AppShell.tsx)、[LoginPage.tsx](../frontend/src/pages/LoginPage.tsx)、[DashboardPage.tsx](../frontend/src/pages/DashboardPage.tsx)、[MessengerPage.tsx](../frontend/src/pages/MessengerPage.tsx)、[SettingsPage.tsx](../frontend/src/pages/SettingsPage.tsx)。

---

## 二、Stage 2：图床模块（`storage`）

仅需在后端 [registry.go](../backend/internal/app/registry.go) 与前端 [index.ts](../frontend/src/modules/index.ts) 各追加 1 行注册即完整生效。

- **后端（`backend/internal/modules/storage`）**：
  - [001_storage.sql](../backend/internal/modules/storage/migrations/001_storage.sql)：仅 1 张用户桶配置表 `user_storage_configs`，文件与目录完全以用户 S3/R2 存储桶为唯一数据源。
  - [s3client.go](../backend/internal/modules/storage/s3client.go)、[metadata.go](../backend/internal/modules/storage/metadata.go)、[path.go](../backend/internal/modules/storage/path.go)、[service.go](../backend/internal/modules/storage/service.go)、[handler.go](../backend/internal/modules/storage/handler.go)、[module.go](../backend/internal/modules/storage/module.go)：
    - `direct` 直传模式：不限制单文件大小，零服务器带宽；
    - `proxy` 中转模式：按 `STORAGE_PROXY_MAX_MB` 通过 `http.MaxBytesReader` 拦截超限返回 `413`；
    - 无损去 EXIF（JPEG 保留 Orientation、PNG、WebP）与 SHA-256 哈希命名；S3 原生 `CopyObject` 改名与移动；
    - 接入 `CommandBus` 实现极简 TG 发图转存。
- **前端（`frontend/src/modules/storage`）**：
  - [metadata.ts](../frontend/src/modules/storage/metadata.ts)、[api.ts](../frontend/src/modules/storage/api.ts)、[StorageSettingsPanel.tsx](../frontend/src/modules/storage/StorageSettingsPanel.tsx)、[StoragePage.tsx](../frontend/src/modules/storage/StoragePage.tsx)：浏览器端去 EXIF + 直传/中转切换、面包屑、搜索、文件夹管理、4:3 相册网格、拖拽/`Ctrl+V` 粘贴上传、多选批量移动/删除、灯箱键盘预览与一键复制直链/Markdown。

---

## 三、Stage 3：日程与提醒模块（`planner`）

- **后端（`backend/internal/modules/planner`）**：
  - [001_planner.sql](../backend/internal/modules/planner/migrations/001_planner.sql)：统一事项表 `planner_items`（仅 `title` 必填）+ 部分 B-Tree 索引 `idx_planner_items_due`（排除 `NULL` 与已完成项）+ 轻量推送历史与去重表 `planner_logs`。
  - [schedule.go](../backend/internal/modules/planner/schedule.go)：基于 `6tail/lunar-go` 与 IANA 时区实现闰年/月末/农历大小月与闰月夹逼、夏令时墙上时钟保护及日历区间投影。
  - [worker.go](../backend/internal/modules/planner/worker.go)：事件驱动单 `time.Timer` 精确唤醒（零空轮询），多通知点单条独立推送 + `trigger_key` 幂等去重 + 自动推进周期。
  - [service.go](../backend/internal/modules/planner/service.go)、[handler.go](../backend/internal/modules/planner/handler.go)、[module.go](../backend/internal/modules/planner/module.go)。
- **前端（`frontend/src/modules/planner`）**：
  - [api.ts](../frontend/src/modules/planner/api.ts)、[ItemModal.tsx](../frontend/src/modules/planner/ItemModal.tsx)、[PlannerPage.tsx](../frontend/src/modules/planner/PlannerPage.tsx)：极简统一表单、回车快速建 Todo、清单视图、FullCalendar 公农历日历视图（`lunar-typescript`）与推送历史。

---

## 四、测试与构建验证汇总

| 验证项 | 结果 | 说明 |
| :--- | :---: | :--- |
| `go test ./... -v` | ✅ PASS | 全部 10 个测试包通过（`app`、`auth`、`crypto`、`db`、`httpx`、`messenger`、`scheduler`、`webui`、`storage`、`planner`） |
| `pnpm typecheck` | ✅ PASS | TypeScript 严格模式零错误 |
| `pnpm build` | ✅ PASS | 模块按路由懒加载独立分包（`StoragePage` 6.29 kB gzip、`PlannerPage` 188.20 kB gzip，主包维持 106.82 kB gzip） |
| `make build-api` | ✅ PASS | 产出纯 API 二进制 `backend/bin/yukideck-api`（14 MB） |
| `make build-embed` | ✅ PASS | 产出内嵌前端单二进制 `backend/bin/yukideck`（15 MB） |
