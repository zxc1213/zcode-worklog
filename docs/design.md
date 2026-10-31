# WorkLog 总体设计（DESIGN）

> v0.1 · 2026-10-31 · 对应 `docs/requirements.md` v0.1。每个里程碑实现前先补充对应子系统小节，实现后回填「实现状态」。

## 1. 架构现状（0.3.2）

- **进程形态**：ZCode 插件 = MCP server（`src/server.mjs`，13 工具）+ MCP App 面板（`src/panel.js` 内联进 `ui://zcode-worklog/panel.html`）+ SessionStart hook（`hooks/session-start.mjs`）。
- **数据层**：`lib/store.mjs`（days/todos/state/search/reports/backups）+ `lib/sessions.mjs`（8 类 AI 会话来源扫描，mtime+size 缓存）+ `lib/config.mjs`（配置与路径）。
- **提炼层**：`lib/report.mjs`（确定性报告 + aiComplete + 模板外置前的硬编码 prompt）+ `lib/archive.mjs`（日归档引擎）。
- **探测层**：`lib/ai-detect.mjs`（ZCode/dsh/Claude/Codex/Gemini 配置只读扫描）。
- **面板**：`src/panel.js` 单文件 h() 渲染，页签：概览/日志/待办/汇报/会话/设置。

## 2. 目标架构

```
┌ Surface 层：面板页签(概览/日历/日志/待办/汇报/图谱/会话/设置) + MCP 工具 + hook + 报告文件
├ Distill 层：templates.mjs(提示词模板引擎) + recommend.mjs(推荐规则引擎)
├ Core 层：store.mjs + entries.mjs(统一条目/时间轴) + graph.mjs(图谱) + calendar.mjs(日历聚合)
└ Source 层：sessions.mjs(AI会话) + archive.mjs(git/docs扫描) + adapters/*.mjs(飞书/禅道/Hermes/通用)
```

新增模块（均挂在 lib/ 下，保持零外部运行时依赖）：

| 模块 | 职责 | 引入版本 |
| --- | --- | --- |
| `lib/scheduler.mjs` | 调度任务表 + 到期判断 + 补偿执行入口 | R1 ✅ |
| `lib/wizard.mjs` | AI 工具配置向导的服务端逻辑（按类型探测指定位置） | R1 ✅ |
| `lib/watch.mjs` | watchDirs 指纹增量扫描（mtime+size，上限 5000 文件/目录） | R1 ✅ |
| `lib/entries.mjs` | 统一条目：追加/去重/按日查询/来源统计 | R2 ✅ |
| `lib/calendar.mjs` | 日历聚合（复用 days/entries/todos/reports） | R2 ✅ |
| `lib/templates.mjs` | 模板文件管理 + 变量渲染 + 场景默认 | R3 ✅ |
| `lib/adapters/` 目录 | core.mjs / feishu.mjs / zentao.mjs / generic.mjs（Hermes 用 generic 承接） | R4 ✅ |
| `lib/recommend.mjs` | 规则打分推荐（五类规则 + 反馈权重） | R5 ✅ |
| `lib/graph.mjs` | 实体关系抽取与查询 | R6 |

## 3. 子系统设计

### 3.1 调度器（REQ-C5，R1）

- 任务表存 `state.schedulerTasks`：`{id, kind, enabled, everyHours?, dailyAt?, lastRunAt, lastStatus, lastError}`。kind 枚举：`collect-sessions`（AI 会话扫描预热）、`collect-entries`（条目采集，R2 后生效）、`connector-sync`（R4 后生效）。
- **补偿式执行**（关键决策）：ZCode 插件无常驻进程，hook 是唯一可靠触发点。SessionStart hook 里调用 `runDueTasks(config)`：遍历 enabled 任务，`now - lastRunAt >= everyHours*3600s`（或 dailyAt 已过且今天未跑）即执行，逐任务记录 lastStatus/lastError/lastRunAt；单任务失败不阻断；整体预算 8s，超时部分记 skipped。
- 面板设置页「采集调度」块：任务列表（开关/间隔/上次运行/状态）+「立即运行」；工具 `worklog_collect {action: run|tasks|history}`。
- 另外在面板每次打开（bootstrap）时也检查一次到期任务（面板打开是第二个触发点）。

### 3.2 AI 工具配置向导（REQ-C2，R1）

