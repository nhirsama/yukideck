# 个人物品与资产管理模块（`assets`）详细设计方案

## 目标与定位

在 YukiDeck 中接入垂直切片模块 **`assets`（个人物品 / 资产管理）**，将个人持有的每件物品作为一笔资产记录其购入价格、多币种汇率换算、计价方式、持有状态、使用次数、保修期、分类、标签、渠道、存放位置、附加收支与子物品归属，并在主页提供「资产概览 + 多维检索筛选 + 分类组织浏览 + 快速/完整录入」的核心工作区。

- **严格模块化边界**：后端位于 `backend/internal/modules/assets`，前端位于 `frontend/src/modules/assets`，仅依赖平台 `core/*`，**严禁** import `storage` / `planner` / `ai_usage` 等兄弟模块；全部用户数据按 `user_id` 隔离。
- **轻量无耦合视觉**：物品默认使用内置图标（或 Emoji），支持可选填图片 URL 展示外链图片，不依赖对象存储模块、不经过服务端中转大图。
- **多币种实时折算**：支持 `CNY` / `USD` / `EUR`，由后端拉取免 Key 公开汇率接口并持久化缓存，汇总与展示按当前最新汇率统一折算至用户主展示币种。

---

## 一、核心业务模型与财务口径

### 1. 多币种与汇率机制

- **支持币种**：`CNY`（人民币，默认）、`USD`（美元）、`EUR`（欧元）。
- **金额存储精度**：数据库统一使用 `BIGINT` 存储**最小货币单位（分 / cent）**（例如 `19999` 表示 `199.99`），避免浮点累加误差；HTTP DTO 对外统一使用常规数值（保留 2 位小数），在服务端边界通过 `math.Round(v * 100)` 与 `float64(cents) / 100` 双向转换。
- **汇率获取与三级容错**：
  1. 后端以 `CNY` 为基准（`base_currency = 'CNY'`）拉取免费免 Key 的公开汇率接口（默认 `https://api.frankfurter.dev/v1/latest?base=CNY&symbols=USD,EUR`，可通过环境变量覆写），得到 `1 CNY -> USD` 与 `1 CNY -> EUR` 汇率，并写入全局缓存表 `assets_exchange_rates`。
  2. **缓存策略**：默认 TTL **24 小时**；读取时若过期由服务端按需触发刷新（使用进程内互斥/单飞机制防并发击穿，单次外部 HTTP 请求超时 `5s`）；提供手动刷新接口（带 5 分钟最小刷新间隔防滥用）。
  3. **三级兜底**：实时拉取成功（`live`）→ 外部接口失败时沿用数据库最近一次缓存（`cached`）→ 首次启动无缓存且离线时使用内置静态参考汇率（`fallback`，如 `1 USD = 7.20 CNY`、`1 EUR = 7.80 CNY`）。接口响应透明返回 `source` 与 `fetched_at`。
- **换算口径**：汇总总资产、总投入、实际回收、实际净支出与日均成本时，**按当前最新汇率**将所有外币记录统一折算至用户当前选择的展示币种（`display_currency`）；数据库始终保留原始录入金额与原始币种。

### 2. 状态、计价模式与财务公式

- **物品状态（`status`）**：
  - `active`：服役中（默认）
  - `favorite`：收藏（仍在服役，排序时可优先置顶）
  - `retired`：已退役
- **退役处置**：
  - 仅在退役操作时记录 `retired_at`（退役日期）、`retire_reason`（`sold` 卖出 / `gifted` 赠送 / `lost` 遗失 / `expired` 过期 / `discarded` 丢弃 / `other` 其他）、`sold_price_cents` + `sold_currency`（出售所得）、`retire_note`（说明）。
  - 支持随时**撤销退役**，状态恢复为 `active` 并清空退役字段。
