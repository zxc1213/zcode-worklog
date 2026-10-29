---
name: worklog
description: 本机工作日志（WorkLog）：归档每天的 Git 提交与文档变更、读写日日志、管理待办、生成日报/周报/月报/季报/绩效素材、检索与问答、备份与旧 WorkLog 导入。当用户提到工作日志、日报、周报、月报、季报、绩效素材、项目进展、待办、归档今天、WorkLog 时使用。
---

# WorkLog（ZCode 版）

WorkLog 是这个插件自己维护的本地工作日志系统。**不依赖 WorkLog.exe，不访问 127.0.0.1:8377**。

- 数据目录：插件数据目录下的 `data/`（由 `ZCODE_PLUGIN_DATA` 决定，可用 `worklog_config` 查看准确路径）。
- 归档结构沿用旧版：`archive/YYYY-MM/第N周(MM.DD-MM.DD)/YYYY-MM-DD.md`，所以旧 `data\archive` 可以直接导入。
- 侧边面板：ZCode 侧栏的 **WorkLog**（概览 / 日志 / 待办 / 汇报 / 设置）。

## 何时用哪个工具

工具名在 ZCode 里可能带 `mcp__plugin_zcode-worklog_worklog__` 前缀，按后缀识别即可。

| 用户意图 | 工具 |
|---|---|
| 今天归档了吗 / 总体状态 | `worklog_status` |
| 看/改某天日志 | `worklog_day`（读） / `worklog_day` 传 `text`（写） |
| 搜历史日志 | `worklog_search` |
| 待办的增删改查 | `worklog_todos` |
| 扫描 Git/文档生成当天日志 | `worklog_archive`（`action=run/backfill/status`） |
| 日报/周报/月报/季报/绩效/项目档案 | `worklog_report` |
| 基于归档问答 | `worklog_ask` |
| 项目汇总 | `worklog_projects` |
| AI 用量 | `worklog_usage` |
| 备份/恢复/从旧 WorkLog 导入 | `worklog_backup` |
| 查看/修改配置 | `worklog_config` |
| 打开侧边面板 | `worklog_open` |

面板内部使用 `worklog_api`，它只对面板可见，模型不要调用。

打开面板优先调用 `worklog_open`。手动入口：右侧面板 **新增标签（+）→ 应用插件 → 查看所有插件 → WorkLog**，或 **设置 → 插件 → 插件市场 → 应用插件**。右侧「应用插件」快捷区只显示官方推荐项，非推荐插件必须走「查看所有插件」。

## 归档行为

`worklog_archive`（`action=run`）会：

1. 在 `scanRoots` 下最多 3 层查找 Git 仓库，取当天提交（按 `gitAuthor` 过滤；留空用各仓库 `git config user.name`）。
2. 在 `docRoots` 下最多 6 层扫描当天修改过的 `.md/.docx/.xlsx/.pptx/.pdf` 等文档。
3. 生成「今日概览 / 项目进展 / 文档变更 / 备注」四节 Markdown，写入归档路径。

未配置扫描目录时，默认扫描当前工作区（`ZCODE_PROJECT_DIR`）。已有当天归档时默认**不覆盖**；只有用户明确要求重新归档才传 `force: true`，因为会覆盖用户手写的「备注」。

自动归档：`worklog_config` 里 `autoArchive=true` 时，MCP 服务进程每分钟检查一次；到 `taskTime`（默认 18:30）且当天未归档就自动执行。跳过周末由 `skipWeekends` 控制。ZCode 没运行就不会自动归档。

## 汇报

`worklog_report` 默认生成确定性草稿（不调用 AI）；只有配置了 `ai.baseUrl` + `ai.model` 且用户要求润色时才传 `useAi: true`。报告保存在 `archive/reports/`，文件名如 `weekly-2026-10-26.md`。

## 安全与边界

- 所有数据只在本机；配置里的 AI API Key 明文保存在 `config.json`，回复中不要回显。
- 恢复备份会覆盖同名日日志与待办，删除备份不可恢复：执行前必须让用户确认。
- `worklog_backup` 的 `import` 只复制旧 `data\archive`，不删除源目录。
- 不要用 shell 直接改归档文件；用 `worklog_day` 或面板，保证路径规则一致。
- 尚未实现：AI 会话记录扫描、Word/Excel 导出、绩效模板 Excel、飞书工时、业务流程图。

## 快捷命令

`/zcode-worklog:status`、`today`、`search`、`todo`、`archive`、`report`、`ask`、`backup`、`config`、`open`。
