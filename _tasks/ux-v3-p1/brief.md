# brief: WorkLog 面板 UX v3 重构 · P1 新骨架

- 目标：面板 6 页签 → 5 页签（今天/时间/资料库/报告/设置），删"当日枢纽"，报告独立页签，今天页 v1；发布 0.19.0
- 档位：深度（设计定稿，只执行）
- 边界：lib/ 零改动；src/api.mjs op 枚举与参数不改；MCP 工具/斜杠命令/hook 不动；设置页拆分与术语清理 = P2/P3 不做
- 日期：2026-11-02

## 事实来源
1. docs/ux-v3-design.md §3/§4/§5
2. 原型 E:\Develop\.zcode\v2\visualizations\bef4e9e9256c80d3d5efc4672d74f841838a1b4199125e1883149a33220c09c0\worklog-ux-v3-prototype.html（布局/文案；视觉沿用 panel.css）
3. 三个取舍点裁决 = 全默认：待办工作台在时间页底部；图谱进资料库子视图；统计卡墙/项目卡删除

## 改动清单（src/panel.js）
1. TABS → today/time/library/report/settings，默认 today
2. todayTab v1：归档状态卡（未归档→「生成今日日志」= archive run force:false；已归档→打开/继续编辑=跳时间页编辑态）；今日待办（due≤today 可勾、就地快加、管理全部待办→时间页滚动定位）；recoCard 建议关注；今日 AI 会话简表（点行→资料库预置当天筛选）；昨天回顾（day op 前 10 行+打开）。删统计卡墙/项目卡/最近运行
3. timeTab：wl-master 左日历（月/周切换保留，标记收敛 ● 日志/▼ 到期/◦ 会话）右当日详情（到期待办可勾+快加 / 日志卡阅读+编辑+保存 / 当天会话→资料库 / 当天记录 / 生成日报或重新生成(force 前确认) / 历史无日志→回填归档）；底部通栏 todosWorkbench 原样搬入（能力不减）；dayHub 状态机删除
4. libraryTab：segmented 会话/日志/图谱。会话=sessionsV2Block 去月历（sessCal* 全删）；日志=搜索+结果行内展开全文（day op）；图谱=graphTab 原样搬入
5. reportTab：生成区平铺（类型 chips 7 种：daily/weekly/month/quarter/perf/project/自由总结；自由总结走 report op action=summarize start/end；范围随类型带默认值；AI 润色开关未配置禁用+提示）；列表按类型分组（kind 取自文件名前缀，summarize→自由总结）；重新生成需确认弹窗（前端 state.confirm）；生成后 refreshAll + 高亮新条目；reportsFold 删除
6. 死代码清理：overviewTab/logsTab/sessionsTab/graphTab/dayHub/reportsFold/sessCalendar*/card 等不留孤儿

## 关键既有 op 参数（已核实）
- archive run: { action:'run', date, force }（backfill 用 dates 数组，本期不用）
- report generate: kind/date|monday|month|quarter|project + useAi；summarize: { action:'summarize', start, end, useAi }
- calendar month/day；day get/save；sessions query/sync_all/content/index_status

## 历史教训
- 双守卫（已加载+进行中）必须保留；新增异步块照抄
- panel-sim 未捕获 jsdom 错误 = 真 bug
- 发布命令不许管道吞 npm test 退出码
- panel JS/CSS 由 lib/panel.mjs 内联
- state.editingDraft + harvest() 草稿驱动沿用

## 测试
- npm test / test:panel / smoke 全绿（原生退出码）；panel-sim 改 5 页签遍历
- 新增：时间页点天不换页详情刷新；报告重新生成确认弹窗；今天页归档状态机（未归档→进行中→已归档）
- e2e-ops 版本 pin 同步（现 pin 0.17.2 已落后于 0.18.0，属遗留失败，随本次 bump 修为 0.19.0）

## 发布
1. 0.19.0 四处：package.json / marketplace.json / .zcode-plugin/plugin.json / lib/config.mjs PLUGIN_VERSION
2. npm run build → git add -A && git commit && git push
3. zcode plugins marketplace update zcode-worklog && zcode plugins update zcode-worklog@zcode-worklog
4. docs/ux-v3-design.md 状态行 → "已确认，P1 已实施（0.19.0）"；docs/requirements.md 变更记录加一行
5. 收据提醒：当前会话 MCP 仍旧版，需新开会话/重启 ZCode

## 验收清单
- [x] 页签恰 5 个，默认今天（panel-sim deepEqual 断言）
- [x] 时间页点天只刷新右侧详情（sim 断言 master/日历仍在、页签不切换）
- [x] 全面板唯一日历（会话月历已删，sim 断言）
- [x] 格子标记 ≤3 种（●日志 ▼到期 ◦会话，sim 断言旧徽标清零）
- [x] 报告生成 ≤2 步平铺可达（页首生成卡，无折叠）
- [x] 重新生成报告/覆盖归档有确认（wl-modal 弹窗，sim 断言取消/确认两路）
- [x] 统计卡墙、项目卡不再出现（card() 已删，sim 断言）
- [x] 三套测试全绿（npm test 86/86 退出码 0；test:panel 退出码 0；smoke 退出码 0）
- [x] 0.19.0 发布，四处版本一致（package.json / marketplace.json / .zcode-plugin/plugin.json / lib/config.mjs = 0.19.0；marketplace update + plugins update 已执行，提示需重启 ZCode）