- **计价模式（`pricing_mode`）**：
  - `time`（按时间，默认）：计算日均 / 月均 / 年均成本，**参与**总资产与总览日均汇总。
  - `usage`（按次计价）：计算单次使用成本，**计入总资产，不参与总览日均/月均/年均汇总**。
  - `none`（不计价）：**计入总资产，不参与总览日均/月均/年均汇总**。
- **日期存储与持有天数计算**：
  - 所有纯日期字段（`purchased_at`、`expected_retire_at`、`warranty_until`、`retired_at`、`occurred_at`）在数据库存 `DATE`，在 HTTP DTO 统一用 `YYYY-MM-DD` 字符串表示，彻底杜绝跨时区 00:00 偏移问题。
  - 列表/详情查询支持传入用户本地日期参数 `today=YYYY-MM-DD`（未传时默认按服务端 `Asia/Shanghai` 当天日期）。
  - **持有天数（`holding_days`）**：
    - 起始日：取 `purchased_at`（快速录入未填时默认填入录入当天）。
    - 截止日：若 `status = 'retired'` 且存在 `retired_at`，**冻结在 `retired_at`**；否则取 `today`。
    - `holding_days = max(1, (end_date - start_date) + 1)`（包含购入当天，至少为 1 天，避免除零）。
- **单件物品财务公式**（以下金额均已按当前汇率折算至展示币种）：
  - `总投入 (total_invested)` = `购入价 + SUM(type='expense' 且 include_in_cost=true 的附加支出)`
  - `实际回收 (total_recovered)` = `SUM(type='income' 的附加收入) + (退役出售所得)`
  - `实际净支出 (net_spent)` = `总投入 - 实际回收`
  - `日均成本 (daily_cost)`（仅 `pricing_mode = 'time'`）：`max(0, 实际净支出) / holding_days`
  - `单次成本 (usage_cost)`（仅 `pricing_mode = 'usage'`）：`usage_count > 0 ? max(0, 实际净支出) / usage_count : max(0, 实际净支出)`
- **顶部资产概览汇总公式**（基于当前筛选结果与 `exclude_retired` 开关）：
  - 若开启 `exclude_retired = true`，则概览汇总剔除 `status = 'retired'` 的物品；
  - `total_asset`（总资产）：纳入统计物品的 `SUM(总投入)`；
  - `total_count`：纳入统计的物品数量；
  - `total_invested` / `total_recovered` / `net_spent`：分别为纳入统计物品对应指标之和；
  - `total_daily_cost`：仅对纳入统计且 `pricing_mode = 'time'` 的物品求和 `SUM(daily_cost)`；
    - `total_monthly_cost = total_daily_cost * 30`
    - `total_yearly_cost = total_daily_cost * 365`
  - `warranty_expiring_count`：未退役物品中 `warranty_until` 距离 `today` 在 `0..30` 天内（含当天）的数量；
  - `warranty_expired_count`：未退役物品中 `warranty_until < today` 的数量。

### 3. 两级分类（含预置分类）与子物品归属

- **两级分类体系**：
  - 仅允许 **一级分类（`parent_id IS NULL`）→ 二级分类（`parent_id` 指向某个一级分类）** 两层。
  - 服务端严格校验：不允许向二级分类下再建子类；已有子分类的一级分类不允许被修改为二级分类。
  - 删除分类时，自动级联删除其二级分类，并将原本属于被删分类（及子分类）的物品 `category_id` 置为 `NULL`（归入「未分类」），绝不级联删除物品。
  - **预置分类（幂等初始化）**：用户首次进入模块时，检查 `assets_user_settings.seeded_categories`，若为 `false` 则自动写入一组默认两级分类并置为 `true`（用户可任意修改、排序、增删，删空后不会再次强制重建）：
    - `数码电子`：手机、电脑平板、耳机音频、摄影器材、外设配件
    - `家用电器`：生活家电、厨房电器、个护电器
    - `居家日用`：家具家居、收纳工具、办公文具
    - `服饰鞋包`：服装、鞋靴、箱包、配饰
    - `运动户外`：健身器材、骑行装备、露营户外
    - `交通出行`：车辆代步、车载配件
    - `兴趣收藏`：游戏主机、乐器、图书手办
