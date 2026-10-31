---
description: 生成日报/周报/月报/季报/绩效素材/项目档案
---

用户输入：$ARGUMENTS

按第一个词分派，调用 `worklog_report`（`action: "generate"`）：

- `daily [YYYY-MM-DD]` → `kind: "daily"`, `date`
- `weekly [任意日期]` → `kind: "weekly"`, `monday`（服务端会归一到周一）
- `month [YYYY-MM]` → `kind: "month"`, `month`
- `quarter [YYYY-Q1..Q4]` → `kind: "quarter"`, `quarter`
- `perf [YYYY-MM]` → `kind: "perf"`, `month`
- `project <项目名>` → `kind: "project"`, `project`
- `summarize <开始> [结束]` → `{ action: "summarize", start, end }`，用「自由总结」提示词模板总结任意日期范围（未配置 AI 时输出规则摘要）
- 为空默认 `weekly`

默认生成确定性草稿。只有用户明确要求「AI 润色」且 `worklog_config` 显示已配置 `ai.baseUrl`/`ai.model` 时，才传 `useAi: true`。

生成后用中文给出：报告文件名、保存路径、内容摘要（不要整篇复述），并提示可在 WorkLog 面板「汇报」页查看全文。若报告需要写入，先展示草稿要点并征得用户同意。
