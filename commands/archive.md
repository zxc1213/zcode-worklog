---
description: 归档工作日志：扫描 Git 提交与文档变更生成当天 Markdown
---

用户输入：$ARGUMENTS

按第一个词分派，调用 `worklog_archive`：

- 为空或 `run` → `{ action: "run", date: <今天> }`。若用户给了 `YYYY-MM-DD` 就用该日期；用户明确说「覆盖/重新归档」时传 `force: true`；
- `backfill <日期...>` → `{ action: "backfill", dates: [...] }`；
- `status` → `{ action: "status" }`，汇报最近归档历史。

归档是写文件操作。执行前用一句话说明将扫描哪些目录（`worklog_config` 的 `effectiveScanRoots`/`effectiveDocRoots`），执行后汇报：日期、提交数、项目数、文档数，以及 `errors` 里的失败项（例如某个目录没有 git 仓库）。不要删除或重写用户手写的备注，除非用户明确要求 `force: true`。