- **子物品归属（统一实体方案）**：
  - 子物品与普通物品同属 `assets_items` 表，通过 `parent_id` 关联到父物品，可随时绑定、更换父物品或解除归属（置 `NULL` 变为独立物品）。
  - 服务端校验**防自环与循环引用**（不允许 `parent_id == id`，也不允许祖先链回指自身）。
  - 删除父物品时，数据库外键 `ON DELETE SET NULL` 自动将子物品解除归属转为独立物品，不误删配件数据。
  - **汇总防重复计算**：总资产统计按 `assets_items` 每件独立物品累加，天然不会重复计算；父物品详情与卡片额外展示「关联子物品列表」与「含子物品合计金额」供参考。

---

## 二、数据模型（9 张模块自治表）

迁移文件：`backend/internal/modules/assets/migrations/001_assets.sql`

```sql
-- 1. 用户模块偏好表（每用户一行）
CREATE TABLE IF NOT EXISTS assets_user_settings (
    user_id            BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_currency   TEXT NOT NULL DEFAULT 'CNY' CHECK (display_currency IN ('CNY', 'USD', 'EUR')),
    cost_period        TEXT NOT NULL DEFAULT 'daily' CHECK (cost_period IN ('daily', 'monthly', 'yearly')),
    exclude_retired    BOOLEAN NOT NULL DEFAULT FALSE,
    hide_amounts       BOOLEAN NOT NULL DEFAULT FALSE,
    default_view       TEXT NOT NULL DEFAULT 'card' CHECK (default_view IN ('card', 'list', 'folder')),
    seeded_categories  BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. 两级分类表
CREATE TABLE IF NOT EXISTS assets_categories (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id   BIGINT REFERENCES assets_categories(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    icon        TEXT NOT NULL DEFAULT 'folder',
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assets_categories_user_sort
    ON assets_categories(user_id, parent_id, sort_order, id);

-- 3. 标签表（扁平多对多）
CREATE TABLE IF NOT EXISTS assets_tags (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);

-- 4. 购买渠道表
CREATE TABLE IF NOT EXISTS assets_channels (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);

-- 5. 存放位置表
CREATE TABLE IF NOT EXISTS assets_locations (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);

-- 6. 物品主表（统一承载顶级物品与子物品）
CREATE TABLE IF NOT EXISTS assets_items (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id           BIGINT REFERENCES assets_items(id) ON DELETE SET NULL,
    category_id         BIGINT REFERENCES assets_categories(id) ON DELETE SET NULL,
    channel_id          BIGINT REFERENCES assets_channels(id) ON DELETE SET NULL,
    location_id         BIGINT REFERENCES assets_locations(id) ON DELETE SET NULL,

    name                TEXT NOT NULL,
    icon                TEXT NOT NULL DEFAULT 'package',
    image_url           TEXT NOT NULL DEFAULT '',

    price_cents         BIGINT NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
    currency            TEXT NOT NULL DEFAULT 'CNY' CHECK (currency IN ('CNY', 'USD', 'EUR')),
    purchased_at        DATE NOT NULL DEFAULT CURRENT_DATE,

    pricing_mode        TEXT NOT NULL DEFAULT 'time' CHECK (pricing_mode IN ('time', 'usage', 'none')),
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'favorite', 'retired')),

    expected_retire_at  DATE,
    warranty_until      DATE,
    usage_count         INT NOT NULL DEFAULT 0 CHECK (usage_count >= 0),

    -- 退役处置信息（仅 status = 'retired' 时有效）
    retired_at          DATE,
    retire_reason       TEXT NOT NULL DEFAULT '' CHECK (retire_reason IN ('', 'sold', 'gifted', 'lost', 'expired', 'discarded', 'other')),
    sold_price_cents    BIGINT NOT NULL DEFAULT 0 CHECK (sold_price_cents >= 0),
    sold_currency       TEXT NOT NULL DEFAULT 'CNY' CHECK (sold_currency IN ('CNY', 'USD', 'EUR')),
    retire_note         TEXT NOT NULL DEFAULT '',

    note                TEXT NOT NULL DEFAULT '',
    sort_order          INT NOT NULL DEFAULT 0,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assets_items_user_sort ON assets_items(user_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_assets_items_user_category ON assets_items(user_id, category_id);
CREATE INDEX IF NOT EXISTS idx_assets_items_user_status ON assets_items(user_id, status);
CREATE INDEX IF NOT EXISTS idx_assets_items_user_parent ON assets_items(user_id, parent_id)
    WHERE parent_id IS NOT NULL;

-- 7. 物品-标签多对多关联表
CREATE TABLE IF NOT EXISTS assets_item_tags (
    item_id  BIGINT NOT NULL REFERENCES assets_items(id) ON DELETE CASCADE,
    tag_id   BIGINT NOT NULL REFERENCES assets_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_assets_item_tags_tag ON assets_item_tags(tag_id);

-- 8. 附加收支明细表
CREATE TABLE IF NOT EXISTS assets_transactions (
    id               BIGSERIAL PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id          BIGINT NOT NULL REFERENCES assets_items(id) ON DELETE CASCADE,
    type             TEXT NOT NULL CHECK (type IN ('expense', 'income')),
    amount_cents     BIGINT NOT NULL CHECK (amount_cents >= 0),
    currency         TEXT NOT NULL DEFAULT 'CNY' CHECK (currency IN ('CNY', 'USD', 'EUR')),
    occurred_at      DATE NOT NULL DEFAULT CURRENT_DATE,
    include_in_cost  BOOLEAN NOT NULL DEFAULT TRUE,
    note             TEXT NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assets_transactions_item ON assets_transactions(user_id, item_id, occurred_at DESC, id DESC);

-- 9. 全局汇率缓存表（公共市场数据，不按用户隔离）
CREATE TABLE IF NOT EXISTS assets_exchange_rates (
    base_currency   TEXT NOT NULL CHECK (base_currency IN ('CNY', 'USD', 'EUR')),
    quote_currency  TEXT NOT NULL CHECK (quote_currency IN ('CNY', 'USD', 'EUR')),
    rate            DOUBLE PRECISION NOT NULL CHECK (rate > 0),
    source          TEXT NOT NULL DEFAULT 'live',
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (base_currency, quote_currency)
);
```