- 复用 `lib/ai-detect.mjs` 的探测函数，暴露为向导 API：`wizard {action: probe|apply, type, location}`。
- probe：按 type+location 读取该位置的详细配置（provider/baseUrl/models[]/来源目录与文件计数/key 存在性布尔），**不返回 key 明文**。
- apply：把 probe 结果写入 config（同现有「应用候选」语义）。
- 面板设置页「AI 工具向导」块：类型下拉 → 位置输入（预填常见路径）→ 「探测」按钮展示探测结果卡片 → 「应用」。
- 自定义类型：允许填 sessionRoots 数组与说明，probe 校验路径存在与可读。

### 3.3 工作目录监控（REQ-C3，R1）

- config 增加目录元数据：`scanRoots` 从 `string[]` 升级为可保持兼容的混合：字符串仍表示本地目录；新增 `watchDirs: [{path, kind: 'local'|'cloud'|'git', label?}]`。
- 云盘指纹增量：复用 sessions 缓存思路，`data/watch-cache.json` 存 {path: {mtime,size}}，变化文件才产出条目（R2 接入条目后生效）。

### 3.4 统一条目（REQ-O1，R2）

- `data/entries.json`：append-only 数组；条目 `{id, source: 'sessions'|'git'|'docs'|'watch'|'feishu'|'zentao'|'hermes'|'manual', type, time, title, detail, project?, tags[], ref, fp}`；fp = sha1(source+nativeId) 去重键。
- 采集端点统一收口 `appendEntries(config, list)`（去重、按 time 归位、cap 单日 detail 长度）；日归档时把当日条目按来源汇总成「## 采集条目」小节。
- 迁移：不回填历史（历史由日文件与 sessions 缓存覆盖），从上线日起积累。

### 3.5 日历（REQ-O2，R2）

- 数据组装 `calendarMonth(config, month)` → `{days: {date: {archived, entryCount, bySource, todoDone, todoOpen, hasReport, summary?}}}`。
- 面板「日历」页签：月视图 7 列网格，格子显示密度点与计数；点格 → 右侧/下方详情面板（当天：归档摘要前 N 行、AI 会话列表、待办完成清单、条目来源分布、报告入口、当天总结）。
- 当天总结 = 优先读当天日报的「## 备注/待办/概览」，或 REQ-D1 的 summarize 场景输出（缓存进 day 文件「## 总结」小节）。

### 3.6 提示词模板（REQ-D1，R3）

- 文件：`data/templates/<id>.md`，frontmatter `{id, name, scene, system?, user}`，正文即 user 模板（或 system+user 双段）。
- 变量：`{{today}} {{now}} {{rangeStart}} {{rangeEnd}} {{content}} {{todos}} {{entries}} {{question}} {{text}}`；未提供安全置空；`{{content}}` 超长自动截断（每场景默认上限）。
- 引擎 `lib/templates.mjs`：`ensureBuiltinTemplates()`（首启写内置五模板）、`render(scene|id, vars)`、`listTemplates()`、`saveTemplate()`；内置模板用现有硬编码 prompt 作为初始内容（行为零变化迁移）。
- 接入点改造：报告润色、askArchive、todos.parse、todos.suggest、新增 summarize 全部改走 render()；AI 用量 kind 增加场景名。

### 3.7 外部连接器（REQ-C4/C6，R4）

- 适配器接口：`{id, title, configFields: [{key,label,type,required,secret?}], test(cfg)→{ok,detail}, fetch(cfg, since)→entries[]}`。
- **飞书**：`POST {域}/open-apis/auth/v3/tenant_access_token/internal`（app_id+app_secret）换 token（缓存至过期）；拉取：im-v1 群列表+群消息摘要（按天）、wiki-v2 空间/节点变更、bitable 记录、calendar-v4 日程——按需启用子项（config 开关）。凭据：面板向导填 app_id/app_secret，secret 掩码回显。
- **禅道**：`POST {base}/api.php/v1/tokens` {account,password} → token（`Token:` 头）；拉取 `my tasks/bugs`（按 assignedTo=account 过滤的任务与缺陷列表，近 N 天变更）。已知坑：部分版本 token 401 需带 cookie 兜底，v1 先直连、异常时提示。
- **Hermes**：`generic` 连接器承接：{baseUrl, method, headers(可含 secret), 列表路径/字段映射(JSONPath 简化版: 点路径+数组通配)}；专用适配器等接口信息后替换。
- 连接器配置存 `config.connectors.{id}`，全部走「测试连接」按钮校验后启用。

### 3.8 推荐引擎（REQ-D2，R5）

