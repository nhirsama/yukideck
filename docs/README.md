# YukiDeck 文档目录

- [总体架构与可扩展框架设计](./architecture.md)：宏观定位、单二进制内嵌与前后端分离双模式部署、前后端垂直切片插件契约、对称渠道消息中枢与归一化 PushURL。
- [日程与提醒模块（`planner`）设计方案](./planner-module.md)：统一事项模型、闰年/大小月/农历闰月/夏令时无漂移算法、PostgreSQL 部分 B-Tree 索引与事件驱动单 `time.Timer` 零轮询唤醒。
- [阶段实施与验证记录](./walkthrough.md)：Stage 1（平台底座）、Stage 2（图床 `storage`）、Stage 3（日程与提醒 `planner`）的交付清单与测试验证结果。