> **安全隔离要点**：所有涉及 `parent_id`、`category_id`、`channel_id`、`location_id`、`tag_ids`、`item_id` 的写操作，服务层均须校验目标外键归属于当前 `auth.UserID(ctx)`，杜绝跨用户引用。

---

## 三、后端架构与 RESTful API

模块 ID：`assets`，路由统一挂载于 `/api/v1/assets/*`，全部接口受平台 OIDC Session Auth 保护；本期不注册 `RegisterPermissions`、`RegisterJobs`、`RegisterCommands`。

### 目录结构

```text
backend/internal/modules/assets/
├── migrations/
│   └── 001_assets.sql      # 模块自治 SQL 迁移（//go:embed）
├── sqlcgen/                # make sqlc 生成代码
├── queries.sql             # sqlc 查询定义
├── dto.go                  # 所有对外 HTTP 请求/响应结构体（供 tygo 生成前端类型）
├── module.go               # 实现 module.Module（嵌入 module.BaseModule）
├── handler.go              # chi 路由注册与请求编解码
├── service.go              # 业务逻辑、两级分类校验、防环校验、财务与筛选排序引擎
├── rates.go                # 外部汇率拉取、singleflight 防击穿、DB 缓存与静态兜底
├── seed.go                 # 预置两级分类定义与幂等初始化
├── store.go                # sqlc 封装与事务编排
└── assets_test.go          # 单元测试（财务公式、多币种折算、分类层级、子物品防环、筛选排序）
```

### 接口清单