- `recommend.mjs`：`buildRecommendations(config, {date, range})` → 有序建议数组 `{id, score, kind, title, detail, refs}`；规则（权重可调常量）：逾期顺延待办(+10×carries)、禅道/飞书高优临期(+8)、git 活跃但当天无日志的项目(+6)、日历临近事项(+5)、长期无进展待办(+3)。
- 注入：周报「## 建议关注」小节 + 面板概览卡片 + `worklog_recommend` 工具；手动刷新；采纳/忽略记录 `state.recommendFeedback`（计数影响同类权重）。

### 3.9 知识图谱（REQ-O3，R6）

- `graph.mjs`：从 days/entries/todos 抽取实体（项目=git repo/目录名、人=git author/会话工具、主题=todo 标签、外部对象=连接器条目 project 字段）；关系：提交了(commit→project)、完成了(todo→project)、提及了(session→project/tag)、同步自(entry→connector)。
- `data/graph.json`：`{nodes: {id: {type, label, weight}}, edges: [{from,to,kind,count}]}`；归档后增量重建（先删当日相关边再加新）。
- 面板「图谱」页签 v1：实体列表（按类型/权重排序）→ 点实体看关系列表与最近条目引用；简单 SVG 邻接图可选。`worklog_graph {action: query, entity}` 工具。

### 3.10 工具面扩展

| 工具 | action | 版本 |
| --- | --- | --- |
| `worklog_collect` | diagnostics/run/set/scan_watch/scan_sessions | R1 ✅（工具数 13→15） |
| `worklog_wizard` | types/probe（apply 复用 worklog_ai apply） | R1 ✅ |
| `worklog_calendar` | month/day | R2 ✅（工具数 15→16） |
| `worklog_templates` | list/save/reset | R3 ✅（工具数 16→17） |
| `worklog_connectors` | list/set/remove/test/sync | R4 ✅（工具数 17→18） |
| `worklog_recommend` | get/feedback | R5 ✅（工具数 18→19） |
| `worklog_graph` | query/rebuild | R6 |

## 4. 关键决策记录

1. **补偿式调度而非常驻进程**：插件无后台生命周期；hook+面板双触发已覆盖"定时"诉求且零运维。
2. **条目 append-only + 指纹去重**：重复采集幂等，历史不可变可审计。
3. **模板文件化而非存 config.json**：用户可直接编辑/进备份/可导入导出。
4. **图谱规则优先**：可解释、零成本、离线可用；AI 抽取只做增强不依赖。
5. **外部对接只读优先**：回写（E2）等单源稳定后单独评审。

## 5. 风险

- 飞书 API 权限申请流程在企业租户可能走审批 → 向导里给出权限清单说明，连接失败提示逐条排查。
- 禅道版本差异（token 401 问题）→ 连接器 test 步骤暴露具体 HTTP 状态与建议。
- 条目/图谱体积增长 → cap detail 长度、按月分片查询、图谱重建命令。
- hook 预算超时 → 调度执行改为"标记 due，面板打开时执行"的降级路径。

## 6. 变更记录

- v0.1（2026-10-31）：首版。八个子系统设计与 R1-R6 工具面规划，与 REQ v0.1 对齐。
- v0.6（2026-10-31）：R5 实现回填（0.8.0）。权重公式定为 (accepted+1)/(total+2)*1.5，下限 0.2；外部临期窗口 = 今天起 3 天；no-log-project 通过解析日文件 "### 项目名" 判断覆盖。面板概览卡片懒加载（当日缓存）。
- v0.5（2026-10-31）：R4 实现回填（0.7.0）。设计落地差异：hermes.mjs 暂以 generic.mjs 承接（待接口信息后替换专用适配器）；连接器状态持久化到 config.connectors[]；同步去重靠条目指纹。飞书 feedMessages 默认关（需真实凭据后手动开）。
- v0.4（2026-10-31）：R3 实现回填（0.6.0）。新增 summarize 场景与 worklog_report action=summarize（设计 v0.1 的"总结场景"落点，自由范围 + 无 AI 降级）。文件读取用 readFileSync（首版误用 async 导致解析失败的自测教训记入）。
- v0.3（2026-10-31）：R2 实现回填（0.5.0）。设计复审修正一处：collect-sessions 调度任务在扫描时同步 appendEntries（定时采集即时产出条目，不等归档）。panel-sim 增加日历页签覆盖。
- v0.2（2026-10-31）：R1 实现回填（0.4.0）。新增 lib/watch.mjs 计划外模块；scheduler 增 collect-watch 任务；工具数 15。R2 前待补充：entries.json 字段定稿、日历页签信息架构图。
