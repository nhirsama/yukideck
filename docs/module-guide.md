# 新增模块接入指南（Checklist）

YukiDeck 采用**垂直切片模块化单体**架构。新增一个业务模块（假设模块 ID 为 `<id>`）时，严格遵守单向依赖铁律：

- 后端 `backend/internal/modules/<id>` 只能依赖 `internal/core/*`，**严禁** import 兄弟模块 `internal/modules/*`（由 `backend/internal/app/arch_test.go` 自动校验）。
- 前端 `frontend/src/modules/<id>` 只能依赖 `@/core/*`，**严禁**直接 import 兄弟模块。
- 所有业务数据按 `user_id` 隔离，外部凭证由用户自填并通过 `core/crypto` 加密存储。

---

## 一、后端接入步骤

1. **创建模块目录**：`backend/internal/modules/<id>/`
   - `module.go`：实现 `module.Module` 接口（推荐嵌入 `module.BaseModule` 仅覆写所需钩子），声明唯一 `Meta().ID`。
   - `dto.go`：**所有对外暴露的 HTTP 请求/响应结构体统一放在此文件**，供 `tygo` 生成前端 TypeScript 类型（不要把 `Service`/`Handler`/`Store` 等内部结构放进 `dto.go`）。
   - `handler.go`：挂载到 `/api/v1/<id>/*` 的受鉴权路由，统一使用 `httpx.Handle`、`httpx.DecodeJSON`、`auth.UserID(r.Context())`。
   - `service.go` & `store.go`：业务逻辑与数据访问层。
   - `<id>_test.go`：模块单元测试。

2. **数据库迁移与 `sqlc`（如模块需要持久化）**
   - 在 `backend/internal/modules/<id>/migrations/` 下新增按数字前缀排序的 SQL 文件（如 `001_init.sql`），表名建议加 `<id>_` 前缀并通过 `user_id` 关联 `users(id)`。
   - 在 `module.go` 中通过 `//go:embed migrations/*.sql` 并在 `Migrations()` 中返回。
   - 在 `backend/internal/modules/<id>/queries.sql` 编写查询语句。
   - 在 `backend/sqlc.yaml` 追加该模块的生成配置（`schema` 同时包含 `internal/core/auth/migrations` 与本模块 `migrations`，输出到 `internal/modules/<id>/sqlcgen`）。
   - 运行 `make sqlc` 生成并提交 `sqlcgen/`。

3. **注册模块**
   - 在 `backend/internal/app/registry.go` 的 `BuildModules` 中追加一行 `<id>.New(deps)`。
   - 如需接入消息中枢或定时任务，分别实现 `RegisterCommands` / `RegisterJobs` 即可，无需改动核心底座代码。

---

## 二、前后端类型同步（`tygo`）

1. 在 `backend/tygo.yaml` 中为新模块追加一段配置：
   ```yaml
   - path: "yukideck/internal/modules/<id>"
     include_files:
       - "dto.go"
     type_mappings:
       time.Time: "string"
     output_path: "../frontend/src/modules/<id>/api.gen.ts"
   ```
   > 提示：若字段为受限字符串联合类型，可在 Go struct tag 上使用 `tstype:"'a' | 'b'"`；若匿名嵌入 struct 需扁平展开，添加 `` `tstype:",extends"` ``；可选请求字段添加 `omitempty`。
2. 运行 `make types`（或 `make gen` 同时执行 `sqlc` + `tygo`），生成 `frontend/src/modules/<id>/api.gen.ts` 并随代码提交到 git（`Makefile` 已通过 `go run` 自动执行锁定版本，无需手动全局安装）。

---

## 三、前端接入步骤

1. **创建模块目录**：`frontend/src/modules/<id>/`
   - `api.gen.ts`：由 `make types` 自动生成，**不要手动编辑**。
   - `api.ts`：从 `./api.gen` 复用/重导出类型，封装调用 `@/core/api` 的 `request<T>(...)` 函数。
   - `<Name>Page.tsx` 及模块内部组件。
   - `index.tsx`：导出 `FrontendModule` 定义（页面组件使用 `React.lazy` 懒加载分包，`id` 必须与后端 `Meta().ID` 一致）。
2. **注册前端模块**
   - 在 `frontend/src/modules/index.ts` 的 `registeredModules` 中追加一行注册。

---

## 四、提交前自检清单

- [ ] 后端表结构与查询均严格按 `user_id` 隔离，无越权读写。
- [ ] `backend/sqlc.yaml` 与 `backend/tygo.yaml` 已更新，已运行 `make gen` 且生成产物已提交。
- [ ] `cd backend && go test -race ./...` 全部通过（含 `TestNoCrossModuleImports` 边界检查）。
- [ ] `cd frontend && pnpm typecheck && pnpm build` 全部通过。
- [ ] 确认未破坏前后端分离边界（所有 API 位于 `/api/v1/<id>/*`，前端统一走 `@/core/api`）。