#### 1. 偏好、汇率与元数据

| 方法与路径 | 说明 |
| :--- | :--- |
| `GET /api/v1/assets/meta` | 一次性返回用户偏好、全部分类（含层级）、标签、渠道、位置及当前汇率快照（首次访问自动初始化偏好与预置分类） |
| `PUT /api/v1/assets/settings` | 更新用户偏好（`display_currency`、`cost_period`、`exclude_retired`、`hide_amounts`、`default_view`） |
| `GET /api/v1/assets/rates` | 获取当前 `CNY / USD / EUR` 汇率与更新时间（支持 `?refresh=true` 手动刷新，5 分钟内限频） |
| `POST /api/v1/assets/categories` | 新建一级或二级分类（校验层级 ≤ 2） |
| `PUT /api/v1/assets/categories/{id}` | 修改分类名称、图标、父级分类（校验层级 ≤ 2） |
| `DELETE /api/v1/assets/categories/{id}` | 删除分类（级联删子类，关联物品自动归为未分类） |
| `POST /api/v1/assets/categories/reorder` | 调整同级分类排序 |
| `POST / PUT / DELETE /api/v1/assets/tags[/{id}]` | 标签增删改 |
| `POST / PUT / DELETE /api/v1/assets/channels[/{id}]` | 购买渠道增删改 |
| `POST / PUT / DELETE /api/v1/assets/locations[/{id}]` | 存放位置增删改 |

#### 2. 物品核心与批量操作

| 方法与路径 | 说明 |
| :--- | :--- |
| `GET /api/v1/assets/items` | 物品列表 + 当前筛选范围的资产概览 `summary`（服务端计算全部折算金额、日均/单次成本、持有天数、保修倒计时及子物品统计） |
| `GET /api/v1/assets/items/{id}` | 单件物品详情（含关联父物品摘要、子物品列表与合计金额、附加收支明细） |
| `POST /api/v1/assets/items` | 新建物品（支持仅传 `name` + `price` 的快速录入，或传完整字段） |
| `PUT /api/v1/assets/items/{id}` | 编辑物品（含修改 `parent_id` 随时变更子物品归属） |
| `DELETE /api/v1/assets/items/{id}` | 删除物品（子物品自动解除归属转为独立物品） |
| `POST /api/v1/assets/items/{id}/use` | 使用次数打卡（请求体 `{"delta": 1}`，支持 `+1` / `-1`，下限为 0） |
| `POST /api/v1/assets/items/{id}/retire` | 办理退役（`retired_at`、`retire_reason`、`sold_price`、`sold_currency`、`retire_note`） |
| `POST /api/v1/assets/items/{id}/unretire` | 撤销退役，恢复为 `active` |
| `POST /api/v1/assets/items/reorder` | 手动拖拽排序（提交有序 `item_ids`，批量刷新 `sort_order`） |
| `POST /api/v1/assets/items/batch` | 批量管理（`action`: `set_category` / `retire` / `delete`） |

#### 3. 附加收支明细

| 方法与路径 | 说明 |
| :--- | :--- |
| `POST /api/v1/assets/items/{id}/transactions` | 为物品新增附加支出或附加收入 |
| `PUT /api/v1/assets/items/{id}/transactions/{tx_id}` | 编辑附加收支明细 |
| `DELETE /api/v1/assets/items/{id}/transactions/{tx_id}` | 删除附加收支明细 |

### `GET /api/v1/assets/items` 查询参数设计

个人物品总量通常在几十至数千件以内，后端一次查出用户物品与收支明细后在内存中完成实时多币种折算、全维度筛选、排序与概览汇总（单次计算耗时 `< 2ms`），彻底避免复杂动态 SQL 拼接与前后端口径漂移：

