# brief: WorkLog 面板 UX v3 重构 · P2 设置页拆分

- **目标**：设置页从"表单 + 4 个异步折叠块混一页"改为常规左导航 + 右表单子页（7 项），诊断独立子页；发布 0.20.0 供真机试用。
- **档位**：深度（设计已确认，执行 brief）
- **边界**：lib/ 零改动；api.mjs op 枚举与参数不改；术语清理属 P3（子页导航文案用设计文档 §3 表格里的正式命名，但旧的"重建/指纹"等词的全面清理留给 P3）；其余页签（今天/时间/资料库/报告）本期不再动。
- **验收**：文末清单。
- **日期**：2026-11-02

## 规格来源

- 设计文档 `docs/ux-v3-design.md` §3 设置行 + §4.5 + §5
- 原型 `E:\Develop\.zcode\v2\visualizations\bef4e9e9256c80d3d5efc4672d74f841838a1b4199125e1883149a33220c09c0\worklog-ux-v3-prototype.html` 的「设置」页签（布局/文案规格；视觉沿用 panel.css）

## 具体改动

1. **左导航 7 子页**（wsub 风格沿用 P1 资料库 segmented 的实现方式或等价横向导航）：通用 / AI 接口 / 采集与调度 / 连接器 / 提示词模板 / 备份与迁移 / 诊断。默认落「通用」。
2. **内容映射**（现有区块 → 子页）：
   - 通用 = 数据目录（只读展示）/ 扫描目录 scanRoots+docRoots / git 作者 / 自动归档开关+时间
   - AI 接口 = AI 润色配置（Base URL/Key/模型/加载模型）+ 「扫描本机 AI 工具」候选列表（wizardSection 并入此页，不再独立折叠块）
   - 采集与调度 = schedSection（调度任务表+立即运行）+ 会话来源开关 + 额外 AI 会话目录
   - 连接器 = connSection 原能力（新建/编辑/测试/同步/删除，删除需确认）
   - 提示词模板 = tplSection 原能力（5 场景编辑/恢复内置）
   - 备份与迁移 = 备份列表+创建+恢复（确认）+删除（确认）+ 旧 WorkLog 导入
   - 诊断 = 各来源健康表（上次扫描/文件数/错误/重扫）+ 调度运行历史（从旧概览"最近运行"迁入）+ AI 用量（worklog_usage）+ 缓存大小与清理
3. **加载纪律**：子页内容首次进入时懒加载（loadSched/loadTpls/loadConns 同款"已加载+进行中"双守卫），失败显示错误 + 「重试」按钮；删除全部折叠交互（settingsSection 折叠机制整体退役），不允许出现折叠块嵌套。
4. **保存纪律**：有独立草稿的子页（通用/AI 接口/采集）各自「保存」；任何子页草稿脏时底部出现保存条（dirty 提示 + 放弃/保存），切走子页时脏草稿提示不丢。saveSettings/draftFromConfig 既有逻辑复用，不重写存储结构。
5. **旧入口清理**：settingsSection 折叠头、原四折叠块标题结构移除；grep 确认无孤儿函数。

## 测试要求

- `npm test` / `npm run test:panel` / `npm run smoke` 全绿（原生退出码）；panel-sim 增加：7 子页遍历、折叠块不复存在、懒加载失败重试路径（可 mock 失败响应）、脏草稿保存条。
- 历史教训同 P1 brief（未捕获错误=真 bug；npm test 退出码不得被管道吞）。

## 发布

版本 0.20.0 四处同步（package.json / marketplace.json / .zcode-plugin/plugin.json / lib/config.mjs），build → commit → push → marketplace update → plugins update；docs/ux-v3-design.md 状态行更新为 P2 已实施（0.20.0），requirements.md 文末加变更记录。收据提醒：需新开会话/重启 ZCode 试用。

## 验收清单

- [x] 设置页为左导航 7 子页，无折叠块（grep settingsSection/settingsOpen 零命中；panel-sim 断言 .wl-fold 全面板为 0）
- [x] 7 个子页内容齐全（映射表逐项），向导并入 AI 接口，诊断含来源健康/运行历史/用量/缓存（sim 逐页断言）
- [x] 懒加载双守卫 + 失败重试路径存在（collect 首调失败→错误+重试→成功，sim 断言；tpl/conn 同构）
- [x] 脏草稿保存条工作（键入显隐、切子页不丢、放弃清脏，sim 断言三段）
- [x] 三套测试全绿（npm test 86/86 exit 0；test:panel exit 0；smoke exit 0）
- [x] 0.20.0 已发布，四处版本号一致（grep 在案；安装缓存 package/plugin.json/server.mjs 均 0.20.0）
- [x] 收据完整（见主会话收据）
