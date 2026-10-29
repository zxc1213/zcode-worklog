/**
 * ZCode WorkLog MCP server.
 *
 * Exposes the WorkLog tools plus the side-panel UI resource. All state lives
 * on the local disk; no network calls unless the user configures an
 * OpenAI-compatible endpoint for optional report polish.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { PLUGIN_NAME, PLUGIN_VERSION, loadConfig, localDate } from '../lib/config.mjs'
import { composePanelHtml } from '../lib/panel.mjs'
import {
  archiveAction,
  backupAction,
  configAction,
  dayAction,
  dispatch,
  maybeAutoArchive,
  reportAction,
  statusPayload,
  todoAction,
  usagePayload,
} from './api.mjs'
import { askArchive } from '../lib/report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANEL_URI = `ui://${PLUGIN_NAME}/panel.html`
const SCRIPT_URI = `ui://${PLUGIN_NAME}/panel.js`
const STYLE_URI = `ui://${PLUGIN_NAME}/panel.css`
const HTML_MIME = 'text/html;profile=mcp-app'

const server = new McpServer(
  { name: PLUGIN_NAME, version: PLUGIN_VERSION },
  {
    instructions:
      'WorkLog 是本机工作日志插件：归档每天 Git 提交与文档变更，管理待办，生成日报/周报/月报/季报/绩效素材，可选用 OpenAI 兼容接口润色。所有数据只在本机。',
  },
)

function ok(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const clipped = text.length > 120000 ? `${text.slice(0, 120000)}\n…（已截断）` : text
  if (Array.isArray(value)) {
    // structuredContent is an object on the wire; wrap lists so the panel
    // receives them without re-parsing the (possibly clipped) text.
    return { content: [{ type: 'text', text: clipped }], structuredContent: { items: value } }
  }
  return {
    content: [{ type: 'text', text: clipped }],
    ...(value && typeof value === 'object' ? { structuredContent: value } : {}),
  }
}

function fail(error) {
  return {
    content: [{ type: 'text', text: String(error?.message || error) }],
    isError: true,
  }
}

function tool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return ok(await handler(args || {}))
    } catch (error) {
      process.stderr.write(`[${PLUGIN_NAME}] ${name} failed: ${String(error?.message || error)}\n`)
      return fail(error)
    }
  })
}

const listOfDates = z.array(z.string())

tool(
  'worklog_status',
  {
    title: 'WorkLog 状态',
    description:
      '查看 WorkLog 状态：数据目录、今天是否已归档、日志/待办/备份/项目统计、最近归档历史与 AI 用量。开始任何日志相关任务前先调用它。',
    inputSchema: z.object({}),
  },
  () => statusPayload(),
)

tool(
  'worklog_day',
  {
    title: '读取或保存某天日志',
    description:
      '读取或保存某天的本地工作日志（Markdown）。不传 text 时读取；传 text 时保存。日期默认今天，格式 YYYY-MM-DD。',
    inputSchema: z.object({
      date: z.string().optional().describe('YYYY-MM-DD，默认今天'),
      text: z.string().optional().describe('要保存的 Markdown 全文；省略则只读取'),
    }),
  },
  (args) => dayAction(args),
)

tool(
  'worklog_search',
  {
    title: '搜索归档',
    description: '在本地日归档中做全文检索，返回日期、命中次数和摘要片段。',
    inputSchema: z.object({
      query: z.string().describe('关键词或短语'),
    }),
  },
  (args) => dispatch('search', args),
)

tool(
  'worklog_todos',
  {
    title: '管理待办',
    description:
      '管理本地待办：list/add/complete/reopen/delete/clear_done。add 支持 pri（高/中/低）、due（YYYY-MM-DD）、md、repeat（daily / weekly:0-6 / monthly:1-31）。',
    inputSchema: z.object({
      action: z.enum(['list', 'add', 'complete', 'reopen', 'delete', 'clear_done']),
      id: z.string().optional(),
      title: z.string().optional(),
      pri: z.enum(['高', '中', '低']).optional(),
      due: z.string().optional(),
      md: z.string().optional(),
      repeat: z.string().optional(),
    }),
  },
  (args) => todoAction(loadConfig(), args),
)

tool(
  'worklog_archive',
  {
    title: '归档工作日志',
    description:
      '本地归档：run=扫描配置的 Git 仓库和文档目录，生成当天 Markdown；backfill=补录多天；status=最近归档历史。未配置扫描目录时默认扫描当前工作区。',
    inputSchema: z.object({
      action: z.enum(['run', 'backfill', 'status']),
      date: z.string().optional().describe('run 的日期，默认今天'),
      dates: listOfDates.optional().describe('backfill 日期列表'),
      force: z.boolean().optional().describe('已有归档时是否覆盖'),
      note: z.string().optional().describe('写入当天日志备注'),
    }),
  },
  (args) => archiveAction(loadConfig(), args),
)

tool(
  'worklog_report',
  {
    title: '生成或查看汇报',
    description:
      '生成/查看本地汇报：daily、weekly、month、quarter、perf、project。默认生成确定性草稿；配置了 AI 接口后可传 useAi=true 润色。',
    inputSchema: z.object({
      action: z.enum(['generate', 'list', 'read']).optional(),
      kind: z.enum(['daily', 'weekly', 'month', 'quarter', 'perf', 'project']).optional(),
      date: z.string().optional(),
      monday: z.string().optional(),
      month: z.string().optional(),
      quarter: z.string().optional(),
      project: z.string().optional(),
      name: z.string().optional().describe('read 的报告文件名'),
      useAi: z.boolean().optional(),
    }),
  },
  (args) => reportAction(loadConfig(), args),
)

tool(
  'worklog_ask',
  {
    title: '基于归档问答',
    description:
      '基于本地归档回答问题：先用关键词检索日文档；配置了 AI 接口后把摘录交给模型回答，否则直接返回相关片段。',
    inputSchema: z.object({
      question: z.string(),
      useAi: z.boolean().optional(),
    }),
  },
  (args) => askArchive(loadConfig(), args.question, { useAi: args.useAi !== false }),
)

tool(
  'worklog_projects',
  {
    title: '汇总项目',
    description: '从本地归档的“### 项目名”小节中汇总项目列表、归档天数和提交数。',
    inputSchema: z.object({}),
  },
  () => dispatch('projects'),
)

tool(
  'worklog_usage',
  {
    title: 'AI 用量',
    description: '查看插件记录的 AI 调用用量（输入/输出/total token）。',
    inputSchema: z.object({}),
  },
  () => usagePayload(loadConfig()),
)

tool(
  'worklog_backup',
  {
    title: '备份与迁移',
    description:
      '本地数据备份：list/create/restore/delete；import 可从旧 WorkLog 安装目录导入 data\\archive。',
    inputSchema: z.object({
      action: z.enum(['list', 'create', 'restore', 'delete', 'import']),
      name: z.string().optional(),
      sourceDir: z.string().optional(),
    }),
  },
  (args) => backupAction(loadConfig(), args),
)

tool(
  'worklog_config',
  {
    title: 'WorkLog 配置',
    description:
      '读取或修改插件配置：dataDir、scanRoots、docRoots、gitAuthor、sources、autoArchive、skipWeekends、taskTime、ai（baseUrl/model/apiKey/apiFormat=openai|anthropic）。action=set 时 patch 为要合并的对象。',
    inputSchema: z.object({
      action: z.enum(['get', 'set']),
      patch: z.record(z.string(), z.unknown()).optional(),
    }),
  },
  (args) => configAction(args),
)

tool(
  'worklog_open',
  {
    title: '打开 WorkLog 面板',
    description:
      '在 ZCode 侧边面板中打开 WorkLog 交互界面。用户说“打开 WorkLog / 工作日志面板 / 看看工作日志面板”时调用。',
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: PANEL_URI } },
  },
  () => ({ opened: true, panel: PANEL_URI, hint: 'WorkLog 面板已在侧栏打开。' }),
)

// Panel-only API: hidden from the model, called by the side panel.
server.registerTool(
  'worklog_api',
  {
    title: 'WorkLog 面板接口',
    description: '面板内部使用的统一操作入口。',
    inputSchema: z.object({
      op: z.enum([
        'bootstrap',
        'status',
        'day',
        'days',
        'search',
        'todos',
        'archive',
        'report',
        'reports',
        'ask',
        'projects',
        'usage',
        'backup',
        'config',
        'ai',
      ]),
      args: z.record(z.string(), z.unknown()).optional(),
    }),
    _meta: { ui: { visibility: ['app'] } },
  },
  async (args) => {
    try {
      return ok(await dispatch(args.op, args.args || {}))
    } catch (error) {
      return fail(error)
    }
  },
)

async function asset(name) {
  return readFile(join(HERE, name), 'utf8')
}

// The sandbox only serves the HTML returned here, so inline the stylesheet and
// script instead of pointing at sibling ui:// resources it cannot fetch.
let panelHtmlPromise
function panelDocument() {
  panelHtmlPromise ??= Promise.all([asset('panel.html'), asset('panel.css'), asset('panel.js')]).then(
    ([html, css, js]) => composePanelHtml(html, css, js),
  )
  return panelHtmlPromise
}

const panelMeta = { ui: { prefersBorder: true } }

server.registerResource(
  'worklog-panel',
  PANEL_URI,
  { title: 'WorkLog 面板', mimeType: HTML_MIME, _meta: panelMeta },
  async () => ({
    contents: [{ uri: PANEL_URI, mimeType: HTML_MIME, text: await panelDocument(), _meta: panelMeta }],
  }),
)

server.registerResource(
  'worklog-panel-js',
  SCRIPT_URI,
  { title: 'WorkLog 面板脚本', mimeType: 'text/javascript' },
  async () => ({
    contents: [{ uri: SCRIPT_URI, mimeType: 'text/javascript', text: await asset('panel.js') }],
  }),
)

server.registerResource(
  'worklog-panel-css',
  STYLE_URI,
  { title: 'WorkLog 面板样式', mimeType: 'text/css' },
  async () => ({
    contents: [{ uri: STYLE_URI, mimeType: 'text/css', text: await asset('panel.css') }],
  }),
)

const transport = new StdioServerTransport()
await server.connect(transport)

// Auto-archive runs inside the session's server process, the same way the
// desktop WorkLog did: every minute, past taskTime, at most once per day.
let archiving = false
const timer = setInterval(async () => {
  if (archiving) return
  archiving = true
  try {
    const result = await maybeAutoArchive(loadConfig())
    if (result) {
      process.stderr.write(
        `[${PLUGIN_NAME}] auto archive ${localDate()}: ${result.created ? 'ok' : 'skip'}\n`,
      )
    }
  } catch (error) {
    process.stderr.write(`[${PLUGIN_NAME}] auto archive failed: ${String(error?.message || error)}\n`)
  } finally {
    archiving = false
  }
}, 60_000)
timer.unref?.()

process.on('SIGINT', () => {
  clearInterval(timer)
  process.exit(0)
})
