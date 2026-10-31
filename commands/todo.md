---
description: 管理待办：列表、添加、编辑、完成、重开、删除、清空、统计、顺延
---

用户输入：$ARGUMENTS

按第一个词分派，调用 `worklog_todos`：

- 为空或 `list` → `{ action: "list" }`，结果已按智能排序（逾期 > 高/中/低 > 到期日升序），按「进行中 / 已完成」分组列出。支持过滤：`{ action: "list", status: "open"|"done", pri: "高"|"中"|"低", tag: "标签", q: "关键词", sort: "smart"|"due"|"created" }`；
- `add <标题>` → `{ action: "add", title, tags?, subtasks? }`。行内支持 `!高` / `!中` / `!低`、`@YYYY-MM-DD`、`#标签`（可多个）、`repeat=daily|weekly:0-6|monthly:1-28`；subtasks 传 `{title, done?}` 数组；
- `edit <id>` → 需要改哪个字段就传哪个：`{ action: "update", id, title?, pri?, due?, repeat?, md?, tags?, subtasks? }`；
- `done <id>` → `{ action: "complete", id }`；
- `reopen <id>` → `{ action: "reopen", id }`；
- `del <id>` → `{ action: "delete", id }`；
- `clear` → `{ action: "clear_done" }`；
- `stats` → `{ action: "stats" }`，报告进行中 / 逾期 / 今日完成 / 本周完成；
- `carry` → `{ action: "carry_over" }`，把逾期未完成项的到期日改到今天（同一天幂等，归档今天时自动执行）；
- `parse <文本>` → `{ action: "parse", text, mode: "batch" }`，把自然语言解析成待办草稿（需 AI 配置）。把返回的 drafts 逐条列出（标题/优先级/到期/重复/标签）请用户确认，确认后逐条 `{ action: "add", ...draft }` 入库；
- `plan` → `{ action: "suggest" }`，AI 从进行中待办里选「今日 3 件要事」并附一句理由（需 AI 配置）。

id 是 `worklog_todos` 返回的完整 UUID；如果用户只给了标题，先 list 找到唯一匹配再操作，匹配不唯一就请用户确认。操作完成后用中文确认结果。
