# WorkLog 待办扩展设计（todos v2）

> 面向 `zcode-worklog` 0.2.6 的待办功能整体升级设计。
> 范围：闭环增强 + 报告聚合 + 子任务与标签 + AI 待办助手，归档时自动顺延。
> 状态：设计稿，待实现。实现时以本文件第 2–10 节为准。

## 0. 结论先行

| 里程碑 | 内容 | 版本 |
| --- | --- | --- |
| M1 闭环增强 | 数据模型 v2、`update`/`stats`/`carry_over` action、list 查询排序、面板行内编辑/智能排序/筛选、归档「待办」小节 + 自动顺延、周月季报聚合 | 0.3.0 |
| M2 子任务与标签 | `subtasks` / `tags` 全链路：行内语法 `#tag`、面板进度条与筛选 chips、命令与工具参数 | 0.3.1 |
| M3 AI 待办助手 | `parse`（单条智能填单 + 批量解析入库）、`suggest`（每日 3 件要事） | 0.3.2 |

目标定位：把待办从「只能记和勾」升级为「记 → 排序 → 做 → 完成 → 进日报 → 进周月报」的闭环。待办始终是日志的输入，不是独立任务管理系统。

**不做什么**：看板/四象限视图、多人协作、跨设备同步、后台提醒推送（面板只在打开时存在，无法常驻提醒）。

## 1. 现状与痛点（0.2.6）

- 数据：`data/todos.json`，字段 `{id, title, md, status, pri(高/中/低/''), due, repeat, created, updated, done_at}`
- 工具：`worklog_todos` 只有 `list/add/complete/reopen/delete/clear_done`；store 里已有 `updateTodo` 但未暴露
- 面板：快速添加（`!高` / `@2026-11-06` 行内语法）+ 勾选完成 + 删除 + 清空已完成；**不能编辑**，无排序、无筛选
- 归档：`buildDayMarkdown` 没有待办小节；未完成项不处理，越积越旧
- 报告：周月季报不含任何待办统计
- Hook：session-start 只报数量和前 3 条标题，逾期不突出

## 2. 数据模型 v2（lib/store.mjs）

```jsonc
{
  "id": "uuid",
  "title": "发周报",
  "md": "",
  "status": "open",            // open | done
  "pri": "高",                  // 高 | 中 | 低 | ''
  "due": "2026-11-06",
  "repeat": "",                 // daily | weekly:0-6 | monthly:1-31 | ''
  "created": "…", "updated": "…", "done_at": "",
  // ---- v2 新增 ----
  "tags": ["周报"],             // string[]，小写去重
  "subtasks": [                 // 子任务 checklist
    { "id": "uuid", "title": "收集数据", "done": false }
  ],
  "carries": 0,                 // 被顺延次数
  "lastCarry": ""               // 最近一次顺延日期 YYYY-MM-DD（幂等护栏）
}
```

规则：

- **向后兼容**：所有新字段有缺省值，旧 `todos.json` 读入即合法。`loadTodos()` 读入时经 `normalizeTodo()` 补默认值（`tags: []`、`subtasks: []`、`carries: 0`、`lastCarry: ''`），只规整不写回，避免无谓写盘；下次任何保存自然落盘新结构。不加 schema version 字段。
- `addTodo` / `updateTodo` 接受 `tags`、`subtasks` 并清洗：tags 取字符串数组、`trim`、去空、去重、上限 8 个；subtasks 校验 `{id, title, done}` 结构，title 非空。
- `spawnRepeatedTodo` 已是 `...todo` 浅拷贝，`tags/subtasks` 自动带到下一次重复实例，但子任务 `done` 要重置为 `false`（新一天重新勾）。
- 子任务不计入独立到期/优先级；父待办完成不强制完成子任务（宽松语义，避免误操作）。

## 3. worklog_todos API v2（src/api.mjs `todoAction`）

既有 action 全部保持兼容。新增/扩展：

