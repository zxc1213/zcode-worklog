# zcode-worklog

**独立 WorkLog for ZCode**：本机工作日志、Git/文档/AI 会话归档、待办、日报/周报/月报/季报/绩效素材，以及一个可交互的侧边面板。

- 不依赖 `WorkLog.exe`，不访问 `127.0.0.1:8377`。
- 侧边面板完全内置：脚本与样式内联在插件返回的 HTML 中，宿主只负责显示，不加载任何外部应用或子资源。
- 数据在 ZCode 的插件数据目录（`ZCODE_PLUGIN_DATA`，面板顶部会显示实际路径），不会写回安装目录。
- 归档时自动汇总本机 AI 工具会话（Claude Code、Codex、DSH、WorkBuddy、ZCode、OpenCode、Gemini CLI 等）。
- 归档目录规则与原 WorkLog 一致，旧 `data\archive` 可直接导入。

## 安装（从 GitHub）

市场仓库：<https://github.com/zxc1213/zcode-worklog>

**方式一：命令行**

```bash
zcode plugins marketplace add zxc1213/zcode-worklog
zcode plugins install zcode-worklog@zcode-worklog
```

**方式二：图形界面**

1. 打开 ZCode **设置 → 插件市场 → 添加 → 添加插件市场**，粘贴：

   ```text
   zxc1213/zcode-worklog
   ```

2. 在 **个人 → zcode-worklog → zcode-worklog → 安装**（完整插件 ID：`zcode-worklog@zcode-worklog`）。
3. 安装后新开一个会话（或重启 ZCode）。
4. 在对话侧栏的面板入口打开 **WorkLog**；看不到入口时先确认插件已启用。

> 仓库根目录同时是插件根目录（`.zcode-plugin/plugin.json`）和市场清单（`marketplace.json`），所以一条 GitHub 源即可完成添加市场和安装插件。本地开发时也可以继续用 `E:\AI_Project\research\marketplace.json`。

### 打开面板

- **对话里直接说**：“打开 WorkLog 面板”，Agent 会调用 `worklog_open`，在右侧侧栏打开。
- **手动入口**：右侧面板点 **新增标签（+）** → **应用插件** → **查看所有插件** → **WorkLog** → 打开。
- 也可以在 **设置 → 插件 → 插件市场 → 个人/已安装 → 应用插件** 里找到 WorkLog 并点「打开」。

> 右侧「应用插件」快捷区只显示 ZCode 官方推荐的插件；WorkLog 属于社区插件，需要走「查看所有插件」或插件市场里的「应用插件」区域。

## 面板

侧栏 **WorkLog**，六个页签：

| 页签 | 内容 |
|---|---|
| 概览 | 今天是否归档、日志/待办/项目/备份/AI 会话统计、今天的 AI 会话列表、最近运行、一键归档今天 |
| 日志 | 读取/编辑/保存某天 Markdown、搜索归档、重新归档、生成日报 |
| 待办 | 添加、行内编辑、完成、重开、删除、清空已完成；智能排序（逾期 > 优先级 > 到期日）、优先级/标签筛选、统计条；`!高`、`@2026-10-30` 快捷语法 |
| 汇报 | 日报、周报、月报、季报、绩效素材、项目档案；可选 AI 润色；查看已生成报告 |
| 会话 | 按日期扫描本机 AI 工具会话，查看来源/标题/轮数/项目/会话源；只读，不写归档 |
| 设置 | 分块折叠：数据与扫描、AI 润色、备份与恢复、从旧 WorkLog 导入；顶部常驻保存栏 |

面板通过插件自己的 MCP 工具 `worklog_api`（仅面板可见）读写同一份本地数据。面板脚本与样式由插件服务端内联进 `ui://zcode-worklog/panel.html`，不依赖外部程序；如果面板一直停在加载态，先关闭面板重开，仍不行就更新插件并重启 ZCode（`zcode plugins update zcode-worklog@zcode-worklog`）。

## AI 配置复用

**设置 → AI 润色 → 扫描本机 AI 工具** 会只在本机读取以下位置，列出可复用的接口，点「使用」即可写入插件配置（API Key 只在本机进程内传递，不会显示在面板里）：

