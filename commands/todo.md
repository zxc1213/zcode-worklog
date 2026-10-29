---
description: 管理待办：列表、添加、完成、重开、删除、清空已完成
---

用户输入：$ARGUMENTS

按第一个词分派，调用 `worklog_todos`：

- 为空或 `list` → `{ action: "list" }`，按「进行中 / 已完成」分组列出；
- `add <标题>` → `{ action: "add", title }`。支持附加 `!高` / `!中` / `!低`、`@YYYY-MM-DD`、`repeat=daily|weekly:0-6|monthly:1-31`；
- `done <id>` → `{ action: "complete", id }`；
- `reopen <id>` → `{ action: "reopen", id }`；
- `del <id>` → `{ action: "delete", id }`；
- `clear` → `{ action: "clear_done" }`。

id 是 `worklog_todos` 返回的完整 UUID；如果用户只给了标题，先 list 找到唯一匹配再操作，匹配不唯一就请用户确认。操作完成后用中文确认结果。
