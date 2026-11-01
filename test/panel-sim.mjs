/**
 * Panel simulation: loads the built panel as an MCP App inside jsdom and
 * answers the host side of the protocol with mock WorkLog data. Verifies the
 * ui/initialize handshake, bootstrap call, the 5-tab IA (today/time/library/
 * report/settings) and per-tab tool calls without needing the ZCode host.
 *
 * The built panel.html must be self-contained: the plugin sandbox only serves
 * the HTML document and does not resolve sibling ui:// resources.
 *
 *   npm install && npm run build && npm run test:panel
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'
import { composePanelHtml } from '../lib/panel.mjs'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const html = composePanelHtml(
  readFileSync(join(DIST, 'panel.html'), 'utf8'),
  readFileSync(join(DIST, 'panel.css'), 'utf8'),
  readFileSync(join(DIST, 'panel.js'), 'utf8'),
)

assert.equal(/<script[^>]+src="ui:\/\//.test(html), false, 'panel must not reference ui:// scripts')
assert.equal(/<link[^>]+href="ui:\/\//.test(html), false, 'panel must not reference ui:// stylesheets')
assert.ok(html.includes('__worklogMounted'), 'panel ships the boot fallback')
assert.ok(html.includes('.wl-root'), 'panel styles are inlined')
assert.ok(html.includes('zcode-worklog panel (bundled)'), 'panel script is inlined')

const config = {
  dataDir: 'D:\\tmp\\worklog\\data',
  configFile: 'D:\\tmp\\worklog\\config.json',
  scanRoots: [],
  effectiveScanRoots: ['E:\\ws'],
  docRoots: [],
  effectiveDocRoots: ['E:\\ws'],
  sources: { git: true, docs: true },
  autoArchive: false,
  skipWeekends: true,
  taskTime: '18:30',
  ai: { baseUrl: 'https://example.test/api/anthropic', model: 'GLM-5.2', apiFormat: 'anthropic', hasApiKey: true },
}

// Mutable: the archive state-machine test flips today.archived to true.
const todayState = { date: '2026-10-29', archived: false }

const bootstrap = {
  status: {
    version: '0.1.0',
    dataDir: config.dataDir,
    today: todayState,
    days: { count: 3, latest: [{ date: '2026-10-28', size: 100, mtime: '' }] },
    todos: {
      count: 2,
      open: 1,
      overdue: 0,
      recent: [{ id: 't1', title: '测试待办', status: 'open', pri: '高', due: '2026-10-29' }],
    },
    sessions: { count: 1, turns: 2, items: [{ source: 'claude', title: '今日会话简表项', turns: 2, start: '09:12', end: '09:40' }] },
    backups: { count: 1, latest: { name: 'backup-test.json' } },
    projects: [{ name: 'demo-project', days: ['2026-10-28'], commits: 2 }],
    runHistory: [{ date: '2026-10-29', mode: 'manual', status: 'ok', note: '2 提交 / 1 文档' }],
    aiUsage: { calls: 2, in: 100, out: 50, total: 150, byModel: [{ model: 'GLM-5.2', calls: 2, in: 100, out: 50, total: 150 }] },
    config,
  },
  days: [{ date: '2026-10-28', size: 100, relative: '2026-10/第5周/2026-10-28.md' }],
  todos: [{ id: 't1', title: '测试待办', status: 'open', pri: '高', due: '2026-10-29' }],
  reports: [{ name: 'weekly-2026-10-26.md', size: 100, mtime: '2026-10-28T10:00:00.000Z' }],
  backups: [{ name: 'backup-test.json', size: 2048, mtime: '2026-10-28T10:00:00.000Z' }],
  config,
}

let failCollect = true
const messages = []
const jsdomErrors = []
const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', (error) => {
  jsdomErrors.push(error.message + ' \n ' + (error.detail?.stack || error.stack || '(no stack)'))
})

function reply(window, id, result, extra = {}) {
  const payload = { jsonrpc: '2.0', id, result: { ...result, ...extra } }
  window.dispatchEvent(new window.MessageEvent('message', { data: payload, source: window }))
}

function respond(window, message) {
  if (!message || typeof message !== 'object') return
  messages.push(message)

  if (message.method === 'ui/initialize' && message.id !== undefined) {
    reply(window, message.id, {
      protocolVersion: '2026-07-28',
      hostCapabilities: {},
      hostInfo: { name: 'mock-host', version: '0' },
      hostContext: {
        theme: 'light',
        platform: 'desktop',
        styles: { variables: { '--color-background-primary': '#ffffff' } },
      },
    })
    return
  }

  if (message.method === 'tools/call' && message.id !== undefined) {
    const op = message.params?.arguments?.op
    const args = message.params?.arguments?.args || {}
    let structured
    if (op === 'bootstrap') structured = bootstrap
    else if (op === 'day') structured = { date: args.date, exists: true, text: '# 测试日志\n' }
    else if (op === 'archive' && args.action === 'run') {
      todayState.archived = true
      structured = { created: true, date: args.date, commitCount: 2, docCount: 1, sessionCount: 1 }
    } else if (op === 'search')
      // the real server wraps list results as { items } (structuredContent
      // must be a record on the wire) — the mock mirrors that contract
      structured = { items: [{ date: '2026-10-28', count: 2, snippet: '…测试日志片段…' }] }
    else if (op === 'report' && args.action === 'generate')
      structured = { kind: args.kind, name: `${args.kind}-mock.md`, text: '# 报告内容\n', ai: false }
    else if (op === 'report' && args.action === 'summarize')
      structured = { kind: 'summarize', name: `summarize-${args.start}_${args.end}.md`, text: '# 规则摘要\n', ai: false }
    else if (op === 'report' && args.action === 'read') structured = { text: '# 报告全文\n' }
    else if (op === 'calendar' && args.action === 'month')
      structured = { month: '2026-10', today: '2026-10-31', days: { '2026-10-31': { date: '2026-10-31', archived: true, hasDailyReport: false, entryCount: 3, bySource: { git: 2, sessions: 1 }, todoDone: 1, todoDue: 1, sessionCount: 1, commitCount: 2 } } }
    else if (op === 'graph' && !args.entity)
      structured = { builtAt: '2026-10-31T09:00:00.000Z', nodeCount: 3, edgeCount: 3, types: { project: 1, person: 1, tool: 1 }, nodes: [{ key: 'project:商城', type: 'project', label: '商城', weight: 5 }, { key: 'person:Ray', type: 'person', label: 'Ray', weight: 3 }] }
    else if (op === 'graph' && args.entity)
      structured = { entity: args.entity, found: true, type: 'project', label: args.entity, weight: 5, relations: [{ kind: '提交了', count: 3, direction: 'in', other: 'Ray', otherType: 'person' }] }
    else if (op === 'collect' && args.action === 'diagnostics') {
      if (failCollect) {
        // first call fails: exercises the lazy-load failure + retry path
        failCollect = false
        reply(window, message.id, { isError: true, content: [{ type: 'text', text: '模拟诊断加载失败' }] })
        return
      }
      structured = { tasks: [{ id: 'collect-sessions', kind: 'collect-sessions', title: 'AI 会话采集', description: 'x', enabled: false, everyHours: 4, dailyAt: '', lastRunAt: '', lastStatus: '', lastError: '' }], history: [], sources: [{ id: 'claude', label: 'Claude Code', path: 'C:/x', kind: 'dir', exists: true, enabled: true }], watchDirs: [] }
    }
    else if (op === 'templates' && args.action === 'list')
      structured = { templates: [{ scene: 'report', name: '报告润色', hint: '周报月报', kind: 'report', source: 'builtin', system: 'S', user: 'U' }] }
    else if (op === 'connectors' && args.action === 'list')
      structured = { connectors: [], types: [{ type: 'feishu', title: '飞书', description: 'd', fields: [{ key: 'appId', label: 'App ID', type: 'text' }] }] }
    else if (op === 'calendar' && args.action === 'day')
      structured = { date: args.date, archived: true, path: 'x', sessions: [{ title: '日历模拟会话', label: 'Claude', turns: 2, timeRange: '10:00' }], todosDue: [{ id: 't1', title: '测试待办', pri: '高' }], todosDone: [{ title: '测试待办', doneAt: '' }], entries: { count: 3, bySource: { git: 2, sessions: 1 }, items: [{ time: '10:00', title: 'feat: x', project: 'demo', source: 'git', ref: 'a1' }] }, hasDailyReport: false }
    else if (op === 'todos' && args.action === 'list') structured = { items: bootstrap.todos }
    else if (op === 'ai' && args.action === 'detect')
      structured = {
        candidates: [
          {
            id: 'zcode:builtin:demo',
            source: 'zcode',
            sourceLabel: 'ZCode',
            name: 'Demo Provider',
            baseUrl: 'https://pick.test/api/anthropic',
            model: 'GLM-5.2',
            apiFormat: 'anthropic',
            hasKey: true,
            keyHint: 'sk-d…7890',
            note: 'ZCode 当前选择的供应商',
            models: ['GLM-5.2', 'GLM-5-Turbo'],
          },
        ],
      }
    else if (op === 'ai' && args.action === 'models')
      structured = { models: ['GLM-5.2', 'GLM-5-Turbo', 'GLM-5.3'], source: 'api' }
    else if (op === 'ai' && args.action === 'apply')
      structured = {
        applied: { name: 'Demo Provider', models: ['GLM-5.2', 'GLM-5-Turbo'] },
        config: bootstrap.config,
      }
    else if (op === 'config') structured = bootstrap.config
    else if (op === 'sessions' && args.action === 'sources')
      structured = {
        sources: [
          { id: 'claude', label: 'Claude Code', path: '~/.claude/projects', kind: 'dir', exists: true, enabled: true },
          { id: 'zcode', label: 'ZCode', path: '~/.zcode/cli/db/db.sqlite', kind: 'db', exists: false, enabled: true },
        ],
      }
    else if (op === 'sessions' && args.action === 'index_status') structured = { builtAt: '2026-10-31T09:00:00.000Z', total: 4 }
    else if (op === 'sessions' && args.action === 'sync_all') structured = { builtAt: '2026-10-31T09:00:00.000Z', total: 4, errors: [] }
    else if (op === 'sessions' && args.action === 'query')
      structured = {
        matched: 1,
        total: 4,
        keywords: [],
        groups: {},
        sessions: [
          {
            key: 'mock-1',
            title: '模拟会话行',
            label: 'Claude Code',
            first: '2026-10-29',
            last: '2026-10-29',
            datesCount: 1,
            turns: 2,
            preview: '摘录预览',
          },
        ],
      }
    else if (op === 'sessions')
      structured = {
        date: args.date || '2026-10-29',
        sessions: [
          {
            source: 'claude',
            label: 'Claude Code',
            title: '调整 zcode worklog 会话扫描',
            turns: 2,
            timeRange: '09:12–09:40',
            cwd: 'E:\\AI_Project\\research',
            texts: [],
          },
        ],
        totals: { sessions: 1, turns: 2 },
        errors: [],
      }
    else structured = { ok: true }
    reply(
      window,
      message.id,
      {},
      {
        content: [{ type: 'text', text: JSON.stringify(structured) }],
        structuredContent: structured,
      },
    )
    return
  }

  if (message.method === 'ping' && message.id !== undefined) {
    reply(window, message.id, {})
  }
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://host.local/',
  virtualConsole,
  beforeParse(window) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16)
    window.cancelAnimationFrame = (id) => clearTimeout(id)
    window.postMessage = (message) => respond(window, message)
  },
})

const window = dom.window
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
await wait(1200)

const doc = window.document
const text = () => doc.body.textContent

assert.ok(text().includes('WorkLog'), 'panel title rendered')

// --- tab skeleton: exactly 5 tabs, today is the default -------------
const tabLabels = [...doc.querySelectorAll('.wl-tab')].map((item) => item.textContent)
assert.deepEqual(tabLabels, ['今天', '时间', '资料库', '报告', '设置'], 'tab skeleton is the UX v3 five tabs')
assert.ok(doc.querySelector('.wl-tab.on')?.textContent === '今天', 'today tab is the default')

// --- today tab: archive state machine (未归档 → 进行中 → 已归档) ----
assert.ok(text().includes('尚未生成日志'), 'today shows the unarchived card')
assert.ok(text().includes('今日待办'), 'today shows the due-todos section')
assert.ok(text().includes('测试待办'), 'today lists the due todo')
assert.ok(doc.querySelector('#wl-today-quick'), 'today has the quick-add input')
assert.ok(text().includes('今天的 AI 会话'), 'today shows the session brief list')
assert.ok(text().includes('昨天回顾'), 'today shows the yesterday preview')
await wait(300)
assert.ok(text().includes('打开昨天的日志'), 'yesterday log preview loaded on boot (not stuck in 加载中)')
assert.ok(!text().includes('项目'), 'stat card wall / project cards are gone')
const genBtn = [...doc.querySelectorAll('button')].find((item) => item.textContent === '生成今日日志')
assert.ok(genBtn, 'primary generate button exists')
genBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
assert.ok(text().includes('生成中…'), 'phase 2: button switches to in-flight state')
await wait(400)
assert.ok(text().includes('今天的日志已生成'), 'phase 3: card flips to archived')
assert.ok(text().includes('打开') && text().includes('继续编辑'), 'archived card offers open / continue editing')
assert.ok(text().includes('今日日志已生成'), 'success notice rendered')
console.log('today OK (archive state machine)')

const clickTab = async (label) => {
  const tab = [...doc.querySelectorAll('.wl-tab')].find((item) => item.textContent === label)
  assert.ok(tab, `tab ${label} exists`)
  tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await wait(350)
}

// --- time tab: master-detail, clicking a day never replaces the page --
await clickTab('时间')
await wait(150)
assert.ok(doc.querySelector('.wl-master'), 'time tab uses the master-detail layout')
assert.ok(doc.querySelector('.wl-cal-grid'), 'calendar grid renders')
assert.ok(text().includes('全部待办'), 'todo workbench lives at the bottom of the time tab')
assert.ok(text().includes('标记：● 有日志 · ▼ 有到期待办 · ◦ 有会话'), 'calendar legend shows the three marks')
const markCount = doc.querySelectorAll('.wl-cal-marks .wl-cal-badge, .wl-cal-marks .wl-cal-dot').length
assert.equal(markCount, 0, 'legacy badge/dot marks are gone (3 text marks only)')
const firstCell = doc.querySelector('.wl-cal-cell:not(.empty)')
assert.ok(firstCell, 'calendar has day cells')
firstCell.click()
await wait(150)
assert.ok(doc.querySelector('.wl-master'), 'clicking a day keeps the page (no full-page replace)')
assert.ok(doc.querySelector('.wl-cal-grid'), 'calendar still visible after day selection')
assert.ok([...doc.querySelectorAll('.wl-tab')].find((item) => item.textContent === '时间').className.includes('on'), 'still on the time tab')
assert.ok(text().includes('日历模拟会话'), 'day detail refreshed with sessions')
assert.ok(text().includes('当天记录 3 条'), 'day detail refreshed with records')
assert.ok(text().includes('当天到期待办'), 'day detail shows due todos')
const dayLogEdit = [...doc.querySelectorAll('button')].find((item) => item.textContent === '编辑')
assert.ok(dayLogEdit, 'day log card starts in read mode with an edit button')
dayLogEdit.click()
await wait(20)
const dayArea = doc.querySelector('.wl-master textarea')
assert.ok(dayArea && dayArea.value.includes('# 测试日志'), 'edit mode shows the day textarea')
console.log('time OK (master-detail, no day hub)')

// --- library tab: sessions / logs / graph sub-views -------------------
await clickTab('资料库')
await wait(100)
const segButtons = [...doc.querySelectorAll('.wl-seg button')].map((item) => item.textContent)
assert.deepEqual(segButtons, ['会话', '日志', '图谱'], 'library has the three sub-views')
assert.ok(text().includes('同步全部会话'), 'sessions view shows the sync actions')
assert.ok(!text().includes('会话月历'), 'session month calendar is gone (single calendar rule)')
const queryBtn = [...doc.querySelectorAll('button')].find((item) => item.textContent === '查询')
assert.ok(queryBtn, 'sessions filter bar has the query button')
queryBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(450)
assert.ok(text().includes('模拟会话行'), 'sessions query renders result rows')

const segLogs = [...doc.querySelectorAll('.wl-seg button')].find((item) => item.textContent === '日志')
segLogs.click()
await wait(50)
const searchInput = doc.querySelector('#wl-query')
assert.ok(searchInput, 'logs view has the search input')
searchInput.value = '测试'
doc.querySelector('#wl-query').dispatchEvent(new window.Event('input', { bubbles: true }))
;[...doc.querySelectorAll('button')].find((item) => item.textContent === '搜索').click()
await wait(450)
assert.ok(text().includes('测试日志片段'), 'log search hits render')
const hitRow = [...doc.querySelectorAll('.wl-item-title')].find((item) => item.textContent.includes('2026-10-28'))
assert.ok(hitRow, 'hit row exists')
hitRow.click()
await wait(450)
assert.ok(text().includes('# 测试日志'), 'hit expands to an inline full-text preview')

const segGraph = [...doc.querySelectorAll('.wl-seg button')].find((item) => item.textContent === '图谱')
segGraph.click()
await wait(300)
assert.ok(text().includes('知识图谱'), 'graph view renders')
const chip = Array.from(doc.querySelectorAll('.wl-chip')).find((el) => el.textContent.includes('商城'))
assert.ok(chip, 'project chip exists')
chip.click()
await wait(100)
assert.ok(text().includes('提交了'), 'entity relations render')
console.log('library OK (sessions/logs/graph)')

// --- report tab: flat generator + regenerate confirm dialog -----------
await clickTab('报告')
await wait(100)
const kindChips = [...doc.querySelectorAll('.wl-chip')].map((item) => item.textContent)
assert.deepEqual(
  kindChips,
  ['日报', '周报', '月报', '季报', '绩效素材', '项目档案', '自由总结'],
  'report generator exposes the seven kind chips',
)
assert.ok(text().includes('weekly-2026-10-26.md'), 'generated report list renders')
const regenBtn = [...doc.querySelectorAll('button')].find((item) => item.textContent === '重新生成')
assert.ok(regenBtn, 'regenerate button is reachable without unfolding anything')
regenBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(20)
assert.ok(text().includes('重新生成 周报？'), 'confirm dialog appears before overwriting')
const cancelBtn = [...doc.querySelectorAll('.wl-modal button')].find((item) => item.textContent === '取消')
assert.ok(cancelBtn, 'confirm dialog has a cancel button')
cancelBtn.click()
await wait(20)
assert.ok(!doc.querySelector('.wl-modal'), 'cancel closes the dialog without running the op')
regenBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(20)
const okBtn = [...doc.querySelectorAll('.wl-modal button')].find((item) => item.textContent === '重新生成')
okBtn.click()
await wait(450)
assert.ok(!doc.querySelector('.wl-modal'), 'confirm closes the dialog')
assert.ok(text().includes('# 报告内容'), 'regenerated report text is displayed in place')
console.log('report OK (flat generator + confirm)')

// --- settings tab: left-nav subpages, no folds, lazy load + retry ------

await clickTab('设置')
await wait(150)
const subLabels = [...doc.querySelectorAll('.wl-subnav button')].map((item) => item.textContent)
assert.deepEqual(
  subLabels,
  ['通用', 'AI 接口', '采集与调度', '连接器', '提示词模板', '备份与迁移', '诊断'],
  'settings sub-nav has the seven pages',
)
assert.ok([...doc.querySelectorAll('.wl-subnav button')][0].className.includes('on'), '通用 is the default subpage')
assert.ok(text().includes('数据目录'), 'general page shows the data dir')
assert.ok(text().includes('自动归档'), 'general page shows auto archive')
assert.ok([...doc.querySelectorAll('textarea')].length >= 3, 'general page has scan/doc/watch textareas')

// dirty draft save bar: typing reveals it without a re-render (focus safe)
const scanArea = [...doc.querySelectorAll('textarea')][0]
scanArea.value = 'E:\\ws\nE:\\more'
scanArea.dispatchEvent(new window.Event('input', { bubbles: true }))
await wait(30)
const dirtyBar = doc.querySelector('#wl-dirty-bar')
assert.ok(dirtyBar, 'dirty save bar exists on draft subpages')
assert.equal(dirtyBar.style.display, 'flex', 'typing reveals the dirty bar')
// switching subpages keeps the dirty draft and the bar
;[...doc.querySelectorAll('.wl-subnav button')].find((item) => item.textContent === 'AI 接口').click()
await wait(350)
assert.ok(text().includes('扫描本机 AI 工具'), 'AI page shows detect actions')
assert.ok(text().includes('AI 工具配置向导'), 'wizard is merged into the AI page')
assert.ok(text().includes('探测'), 'wizard probe action is reachable')
;[...doc.querySelectorAll('.wl-subnav button')].find((item) => item.textContent === '通用').click()
await wait(50)
assert.equal(doc.querySelector('#wl-dirty-bar').style.display, 'flex', 'dirty bar survives subpage switches')
;[...doc.querySelectorAll('#wl-dirty-bar button')].find((item) => item.textContent === '放弃').click()
await wait(50)
assert.equal(doc.querySelector('#wl-dirty-bar').style.display, 'none', 'discard clears the dirty state')
console.log('settings general/dirty-bar OK')

// lazy load failure + retry on 采集与调度 (first diagnostics call fails)
;[...doc.querySelectorAll('.wl-subnav button')].find((item) => item.textContent === '采集与调度').click()
await wait(350)
assert.ok(text().includes('采集与调度加载失败'), 'lazy load failure surfaces an error')
const retryBtn = [...doc.querySelectorAll('button')].find((item) => item.textContent === '重试')
assert.ok(retryBtn, 'failure offers a retry button')
retryBtn.click()
await wait(450)
assert.ok(text().includes('调度任务'), 'retry loads the diagnostics content')
assert.ok(text().includes('运行所有到期任务'), 'immediate-run buttons live on the collect page')
assert.ok(text().includes('额外 AI 会话目录'), 'extra session dirs live on the collect page')
console.log('settings collect OK (lazy fail + retry)')

// AI page: candidate linkage (moved from the old fold assertions)
;[...doc.querySelectorAll('.wl-subnav button')].find((item) => item.textContent === 'AI 接口').click()
await wait(350)
const pick = doc.querySelector('#wl-ai-pick')
assert.ok(pick, 'AI candidate dropdown renders')
assert.ok(pick.textContent.includes('Demo Provider'), 'dropdown lists the candidate')
assert.ok(pick.textContent.includes('2 模型'), 'dropdown shows the model count')
pick.value = 'zcode:builtin:demo'
pick.dispatchEvent(new window.Event('change', { bubbles: true }))
await wait(200)
const linkedInput = [...doc.querySelectorAll('input')].find((el) => el.value === 'https://pick.test/api/anthropic')
assert.ok(linkedInput, 'selecting a candidate links Base URL into the form')
assert.ok(text().includes('已带入 2 个模型'), 'selecting a candidate brings its models')
let modelPick = doc.querySelector('#wl-ai-model-pick')
assert.ok(modelPick, 'model select renders after linkage')
assert.equal(modelPick.querySelectorAll('option').length, 3, 'placeholder plus the two linked models')
const loadBtn = [...doc.querySelectorAll('button')].find((el) => el.textContent === '加载模型')
assert.ok(loadBtn, 'load models button renders')
loadBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(400)
modelPick = doc.querySelector('#wl-ai-model-pick')
assert.ok(modelPick, 'model select still renders after loading')
assert.equal(modelPick.querySelectorAll('option').length, 4, 'placeholder plus three loaded models')
assert.equal(text().split('已加载 3 个模型').length - 1, 1, 'model hint renders exactly once')
console.log('settings ai OK (wizard merged)')

// 连接器 / 提示词模板
;[...doc.querySelectorAll('.wl-subnav button')].find((item) => item.textContent === '连接器').click()
await wait(300)
assert.ok(text().includes('新建连接器'), 'connector page renders')
;[...doc.querySelectorAll('.wl-subnav button')].find((item) => item.textContent === '提示词模板').click()
await wait(300)
assert.ok(text().includes('变量：'), 'template page renders')
console.log('settings conn/tpl OK')

// 备份与迁移: delete asks first
;[...doc.querySelectorAll('.wl-subnav button')].find((item) => item.textContent === '备份与迁移').click()
await wait(150)
assert.ok(text().includes('创建备份'), 'backup page renders')
assert.ok(text().includes('backup-test.json'), 'backup list renders')
const backupDel = [...doc.querySelectorAll('button')].find((item) => item.textContent === '删除' && item.className.includes('danger'))
assert.ok(backupDel, 'backup delete button exists')
backupDel.click()
await wait(20)
assert.ok(text().includes('删除备份 backup-test.json？'), 'backup delete asks for confirmation')
;[...doc.querySelectorAll('.wl-modal button')].find((item) => item.textContent === '取消').click()
await wait(20)
assert.ok(!doc.querySelector('.wl-modal'), 'cancel aborts the delete')
console.log('settings backup OK (delete confirm)')

// 诊断: sources + run history + usage + cache
;[...doc.querySelectorAll('.wl-subnav button')].find((item) => item.textContent === '诊断').click()
await wait(350)
assert.ok(text().includes('会话来源健康'), 'diag shows source health')
assert.ok(text().includes('Claude Code'), 'diag lists the source row')
assert.ok(text().includes('运行历史'), 'diag shows the migrated run history')
assert.ok(text().includes('2 提交'), 'run history rows render')
assert.ok(text().includes('AI 用量'), 'diag shows AI usage')
assert.ok(text().includes('会话索引缓存'), 'diag shows the session cache card')
assert.ok(text().includes('强制重扫'), 'cache rebuild action exists')
console.log('settings diag OK')

// folds are gone everywhere — the fold mechanism is retired
assert.equal(doc.querySelectorAll('.wl-fold').length, 0, 'no fold blocks remain in the whole panel')
console.log('settings OK')


const ops = messages
  .filter((message) => message.method === 'tools/call')
  .map((message) => message.params?.arguments?.op)
assert.ok(messages.some((message) => message.method === 'ui/initialize'), 'handshake happened')
assert.ok(ops.includes('bootstrap') && ops.includes('day'), 'panel called the server')
assert.ok(ops.includes('archive') && ops.includes('report'), 'archive and report ops were exercised')
// v0.17 lesson: any uncaught jsdom error here is a real bug, never noise.
assert.deepEqual(jsdomErrors, [], 'no uncaught jsdom errors during the whole walk')
console.log('tool ops:', ops.join(', '))
console.log('PANEL OK')