- **通用**：`today`（`YYYY-MM-DD`）、`currency`（覆盖展示币种）、`exclude_retired`（`true`/`false`）
- **搜索**：`q`（模糊匹配物品名称、备注、渠道名、位置名、标签名）
- **快捷筛选**：
  - `category_id`（具体分类 ID；若为一级分类默认包含其下二级分类，传 `uncategorized` 筛未分类；配合 `exact_category=true` 供文件夹视图精确查看直接归属物品）
  - `status`（`active` / `favorite` / `retired`）
  - `retire_reason`（`sold` / `gifted` / `lost` / `expired` / `discarded` / `other`）
- **高级筛选**：
  - `min_price` / `max_price`（按当前展示币种的购入价区间）
  - `min_daily_cost` / `max_daily_cost`（按当前展示币种的日均区间）
  - `purchased_from` / `purchased_to`（购买日期区间）
  - `min_holding_days` / `max_holding_days`（持有天数区间）
  - `min_usage_count` / `max_usage_count`（使用次数区间）
  - `warranty_status`（`active` 保修内 / `expiring_soon` 30 天内到期 / `expired` 已过期 / `none` 无保修）
  - `tag_ids`（逗号分隔多选标签 ID，默认按交集或并集，约定多选为**包含任意选中标签**或通过 `tag_mode=all|any` 控制，默认 `any`）
- **排序**：
  - `sort_by`：`manual`（默认手动序）/ `created_at` / `updated_at` / `price` / `daily_cost` / `usage_count` / `holding_days` / `expected_retire_at` / `warranty_until` / `status_priority`（收藏 > 服役中 > 已退役）
  - `sort_dir`：`asc` / `desc`

---

## 四、前端页面与交互设计

前端目录：`frontend/src/modules/assets/`，通过 `React.lazy` 挂载至 `/assets` 路由。

```text
frontend/src/modules/assets/
├── api.gen.ts              # make types 自动生成，严禁手改
├── api.ts                  # API 请求封装与 React Query hooks
├── index.tsx               # FrontendModule 注册定义
├── AssetsPage.tsx          # 主页工作区（状态编排、视图切换、批量管理）
├── components/
│   ├── OverviewBar.tsx         # 资产概览栏（总资产、日/月/年均、投入回收、保修提示、隐私/退役/币种控制）
│   ├── FilterBar.tsx           # 搜索（含 localStorage 历史）、快捷筛选、高级筛选面板、排序与视图切换
│   ├── ItemCardView.tsx        # 卡片网格视图（支持拖拽排序与批量勾选）
│   ├── ItemListView.tsx        # 紧凑列表视图（支持拖拽排序与批量勾选）
│   ├── FolderBrowserView.tsx   # 两级分类文件夹下钻视图（面包屑 + 未分类区）
│   ├── QuickAddModal.tsx       # 快速录入弹窗（名称 + 价格 + 币种）
│   ├── ItemDrawer.tsx          # 物品详情与完整编辑抽屉（含父子物品归属管理、附加收支流水）
│   ├── RetireModal.tsx         # 退役/卖出处置弹窗
│   ├── BatchActionBar.tsx      # 批量管理底部操作条（批量改分类、退役、删除）
│   ├── MetaManagerModal.tsx    # 分类（两级）、标签、渠道、存放位置集中管理弹窗
│   └── IconPicker.tsx          # 内置 Lucide 图标 + Emoji 选择器（并支持图片 URL 预览）
```

### 核心交互细节

1. **资产概览栏（`OverviewBar`）**：
   - 主卡片展示总资产、物品件数、日均 / 月均 / 年均切换；辅助展示总投入、实际回收、实际净支出；当存在即将过保或已过保物品时展示点击即可筛选的倒计时徽章。
   - 快捷控制组：隐私遮罩按钮（一键隐藏全部金额为 `****`）、排除退役开关、币种切换（`CNY` / `USD` / `EUR`，悬停展示当前汇率与更新时间，支持点按刷新）。所有开关变更自动持久化到 `/settings`。
