---
description: 查看 WorkLog 状态：今天是否归档、日志/待办/项目统计与最近运行
---

调用 `worklog_status` 工具，然后用中文简要汇报：

1. 今天（YYYY-MM-DD）是否已归档；
2. 日志总数、最近一篇归档日期；
3. 进行中/逾期待办数量（列出最多 3 条）；
4. 归档覆盖的项目数量；
5. 如果今天还没归档，提醒用户可以运行 `/zcode-worklog:archive` 或打开 WorkLog 面板归档。

用户附加参数：$ARGUMENTS