| action | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `update`（新） | `id` + 任意字段 patch（title/md/pri/due/repeat/tags/subtasks） | `{todo, spawned}` | 暴露既有 `updateTodo`；`repeat` 变更不触发补生成，只在 status→done 时走 `spawnRepeatedTodo` |
| `carry_over`（新） | `{date?}`（缺省今天） | `{carried: [{id,title,pri,due,carries}], skipped}` | 幂等：`lastCarry === 今天` 的项跳过。归档流程内部自动调用，也单独暴露给命令/面板 |
| `stats`（新） | `{}` | `{open, overdue, doneToday, doneWeek, byPri}` | 面板统计条与报告共用同一实现 |
| `list`（扩展） | 可选 `{status, pri, tag, q, sort}` | 项数组 | 服务端过滤+排序，供命令/工具用；`sort: 'smart'(默认) \| 'created' \| 'due'` |
| `add`（扩展） | 追加 `tags`、`subtasks` | todo | 行内语法扩展 `#标签`（M2） |

**智能排序**（`compareTodos(a, b, today)`，store 导出，list 与报告复用）：

1. 逾期（open 且 due < today）按 due 升序
2. 高优按 due 升序 → 3. 中优 → 4. 低优（组内 due 升序，无 due 在后按 created 倒序）

面板无法 import store（内联浏览器 JS），在 `src/panel.js` 复刻同一份 ~15 行比较函数，两端规则在测试里用同一组样例断言一致。

## 4. 归档集成与自动顺延（lib/archive.mjs）

**触发点**：`archiveDay()` 内、扫描完成后、`buildDayMarkdown` 之前。

**触发条件（关键）**：仅当 `dateString === localDate()`（归档的是今天）才执行 `carry_over`。补归档历史日期**不**触发顺延（避免把今天的动作写进上周的日志造成误导），此时日报待办小节用纯快照（只写完成/新增/逾期计数）。

**顺延规则**（用户已选自动顺延）：

- 对象：`status === 'open' && due && due < today && lastCarry !== today`
- 动作：`due = today`，`carries += 1`，`lastCarry = today`
- 效果：列表里永远只有「今天到期」和「未来到期」两种未完成项，逾期态在归档后即清零；连续未完成的任务 `carries` 逐日 +1，成为"拖延热度"指标
- 幂等：同一天重复归档（force 重跑、auto+manual 并发）由 `lastCarry` 挡住

**日报小节**（`buildDayMarkdown` 增加第 5 参 `todoSection`，由 `archiveDay` 组装后传入，保持函数纯度便于测试）：

```markdown
## 待办

- 今日完成 3 条 · 新增 2 条 · 顺延 5 条（另 1 条逾期未顺延仅提示）
- 今日完成：发布 0.2.6、修面板深色主题、回复评审
- 顺延：[高] 写季度 OKR（第 3 次）、[中] 整理会话缓存…
- 当前未完成共 12 条，最近到期 2026-11-02
```

- 「今日完成」取 `done_at` 在归档日的 done 项（字段已有，无需迁移）；「新增」取 `created` 在归档日的项
- 顺延清单由 `carry_over` 返回的 `carried[]` 渲染，标注 `carries` 次数（≥2 次加醒目前缀）
- 自动归档的 run history note 追加顺延计数：`自动归档：N 提交 / M 文档 / K 会话 / 顺延 5 待办`

## 5. 面板 UI（src/panel.js `todosTab`）

```
┌ 待办页签 ──────────────────────────────────────────────┐
│ [新待办，支持 !高 #标签 @2026-11-06____] [添加] [AI 填单*] │
│ [优先级▾] [到期日____] [标签筛选: 全部|#周报|#okr]  统计条  │
│ 统计：进行中 12 · 逾期 2 · 本周完成 8        [清空已完成] │
├───────────────────────────────────────────────────────┤
│ 进行中（智能排序：逾期>高>中>低>无，组内按到期日）           │
│ ☐ [高][已逾期·顺延2] 写季度 OKR  #okr  2/5 ▸  [编辑][删]  │
│ ☐ [中] 发周报 #周报 到 2026-11-06            [编辑][删]  │
│ （点「编辑」→ 行内展开表单：标题/优先级/到期/重复/标签/子任务/备注）│
│ 已完成（最近 40 条，含完成日期）                           │
└───────────────────────────────────────────────────────┘
```

