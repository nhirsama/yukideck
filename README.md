# YukiDeck

个人工具聚合工作台（React + Go + PostgreSQL），支持单二进制内嵌部署与前后端分离部署。

## 主要功能

- **平台底座**：标准 OIDC SSO 登录与多用户隔离、全局细粒度 API Key、消息中枢（Telegram Bot 等多渠道双向能力 + 自定义推送终结点）。
- **图床（`storage`）**：对接自有 S3 / R2 对象存储桶，支持前端直传与后端中转双模式。
- **日程与提醒（`planner`）**：统一的待办、日程与周期提醒，支持公历/农历与多提前通知点。
- **AI Agent 用量统计（`ai-usage`，规划中）**：多设备汇总 Claude Code、Codex、Antigravity、Pi 等 Agent 的小时与会话级 Token / 工具调用统计。

## 本地开发

```bash
cp .env.example .env

# 1. 启动后端 API
make dev-backend

# 2. 启动前端 Vite（自动代理 /api 到 :8080）
make dev-frontend
```

## 构建与部署

### Docker Compose（内嵌前端，推荐）

```bash
cp .env.example .env
# 按需填写 DATABASE_URL、APP_SECRET_KEY、OIDC_* 等环境变量
docker compose up -d
```

本地编译单二进制（内嵌前端）：

```bash
make build-embed
# 产物：backend/bin/yukideck
```

### 前后端分离部署

```bash
# 编译纯 API 后端
make build-api
# 运行时配置：
#   UI_ENABLED=false
#   FRONTEND_BASE_URL=https://deck.example.com
#   CORS_ALLOWED_ORIGINS=https://deck.example.com

# 构建独立前端（部署至 Nginx / CDN / Pages）
cd frontend && VITE_API_BASE_URL=https://api.example.com pnpm build
```

## 文档

详细架构、模块接入规范与各模块设计文档见 [docs/README.md](./docs/README.md)。
