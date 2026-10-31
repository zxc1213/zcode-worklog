---
description: 管理待办：列表、添加、编辑、完成、重开、删除、清空、统计、顺延
---

用户输入：$ARGUMENTS

按第一个词分派，调用 `worklog_todos`：

- 为空或 `list` → `{ action: "list" }`，结果已按智能排序（逾期 > 高/中/低 > 到期日升序），按「进行中 / 已完成」分组列出。支持过滤：`{ action: "list", status: "open"|"done", pri: "高"|"中"|"低", tag: "标签", q: "关键词", sort: "smart"|"due"|"created" }`；
- `add <标题>` → `{ action: "add", title }`。支持附加 `!高` / `!中` / `!低`、`@YYYY-MM-DD`、`repeat=daily|weekly:0-6|monthly:1-31`；tags/subtasks 参数 0.3.1 开放；
- `edit <id>` → 需要改哪个字段就传哪个：`{ action: "update", id, title?, pri?, due?, repeat?, md? }`；
- `done <id>` → `{ action: "complete", id }`；
- `reopen <id>` → `{ action: "reopen", id }`；
- `del <id>` → `{ action: "delete", id }`；
- `clear` → `{ action: "clear_done" }`；
- `stats` → `{ action: "stats" }`，报告进行中 / 逾期 / 今日完成 / 本周完成；
- `carry` → `{ action: "carry_over" }`，把逾期未完成项的到期日改到今天（同一天幂等，归档今天时自动执行）。

id 是 `worklog_todos` 返回的完整 UUID；如果用户只给了标题，先 list 找到唯一匹配再操作，匹配不唯一就请用户确认。操作完成后用中文确认结果。
