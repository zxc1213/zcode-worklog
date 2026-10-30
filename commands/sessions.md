---
description: 汇总本机 AI 工具会话：按天列出 Claude Code/Codex/DSH/WorkBuddy/ZCode/OpenCode/Gemini 的用户提问
---

用户输入：$ARGUMENTS

按第一个词分派，调用 `worklog_sessions`：

- 为空或日期（YYYY-MM-DD）→ `{ action: "list", date: <日期或今天> }`，汇报场数、轮数，按来源分组列出标题、时间与项目目录；
- `sources` → `{ action: "sources" }`，列出会话源路径与存在性；
- `refresh [日期]` → `{ action: "refresh", date: <日期或今天> }`，忽略缓存强制重扫。

会话扫描是只读操作。首次扫描会解析历史文件（之后按 mtime+size 增量缓存），如果耗时较长提前说明。汇报时不要粘贴用户提问原文，只列标题、来源、轮数与时间，避免把日志变成聊天记录。
