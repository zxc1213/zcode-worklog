---
description: 查看或修改 WorkLog 配置（扫描目录、自动归档、AI 接口）
---

用户输入：$ARGUMENTS

1. 不带参数时调用 `worklog_config`（`action: "get"`），用表格列出：数据目录、扫描根目录、文档目录、Git 作者、自动归档开关与时间、AI 是否配置。
2. 用户要改配置时，把自然语言转换成 `patch`，调用 `worklog_config`（`action: "set"`）：
   - `scanRoots` / `docRoots` 是字符串数组（每个目录一项）；
   - `sources: { git: boolean, docs: boolean }`；
   - `autoArchive`、`skipWeekends` 是布尔；`taskTime` 是 `HH:MM`；
   - `ai: { baseUrl, model, apiKey }`；API Key 只在用户明确提供时写入，回复中不要回显明文。
3. 修改后重新 `get` 一次确认，并提醒用户：数据只在本机；改数据目录不会自动搬移旧数据，需要手动复制或用备份/导入。
