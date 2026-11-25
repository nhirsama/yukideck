# YukiDeck 文档目录

- [总体架构与平台底座设计](./architecture.md)：分层架构、双部署模式、模块插件契约、OIDC 与全局 API Key、消息中枢与自定义推送终结点。
- [新增模块接入指南（Checklist）](./module-guide.md)：前后端垂直切片改动清单、`sqlc` 迁移、`tygo` 类型同步与自检项。
- [日程与提醒模块（`planner`）设计方案](./planner-module.md)：统一事项模型、日历/农历/DST 算法、部分索引与事件驱动调度。
- [AI Agent 用量统计模块（`ai-usage`）设计方案](./ai-usage-module.md)：小时×会话 UUID 模型、多维统计 API、服务端定价与 `collector/` 同步工具。
- [阶段实施与验证记录](./walkthrough.md)：已完成各阶段的交付清单与测试验证结果。
