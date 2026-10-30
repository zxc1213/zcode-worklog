/**
 * Panel simulation: loads the built panel as an MCP App inside jsdom and
 * answers the host side of the protocol with mock WorkLog data. Verifies the
 * ui/initialize handshake, bootstrap call, tab rendering and a per-tab tool
 * call without needing the ZCode desktop host.
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

const bootstrap = {
  status: {
    version: '0.1.0',
    dataDir: config.dataDir,
    today: { date: '2026-10-29', archived: false },
    days: { count: 3, latest: [{ date: '2026-10-28', size: 100, mtime: '' }] },
    todos: {
      count: 2,
      open: 1,
      overdue: 0,
      recent: [{ id: 't1', title: '测试待办', status: 'open', pri: '高', due: '2026-10-30' }],
    },
    backups: { count: 0, latest: null },
    projects: [{ name: 'demo-project', days: ['2026-10-28'], commits: 2 }],
    runHistory: [],
    config,
  },
  days: [{ date: '2026-10-28', size: 100, relative: '2026-10/第5周/2026-10-28.md' }],
  todos: [{ id: 't1', title: '测试待办', status: 'open', pri: '高', due: '2026-10-30' }],
  reports: [{ name: 'weekly-2026-10-26.md', size: 100, mtime: '2026-10-28T10:00:00.000Z' }],
  backups: [],
  config,
}

const messages = []
const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', (error) => console.error('[jsdomError]', error.message))

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
    else if (op === 'todos' && args.action === 'list') structured = { items: bootstrap.todos }
    else if (op === 'ai' && args.action === 'detect')
      structured = {
        candidates: [
          {
            id: 'zcode:builtin:demo',
            source: 'zcode',
            sourceLabel: 'ZCode',
            name: 'Demo Provider',
            baseUrl: 'https://example.test/api/anthropic',
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
    else if (op === 'sessions' && args.action === 'sources')
      structured = {
        sources: [
          { id: 'claude', label: 'Claude Code', path: '~/.claude/projects', kind: 'dir', exists: true, enabled: true },
          { id: 'zcode', label: 'ZCode', path: '~/.zcode/cli/db/db.sqlite', kind: 'db', exists: false, enabled: true },
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
assert.ok(text().includes('未归档'), 'overview shows archive state')
assert.ok(text().includes('1 进行中'), 'overview shows open todo count')
assert.ok(text().includes('demo-project'), 'overview shows project')
console.log('overview OK')

const clickTab = async (label) => {
  const tab = [...doc.querySelectorAll('.wl-tab')].find((item) => item.textContent === label)
  assert.ok(tab, `tab ${label} exists`)
  tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await wait(350)
}

await clickTab('日志')
const logArea = doc.querySelector('textarea')
assert.ok(logArea && logArea.value.includes('# 测试日志'), 'logs tab loads day text')
console.log('logs OK')

await clickTab('待办')
assert.ok(text().includes('测试待办'), 'todos tab lists todo')
console.log('todos OK')

await clickTab('汇报')
assert.ok(text().includes('周报'), 'reports tab renders')
assert.ok(text().includes('weekly-2026-10-26.md'), 'reports list rendered')
console.log('reports OK')

await clickTab('会话')
const scanButton = [...doc.querySelectorAll('button')].find((item) => item.textContent === '扫描会话')
assert.ok(scanButton, 'sessions tab renders scan button')
scanButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(450)
assert.ok(text().includes('调整 zcode worklog 会话扫描'), 'sessions scan renders session title')
assert.ok(text().includes('1 场'), 'sessions totals card rendered')
console.log('sessions OK')

const clickFold = async (label) => {
  const head = [...doc.querySelectorAll('.wl-fold-head')].find((item) => item.textContent.includes(label))
  assert.ok(head, `fold ${label} exists`)
  head.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await wait(200)
}

await clickTab('设置')
assert.ok(text().includes('保存设置'), 'settings save bar renders')
assert.ok(text().includes('数据与扫描'), 'settings tab is split into folds')
assert.ok(text().includes('备份与恢复'), 'settings tab shows backup fold')
await wait(250)
await clickFold('数据与扫描')
assert.ok(text().includes('扫描根目录'), 'data fold expands')
await clickFold('AI 润色')
await wait(300)
const pick = doc.querySelector('#wl-ai-pick')
assert.ok(pick, 'AI candidate dropdown renders')
assert.ok(pick.textContent.includes('Demo Provider'), 'dropdown lists the candidate')
assert.ok(pick.textContent.includes('2 模型'), 'dropdown shows the model count')
const modelInput = [...doc.querySelectorAll('input')].find((el) => el.getAttribute('list') === 'wl-ai-models')
assert.ok(modelInput, 'model input has a datalist')
const loadBtn = [...doc.querySelectorAll('button')].find((el) => el.textContent === '加载模型')
assert.ok(loadBtn, 'load models button renders')
loadBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await wait(400)
const datalist = doc.querySelector('#wl-ai-models')
assert.ok(datalist, 'model datalist renders')
assert.equal(datalist.querySelectorAll('option').length, 3, 'models loaded into the datalist')
assert.ok(text().includes('已加载 3 个模型'), 'model count hint renders')
console.log('settings OK')

const ops = messages
  .filter((message) => message.method === 'tools/call')
  .map((message) => message.params?.arguments?.op)
assert.ok(messages.some((message) => message.method === 'ui/initialize'), 'handshake happened')
assert.ok(ops.includes('bootstrap') && ops.includes('day'), 'panel called the server')
console.log('tool ops:', ops.join(', '))
console.log('PANEL OK')