| 来源 | 读取内容 |
|---|---|
| ZCode | `~/.zcode/v2/config.json` 中已配置的供应商（baseURL、apiKey、kind、模型），优先显示当前选中的供应商 |
| DeepSeek Harness | 活动 profile（`~/.dsh/profiles/web/cordis.patch.yml` 或 `cordis.yml`）里 `llm-pi-ai` 的 `providers`，旧版回退到 `settings.yaml` / `settings-legacy.yaml`；密钥取自 `.credentials.yaml` 的 `refs`，含 `DEEPSEEK_API_KEY` |
| Claude Code | `~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_DEFAULT_*_MODEL` |
| Codex CLI | `~/.codex/config.toml` 与 `auth.json`（只有存在 API Key 时才会列出；OAuth 登录无法复用） |
| Gemini CLI | `GEMINI_API_KEY`（环境变量或 `~/.gemini/.env`），走 OpenAI 兼容端点 |
| 环境变量 | `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `ANTHROPIC_API_KEY` 等 |

接口格式支持 **OpenAI 兼容**（`/chat/completions`）和 **Anthropic 兼容**（`/v1/messages`），ZCode 目前常用的 BigModel / Z.ai Coding Plan 属于后者。手动填写也照常可用。

0.2.4 起：本机配置以下拉框展示（标注可用模型数，不再平铺）；填好 Base URL / Key 后点「加载模型」会请求 `/models`（Anthropic 兼容为 `/v1/models`），模型框变成可下拉选择、也可手动填写；接口不提供模型列表时自动回退到本机配置里已知的模型。

## 数据目录

```text
<plugin-data>/
  config.json                  # 配置（含可选 AI API Key，明文，仅本机）
  data/
    archive/
      2026-10/
        第5周(10.26-11.01)/
          2026-10-29.md       # 每天一篇 Markdown
      reports/                # 日报/周报/月报/季报/绩效素材
    todos.json
    state.json                # 最近归档、运行历史、AI 用量
    session-cache.json        # AI 会话解析缓存（按文件 mtime+size 增量刷新）
    backups/                  # JSON 备份
```

周目录规则：周一~周日，整周归周四所在月。旧 WorkLog 的 `data\archive` 可以直接复制或用「设置 → 从旧 WorkLog 导入」。

## 每日归档

`worklog_archive`（或面板「归档今天」）会：

1. 在 `scanRoots` 下最多 3 层查找 Git 仓库，取当天提交（按 `gitAuthor` 过滤；留空用各仓库 `git config user.name`）。
2. 在 `docRoots` 下最多 6 层扫描当天修改过的 `.md/.docx/.xlsx/.pptx/.pdf/...`。
3. 扫描本机 AI 工具会话，汇总当天有真实用户提问的会话（来源、标题、轮数、时间、项目）。
4. 生成「今日概览 / 项目进展 / 文档变更 / AI 会话 / 备注」五节 Markdown，写入归档路径。

未配置扫描目录时默认扫描当前工作区（`ZCODE_PROJECT_DIR`）。当天已有归档时默认不覆盖，只有 `force: true` 才会重写（会覆盖手写备注）。

自动归档：开启后，MCP 服务进程每分钟检查一次；到 `taskTime`（默认 18:30）且当天未归档就执行一次。**ZCode 没运行就不会自动归档。**

## AI 会话汇总

归档时只读扫描本机 AI 工具当天的真实用户提问，写入日文档的「## AI 会话」小节：

| 来源 | 读取位置 |
|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl`（只取真实用户提问，标题取 `ai-title`） |
| Codex | `~/.codex/sessions/**/*.jsonl`（`session_meta.cwd`、`user_message`） |
| DeepSeek Harness | `$DSH_HOME/sessions/**/session*.jsonl[.zstd]`（按 zstd 帧解压） |
| WorkBuddy | `~/.workbuddy/projects/**/*.jsonl`（`<user_query>` 提取真实提问） |
| ZCode | `~/.zcode/cli/db/db.sqlite` 的 session/message/part（只取用户消息，过滤 model-only 注入） |
| OpenCode | `~/.local/share/opencode/storage/{session,message,part}` |
| Gemini CLI | `~/.gemini|.qwen|.iflow/tmp/*/chats/*.json` |
| 自定义 | 设置里的「额外 AI 会话目录」，支持 jsonl/json 通用 user 消息解析 |