- **统计条**：`stats` action 数据，AI 未配置时「AI 填单」按钮隐藏（M3 接入，M1 预留位置）
- **行内编辑**：点「编辑」把 `todoItem` 展开为表单（复用添加行的控件），保存调 `update`，取消还原；删除保留现有无确认直删（有备份兜底）
- **筛选**：标签 chips 单选切换 + 优先级下拉，纯前端过滤 `state.todos`，不加请求
- **子任务**（M2）：meta 行显示 `2/5` 进度；编辑表单内增删子任务、勾选 toggle（调 `update` 传整个 subtasks 数组）
- **顺延标记**：`carries >= 1` 显示「顺延 N」小标，>=2 换警示色（复用 `.overdue` 样式族）

## 6. AI 待办助手（M3，src/api.mjs + lib/report.mjs）

复用既有 `aiComplete` 管道；给 `aiComplete` 加第 4 参 `{ kind = 'report' }`，待办类调用传 `kind: 'todo'`，用量统计自动落 `state.aiUsage`，面板 AI 用量表按 kind 分列。

### `todos.parse` — 自然语言 → 待办草稿

- 入参：`{text, mode: 'one' | 'batch'}`，返回**草稿数组，不直接入库**（安全 + 可改），面板确认后才调 `add`
- Prompt 要点（system）：
  - 输出**纯 JSON**：`{"todos":[{"title","pri":"高|中|低|","due":"YYYY-MM-DD|","repeat":"daily|weekly:N|monthly:N|","tags":[]}]}`，不输出其他文字
  - 相对时间解析规则：周五→本周五、下周一→下周一、月底→当月最后一天、3 天后→today+3；无时间信息 `due: ""`
  - `repeat` 关键词：每天/每日→daily，每周X→weekly:X，每月X号→monthly:X
  - 紧急/尽快/马上→高优；不急/有空→低优；`#词` 提取为 tags
  - batch 模式：把一段会议纪要/便签拆成多条独立待办，每条 title 一句话
- 面板两种入口：
  - **单条智能填单**：输入框旁「AI 填单」按钮 → 解析当前输入 → 回填表单控件供确认
  - **批量解析**（折叠块）：粘贴一段文字 → 解析出 N 条草稿 → checkbox 列表预览（可逐条改 pri/due）→ 添加选中项
- AI 未配置（无 baseUrl/model）时入口不渲染；请求失败 notice 提示原因，不阻塞普通添加

### `todos.suggest` — 每日 3 件要事

- 入参：`{}`；把 open 待办（id/title/pri/due/carries/tags）+ 今日归档状态喂给模型，要求选 3 条并各给一句话理由，输出 JSON `{"picks":[{"id","reason"}]}`
- 面板「待办」页签顶部卡片「今日 3 件要事」，点条目滚动高亮对应待办；每次打开可手动刷新，不做自动请求（打开面板不产生计划外网络调用）
- 失败静默降级：卡片收起为一行「AI 建议生成失败：原因」

## 7. 报告聚合（lib/report.mjs `generateReport`）

**直接从 `todos.json` 聚合，不解析日报 markdown 小节**（快照写进日报只供人读，程序聚合走结构化数据，避免 markdown 回析的脆弱性）。

在现有周/月/季报尾部追加小节：

```markdown
## 待办概况

- 完成 23 条，按时完成率 78%（done_at ≤ due 计按时）
- 当前逾期 2 条，平均被顺延 1.4 次
- 顺延最多：写季度 OKR（顺延 3 次，仍未完成）
```

