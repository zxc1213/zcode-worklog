---
name: worklog-platform-roadmap
description: WorkLog 平台化长期项目：需求/设计文档位置、R1-R6 路线图、当前进度与待 Ray 确认的开放问题
metadata:
  node_type: memory
  type: project
  originSessionId: sess_a8f6f94f-5697-4723-9ff6-174ed27dbdee
---

WorkLog 平台化改造（2026-10-31 启动）：需求文档 `docs/requirements.md`、设计文档 `docs/design.md`（仓库内，逐步完善）；基线九条（AI对话定时/手动采集、AI工具位置向导、飞书/禅道/Hermes 对接、目录监控、周期推荐、自定义对接配置、自定义提示词模板总结、交互日历、知识图谱）映射为 REQ-C1..P4，路线 R1(调度+向导+网盘指纹,0.4.0)→R2(统一条目+日历,0.5.0)→R3(提示词模板,0.6.0)→R4(适配器框架+飞书/禅道,0.7.0)→R5(推荐引擎,0.8.0)→R6(知识图谱,0.9.0)。

**进度**：R1-R6 全部完成并发布（0.4.0 → 0.9.0，九条基线全部落地）。R6 收官：lib/graph.mjs 规则图谱（person/tool/source/topic→project 四类关系，归档自动重建，worklog_graph 工具），面板 8 页签（概览/日历/日志/待办/汇报/图谱/会话/设置）。20 个 MCP 工具、67 测试全绿。1.x 候选：飞书子项真机验证（待凭据）、对外回写 E2、AI 主题抽取、力导向可视化、日历周视图。

**关键设计决策**：补偿式调度（hook + bootstrap 双触发，插件无常驻进程）；条目 append-only+指纹去重；模板文件化 data/templates/*.md；图谱规则优先 AI 增强；外部对接只读优先。

**待 Ray 提供**：Hermes 接口信息；飞书自建应用权限与优先范围；禅道地址/版本；网盘具体路径；定时粒度期望。

**R7（0.10.0，e2d353e）会话管理 v2**：collectAllSessions（全源全历史，sqlite 源按窗口扫+按 source+file 合并跨天）；data/sessions-index.json 持久索引（sha1(source|file) 键，marks/group 跨重建保留）；query 多维筛选（q/project/source/date/minTurns/mark/group/workOnly+workKeywords）一次返回 sessions+keywords(中英 n-gram)+groups；mark/unmark/group 动作；面板会话页签 v2。**关键教训：day 路径与全量路径必须隔离窗口参数**（scanSessions 强制 windowDays=1，否则 sqlite 120 天窗口拖慢归档/hook/测试——曾把 npm test 卡到超时）。

**0.11.0（52fa1c9）会话月历**：sessionMonthCounts 按活跃天计数（跨天会话每天都计）；会话页签默认月历，点天→工作台按该天筛选（first<=day<=last）可标记/设组；worklog_sessions action=month。入库会话入口=会话月历/日历页签某天详情/日报小节。

**0.12.0（61363e7）日志页签 v2**：月历置顶（复用 calendar op，格子=归档●/日报●/条目数/待办✓），点天载入；内容查看（wl-pre）/编辑（textarea）分离，未归档天直接编辑态；panel-sim 断言已同步更新。Ray 的 UI 偏好模式：**浏览用月历、内容分阅读/编辑两态、列表平铺=差评**——后续新页签直接按此模式设计。

**0.14.0（9930b19）IA 重设计**：页签 7→6（概览/日程/日志·汇报/会话/图谱/设置）。「日程」= 日历+待办整合：calDayHub（到期待办勾选完成/就地加待办/打开日志/生成日报/会话跳转预置筛选/采集条目）+ 月历 ▼到期徽标 + 下方待办工作台；日志页移除月历。calendar API 增 todoDue/todosDue。**教训：panel.js 大段删移用「括号扫描+唯一性断言」的 python 脚本，禁止 s.index 想当然（曾回绕造成全文件重复，靠 git checkout 重放 recovery）**。

**0.16.x-0.17.0（至 4a4d003）**：会话行展开「加载完整摘录」（getSessionDetail 按天摘录，源丢失有提示）；信息可达性审计修复（会话行展开/图谱对端遍历/概览卡片与建议跳转）；**TDZ 真 bug 修复（0.16.1）**：scheduleTab `const today = ...|| today()` 自引用，点日程即抛——定位法：sim 的 jsdomError 钩子加堆栈 + minify:false 出包跑模拟器看真名；此前两轮把它标为"模拟器噪声"是误判，**未捕获错误必须当真 bug 查**。日程周视图（月/周切换，跨月自动拉取）。当前 0.17.0。

**0.17.1（f98d9eb）设置冻结修复**：三个异步设置折叠块（调度诊断/模板/连接器）在 render 内无条件触发加载→加载中/失败/空响应时无限渲染循环冻结全面板。修复=双守卫（已加载+进行中）+失败/空响应哨兵；sim 补折叠展开回归（此前从未展开过设置折叠，bug 逃逸四个月）。**0.17.2（7382478）**：r1 调度测试扫真机会话目录 55s 挤掉断言——scheduler 加 WORKLOG_SESSION_HOME 测试覆盖；**流程教训：npm test 接 grep 管道会吞退出码，发布命令链里的测试必须用原生退出码阻断（本次失败测试被带过发布）**。

**0.18.0（0fe711f）**：Ray 发现日历 ◀▶ 全是年±1（0.11.0 写错后复制三处）——shiftMonth 修复；新增 test/e2e-ops.test.mjs（dispatch() 打全部 22 个 op 的端到端 sweep，86 用例）；日报待办小节补未完成标题（此前只有数量，问答搜索盲区）。当前 0.18.0，86 用例全绿。

**0.19.0-0.22.0（UX v3，2026-11-01/02）**：页签重组 5 个（今天/时间/资料库/报告/设置）、主从布局、设置左导航 7 子页、术语清理、摘录缓存读、图谱 SVG。详见仓库 docs/ux-v3-design.md 与 requirements.md 变更记录（memory 不重复仓库可查内容）。

**0.23.0（a59bcca，2026-11-02）检视修复轮**：功能定义/交互/易用性专项检视后一次收 12 项——工具面描述纠错（wizard 幽灵 worklog_ai 引用、sessions 缺 month/content）、待办删除/清空确认、日志编辑脏守卫、会话来源下拉、搜索日期范围（searchDays start/end 先于 cap 过滤）、弹窗 Esc/遮罩、日历失败哨兵+重试。**新教训：call() 会把 structuredContent 顶层 items 数组解包成裸数组——op 返回 {date, items} 这类对象时消费端拿到数组（建议卡因此自 0.8.0 起从未渲染过，真机无感知因为不报错只是空白）；新增 op 返回形状要么避开顶层 items 键，要么消费端归一化（loadReco 已做）**。同类信封全量排查过，recommend 是唯一受害者。91 用例+panel-sim+smoke 全绿；Mimosa deep 扫描 0 findings。

**剩余欠账（按优先级）**：① Agent 工具面收敛 20→~10（ux-v3 §9 承诺另立方案文档，涉及 Ray 使用习惯，未动）；② 连接器真实凭据验证（飞书子项/禅道，等 Ray）；③ 推荐引擎采纳率复盘（等使用数据）；④ REQ-D1 模板导入导出（现靠磁盘直改+备份部分兜底，低频）。

每里程碑完成后按 [[publish-worklog-after-changes]] 发布，并回写两文档的变更记录。技术细节见 [[zcode-worklog-plugin]]。