- 只统计有真实用户提问的会话；`<system-reminder>`、`<environment_context>`、model-only 运行时注入等会被过滤。
- 每个会话每天最多保留 3 条提问摘录（缓存里），日文档只写来源/时间/轮数/标题与项目目录，避免日志变成聊天记录。
- 解析结果按文件 `mtime + size` 缓存在 `data/session-cache.json`，只有变化的文件会重新解析；`worklog_sessions` 的 `refresh` 可强制重扫。
- 面板「会话」页签可按天扫描查看；设置里可以关闭「归档时汇总 AI 会话」，也可以用「额外 AI 会话目录」添加其他工具的导出目录。
- 会话内容只在本机读取和写入归档，不会自动上传；只有你主动勾选 AI 润色时，素材才会发给已配置的 AI 接口。

日文档格式：

```markdown
## AI 会话

- [Claude Code] 09:12–09:40 · 3 轮 · 会话标题
  - 项目：`E:\AI_Project\research`
- [ZCode] 10:57–11:00 · 2 轮 · 另一个会话标题
  - 项目：`E:\AI_Project\research\zcode-worklog`
```

## Agent 工具

`worklog_status`、`worklog_day`、`worklog_search`、`worklog_todos`、`worklog_archive`、`worklog_sessions`、`worklog_report`、`worklog_ask`、`worklog_projects`、`worklog_usage`、`worklog_backup`、`worklog_config`、`worklog_open`。

工具名在会话里通常带 `mcp__plugin_zcode-worklog_worklog__` 前缀。

## 快捷命令

命令面板里通常显示为 `/zcode-worklog:status`；如果你的客户端用斜杠分隔，则是 `/zcode-worklog/status`。

```text
/zcode-worklog:status
/zcode-worklog:today [YYYY-MM-DD]
/zcode-worklog:search <关键词>
/zcode-worklog:todo list | add <标题> [!高] [@YYYY-MM-DD] | edit <id> | done <id> | reopen <id> | del <id> | clear | stats | carry
/zcode-worklog:archive run | backfill <日期...> | status
/zcode-worklog:sessions [YYYY-MM-DD] | sources | refresh [YYYY-MM-DD]
/zcode-worklog:report daily|weekly|month|quarter|perf|project [参数]
/zcode-worklog:ask <问题>
/zcode-worklog:backup list|create|restore <name>|delete <name>|import <旧WorkLog目录>
/zcode-worklog:config
/zcode-worklog:open
```

## 初始化钩子

`SessionStart` 钩子会在会话开始时：

- 注入一行状态（今天是否归档、待办数量与逾期数、最近归档日期）；
- 如果 `autoArchive` 已开启且到点，顺带执行当天的自动归档（最多一次）。

钩子失败不会阻塞会话，错误只写到 stderr。

## 从旧 WorkLog 迁移

面板「设置 → 从旧 WorkLog 导入」，填旧安装目录（例如 `E:\WorkLog`），点「导入」。插件只复制 `data\archive`，不删除源目录。旧的 `settings.json`、待办、绩效模板不会自动迁移。

## 与旧版 / dsh-worklog 的区别

- 独立维护，不依赖 WorkLog 的 Python 后端、Claude CLI、8377 端口。
- 已实现：Git/文档归档、日志编辑/搜索、待办、确定性汇报、可选 AI 润色/问答、AI 会话汇总、备份、旧归档导入、自动归档、侧边面板。
- 尚未实现：Cursor/Trae/Windsurf 的 VS Code 数据库会话扫描、Word/Excel 导出、绩效模板 Excel 还原、飞书工时、业务流程图。后续可以按需从 dsh-worklog 继续移植。

## 开发

```bash
npm install        # 仅构建/测试需要（esbuild + MCP SDK + ext-apps + jsdom）
npm run build      # 生成 dist/：server.mjs、session-start.mjs、panel.js、panel.html、panel.css
npm test           # 本地存储/归档/报告/MCP API
npm run test:panel # jsdom 里模拟 MCP App 宿主，验证握手、bootstrap 和六个页签
npm run smoke      # 临时目录下跑通归档+待办+备份
node test/smoke-mcp.mjs   # 真实 stdio JSON-RPC：initialize/tools/list/tools/call/resources/read
```

`dist/` 已经提交，安装时不需要 Node 依赖；`node_modules` 只在重新构建时需要。

## 安全

- 数据只在本机插件数据目录。
- AI API Key 明文保存在 `config.json`；不配置就完全不发外部请求。
- 恢复备份会覆盖同名日日志与待办；删除备份不可恢复。
- 没有暴露删除归档目录、重置全部数据之类的破坏性接口。

## License

MIT
