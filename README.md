# YukiDeck

轻量、高可扩展、可维护的模块化个人工具聚合工作台（**React + Go**）。

## 核心设计特点

- **双部署模式**：默认通过 Go `-tags embed_ui` 内嵌 React 构建产物（单二进制 / 单容器运行）；同时完整保留 `/api/v1/*` 接口边界、CORS、Cookie 域与 `UI_ENABLED=false` 配置，支持前后端分离部署。
- **标准 OIDC + 外部 PostgreSQL**：通过 `DATABASE_URL` 接入外部 PG，每个用户按 OIDC `sub` 独立隔离，所有外部资源凭证均由用户自填并通过 AES-256-GCM 静态加密保存。
- **对称能力消息中枢（`core/messenger`）+ 归一化 PushURL**：
  - 每个渠道驱动统一声明自身拥有的能力：`outbound`（发送）与 `inbound`（接收），用户可按方向独立开关与对称筛选。
  - 首期内置 **Telegram Bot** 双向驱动（支持单向推送、Webhook 验签 + `chat_id` 校验与 `CommandBus` 指令交互）。
  - 提供归一化 `GET/POST /api/v1/push/{token}` 端点，外部脚本统一调用，内部按配置扇出到默认或选定的 `outbound` 渠道。
- **服务器安全护栏原则**：仅对实际消耗服务器资源的路径（如中转流、JSON 请求体、外部 HTTP 超时）设置可配置保护，对不经过服务器的直传路径零人为限制。

## 本地开发

```bash
cp .env.example .env
# 1. 启动后端 API（未打 embed_ui 标签，秒级编译）
make dev-backend
# 2. 启动前端 Vite（自动代理 /api 到 :8080）
make dev-frontend
```

## 构建与部署

### 模式 A：Go 单二进制内嵌前端（推荐）

```bash
make build-embed
# 产物：backend/bin/yukideck（内嵌前端 SPA + Go 后端）
```

### 模式 B：前后端分离部署

```bash
# 后端纯 API 二进制
make build-api
# 启动时设置：
#   UI_ENABLED=false
#   FRONTEND_BASE_URL=https://deck.example.com
#   CORS_ALLOWED_ORIGINS=https://deck.example.com

# 前端构建独立部署至 Nginx / CDN / Pages
cd frontend && VITE_API_BASE_URL=https://api.example.com pnpm build
```

## 扩展新模块（垂直切片插件规范）

1. **后端**：在 `backend/internal/modules/<name>/` 实现 `module.Module` 接口（可嵌入 `module.BaseModule`），并在 `backend/internal/app/registry.go` 追加 1 行注册。模块间严禁互相 `import`。
2. **前端**：在 `frontend/src/modules/<name>/` 导出 `FrontendModule`（使用 `React.lazy` 懒加载），并在 `frontend/src/modules/index.ts` 追加 1 行注册。
