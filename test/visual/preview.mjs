/**
 * Visual preview harness: serves the built panel as a normal web page with a
 * full mock host (same protocol answers as test/panel-sim.mjs), so the real
 * browser layout can be screenshotted per tab.
 *
 *   npm run build && node test/visual/preview.mjs
 *   → http://127.0.0.1:4173/?tab=today|time|library|report|settings
 *     &view=sessions|logs|graph   (library sub-view)
 *     &sub=general|ai|collect|conn|tpl|backup|diag  (settings sub-page)
 *
 * Static only: serves an in-memory document, never touches real data.
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composePanelHtml } from '../../lib/panel.mjs'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist')
const PORT = Number(process.env.WORKLOG_PREVIEW_PORT || 4173)

const html = composePanelHtml(
  readFileSync(join(DIST, 'panel.html'), 'utf8'),
  readFileSync(join(DIST, 'panel.css'), 'utf8'),
  readFileSync(join(DIST, 'panel.js'), 'utf8'),
)

const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const TODAY = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
const MONTH = TODAY.slice(0, 7)
const YESTERDAY = (() => {
  const d = new Date(now)
  d.setDate(d.getDate() - 1)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
})()

// Full current month with varied marks so the calendar grid reads like real data.
const calDays = {}
const dim = new Date(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0).getDate()
for (let day = 1; day <= dim; day++) {
  const date = MONTH + '-' + pad(day)
  if (day > now.getDate()) break
  calDays[date] = {
    date,
    archived: day % 3 !== 0,
    hasDailyReport: day % 7 === 0,
    entryCount: day % 4,
    bySource: { git: day % 5, sessions: day % 3 },
    todoDone: day % 3,
    todoDue: day % 4 === 0 ? 1 : 0,
    sessionCount: day % 5 === 0 ? 2 : day % 3,
    commitCount: day % 6,
  }
}

const config = {
  dataDir: 'C:\\Users\\demo\\AppData\\Local\\zcode\\plugins\\data',
  configFile: 'C:\\Users\\demo\\AppData\\Local\\zcode\\plugins\\config.json',
  scanRoots: [],
  effectiveScanRoots: ['E:\\ws\\research', 'E:\\ws\\client-a'],
  docRoots: [],
  effectiveDocRoots: ['E:\\ws\\docs'],
  sources: { git: true, docs: true, sessions: true },
  autoArchive: true,
  skipWeekends: true,
  taskTime: '18:30',
  watchDirs: [{ path: 'E:\\cloud\\onedrive', kind: 'cloud' }],
  ai: { baseUrl: 'https://api.test/v1', model: 'GLM-5.3', apiFormat: 'anthropic', hasApiKey: true },
}

const bootstrap = {
  status: {
    version: '0.23.0',
    dataDir: config.dataDir,
    today: { date: TODAY, archived: false },
    days: {
      count: 128,
      latest: [
        { date: YESTERDAY, size: 4200, mtime: '' },
        { date: MONTH + '-' + pad(Math.max(1, now.getDate() - 2)), size: 3800, mtime: '' },
      ],
    },
    todos: {
      count: 7,
      open: 5,
      overdue: 2,
      stats: { open: 5, overdue: 2, doneToday: 2, doneWeek: 9 },
      recent: [],
    },
    sessions: {
      count: 3,
      turns: 9,
      items: [
        { source: 'Claude Code', title: '排查 worklog 面板间距问题', turns: 4, start: '09:12', end: '09:40' },
        { source: 'ZCode', title: '重构会话索引查询', turns: 3, start: '10:57', end: '11:20' },
        { source: 'Codex', title: '写周报初稿', turns: 2, start: '14:02', end: '14:18' },
      ],
    },
    backups: { count: 2, latest: { name: 'backup-2026-11-01.json' } },
    projects: [{ name: 'zcode-worklog', days: [TODAY], commits: 6 }],
    runHistory: [
      { date: YESTERDAY, mode: 'auto', status: 'ok', note: '4 提交 / 2 文档' },
      { date: MONTH + '-' + pad(Math.max(1, now.getDate() - 1)), mode: 'manual', status: 'ok', note: '2 提交 / 1 文档' },
    ],
    aiUsage: {
      calls: 14,
      in: 21000,
      out: 3400,
      total: 24400,
      byModel: [{ model: 'GLM-5.3', calls: 14, in: 21000, out: 3400, total: 24400 }],
    },
    config,
  },
  days: [{ date: YESTERDAY, size: 4200, relative: MONTH + '/第5周/' + YESTERDAY + '.md' }],
  todos: [
    { id: 't1', title: '修复面板区块贴住的间距问题', status: 'open', pri: '高', due: YESTERDAY, carries: 2, tags: ['worklog'] },
    { id: 't2', title: '评审 0.23.0 检视报告', status: 'open', pri: '中', due: TODAY, tags: ['review'] },
    { id: 't3', title: '准备周报素材', status: 'open', due: TODAY },
    { id: 't4', title: '回访客户反馈', status: 'open', pri: '低', due: MONTH + '-28', subtasks: [{ title: '整理清单', done: true }, { title: '电话回访', done: false }] },
    { id: 't5', title: '归档十月日志', status: 'done', done_at: TODAY + 'T10:00', tags: ['worklog'] },
    { id: 't6', title: '同步会话索引', status: 'done', done_at: TODAY + 'T09:10' },
  ],
  reports: [
    { name: 'weekly-' + MONTH + '-' + pad(Math.max(1, now.getDate() - 2)) + '.md', size: 3200, mtime: now.toISOString() },
    { name: 'daily-' + YESTERDAY + '.md', size: 2100, mtime: now.toISOString() },
    { name: 'summarize-2026-10-01_2026-10-31.md', size: 5400, mtime: now.toISOString() },
  ],
  backups: [
    { name: 'backup-2026-11-01.json', size: 204800, mtime: now.toISOString() },
    { name: 'backup-2026-10-15.json', size: 190000, mtime: now.toISOString() },
  ],
  config,
}

const graphOverview = {
  builtAt: now.toISOString(),
  nodeCount: 6,
  edgeCount: 7,
  types: { project: 2, person: 2, tool: 1, topic: 1 },
  nodes: [
    { key: 'project:zcode-worklog', type: 'project', label: 'zcode-worklog', weight: 18 },
    { key: 'project:client-a', type: 'project', label: 'client-a', weight: 7 },
    { key: 'person:Ray', type: 'person', label: 'Ray', weight: 12 },
    { key: 'person:demo', type: 'person', label: 'demo', weight: 3 },
    { key: 'tool:ZCode', type: 'tool', label: 'ZCode', weight: 9 },
    { key: 'topic:可视化', type: 'topic', label: '可视化', weight: 4 },
  ],
  edges: [
    { from: 'person:Ray', to: 'project:zcode-worklog', kind: '提交了', count: 12 },
    { from: 'tool:ZCode', to: 'project:zcode-worklog', kind: '用于', count: 9 },
    { from: 'person:Ray', to: 'project:client-a', kind: '提交了', count: 5 },
    { from: 'topic:可视化', to: 'project:zcode-worklog', kind: '出现于', count: 4 },
    { from: 'person:demo', to: 'project:client-a', kind: '提交了', count: 2 },
  ],
}

const sessionsQuery = {
  matched: 3,
  total: 42,
  keywords: [
    { word: '面板', count: 6 },
    { word: 'spacing', count: 3 },
  ],
  groups: {},
  sessions: [
    {
      key: 'mock-1',
      title: '排查 worklog 面板间距问题',
      label: 'Claude Code',
      source: 'claude',
      first: TODAY,
      last: TODAY,
      datesCount: 1,
      turns: 4,
      preview: '用户提问：今天的 AI 会话跟上面的框贴在一起了……',
      cwd: 'E:\\AI_Project\\research\\zcode-worklog',
    },
    {
      key: 'mock-2',
      title: '重构会话索引查询',
      label: 'ZCode',
      source: 'zcode',
      first: TODAY,
      last: TODAY,
      datesCount: 1,
      turns: 3,
      preview: '用户提问：把 query 的窗口参数隔离……',
      cwd: 'E:\\AI_Project\\research',
    },
    {
      key: 'mock-3',
      title: '写周报初稿',
      label: 'Codex',
      source: 'codex',
      first: YESTERDAY,
      last: TODAY,
      datesCount: 2,
      turns: 2,
      preview: '用户提问：帮我起草本周周报……',
      cwd: 'E:\\ws\\docs',
    },
  ],
}

const MOCK_SCRIPT = `<script>
(function () {
  var TODAY = ${JSON.stringify(TODAY)}
  var YESTERDAY = ${JSON.stringify(YESTERDAY)}
  var MONTH = ${JSON.stringify(MONTH)}
  function reply(id, structured) {
    window.dispatchEvent(new MessageEvent('message', {
      data: { jsonrpc: '2.0', id: id, result: {
        content: [{ type: 'text', text: JSON.stringify(structured) }],
        structuredContent: structured,
      } }, source: window,
    }))
  }
  function structuredFor(op, args) {
    if (op === 'bootstrap') return ${JSON.stringify(bootstrap)}
    if (op === 'day') return { date: args.date, exists: true, text: '# 工作日志\\n\\n## 今日概览\\n- 修复面板间距\\n- 评审检视报告\\n\\n## AI 会话\\n- [Claude Code] 09:12 · 4 轮 · 排查面板间距\\n' }
    if (op === 'archive' && args.action === 'run') return { created: true, date: TODAY, commitCount: 4, docCount: 2, sessionCount: 3 }
    if (op === 'search') return { items: [{ date: YESTERDAY, count: 3, snippet: '…修复面板间距，评审检视报告…' }, { date: MONTH + '-28', count: 1, snippet: '…间距基刻度归一…' }] }
    if (op === 'report' && args.action === 'generate') return { kind: args.kind, name: args.kind + '-mock.md', text: '# 报告内容\\n\\n本周完成面板间距修复。', ai: false }
    if (op === 'report' && args.action === 'summarize') return { kind: 'summarize', name: 'summarize-mock.md', text: '# 规则摘要\\n\\n区间内共 12 天归档。', ai: false }
    if (op === 'report' && args.action === 'read') return { text: '# 报告全文\\n\\n第一段。\\n\\n第二段。' }
    if (op === 'calendar' && args.action === 'month') return { month: MONTH, today: TODAY, days: ${JSON.stringify(calDays)} }
    if (op === 'calendar' && args.action === 'day') return { date: args.date, archived: true, sessions: [
      { title: '排查 worklog 面板间距问题', label: 'Claude Code', turns: 4, timeRange: '09:12–09:40' },
      { title: '重构会话索引查询', label: 'ZCode', turns: 3, timeRange: '10:57–11:20' },
    ], todosDue: [{ id: 't1', title: '修复面板区块贴住的间距问题', pri: '高', carries: 2 }], todosDone: [{ title: '归档十月日志' }, { title: '同步会话索引' }], entries: { count: 5, bySource: { git: 3, docs: 1, feishu: 1 }, items: [
      { time: '09:40', title: 'fix: 间距节奏', source: 'git' },
      { time: '11:02', title: 'docs: 检视报告', source: 'git' },
      { time: '13:20', title: '评审记录.docx', source: 'docs' },
      { time: '15:00', title: '飞书群消息摘要', source: 'feishu' },
    ] }, hasDailyReport: true }
    if (op === 'recommend' && args.action === 'get') return { date: TODAY, items: [
      { kind: '逾期顺延', title: '修复面板区块贴住的间距问题', detail: '已顺延 2 天', score: 12, final: 12, refs: { date: YESTERDAY } },
      { kind: '项目未覆盖', title: 'client-a 昨天有提交但无日志', detail: '', score: 6, final: 6, refs: { date: YESTERDAY } },
    ] }
    if (op === 'graph' && !args.entity) return ${JSON.stringify(graphOverview)}
    if (op === 'graph' && args.entity) return { entity: args.entity, found: true, type: args.entity === 'Ray' ? 'person' : 'project', label: args.entity, weight: 12, relations: [
      { kind: '提交了', count: 12, direction: 'out', other: 'zcode-worklog', otherType: 'project' },
      { kind: '提交了', count: 5, direction: 'out', other: 'client-a', otherType: 'project' },
      { kind: '用于', count: 9, direction: 'in', other: 'ZCode', otherType: 'tool' },
    ] }
    if (op === 'collect' && args.action === 'diagnostics') return { tasks: [
      { id: 'collect-sessions', title: 'AI 会话采集', description: '扫描本机 AI 工具会话', enabled: true, everyHours: 4, dailyAt: '', lastRunAt: TODAY + 'T08:00', lastStatus: 'ok', lastError: '' },
      { id: 'collect-watch', title: '监控目录扫描', description: '增量扫描监控目录', enabled: true, everyHours: 2, dailyAt: '', lastRunAt: TODAY + 'T07:30', lastStatus: 'ok', lastError: '' },
      { id: 'connector-sync', title: '连接器同步', description: '同步外部系统条目', enabled: false, everyHours: 6, dailyAt: '', lastRunAt: '', lastStatus: '', lastError: '' },
    ], history: [
      { at: TODAY + 'T08:00', title: 'AI 会话采集', status: 'ok', sessions: 3 },
      { at: TODAY + 'T07:30', title: '监控目录扫描', status: 'ok', changed: 2 },
    ], sources: [
      { id: 'claude', label: 'Claude Code', path: '~/.claude/projects', kind: 'dir', exists: true, enabled: true },
      { id: 'zcode', label: 'ZCode', path: '~/.zcode/cli/db/db.sqlite', kind: 'db', exists: true, enabled: true },
      { id: 'codex', label: 'Codex', path: '~/.codex/sessions', kind: 'dir', exists: false, enabled: true },
    ], watchDirs: [{ path: 'E:\\\\cloud\\\\onedrive', kind: 'cloud' }] }
    if (op === 'templates' && args.action === 'list') return { templates: [
      { scene: 'report', name: '报告润色', hint: '周报月报', source: 'builtin', system: 'S', user: 'U' },
      { scene: 'summarize', name: '自由总结', hint: '任意范围', source: 'user', system: 'S', user: 'U' },
    ] }
    if (op === 'connectors' && args.action === 'list') return { connectors: [
      { id: 'feishu:main', type: 'feishu', label: '飞书', enabled: true, config: { appId: 'cli_x' }, lastSyncAt: TODAY + 'T06:00', lastStatus: 'ok' },
    ], types: [{ type: 'feishu', title: '飞书', description: 'd', fields: [{ key: 'appId', label: 'App ID', type: 'text' }] }] }
    if (op === 'sessions' && args.action === 'sources') return { sources: [
      { id: 'claude', label: 'Claude Code', path: '~/.claude/projects', kind: 'dir', exists: true, enabled: true },
      { id: 'zcode', label: 'ZCode', path: '~/.zcode/cli/db/db.sqlite', kind: 'db', exists: true, enabled: true },
      { id: 'codex', label: 'Codex', path: '~/.codex/sessions', kind: 'dir', exists: false, enabled: true },
    ] }
    if (op === 'sessions' && args.action === 'index_status') return { builtAt: TODAY + 'T06:00', total: 42 }
    if (op === 'sessions' && args.action === 'sync_all') return { builtAt: TODAY + 'T06:00', total: 42, errors: [] }
    if (op === 'sessions' && args.action === 'query') return ${JSON.stringify(sessionsQuery)}
    if (op === 'sessions' && args.action === 'content') return { key: args.key, available: true, dates: [{ date: TODAY, turns: 4, texts: ['今天的 AI 会话跟上面的框贴在一起了', '全部待办下面的两个框也贴在一起'] }] }
    if (op === 'ai' && args.action === 'detect') return { candidates: [
      { id: 'zcode:builtin:demo', source: 'zcode', sourceLabel: 'ZCode', name: 'Demo Provider', baseUrl: 'https://api.test/v1', model: 'GLM-5.3', apiFormat: 'anthropic', hasKey: true, keyHint: 'sk-d…7890', note: 'ZCode 当前选择的供应商', models: ['GLM-5.3', 'GLM-5-Turbo'] },
    ] }
    if (op === 'ai' && args.action === 'models') return { models: ['GLM-5.3', 'GLM-5-Turbo', 'GLM-5.3-Flash'], source: 'api' }
    if (op === 'ai' && args.action === 'apply') return { applied: { name: 'Demo Provider', models: ['GLM-5.3'] }, config: ${JSON.stringify(config)} }
    if (op === 'config') return ${JSON.stringify(config)}
    return { ok: true }
  }
  window.postMessage = function (message) {
    if (!message || typeof message !== 'object') return
    if (message.method === 'ui/initialize' && message.id !== undefined) {
      window.dispatchEvent(new MessageEvent('message', {
        data: { jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: '2026-07-28',
          hostCapabilities: {},
          hostInfo: { name: 'visual-preview-host', version: '0' },
          hostContext: { theme: 'light', platform: 'desktop', styles: { variables: { '--color-background-primary': '#ffffff' } } },
        } }, source: window,
      }))
      return
    }
    if (message.method === 'tools/call' && message.id !== undefined) {
      var op = message.params && message.params.arguments && message.params.arguments.op
      var args = (message.params && message.params.arguments && message.params.arguments.args) || {}
      reply(message.id, structuredFor(op, args))
      return
    }
    if (message.method === 'ping' && message.id !== undefined) reply(message.id, {})
  }
  // Auto-switch per query params: ?tab=&view=&sub=
  var timer = setInterval(function () {
    var tabs = document.querySelectorAll('.wl-tab')
    if (!tabs.length) return
    clearInterval(timer)
    var params = new URLSearchParams(location.search)
    var want = params.get('tab')
    var names = { today: '今天', time: '时间', library: '资料库', report: '报告', settings: '设置' }
    if (want && names[want]) {
      for (var i = 0; i < tabs.length; i++) if (tabs[i].textContent === names[want]) { tabs[i].click(); break }
    }
    setTimeout(function () {
      var view = params.get('view')
      if (view) {
        var seg = document.querySelectorAll('.wl-seg button')
        var segNames = { sessions: '会话', logs: '日志', graph: '图谱' }
        for (var j = 0; j < seg.length; j++) if (seg[j].textContent === segNames[view]) { seg[j].click(); break }
      }
      var sub = params.get('sub')
      if (sub) {
        var nav = document.querySelectorAll('.wl-subnav button')
        var subNames = { general: '通用', ai: 'AI 接口', collect: '采集与调度', conn: '连接器', tpl: '提示词模板', backup: '备份与迁移', diag: '诊断' }
        for (var k = 0; k < nav.length; k++) if (nav[k].textContent === subNames[sub]) { nav[k].click(); break }
      }
    }, 400)
  }, 80)
})()
</script>`

const served = html.replace(/<head>/i, (m) => m + MOCK_SCRIPT)

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(served)
})
server.listen(PORT, '127.0.0.1', () => {
  console.log('preview: http://127.0.0.1:' + PORT + '/?tab=today|time|library|report|settings')
})