- 范围口径：完成数/按时率统计 `done_at` 落在报告区间内的项；逾期/顺延统计报告生成时点的实时状态
- 无待办数据的区间输出「本期待办统计：无记录」，不空挂小节

## 8. 周边同步更新

| 文件 | 改动 |
| --- | --- |
| `src/server.mjs` | `worklog_todos` 描述补新 action 与字段；工具数不变（仍 13 个，无新工具） |
| `commands/todo.md` | 分派表加 `edit`/`stats`/`carry`；`add` 支持 `#tag`；sort 默认 smart |
| `skills/worklog/SKILL.md` | 待办段落同步 |
| `hooks/session-start.mjs` | 前 3 条预览改用智能排序（逾期优先），文案 `待办 12 条进行中（2 条逾期：xxx…）` |
| `README.md` / `README_CN.md` | 功能说明与版本记录 |

## 9. 迁移与兼容

- 无破坏性变更：旧字段全部保留、新字段全可缺省；旧命令/旧 action 调用零感知
- 首次保存后 `todos.json` 自动带新字段；回滚到 0.2.6 也能读（多出的字段被忽略）
- `worklog_backup` / 恢复流程已按整个 `todos.json` 处理，无需改动

## 10. 测试要点

- `test/` store：normalize 缺省字段；update 各字段 patch；carry_over 幂等（同日二次调用 skipped、跨日再顺延）；repeat 生成携带 tags/subtasks 且子任务 done 重置；smart 排序样例组（面板比较函数用同一组样例断言同序）
- `test/` api：新 action 参数校验（update 缺 id、carry_over 非法 date、parse 无 AI 配置时报错文案）
- 归档：归档今天含顺延小节且 run history 记顺延数；补归档历史日期不触发顺延；`--force` 同日重跑不重复顺延
- 报告：完成率/逾期统计口径（done_at 跨区间边界）；无待办区间不挂空小节
- 既有用例注意：`sources.sessions=false` 会持久化到 config.json，新用例需显式覆盖（0.2.0 踩过的坑）
- `npm test && npm run test:panel && npm run smoke:mcp`；smoke 断言 toolCount 仍为 13

## 11. 里程碑任务拆解

**M1（0.3.0）**：store（normalize/tags/subtasks 字段清洗 + compareTodos + carryOver + todoStats）→ api（update/carry_over/stats/list 查询）→ archive（carry 触发 + 待办小节 + run note）→ report（待办概况）→ panel（排序/筛选/统计条/行内编辑，tags/subtasks 控件同文件先备好 M2 复用）→ hook/命令/工具描述 → 测试 → 版本四连跳发布。

**M2（0.3.1）**：`#tag` 行内语法（添加框与命令）、面板标签筛选 chips 默认启用、编辑表单子任务管理、README。

**M3（0.3.2）**：aiComplete 加 kind 参数 → `todos.parse` + 面板智能填单/批量解析 → `todos.suggest` + 每日 3 件要事卡片 → 用量统计分列。

发布流程（既有）：bump `.zcode-plugin/plugin.json`、`lib/config.mjs` 的 `PLUGIN_VERSION`、`marketplace.json`、`package.json` → push → `zcode plugins marketplace update zcode-worklog && zcode plugins update zcode-worklog@zcode-worklog` → **新开会话**（当前会话 MCP 进程仍旧版）。

## 12. 风险与边界

- **顺延语义**：归档把逾期 due 改为今天，"逾期"红标当天即消失——这是刻意行为（列表只剩"今天到期/未来"两种态），拖延热度用 `carries` 传达；若 Ray 觉得丢失逾期警示，可加开关 `todoCarry: true|false`（config 一行，默认开）。
- **AI parse 的日期幻觉**：模型可能给出错误 due；草稿必须经用户确认，且 due 一律渲染为可编辑的 date input。
- **suggest 成本**：open 待办很多时 prompt 变大——截断为智能排序前 30 条喂模型，足够选 3 件要事。
- **面板与 store 排序逻辑双份**：用共享测试样例锁行为，注释里互相指向。