2. **搜索与双层筛选（`FilterBar`）**：
   - 搜索框聚焦时展示 `localStorage` 维护的最近搜索词及一键清空。
   - 快捷筛选行：一级/二级分类过滤 + 状态过滤（服役中 / 收藏 / 已退役 + 退役原因）。
   - 高级筛选面板：价格区间、日均价格区间（附常用分档快捷按钮）、购买日期区间（附「近 30 天 / 近 3 月 / 近 6 月 / 近 1 年」快捷按钮）、持有天数、使用次数、保修状态、标签多选；筛选无结果时提供空状态引导与一键重置筛选。
3. **三种视图与拖拽/批量操作**：
   - **卡片视图 / 列表视图**：展示图标或图片 URL、名称、分类/标签、状态、价格（原币种与折算主币种）、日均或单次成本、使用次数（支持卡片直接点 `+1` 打卡）、保修倒计时标签（当天到期 / 次日到期 / N 天后到期 / 已过期）以及子物品数量角标。
   - **文件夹下钻视图**：顶层显示一级分类文件夹（附物品件数与汇总资产）+「未分类」入口；点入后顶部展示面包屑（`全部 / 数码电子 / 手机`），依次展示当前层级的子分类文件夹与归属物品。
   - **手动拖拽排序**：在 `sort_by === 'manual'` 且未开启批量模式时，利用原生 HTML5 Drag & Drop（或轻量拖拽句柄）调整顺序并乐观更新，松手后调用 `POST /items/reorder` 持久化。
   - **批量管理**：进入批量选择模式后，点击物品卡片/行勾选，底部弹出操作栏支持一键**批量改分类**、**批量退役**、**批量删除**。
4. **录入与详情闭环**：
   - **快速录入**：只填名称 + 价格 + 币种（默认今天购入、服役中、按时间计价），回车即完成记录，适合随手记账。
   - **详情与编辑抽屉**：可补全或修改任意字段；**子物品归属**区可直接选择/搜索任意其他物品设为父物品或一键解除归属，下方列出挂载在本物品下的全部子物品（可点击跳转查看，并展示含子物品的总投入）；**附加收支**区支持实时增删改每条支出/收入并勾选是否计入成本。

---

## 五、接入清单与实施阶段

### 平台注册点改动（遵循 [module-guide.md](./module-guide.md)）
1. `backend/sqlc.yaml`：追加 `internal/modules/assets` 的代码生成块。
2. `backend/tygo.yaml`：追加 `yukideck/internal/modules/assets` 的 `dto.go` → `../frontend/src/modules/assets/api.gen.ts` 映射。
3. `backend/internal/app/registry.go`：在 `BuildModules` 中追加 `assets.New(deps)`。
4. `frontend/src/modules/index.ts`：在 `registeredModules` 中追加 `assetsModule`。

### 分步开发与验证计划
1. **Phase 1（数据层与骨架）**：编写 `001_assets.sql`、`queries.sql`、`dto.go`、更新 `sqlc.yaml` & `tygo.yaml` 并执行 `make gen`；搭建 `module.go`、`store.go`、`seed.go` 并注册至 `registry.go`。
2. **Phase 2（核心服务与接口）**：实现 `rates.go`（汇率拉取+缓存+兜底）、`service.go`（两级分类约束、子物品防环、财务公式、筛选排序引擎、批量操作）、`handler.go`，补齐 `assets_test.go` 单元测试并确保 `cd backend && go test -race ./...` 全绿。
3. **Phase 3（前端工作区）**：实现 `api.ts`、`OverviewBar`、`FilterBar`、三种浏览视图（卡片 / 列表 / 文件夹下钻）与 `QuickAddModal`。
4. **Phase 4（完整交互与验收）**：实现 `ItemDrawer`（完整编辑、父子归属、附加收支）、`RetireModal`、`MetaManagerModal`、`BatchActionBar` 与拖拽排序；完成全量自检：
   - `make gen` 生成产物最新且干净；
   - `cd backend && go test -race ./...` 全部通过（含 `TestNoCrossModuleImports`）；
   - `cd frontend && pnpm typecheck && pnpm build` 全部通过。
