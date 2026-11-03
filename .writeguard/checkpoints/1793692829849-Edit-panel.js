/**
 * WorkLog side panel (MCP App).
 *
 * Talks to this plugin's own MCP server through the host:
 *   app.callServerTool({ name: 'worklog_api', arguments: { op, args } })
 * All committed data stays on disk inside the plugin's data directory.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps'

const app = new App({ name: 'zcode-worklog', version: '0.1.0' }, {})

const CONNECT_TIMEOUT_MS = 8000
const CALL_TIMEOUT_MS = 30000

function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function markMounted() {
  window.__worklogMounted = true
  clearTimeout(window.__worklogBootTimer)
}

const TABS = [
  ['today', '今天'],
  ['time', '时间'],
  ['library', '资料库'],
  ['report', '报告'],
  ['settings', '设置'],
]

// 'custom'（自由总结）walks the report op's summarize action with a start/end
// range; the other six map straight onto report generate's kind enum.
const REPORT_KINDS = [
  ['daily', '日报'],
  ['weekly', '周报'],
  ['month', '月报'],
  ['quarter', '季报'],
  ['perf', '绩效素材'],
  ['project', '项目档案'],
  ['custom', '自由总结'],
]

// Report list entries only carry a file name ("<kind>-<key>.md"), so the kind
// label for grouping/regeneration is derived from the same enum (summarize is
// how the backend names 自由总结 files).
const REPORT_KIND_LABELS = {
  daily: '日报',
  weekly: '周报',
  month: '月报',
  quarter: '季报',
  perf: '绩效素材',
  project: '项目档案',
  summarize: '自由总结',
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function today() {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function month() {
  return today().slice(0, 7)
}

function quarter() {
  const now = new Date()
  return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`
}

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function yesterdayOf(dateText) {
  const d = new Date(dateText)
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function cnDate(dateText) {
  return Number(String(dateText).slice(5, 7)) + '月' + Number(String(dateText).slice(8, 10)) + '日'
}

function weekdayCn(dateText) {
  return '日一二三四五六'[new Date(dateText).getDay()] || ''
}

const state = {
  tab: 'today',
  busy: '',
  notice: null,
  status: null,
  days: [],
  todos: [],
  todoFilter: { pri: '', tag: '' },
  editingTodo: null,
  editingDraft: null,
  todoSuggest: null,
  todoBatch: { open: false, drafts: null, checked: [] },
  aiDraft: null,
  schedData: null,
  schedLoading: false,
  calMonth: '',
  calMonths: {},
  calSelected: '',
  calMode: 'month',
  calAnchor: '',
  calDay: null,
  calDayLoading: false,
  dayEdit: false,
  yesterday: { date: '', text: '', loaded: false, loading: false },
  libView: 'sessions',
  wizardTypes: null,
  wizardDraft: { type: 'claude', location: '' },
  wizardProbe: null,
  tplList: null,
  tplDraft: null,
  tplLoading: false,
  connList: null,
  connDraft: null,
  connLoading: false,
  recoData: null,
  recoLoading: false,
  graphData: null,
  graphEntity: '',
  graphLoading: false,
  graphTrail: [],
  graphType: '',
  sessIndex: null,
  sessContent: {},
  sessExpanded: [],
  sessFilters: { q: '', project: '', source: '', start: '', end: '', minTurns: '', workOnly: false, workKeywords: '' },
  sessGroupBy: '',
  sessResult: null,
  sessChecked: [],
  sessMark: '',
  sessGroupInput: '',
  reports: [],
  backups: [],
  config: null,
  settings: null,
  log: { date: today(), text: '', exists: false, loaded: false },
  logRange: { start: '', end: '' },
  sessSources: null,
  sessSourcesLoading: false,
  hits: [],
  logExpand: '',
  logExpandLoading: false,
  logExpandData: null,
  reportText: '',
  reportKind: 'weekly',
  reportPeriod: today(),
  reportStart: daysAgo(6),
  reportEnd: today(),
  reportUseAi: false,
  reportFlash: '',
  confirm: null,
  importDir: '',
  aiCandidates: null,
  aiBusy: false,
  aiPick: '',
  aiModels: [],
  aiModelsBusy: false,
  aiModelsNote: '',
  sub: 'general',
  tplError: '',
  connError: '',
  sessIndexLoading: false,
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'className') node.className = value
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value)
    } else if (key === 'value' || key === 'checked') node[key] = value
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function noticeNode() {
  if (!state.notice) return null
  return h('div', { className: `wl-notice ${state.notice.type}` }, state.notice.text)
}

function setNotice(type, text) {
  state.notice = { type, text }
}

async function call(op, args = {}) {
  const result = await withTimeout(
    app.callServerTool({ name: 'worklog_api', arguments: { op, args } }),
    CALL_TIMEOUT_MS,
    `调用 ${op} 超时。WorkLog 面板由插件内置提供，请确认插件已启用后重开面板。`,
  )
  const text = result?.content?.find?.((item) => item.type === 'text')?.text
  if (result?.isError) throw new Error(text || '操作失败')
  const structured = result?.structuredContent
  if (structured && Array.isArray(structured.items)) return structured.items
  if (structured !== undefined) return structured
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function refreshAll() {
  const data = await call('bootstrap')
  state.status = data.status
  state.days = data.days || []
  state.todos = data.todos || []
  state.reports = data.reports || []
  state.backups = data.backups || []
  state.config = data.config || state.status?.config || null
  if (!state.settings) state.settings = draftFromConfig(state.config)
}

function draftFromConfig(config) {
  const c = config || {}
  return {
    dataDir: c.dataDir || '',
    scanRoots: (c.scanRoots || []).join('\n'),
    docRoots: (c.docRoots || []).join('\n'),
    sessionRoots: (c.sessionRoots || []).join('\n'),
    watchDirsText: (c.watchDirs || []).map(function (item) { return typeof item === 'string' ? item : item.path + (item.kind && item.kind !== 'local' ? '|'+item.kind : '') }).join('\n'),
    gitAuthor: c.gitAuthor || '',
    git: c.sources?.git !== false,
    docs: c.sources?.docs !== false,
    sessions: c.sources?.sessions !== false,
    autoArchive: Boolean(c.autoArchive),
    skipWeekends: Boolean(c.skipWeekends),
    taskTime: c.taskTime || '18:30',
    aiBaseUrl: c.ai?.baseUrl || '',
    aiModel: c.ai?.model || '',
    aiFormat: c.ai?.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
    aiKey: '',
  }
}

function splitLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

async function act(label, fn, { refresh = true } = {}) {
  if (state.busy) {
    // A click during an in-flight op used to vanish silently; say so instead.
    setNotice('info', '上一步操作仍在进行，请稍候。')
    render()
    return
  }
  state.busy = label
  state.notice = null
  render()
  try {
    await fn()
  } catch (error) {
    setNotice('err', String(error?.message || error))
  } finally {
    state.busy = ''
    if (refresh) {
      try {
        await refreshAll()
      } catch (error) {
        setNotice('err', `刷新失败：${String(error?.message || error)}`)
      }
    }
    render()
  }
}

function tabButton(key, label) {
  return h(
    'button',
    {
      className: `wl-tab${state.tab === key ? ' on' : ''}`,
      onClick: () => {
        state.tab = key
        if (key === 'today') {
          loadYesterday().then(render, () => render())
          if (!state.recoData && !state.recoLoading) loadReco().then(render, () => render())
        }
        if (key === 'settings') {
          if (state.config) state.settings = state.settings || draftFromConfig(state.config)
          if (state.aiCandidates === null) detectAi()
        }
        render()
      },
    },
    label,
  )
}

function gotoTab(tab) {
  state.tab = tab
  render()
}

// Cross-page jump helpers (explicit links only; no card walls).
function openLibrarySessions(date) {
  state.tab = 'library'
  state.libView = 'sessions'
  state.sessFilters.start = date || ''
  state.sessFilters.end = date || ''
  state.sessGroupBy = ''
  state.sessResult = null
  render()
  runSessQuery()
}

function gotoWorkbench() {
  state.tab = 'time'
  render()
  const el = document.getElementById('wl-todo-workbench')
  if (el?.scrollIntoView) el.scrollIntoView({ block: 'start' })
}

function priorityTag(pri) {
  if (!pri) return null
  const tone = pri === '高' ? 'high' : pri === '中' ? 'mid' : 'low'
  return h('span', { className: `wl-tag ${tone}` }, pri)
}

async function loadLog(date) {
  const data = await call('day', { date })
  state.log = {
    date: data.date || date,
    text: data.text || '',
    exists: Boolean(data.exists),
    loaded: true,
    savedText: data.text || '',
  }
  return data
}

// The day-log edit is dirty when edit mode is on and the text diverges from
// what was loaded from disk. Used to gate day switches (no silent data loss).
function logEditDirty() {
  return Boolean(
    state.dayEdit
      && state.log.loaded
      && state.log.text !== (state.log.savedText ?? state.log.text),
  )
}

// Yesterday preview on the today tab. Guard both 'loaded' and 'in flight';
// failures still set the loaded sentinel so the panel never retries in a loop.
async function loadYesterday() {
  const date = yesterdayOf(today())
  if (state.yesterday.loaded && state.yesterday.date === date) return
  if (state.yesterday.loading) return
  state.yesterday.loading = true
  state.yesterday.date = date
  render()
  try {
    const data = await call('day', { date })
    state.yesterday = { date, text: data?.text || '', loaded: true, loading: false }
  } catch {
    state.yesterday = { date, text: '', loaded: true, loading: false }
  }
  render()
}

// Jump to a day on the time tab (read mode by default; edit mode is the
// today tab「继续编辑」target state).
async function openDay(date, { edit = false } = {}) {
  state.tab = 'time'
  render()
  await selectCalDay(date, { edit })
}

// Today tab v1: one archive action card, due todos, recommendations, a brief
// session list and a yesterday preview. The old stat card wall, project cards
// and "recent runs" block are gone (P1 redesign, see docs/ux-v3-design.md §4.1).
function todayTab() {
  const status = state.status
  if (!status) return h('div', { className: 'wl-empty' }, '加载中…')
  const todayInfo = status.today || { date: today(), archived: false }
  const todayText = today()
  const dueTodos = state.todos.filter((item) => item.status !== 'done' && item.due && item.due <= todayText)
  const overdueCount = dueTodos.filter((item) => item.due < todayText).length

  return h(
    'div',
    { className: 'wl-stack' },
    noticeNode(),
    todayInfo.archived
      ? h(
          'div',
          { className: 'wl-card wide' },
          h(
            'div',
            { className: 'wl-row' },
            h(
              'div',
              { className: 'grow' },
              h('div', { className: 'wl-item-title' }, `今天的日志已生成（${cnDate(todayInfo.date)} 周${weekdayCn(todayInfo.date)}）`),
              h('div', { className: 'wl-item-meta' }, '可在时间页查看当天汇总，或继续补充手写内容'),
            ),
            h('button', { className: 'wl-btn', onClick: () => openDay(todayInfo.date) }, '打开'),
            h('button', { className: 'wl-btn', onClick: () => openDay(todayInfo.date, { edit: true }) }, '继续编辑'),
          ),
        )
      : h(
          'div',
          { className: 'wl-card wide' },
          h(
            'div',
            { className: 'wl-row' },
            h(
              'div',
              { className: 'grow' },
              h('div', { className: 'wl-item-title' }, `今天（${cnDate(todayInfo.date)} 周${weekdayCn(todayInfo.date)}）尚未生成日志`),
              h('div', { className: 'wl-item-meta' }, '将汇总：git 提交 · 文档变更 · AI 会话 · 待办'),
            ),
            h(
              'button',
              {
                className: 'wl-btn primary',
                disabled: state.busy === 'archive-today',
                onClick: () =>
                  act('archive-today', async () => {
                    const result = await call('archive', { action: 'run', date: today(), force: false })
                    setNotice(
                      'ok',
                      result.created
                        ? `今日日志已生成：${result.commitCount} 个提交 / ${result.docCount} 个文档 / ${result.sessionCount || 0} 个会话`
                        : `${result.date} 已有归档，未覆盖。可在时间页对该天「重新生成」。`,
                    )
                    if (state.log.date === today()) state.log.loaded = false
                  }),
              },
              state.busy === 'archive-today' ? '生成中…' : '生成今日日志',
            ),
          ),
        ),
    h(
      'div',
      { className: 'wl-section-title' },
      '今日待办 ',
      h('span', { className: 'wl-hint' }, dueTodos.length + ' 件未完成' + (overdueCount ? '（含逾期 ' + overdueCount + '）' : '')),
    ),
    h(
      'div',
      { className: 'wl-card' },
      dueTodos.length
        ? dueTodos.map((todo) => todoItem(todo, todayText))
        : h('div', { className: 'wl-empty' }, '暂无今日到期待办 ✓'),
      h('div', { className: 'wl-todo-form', style: { marginTop: '8px' } }, todoAddForm('today-todo', todayText)),
      h(
        'div',
        { style: { marginTop: '8px' } },
        h('button', { className: 'wl-click', style: { color: 'var(--wl-accent-text)' }, onClick: gotoWorkbench }, '管理全部待办 →'),
      ),
    ),
    recoCard(),
    h(
      'div',
      { className: 'wl-section-title' },
      '今天的 AI 会话 ',
      h('span', { className: 'wl-hint' }, (status.sessions?.items?.length || 0) + ' 场'),
    ),
    status.sessions?.items?.length
      ? h(
          'div',
          { className: 'wl-card' },
          status.sessions.items.map((session, index) =>
            h(
              'div',
              { className: 'wl-item', key: index },
              h(
                'button',
                {
                  className: 'wl-click grow',
                  title: '在资料库中按今天筛选',
                  onClick: () => openLibrarySessions(todayText),
                },
                h('div', { className: 'wl-item-title' }, session.title),
                h(
                  'div',
                  { className: 'wl-item-meta' },
                  h('span', { className: 'wl-tag low' }, session.source),
                  h('span', null, `${session.turns} 轮`),
                  h('span', null, session.start === session.end ? session.start : `${session.start}–${session.end}`),
                ),
              ),
            ),
          ),
        )
      : h(
          'div',
          { className: 'wl-empty' },
          todayInfo.archived ? '今天的归档里没有 AI 会话记录。' : '生成今日日志时会自动汇总本机 AI 会话。',
        ),
    h(
      'div',
      { className: 'wl-section-title' },
      '昨天回顾 ',
      h('span', { className: 'wl-hint' }, state.yesterday.date || ''),
    ),
    h(
      'div',
      { className: 'wl-card' },
      !state.yesterday.loaded
        ? h('div', { className: 'wl-empty' }, '加载中…')
        : state.yesterday.text
          ? [
              h('div', { className: 'wl-pre', style: { maxHeight: '180px' } }, state.yesterday.text.split(/\r?\n/).slice(0, 10).join('\n')),
              h('button', { className: 'wl-btn', onClick: () => openDay(state.yesterday.date) }, '打开昨天的日志'),
            ]
          : h('div', { className: 'wl-empty' }, '暂无昨日日志。'),
    ),
  )
}

// Library · logs view: archive search with inline full-text preview
// (no page jumps, no popup reading — UX v3 rule, see docs/ux-v3-design.md §4.3).
function logsView() {
  return h(
    'div',
    { className: 'wl-stack' },
    h(
      'div',
      { className: 'wl-card' },
      h(
        'div',
        { className: 'wl-row' },
        h('input', {
          className: 'wl-input',
          id: 'wl-query',
          placeholder: '搜索归档日志，例如 巡检 / 数据采集',
          onKeydown: (event) => {
            if (event.key === 'Enter') runSearch()
          },
        }),
        h('button', { className: 'wl-btn primary', onClick: runSearch }, '搜索'),
      ),
      h(
        'div',
        { className: 'wl-row', style: { marginTop: '8px' } },
        h('input', {
          className: 'wl-input',
          type: 'date',
          id: 'wl-log-start',
          value: state.logRange.start,
          title: '只搜该日期（含）之后',
          style: { width: '132px' },
          onInput: (event) => {
            state.logRange.start = event.target.value
          },
        }),
        h('span', { className: 'wl-hint' }, '至'),
        h('input', {
          className: 'wl-input',
          type: 'date',
          id: 'wl-log-end',
          value: state.logRange.end,
          title: '只搜该日期（含）之前',
          style: { width: '132px' },
          onInput: (event) => {
            state.logRange.end = event.target.value
          },
        }),
        h('span', { className: 'wl-hint' }, '可选：限定日期范围'),
      ),
    ),
    state.hits.length
      ? h(
          'div',
          { className: 'wl-card' },
          state.hits.slice(0, 60).map((hit) =>
            h(
              'div',
              { key: hit.date },
              h(
                'div',
                { className: 'wl-row' },
                h(
                  'button',
                  {
                    className: 'wl-click grow',
                    title: '点击展开/收起全文预览',
                    onClick: () => {
                      state.logExpand = state.logExpand === hit.date ? '' : hit.date
                      render()
                    },
                  },
                  h('div', { className: 'wl-item-title' }, `${hit.date}（${hit.count} 处）`),
                  h('div', { className: 'wl-item-meta' }, hit.snippet),
                ),
              ),
              state.logExpand === hit.date ? logExpandNode(hit.date) : null,
            ),
          ),
        )
      : null,
  )
}

// Inline day-text loader for the logs view. Guard 'loaded for this date' and
// 'in flight'; failures cache an empty sentinel so retries stay user-driven.
function logExpandNode(date) {
  const cached = state.logExpandData
  if (!cached || cached.date !== date) {
    if (!state.logExpandLoading) {
      state.logExpandLoading = true
      call('day', { date })
        .then((data) => {
          state.logExpandData = { date, text: data?.text || '' }
        })
        .catch((error) => {
          state.logExpandData = { date, text: '' }
          setNotice('err', '日志预览加载失败：' + String(error?.message || error))
        })
        .finally(() => {
          state.logExpandLoading = false
          render()
        })
    }
    return h('div', { className: 'wl-hint', style: { padding: '4px 6px 8px 10px' } }, '加载中…')
  }
  return h('div', { className: 'wl-pre', style: { maxHeight: '320px', margin: '4px 6px 8px 10px' } }, cached.text || '（内容为空）')
}
function runSearch() {
  const input = document.getElementById('wl-query')
  const query = input?.value?.trim() || ''
  if (!query) return
  act(
    'search',
    async () => {
      state.hits = await call('search', {
        query,
        start: state.logRange.start || undefined,
        end: state.logRange.end || undefined,
      })
      if (!state.hits.length) setNotice('info', '暂无匹配的归档日志。')
    },
    { refresh: false },
  )
}

const PRI_RANK = { 高: 0, 中: 1, 低: 2 }
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

// Mirror of compareTodos in lib/store.mjs (the panel cannot import node
// modules); test/todo-v2.test.mjs pins both to the same fixtures — keep in sync.
function compareTodos(a, b, todayText) {
  const aDone = a.status === 'done'
  const bDone = b.status === 'done'
  if (aDone !== bDone) return aDone ? 1 : -1
  if (aDone) return String(b.done_at || '').localeCompare(String(a.done_at || ''))
  const aOver = a.due && a.due < todayText ? 1 : 0
  const bOver = b.due && b.due < todayText ? 1 : 0
  if (aOver !== bOver) return bOver - aOver
  const aRank = aOver ? -1 : PRI_RANK[a.pri] ?? 3
  const bRank = bOver ? -1 : PRI_RANK[b.pri] ?? 3
  if (aRank !== bRank) return aRank - bRank
  if (a.due !== b.due) {
    if (!a.due) return 1
    if (!b.due) return -1
    return a.due.localeCompare(b.due)
  }
  return String(b.created || '').localeCompare(String(a.created || ''))
}

function repeatLabel(repeat) {
  const text = String(repeat || '')
  const weekly = text.match(/^weekly:([0-6])$/)
  if (weekly) {
    const weekday = WEEKDAY_LABELS[Number(weekly[1])]
    return '每周' + weekday
  }
  const monthly = text.match(/^monthly:(\d{1,2})$/)
  if (monthly) {
    const day = monthly[1]
    return '每月' + day + '号'
  }
  return text === 'daily' ? '每天' : text
}

function filterSortTodos(list, todayText) {
  const { pri, tag } = state.todoFilter
  let items = list
  if (pri) items = items.filter((todo) => todo.pri === pri)
  if (tag) items = items.filter((todo) => (todo.tags || []).includes(tag))
  return [...items].sort((a, b) => compareTodos(a, b, todayText))
}

function filterChip(value, current, onPick, label) {
  return h(
    'button',
    {
      className: `wl-chip${current === value ? ' on' : ''}`,
      onClick: () => {
        onPick(current === value ? '' : value)
        render()
      },
    },
    label,
  )
}

function aiReady() {
  return Boolean(state.config?.ai?.baseUrl && state.config?.ai?.model)
}

async function aiFillForm() {
  const titleInput = document.getElementById('wl-todo-title')
  const raw = String(titleInput?.value || '').trim()
  if (!raw) {
    setNotice('err', '先在标题框写一句话待办，再点 AI 填单')
    render()
    return
  }
  await act('todo-parse', async () => {
    const result = await call('todos', { action: 'parse', text: raw, mode: 'one' })
    const draft = result?.drafts?.[0]
    if (!draft) throw new Error('AI 没有解析出待办')
    state.aiDraft = draft
    state.todoBatch = { open: false, drafts: null, checked: [] }
    setNotice('ok', 'AI 已填单（' + draft.title + '），确认后点「添加」')
  })
}

async function runBatchParse() {
  const textarea = document.getElementById('wl-todo-batch-text')
  const text = String(textarea?.value || '').trim()
  if (!text) {
    setNotice('err', '先粘贴要解析的文字')
    render()
    return
  }
  await act('todo-parse', async () => {
    const result = await call('todos', { action: 'parse', text, mode: 'batch' })
    state.todoBatch.drafts = result.drafts || []
    state.todoBatch.checked = []
    setNotice('ok', '解析出 ' + state.todoBatch.drafts.length + ' 条待办草稿')
  })
}

async function addBatchDrafts() {
  const batch = state.todoBatch
  const selected = (batch.drafts || [])
    .map((draft, index) => (batch.checked[index] !== false ? draft : null))
    .filter(Boolean)
  if (!selected.length) {
    setNotice('err', '没有勾选任何草稿')
    render()
    return
  }
  await act('todo-batch-add', async () => {
    let added = 0
    for (const draft of selected) {
      await call('todos', {
        action: 'add',
        title: draft.title,
        pri: draft.pri,
        due: draft.due,
        repeat: draft.repeat,
        tags: draft.tags,
      })
      added += 1
    }
    state.todoBatch = { open: false, drafts: null, checked: [] }
    setNotice('ok', '已添加 ' + added + ' 条待办')
  })
}

function todoBatchBlock() {
  const batch = state.todoBatch
  const drafts = batch.drafts || []
  const selectedCount = drafts.filter((draft, index) => batch.checked[index] !== false).length
  return h(
    'div',
    { className: 'wl-section', style: { marginTop: '8px' } },
    h(
      'div',
      { className: 'wl-row' },
      h(
        'button',
        {
          className: 'wl-btn tiny',
          onClick: () => {
            batch.open = !batch.open
            render()
          },
        },
        batch.open ? '收起批量解析' : 'AI 批量解析',
      ),
      batch.open && !drafts.length
        ? h('span', { className: 'wl-hint' }, '粘贴会议记录/便签，拆成多条待办，勾选后入库')
        : null,
    ),
    batch.open
      ? [
          h('textarea', {
            className: 'wl-input',
            id: 'wl-todo-batch-text',
            rows: 3,
            placeholder: '粘贴一段文字，例如会议结论：张三周五前出报告 !高；我每周一整理周报',
          }),
          h(
            'div',
            { className: 'wl-row', style: { marginTop: '4px' } },
            h(
              'button',
              { className: 'wl-btn', disabled: state.busy === 'todo-parse', onClick: runBatchParse },
              '解析',
            ),
            drafts.length
              ? h('span', { className: 'wl-hint' }, '解析出 ' + drafts.length + ' 条，勾选后添加')
              : null,
          ),
          drafts.length
            ? h(
                'div',
                { className: 'wl-list', style: { marginTop: '4px' } },
                drafts.map((draft, index) =>
                  h(
                    'div',
                    { className: 'wl-item', key: 'bd' + index },
                    h('input', {
                      className: 'wl-check',
                      type: 'checkbox',
                      checked: batch.checked[index] !== false,
                      onChange: () => {
                        batch.checked[index] = batch.checked[index] === false
                        render()
                      },
                    }),
                    h(
                      'div',
                      { className: 'grow' },
                      h('div', { className: 'wl-item-title' }, draft.title),
                      h(
                        'div',
                        { className: 'wl-item-meta' },
                        priorityTag(draft.pri),
                        draft.due ? h('span', null, '到期 ' + draft.due) : null,
                        draft.repeat ? h('span', null, repeatLabel(draft.repeat)) : null,
                        (draft.tags || []).map((tag) => h('span', { className: 'wl-tag' }, '#' + tag)),
                      ),
                    ),
                  ),
                ),
              )
            : null,
          drafts.length && selectedCount
            ? h(
                'div',
                { className: 'wl-row', style: { marginTop: '4px' } },
                h(
                  'button',
                  {
                    className: 'wl-btn primary',
                    disabled: state.busy === 'todo-batch-add',
                    onClick: addBatchDrafts,
                  },
                  '添加选中的 ' + selectedCount + ' 条',
                ),
              )
            : null,
        ]
      : null,
  )
}

async function refreshSuggest() {
  await act('todo-suggest', async () => {
    const result = await call('todos', { action: 'suggest' })
    state.todoSuggest = result
    if (!result?.picks?.length) setNotice('ok', result?.note || 'AI 没有给出建议')
  })
}

function suggestCard(openCount) {
  const picks = state.todoSuggest?.picks || []
  // Only offer AI picks when there is something to pick from (or when picks
  // are already shown) — an empty workbench should not advertise it.
  if (!picks.length && !openCount) return null
  return h(
    'div',
    { className: 'wl-strip' },
    picks.length
      ? [
          h(
            'div',
            { className: 'wl-row' },
            h('div', { className: 'wl-strip-title grow' }, '今日 3 件要事'),
            h(
              'button',
              {
                className: 'wl-btn tiny',
                disabled: state.busy === 'todo-suggest',
                onClick: refreshSuggest,
              },
              '换一批',
            ),
            h(
              'button',
              {
                className: 'wl-btn tiny',
                onClick: () => {
                  state.todoSuggest = null
                  render()
                },
              },
              '收起',
            ),
          ),
          h(
            'div',
            { className: 'wl-list', style: { marginTop: '4px' } },
            picks.map((pick) =>
              h(
                'div',
                { className: 'wl-item', key: pick.id },
                h(
                  'div',
                  { className: 'grow' },
                  h('div', { className: 'wl-item-title' }, '⭐ ' + pick.title),
                  h(
                    'div',
                    { className: 'wl-item-meta' },
                    priorityTag(pick.pri),
                    pick.due ? h('span', null, '到期 ' + pick.due) : null,
                    pick.carries ? h('span', { className: 'wl-carry' }, '顺延 ' + pick.carries) : null,
                    h('span', null, pick.reason),
                  ),
                ),
              ),
            ),
          ),
        ]
      : h(
          'div',
          { className: 'wl-row' },
          h(
            'div',
            { className: 'grow' },
            h('div', { className: 'wl-strip-title' }, '今日 3 件要事'),
            h('div', { className: 'wl-hint' }, '让 AI 从进行中的待办里挑出今天的重点。'),
          ),
          h(
            'button',
            {
              className: 'wl-btn',
              disabled: state.busy === 'todo-suggest',
              onClick: refreshSuggest,
            },
            '生成建议',
          ),
        ),
  )
}

function todosWorkbench() {
  const todayText = today()
  const stats = state.status?.todos?.stats || null
  const open = filterSortTodos(
    state.todos.filter((item) => item.status !== 'done'),
    todayText,
  )
  const done = filterSortTodos(
    state.todos.filter((item) => item.status === 'done'),
    todayText,
  ).sort((a, b) => String(b.done_at || '').localeCompare(String(a.done_at || '')))
  const allTags = [...new Set(state.todos.flatMap((todo) => todo.tags || []))].sort()

  return h(
    'div',
    { className: 'wl-stack' },
    suggestCard(),
    h(
      'div',
      { className: 'wl-card wide' },
      h('div', { className: 'wl-todo-form' }, todoAddForm('todo', todayText, { withAi: true })),
      h(
        'div',
        { className: 'wl-row', style: { marginTop: '8px' } },
        state.aiDraft
          ? h('span', { className: 'wl-hint' }, 'AI 填单草稿，确认无误后点「添加」，或直接修改')
          : h('span', { className: 'wl-hint' }, '日期默认今天；优先级/标签可选'),
        h(
          'button',
          {
            className: 'wl-btn',
            disabled: state.busy === 'todo-clear',
            onClick: () => {
              state.confirm = {
                title: '清空全部已完成待办？',
                body: '将删除全部「已完成」状态的待办，删除后不可恢复。',
                okLabel: '清空',
                run: () =>
                  act('todo-clear', async () => {
                    const result = await call('todos', { action: 'clear_done' })
                    setNotice('ok', `已清空 ${result.removed} 条已完成待办`)
                  }),
              }
              render()
            },
          },
          '清空已完成',
        ),
      ),
    ),
    h(
      'div',
      { className: 'wl-row', style: { marginTop: '8px' } },
      h('span', { className: 'wl-hint' }, '筛选'),
      filterChip('高', state.todoFilter.pri, (value) => (state.todoFilter.pri = value), '高'),
      filterChip('中', state.todoFilter.pri, (value) => (state.todoFilter.pri = value), '中'),
      filterChip('低', state.todoFilter.pri, (value) => (state.todoFilter.pri = value), '低'),
      ...allTags.map((item) =>
        filterChip(item, state.todoFilter.tag, (value) => (state.todoFilter.tag = value), `#${item}`),
      ),
    ),
    aiReady() ? todoBatchBlock() : null,
    h(
      'div',
      { className: 'wl-hint', style: { marginTop: '4px' } },
      '进行中 ' +
        (stats?.open ?? open.length) +
        ' · 逾期 ' +
        (stats?.overdue || 0) +
        ' · 今日完成 ' +
        (stats?.doneToday || 0) +
        ' · 本周完成 ' +
        (stats?.doneWeek || 0),
    ),
    h('div', { className: 'wl-label' }, '进行中'),
    open.length
      ? h(
          'div',
          { className: 'wl-list' },
          open.map((todo) => (state.editingTodo === todo.id ? todoEditForm(todo) : todoItem(todo, todayText))),
        )
      : h('div', { className: 'wl-empty' }, '没有进行中的待办。'),
    done.length
      ? h(
          'div',
          { className: 'wl-section' },
          h('div', { className: 'wl-section-title' }, '已完成'),
          h(
            'div',
            { className: 'wl-list' },
            done.slice(0, 40).map((todo) => todoItem(todo, todayText)),
          ),
        )
      : null,
  )
}

function todoItem(todo, todayText) {
  const isDone = todo.status === 'done'
  const overdue = !isDone && todo.due && todo.due < todayText
  const subTotal = (todo.subtasks || []).length
  const subDone = (todo.subtasks || []).filter((sub) => sub.done).length
  const carryNode =
    !isDone && todo.carries
      ? h('span', { className: todo.carries >= 2 ? 'wl-carry hot' : 'wl-carry' }, '顺延 ' + todo.carries)
      : null
  return h(
    'div',
    { className: `wl-item${isDone ? ' done' : ''}${overdue ? ' overdue' : ''}`, key: todo.id },
    h('input', {
      className: 'wl-check',
      type: 'checkbox',
      checked: isDone,
      title: isDone ? '重新打开' : '完成',
      'aria-label': (isDone ? '重新打开「' : '完成「') + todo.title + '」',
      onChange: () =>
        act(isDone ? 'todo-reopen' : 'todo-done', async () => {
          await call('todos', { action: isDone ? 'reopen' : 'complete', id: todo.id })
        }),
    }),
    h(
      'div',
      { className: 'grow' },
      h('div', { className: 'wl-item-title' }, todo.title),
      h(
        'div',
        { className: 'wl-item-meta' },
        priorityTag(todo.pri),
        todo.due ? h('span', null, `${overdue ? '已逾期 ' : '到期 '}${todo.due}`) : null,
        todo.repeat ? h('span', null, repeatLabel(todo.repeat)) : null,
        carryNode,
        (todo.tags || []).map((tag) => h('span', { className: 'wl-tag' }, '#' + tag)),
        subTotal ? h('span', null, '子任务 ' + subDone + '/' + subTotal) : null,
        isDone && todo.done_at ? h('span', null, `完成于 ${String(todo.done_at).slice(0, 10)}`) : null,
      ),
    ),
    !isDone
      ? h(
          'button',
          {
            className: 'wl-btn tiny',
            onClick: () => startTodoEdit(todo),
          },
          '编辑',
        )
      : null,
    h(
      'button',
      {
        className: 'wl-btn danger tiny',
        onClick: () => {
          state.confirm = {
            title: '删除待办？',
            body: '将删除「' + todo.title + '」，删除后不可恢复。',
            okLabel: '删除',
            run: () =>
              act('todo-del', async () => {
                await call('todos', { action: 'delete', id: todo.id })
                setNotice('ok', '已删除待办')
              }),
          }
          render()
        },
      },
      '删除',
    ),
  )
}

function startTodoEdit(todo) {
  const current = String(todo.repeat || '')
  const weekly = current.match(/^weekly:([0-6])$/)
  const monthly = current.match(/^monthly:(\d{1,2})$/)
  state.editingTodo = todo.id
  state.editingDraft = {
    title: todo.title,
    pri: todo.pri || '',
    due: todo.due || '',
    repeatType: current === 'daily' ? 'daily' : weekly ? 'weekly' : monthly ? 'monthly' : '',
    weekday: weekly ? Number(weekly[1]) : 1,
    monthday: monthly ? Number(monthly[1]) : 1,
    md: todo.md || '',
    tags: (todo.tags || []).join(' '),
    subtasks: (todo.subtasks || []).map((sub) => ({ ...sub })),
  }
  render()
}

function todoEditForm(todo) {
  const draft = state.editingDraft
  if (!draft) return todoItem(todo, today())
  const harvest = () => {
    draft.title = document.getElementById('wl-edit-title')?.value ?? draft.title
    draft.pri = document.getElementById('wl-edit-pri')?.value ?? draft.pri
    draft.due = document.getElementById('wl-edit-due')?.value ?? draft.due
    draft.repeatType = document.getElementById('wl-edit-repeat')?.value ?? draft.repeatType
    draft.weekday = document.getElementById('wl-edit-weekday')?.value ?? draft.weekday
    draft.monthday = document.getElementById('wl-edit-monthday')?.value ?? draft.monthday
    draft.md = document.getElementById('wl-edit-md')?.value ?? draft.md
    draft.tags = document.getElementById('wl-edit-tags')?.value ?? draft.tags
  }
  const save = () => {
    harvest()
    const title = String(draft.title || '').trim()
    if (!title) {
      setNotice('err', '标题不能为空')
      render()
      return
    }
    let repeat = ''
    if (draft.repeatType === 'daily') repeat = 'daily'
    else if (draft.repeatType === 'weekly') repeat = 'weekly:' + (Number(draft.weekday) || 0)
    else if (draft.repeatType === 'monthly') {
      repeat = 'monthly:' + Math.min(28, Math.max(1, Number(draft.monthday) || 1))
    }
    const tags = [...new Set(
      String(draft.tags || '')
        .split(/[\s,，、]+/)
        .map((item) => item.trim().replace(/^#/, ''))
        .filter(Boolean),
    )]
    const patch = {
      id: todo.id,
      title,
      pri: draft.pri || '',
      due: draft.due || '',
      repeat,
      md: draft.md || '',
      tags,
      subtasks: draft.subtasks,
    }
    act('todo-edit', async () => {
      await call('todos', { action: 'update', ...patch })
      state.editingTodo = null
      state.editingDraft = null
      setNotice('ok', '已保存：' + title)
    })
  }
  const addSubtask = () => {
    harvest()
    const input = document.getElementById('wl-edit-sub-new')
    const title = String(input?.value || '').trim()
    if (!title) return
    draft.subtasks.push({ id: 'sub-' + Date.now(), title, done: false })
    render()
  }
  return h(
    'div',
    { className: 'wl-item editing', key: todo.id },
    h(
      'div',
      { className: 'grow' },
      h('input', { className: 'wl-input', id: 'wl-edit-title', value: draft.title }),
      h(
        'div',
        { className: 'wl-row', style: { marginTop: '8px' } },
        h(
          'select',
          {
            className: 'wl-select',
            id: 'wl-edit-pri',
            style: { width: '86px' },
            onChange: harvest,
          },
          h('option', { value: '', selected: !draft.pri }, '优先级'),
          h('option', { value: '高', selected: draft.pri === '高' }, '高'),
          h('option', { value: '中', selected: draft.pri === '中' }, '中'),
          h('option', { value: '低', selected: draft.pri === '低' }, '低'),
        ),
        h('input', {
          className: 'wl-input',
          id: 'wl-edit-due',
          type: 'date',
          value: draft.due || '',
          style: { width: '136px' },
          onChange: harvest,
        }),
        h(
          'select',
          {
            className: 'wl-select',
            id: 'wl-edit-repeat',
            style: { width: '92px' },
            onChange: () => {
              harvest()
              render()
            },
          },
          h('option', { value: '', selected: !draft.repeatType }, '不重复'),
          h('option', { value: 'daily', selected: draft.repeatType === 'daily' }, '每天'),
          h('option', { value: 'weekly', selected: draft.repeatType === 'weekly' }, '每周…'),
          h('option', { value: 'monthly', selected: draft.repeatType === 'monthly' }, '每月…'),
        ),
        draft.repeatType === 'weekly'
          ? h(
              'select',
              {
                className: 'wl-select',
                id: 'wl-edit-weekday',
                style: { width: '92px' },
                onChange: harvest,
              },
              ...WEEKDAY_LABELS.map((label, index) =>
                h('option', { value: index, selected: Number(draft.weekday) === index }, '周' + label),
              ),
            )
          : null,
        draft.repeatType === 'monthly'
          ? h('input', {
              className: 'wl-input',
              id: 'wl-edit-monthday',
              type: 'number',
              min: 1,
              max: 28,
              value: draft.monthday,
              style: { width: '64px' },
              onChange: harvest,
            })
          : null,
      ),
      h('textarea', {
        className: 'wl-input',
        id: 'wl-edit-md',
        rows: 2,
        placeholder: '备注（详情、链接、上下文）',
        style: { marginTop: '8px' },
        onInput: harvest,
      }, draft.md || ''),
      h('input', {
        className: 'wl-input',
        id: 'wl-edit-tags',
        placeholder: '标签，空格分隔，如：周报 okr',
        style: { marginTop: '8px' },
        onInput: harvest,
      }, draft.tags || ''),
      h(
        'div',
        { className: 'wl-section', style: { marginTop: '8px' } },
        h('div', { className: 'wl-section-title' }, '子任务 ' + draft.subtasks.filter((sub) => sub.done).length + '/' + draft.subtasks.length),
        draft.subtasks.map((sub, index) =>
          h(
            'div',
            { className: 'wl-row', key: sub.id, style: { marginTop: '2px' } },
            h('input', {
              className: 'wl-check',
              type: 'checkbox',
              checked: Boolean(sub.done),
              onChange: () => {
                harvest()
                draft.subtasks[index].done = !draft.subtasks[index].done
                render()
              },
            }),
            h('span', { className: 'grow' + (sub.done ? ' wl-sub-done' : '') }, sub.title),
            h(
              'button',
              {
                className: 'wl-btn danger tiny',
                onClick: () => {
                  harvest()
                  draft.subtasks.splice(index, 1)
                  render()
                },
              },
              '删除',
            ),
          ),
        ),
        h(
          'div',
          { className: 'wl-row', style: { marginTop: '4px' } },
          h('input', {
            className: 'wl-input',
            id: 'wl-edit-sub-new',
            placeholder: '新子任务，回车添加',
            style: { flex: '1' },
            onKeydown: (event) => {
              if (event.key === 'Enter') addSubtask()
            },
          }),
          h('button', { className: 'wl-btn tiny', onClick: addSubtask }, '添加子任务'),
        ),
      ),
      h(
        'div',
        { className: 'wl-row', style: { marginTop: '8px' } },
        h(
          'button',
          { className: 'wl-btn primary', disabled: state.busy === 'todo-edit', onClick: save },
          '保存',
        ),
        h(
          'button',
          {
            className: 'wl-btn',
            onClick: () => {
              state.editingTodo = null
              state.editingDraft = null
              render()
            },
          },
          '取消',
        ),
      ),
    ),
  )
}

function subCountNode(todo) {
  const subTotal = (todo.subtasks || []).length
  if (!subTotal) return null
  const subDone = (todo.subtasks || []).filter((sub) => sub.done).length
  return h('span', null, '子任务 ' + subDone + '/' + subTotal)
}

// Shared one-line todo parser: !高 #标签 @2026-10-31 repeat=daily.
// Form-style todo creation (UX v3.1): the old `#标签 @日期` command-line input
// is gone. One component, two mounts — the today tab (compact) and the
// time-tab workbench (same fields + AI 填单). Fields go straight into the
// todos add op; no inline syntax is required anywhere.
function todoAddForm(prefix, dueDefault, { withAi = false } = {}) {
  const draft = withAi ? state.aiDraft : null
  const id = (suffix) => 'wl-' + prefix + '-' + suffix
  return [
    h(
      'div',
      { className: 'wl-row' },
      h('input', {
        className: 'wl-input',
        id: id('title'),
        value: draft?.title || '',
        placeholder: '待办标题（必填）',
        onKeydown: (event) => {
          if (event.key === 'Enter') submitTodoForm(prefix, dueDefault)
        },
      }),
    ),
    h(
      'div',
      { className: 'wl-row', style: { marginTop: '8px' } },
      h('input', {
        className: 'wl-input',
        id: id('due'),
        type: 'date',
        value: draft?.due || dueDefault || '',
        style: { width: '136px' },
      }),
      h(
        'select',
        { className: 'wl-select', id: id('pri'), style: { width: '86px' } },
        h('option', { value: '', selected: !draft?.pri }, '优先级'),
        h('option', { value: '高', selected: draft?.pri === '高' }, '高'),
        h('option', { value: '中', selected: draft?.pri === '中' }, '中'),
        h('option', { value: '低', selected: draft?.pri === '低' }, '低'),
      ),
      h('input', {
        className: 'wl-input',
        id: id('tag'),
        value: (draft?.tags || [])[0] || '',
        placeholder: '标签（可选）',
        style: { width: '104px' },
      }),
      h('button', {
        className: 'wl-btn primary',
        disabled: state.busy === 'todo-add',
        onClick: () => submitTodoForm(prefix, dueDefault),
      }, '添加'),
      withAi && aiReady()
        ? h('button', { className: 'wl-btn', disabled: state.busy === 'todo-parse', onClick: aiFillForm }, 'AI 填单')
        : null,
    ),
  ]
}

function submitTodoForm(prefix, dueDefault) {
  const field = (suffix) => document.getElementById('wl-' + prefix + '-' + suffix)
  const title = String(field('title')?.value || '').trim()
  if (!title) {
    setNotice('err', '请先填写待办标题')
    render()
    return
  }
  const due = String(field('due')?.value || '').trim() || dueDefault || ''
  const pri = field('pri')?.value || ''
  const tag = String(field('tag')?.value || '').trim().replace(/^#/, '')
  // AI drafts may carry a repeat rule (no form field for it — keep the value).
  const repeat = state.aiDraft?.repeat || ''
  act('todo-add', async () => {
    await call('todos', { action: 'add', title, due, pri, repeat, tags: tag ? [tag] : [] })
    state.aiDraft = null
    const titleEl = field('title')
    const tagEl = field('tag')
    const priEl = field('pri')
    const dueEl = field('due')
    if (titleEl) titleEl.value = ''
    if (tagEl) tagEl.value = ''
    if (priEl) priEl.value = ''
    if (dueEl) dueEl.value = dueDefault || ''
    setNotice('ok', `已添加：${title}`)
  })
}
function reportRangePlaceholder(kind) {
  if (kind === 'weekly') return '周一日期（可填任意日期）'
  if (kind === 'project') return '项目名'
  if (kind === 'month' || kind === 'perf') return 'YYYY-MM'
  if (kind === 'quarter') return 'YYYY-Q1..Q4'
  return 'YYYY-MM-DD'
}

function reportRangeHint(kind) {
  if (kind === 'daily') return '以某天的日志为内容生成日报'
  if (kind === 'weekly') return '按所填日期所在周一的一周汇总'
  if (kind === 'month' || kind === 'perf' || kind === 'quarter') return '按月/季汇总归档与待办'
  if (kind === 'project') return '按项目名汇总全部相关归档'
  return '对区间内的日志做一份自由总结'
}

function selectReportKind(kind) {
  state.reportKind = kind
  state.reportPeriod =
    kind === 'month' || kind === 'perf'
      ? month()
      : kind === 'quarter'
        ? quarter()
        : kind === 'project'
          ? ''
          : today()
  render()
}

// One generate/regen code path; kind 'custom'/'summarize' walks the report
// op's summarize action with a start/end range. `key` carries the range of an
// existing report file when regenerating; undefined means "use the form".
async function runReportGenerate(kind, key) {
  let result
  const projectValue = key !== undefined ? key : state.reportPeriod
  if (kind === 'project' && !String(projectValue || '').trim()) {
    setNotice('err', '请先填写项目名，再生成项目档案。')
    render()
    return
  }
  if (kind === 'custom' || kind === 'summarize') {
    const [start, end] = key ? String(key).split('_') : [state.reportStart, state.reportEnd]
    result = await call('report', { action: 'summarize', start: start || daysAgo(6), end: end || today(), useAi: state.reportUseAi })
  } else {
    const body = { action: 'generate', kind, useAi: state.reportUseAi }
    if (kind === 'daily') body.date = key || state.reportPeriod || today()
    if (kind === 'weekly') body.monday = key || state.reportPeriod || today()
    if (kind === 'month' || kind === 'perf') body.month = key || state.reportPeriod || month()
    if (kind === 'quarter') body.quarter = key || state.reportPeriod || quarter()
    if (kind === 'project') body.project = key !== undefined ? key : state.reportPeriod
    result = await call('report', body)
  }
  state.reportText = result.text || ''
  state.reportFlash = result.name || ''
  setNotice('ok', `已生成 ${result.name}${result.ai ? '（AI 润色）' : ''}`)
  setTimeout(() => {
    if (state.reportFlash === result.name) {
      state.reportFlash = ''
      render()
    }
  }, 2500)
  return result
}

// Report tab: the generator sits flat on top (no fold — that was the v0.13
// "buried high-frequency action" problem), the generated list is grouped by
// kind below. Regenerating always asks before overwriting.
function reportTab() {
  const kind = state.reportKind
  const aiPolishReady = Boolean(state.config?.ai?.model && state.config?.ai?.hasApiKey)
  return h(
    'div',
    { className: 'wl-stack' },
    noticeNode(),
    h(
      'div',
      { className: 'wl-card' },
      h(
        'div',
        { className: 'wl-row' },
        REPORT_KINDS.map(([value, label]) =>
          h(
            'button',
            {
              className: `wl-chip${state.reportKind === value ? ' on' : ''}`,
              onClick: () => selectReportKind(value),
            },
            label,
          ),
        ),
      ),
      h(
        'div',
        { className: 'wl-row', style: { marginTop: '8px' } },
        h('span', { className: 'wl-hint', style: { width: '34px' } }, '范围'),
        kind === 'custom'
          ? [
              h('input', {
                className: 'wl-input',
                type: 'date',
                value: state.reportStart,
                style: { width: '140px' },
                onInput: (event) => {
                  state.reportStart = event.target.value
                },
              }),
              h('span', { className: 'wl-hint' }, '至'),
              h('input', {
                className: 'wl-input',
                type: 'date',
                value: state.reportEnd,
                style: { width: '140px' },
                onInput: (event) => {
                  state.reportEnd = event.target.value
                },
              }),
            ]
          : h('input', {
              className: 'wl-input',
              value: state.reportPeriod,
              placeholder: reportRangePlaceholder(kind),
              style: { maxWidth: '220px' },
              onInput: (event) => {
                state.reportPeriod = event.target.value
              },
            }),
        h(
          'label',
          { className: 'wl-checkline', style: { margin: '0 0 0 auto' } },
          h('input', {
            type: 'checkbox',
            checked: state.reportUseAi && aiPolishReady,
            disabled: !aiPolishReady,
            onChange: (event) => {
              state.reportUseAi = event.target.checked
              render()
            },
          }),
          'AI 润色',
        ),
      ),
      h(
        'div',
        { className: 'wl-hint', style: { marginTop: '4px' } },
        (aiPolishReady ? '' : '未配置 AI 接口，将生成确定性草稿；可到「设置 → AI 润色」配置。') + reportRangeHint(kind),
      ),
      h(
        'div',
        { className: 'wl-row', style: { marginTop: '8px' } },
        h(
          'button',
          {
            className: 'wl-btn primary',
            disabled: state.busy === 'report',
            onClick: () =>
              act('report', async () => {
                await runReportGenerate(kind)
              }),
          },
          state.busy === 'report' ? '生成中…' : '生成',
        ),
      ),
    ),
    state.reportText ? h('pre', { className: 'wl-pre' }, state.reportText) : null,
    h('div', { className: 'wl-section-title', style: { marginTop: '12px' } }, '已生成报告'),
    reportsListGrouped(),
  )
}

// Report list files are named "<kind>-<key>.md"; the kind drives grouping and
// the parameter shape a regeneration needs (same enum as generate).
function reportKindKey(name) {
  const match = String(name || '').match(/^([a-z]+)-(.+)\.md$/i)
  return match ? { kind: match[1], key: match[2] } : { kind: '', key: '' }
}

function reportsListGrouped() {
  if (!state.reports.length) return h('div', { className: 'wl-empty' }, '暂无报告，可在上方生成。')
  const groups = {}
  for (const report of state.reports.slice(0, 80)) {
    const { kind } = reportKindKey(report.name)
    const label = REPORT_KIND_LABELS[kind] || '其他'
    ;(groups[label] = groups[label] || []).push(report)
  }
  return Object.entries(groups).map(([label, list]) =>
    h(
      'div',
      { className: 'wl-section', key: label },
      h('div', { className: 'wl-section-title' }, label + '（' + list.length + '）'),
      h(
        'div',
        { className: 'wl-list' },
        list.map((report) => {
          const { kind, key } = reportKindKey(report.name)
          return h(
            'div',
            { className: `wl-item${state.reportFlash === report.name ? ' flash' : ''}`, key: report.name },
            h(
              'button',
              {
                className: 'wl-click grow',
                onClick: () =>
                  act(
                    'report-read',
                    async () => {
                      const data = await call('report', { action: 'read', name: report.name })
                      state.reportText = data.text || ''
                    },
                    { refresh: false },
                  ),
              },
              h('div', { className: 'wl-item-title' }, report.name),
              h('div', { className: 'wl-item-meta' }, String(report.mtime || '').replace('T', ' ').slice(0, 16)),
            ),
            h('button', { className: 'wl-btn tiny', onClick: () => confirmRegenerateReport(report.name, kind, key) }, '重新生成'),
            h('button', { className: 'wl-btn tiny', onClick: () => copyReport(report.name) }, '复制'),
          )
        }),
      ),
    ),
  )
}

function confirmRegenerateReport(name, kind, key) {
  state.confirm = {
    title: '重新生成 ' + (REPORT_KIND_LABELS[kind] || kind || '报告') + '？',
    body: '将覆盖 ' + name + ' 的现有内容；若该报告含手写修改，会被替换。',
    okLabel: '重新生成',
    run: () =>
      act('report-regen', async () => {
        await runReportGenerate(kind, key)
      }),
  }
  render()
}

async function copyReport(name) {
  try {
    const data = await call('report', { action: 'read', name })
    await navigator.clipboard?.writeText(data.text || '')
    setNotice('ok', '已复制 Markdown：' + name)
  } catch (error) {
    setNotice('err', '复制失败：' + String(error?.message || error))
  }
  render()
}
async function detectAi() {
  if (state.aiBusy) return
  state.aiBusy = true
  render()
  try {
    const data = await call('ai', { action: 'detect' })
    state.aiCandidates = Array.isArray(data?.candidates) ? data.candidates : []
    state.aiPick = ''
    if (!state.aiCandidates.length) setNotice('info', '暂无可复用的本机 AI 配置，可在下方手动填写。')
  } catch (error) {
    state.aiCandidates = []
    setNotice('err', `扫描本机 AI 配置失败：${String(error?.message || error)}`)
  } finally {
    state.aiBusy = false
    render()
  }
}

async function loadAiModels() {
  if (state.aiModelsBusy) return
  const draft = state.settings || draftFromConfig(state.config)
  if (!draft.aiBaseUrl) {
    state.aiModelsNote = '请先填写 Base URL'
    render()
    return
  }
  state.aiModelsBusy = true
  state.aiModelsNote = ''
  render()
  try {
    const data = await call('ai', {
      action: 'models',
      baseUrl: draft.aiBaseUrl,
      apiFormat: draft.aiFormat,
      apiKey: draft.aiKey || undefined,
    })
    state.aiModels = Array.isArray(data?.models) ? data.models : []
    let note = state.aiModels.length ? `已加载 ${state.aiModels.length} 个模型` : '接口没有返回模型列表'
    if (data?.source === 'local') {
      note += `；接口不支持 /models，已用本机配置里的模型${data.warning ? `（${String(data.warning).slice(0, 120)}）` : ''}`
    }
    state.aiModelsNote = note
  } catch (error) {
    state.aiModelsNote = `加载失败：${String(error?.message || error).slice(0, 160)}`
  } finally {
    state.aiModelsBusy = false
    render()
  }
}

function aiCandidateRow(candidates) {
  const current = candidates.find((candidate) => candidate.id === state.aiPick) || candidates[0]
  const pickCandidate = (id) => {
    state.aiPick = id
    const picked = candidates.find((candidate) => candidate.id === id)
    if (!picked) return
    // 联动：选中即把 Base URL / 接口格式 / 模型填进下方表单（不写入配置）。
    const draft = state.settings || draftFromConfig(state.config)
    state.settings = {
      ...draft,
      aiBaseUrl: picked.baseUrl,
      aiModel: picked.model || draft.aiModel,
      aiFormat: picked.apiFormat,
    }
    state.aiModels = Array.isArray(picked.models) ? picked.models : []
    state.aiModelsNote = state.aiModels.length ? `已带入 ${state.aiModels.length} 个模型` : ''
  }
  return h(
    'div',
    null,
    h(
      'div',
      { className: 'wl-date-row' },
      h(
        'select',
        {
          className: 'wl-select',
          id: 'wl-ai-pick',
          onChange: (event) => {
            pickCandidate(event.target.value)
            render()
          },
        },
        candidates.map((candidate, index) =>
          h(
            'option',
            { value: candidate.id, selected: candidate.id === current.id },
            `${candidate.sourceLabel} · ${candidate.name}（${candidate.models.length || 0} 模型${candidate.hasKey ? '' : '，无 Key'}）`,
          ),
        ),
      ),
      h(
        'button',
        {
          className: 'wl-btn primary',
          disabled: state.busy === 'ai-apply',
          onClick: () =>
            act(
              'ai-apply',
              async () => {
                const result = await call('ai', { action: 'apply', id: current.id })
                const base = state.settings || draftFromConfig(result.config)
                state.config = result.config
                state.settings = {
                  ...base,
                  aiBaseUrl: result.config.ai.baseUrl,
                  aiModel: result.config.ai.model,
                  aiFormat: result.config.ai.apiFormat,
                  aiKey: '',
                }
                state.aiPick = current.id
                state.aiModels = Array.isArray(result.applied?.models) ? result.applied.models : []
                state.aiModelsNote = state.aiModels.length ? `已载入 ${state.aiModels.length} 个模型` : ''
                setNotice('ok', `已复用 ${result.applied?.name || current.name} 的 AI 配置`)
              },
              { refresh: false },
            ),
        },
        state.busy === 'ai-apply' ? '应用中…' : '使用',
      ),
    ),
    current
      ? h(
          'div',
          { className: 'wl-hint' },
          `${current.baseUrl}${current.note ? ` · ${current.note}` : ''}`,
        )
      : h('div', { className: 'wl-hint' }, '选择后自动填到下方 Base URL / 接口格式 / 模型；点「使用」直接写入配置并带上 Key。'),
  )
}

async function saveSettings() {
  const draft = state.settings
  if (!draft) return
  await act('config-save', async () => {
    const patch = {
      dataDir: draft.dataDir,
      scanRoots: splitLines(draft.scanRoots),
      docRoots: splitLines(draft.docRoots),
      sessionRoots: splitLines(draft.sessionRoots),
      watchDirs: splitLines(draft.watchDirsText).map(function (line) { const seg = line.split('|'); const path = (seg[0] || '').trim(); const kind = ['local','cloud','git'].indexOf((seg[1] || '').trim()) >= 0 ? seg[1].trim() : 'local'; return { path: path, kind: kind } }).filter(function (item) { return item.path }),
      gitAuthor: draft.gitAuthor,
      sources: { git: draft.git, docs: draft.docs, sessions: draft.sessions },
      autoArchive: draft.autoArchive,
      skipWeekends: draft.skipWeekends,
      taskTime: draft.taskTime,
      ai: {
        baseUrl: draft.aiBaseUrl,
        model: draft.aiModel,
        apiFormat: draft.aiFormat,
        ...(draft.aiKey ? { apiKey: draft.aiKey } : {}),
      },
    }
    await call('config', { action: 'set', patch })
    state.settings = null
    setNotice('ok', '设置已保存')
  })
}

const SETTINGS_SUBS = [
  ['general', '通用'],
  ['ai', 'AI 接口'],
  ['collect', '采集与调度'],
  ['conn', '连接器'],
  ['tpl', '提示词模板'],
  ['backup', '备份与迁移'],
  ['diag', '诊断'],
]

// Settings tab: regular left-nav + right form pages, one thing per page
// (UX v3 §4.5 — replaces the old single page with four async folds inside).
function settingsTab() {
  if (!SETTINGS_SUBS.some(([key]) => key === state.sub)) state.sub = 'general'
  return h(
    'div',
    null,
    h(
      'div',
      { className: 'wl-subnav' },
      SETTINGS_SUBS.map(([key, label]) =>
        h(
          'button',
          {
            className: state.sub === key ? 'on' : '',
            onClick: () => {
              state.sub = key
              render()
            },
          },
          label,
        ),
      ),
    ),
    state.sub === 'general'
      ? settingsGeneralPage()
      : state.sub === 'ai'
        ? settingsAiPage()
        : state.sub === 'collect'
          ? settingsCollectPage()
          : state.sub === 'conn'
            ? settingsConnPage()
            : state.sub === 'tpl'
              ? settingsTplPage()
              : state.sub === 'backup'
                ? settingsBackupPage()
                : settingsDiagPage(),
  )
}

// Dirty check: the clean draft is reproducible from config, so comparing the
// live draft against a fresh draftFromConfig is the single source of truth —
// no mutation-point tracking can drift.
function settingsDirty() {
  if (!state.settings || !state.config) return false
  return JSON.stringify(state.settings) !== JSON.stringify(draftFromConfig(state.config))
}

// Bottom save bar for draft-bearing subpages (通用 / AI 接口 / 采集与调度).
// Keystrokes toggle it via DOM (no re-render, no focus loss); every render
// re-derives visibility from the computed dirty state.
function dirtyBarNode() {
  return h(
    'div',
    { className: 'wl-dirtybar', id: 'wl-dirty-bar', style: { display: settingsDirty() ? 'flex' : 'none' } },
    h('span', { className: 'wl-hint', style: { color: 'var(--wl-warn)', flex: '1' } }, '有未保存的修改'),
    h(
      'button',
      {
        className: 'wl-btn',
        onClick: () => {
          state.settings = draftFromConfig(state.config)
          setNotice('info', '已放弃未保存的修改')
          render()
        },
      },
      '放弃',
    ),
    h(
      'button',
      { className: 'wl-btn primary', disabled: state.busy === 'config-save', onClick: saveSettings },
      state.busy === 'config-save' ? '保存中…' : '保存修改',
    ),
  )
}

// Draft field mutator: writes into the draft and (without re-render) reveals
// the dirty bar so typing never loses focus.
function settingsSet(draft) {
  return (key) => (event) => {
    draft[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value
    const bar = document.getElementById('wl-dirty-bar')
    if (bar && settingsDirty()) bar.style.display = 'flex'
  }
}

// 通用：数据目录（只读）/ 扫描目录 / 监控目录 / git 作者 / 自动归档。
function settingsGeneralPage() {
  const draft = (state.settings = state.settings || draftFromConfig(state.config))
  const config = state.config || {}
  const set = settingsSet(draft)
  return h(
    'div',
    { className: 'wl-stack' },
    noticeNode(),
    h(
      'div',
      { className: 'wl-card' },
      h('div', { className: 'wl-label', style: { marginTop: '0' } }, '数据目录'),
      h('input', { className: 'wl-input', value: config.dataDir || '', disabled: true }),
      h('div', { className: 'wl-hint', style: { marginTop: '4px' } }, `配置文件：${config.configFile || ''}`),
      h('div', { className: 'wl-label' }, 'Git 扫描根目录（每行一个，最多向下 3 层）'),
      h('textarea', { className: 'wl-area small', value: draft.scanRoots, onInput: set('scanRoots') }),
      h('div', { className: 'wl-label' }, '文档扫描目录（每行一个，最多向下 6 层）'),
      h('textarea', { className: 'wl-area small', value: draft.docRoots, onInput: set('docRoots') }),
      h('div', { className: 'wl-label' }, '监控目录（每行一条：路径 或 路径|cloud 或 路径|git）'),
      h('textarea', { className: 'wl-area small', value: draft.watchDirsText, onInput: set('watchDirsText') }),
      h('div', { className: 'wl-label' }, 'Git 作者（留空 = 各仓库 git config user.name）'),
      h('input', { className: 'wl-input', value: draft.gitAuthor, onInput: set('gitAuthor') }),
    ),
    h(
      'div',
      { className: 'wl-card' },
      h('div', { className: 'wl-label', style: { marginTop: '0' } }, '自动归档'),
      h(
        'div',
        { className: 'wl-checkline' },
        h('input', { type: 'checkbox', checked: draft.autoArchive, onChange: set('autoArchive') }),
        '每天自动生成',
        h('input', { type: 'checkbox', checked: draft.skipWeekends, onChange: set('skipWeekends'), style: { marginLeft: '8px' } }),
        '跳过周末',
        h('input', {
          className: 'wl-input',
          type: 'time',
          value: draft.taskTime,
          onInput: set('taskTime'),
          style: { width: '96px', marginLeft: 'auto' },
        }),
      ),
      h('div', { className: 'wl-hint' }, '到点且 ZCode 在运行时自动生成当天日志；错过的下次启动补跑。'),
    ),
    dirtyBarNode(),
  )
}

// AI 接口：润色配置 + 本机候选 + 配置向导（向导并入此页，不再是独立折叠块）。
function settingsAiPage() {
  const draft = (state.settings = state.settings || draftFromConfig(state.config))
  const config = state.config || {}
  const set = settingsSet(draft)
  if (state.aiCandidates === null && !state.aiBusy) detectAi()
  if (!state.wizardTypes && !state.wizardTypesLoading) {
    state.wizardTypesLoading = true
    call('wizard', { action: 'types' })
      .then((result) => {
        state.wizardTypes = result?.types || []
      })
      .catch(() => {
        state.wizardTypes = []
      })
      .finally(() => {
        state.wizardTypesLoading = false
        render()
      })
  }
  const aiHint = config.ai?.model ? `${config.ai.model}${config.ai.hasApiKey ? ' · 已配置 Key' : ' · 无 Key'}` : '未配置'
  return h(
    'div',
    { className: 'wl-stack' },
    noticeNode(),
    h('div', { className: 'wl-hint', style: { marginBottom: '8px' } }, '当前：' + aiHint),
    h(
      'div',
      { className: 'wl-card' },
      h(
        'div',
        { className: 'wl-toolbar', style: { margin: '0 0 8px' } },
        h('button', { className: 'wl-btn', disabled: state.aiBusy, onClick: detectAi }, state.aiBusy ? '扫描中…' : '扫描本机 AI 工具'),
        h('span', { className: 'wl-hint' }, '只在本机读取 ZCode / DeepSeek Harness / Claude Code / Codex / Gemini / 环境变量'),
      ),
      state.aiCandidates === null
        ? h('div', { className: 'wl-hint' }, '加载中…')
        : state.aiCandidates.length
          ? aiCandidateRow(state.aiCandidates)
          : h('div', { className: 'wl-empty' }, '暂无可复用的本机 AI 配置，可在下方手动填写。'),
      h('div', { className: 'wl-label' }, '接口格式'),
      h(
        'select',
        { className: 'wl-select', onChange: set('aiFormat') },
        h('option', { value: 'openai', selected: draft.aiFormat !== 'anthropic' }, 'OpenAI 兼容（chat/completions）'),
        h('option', { value: 'anthropic', selected: draft.aiFormat === 'anthropic' }, 'Anthropic 兼容（v1/messages）'),
      ),
      h('div', { className: 'wl-label' }, 'Base URL'),
      h('input', {
        className: 'wl-input',
        value: draft.aiBaseUrl,
        placeholder: 'https://api.openai.com/v1',
        onInput: set('aiBaseUrl'),
      }),
      h('div', { className: 'wl-label' }, '模型'),
      h(
        'div',
        { className: 'wl-date-row' },
        state.aiModels.length
          ? h(
              'select',
              {
                className: 'wl-select',
                id: 'wl-ai-model-pick',
                onChange: (event) => {
                  const current = state.settings || draftFromConfig(state.config)
                  state.settings = { ...current, aiModel: event.target.value }
                  render()
                },
              },
              h('option', { value: '' }, `— 从 ${state.aiModels.length} 个模型中选择 —`),
              state.aiModels.map((model) => h('option', { value: model, selected: model === draft.aiModel }, model)),
              draft.aiModel && !state.aiModels.includes(draft.aiModel)
                ? h('option', { value: draft.aiModel, selected: true }, `${draft.aiModel}（当前填写）`)
                : null,
            )
          : h('input', {
              className: 'wl-input',
              value: draft.aiModel,
              placeholder: 'gpt-4o-mini，加载后可下拉选择',
              onInput: set('aiModel'),
            }),
        h('button', { className: 'wl-btn', disabled: state.aiModelsBusy, onClick: loadAiModels }, state.aiModelsBusy ? '加载中…' : '加载模型'),
      ),
      state.aiModels.length
        ? h('input', {
            className: 'wl-input',
            value: draft.aiModel,
            placeholder: '或手动填写模型名',
            onInput: set('aiModel'),
            style: { marginTop: '8px' },
          })
        : null,
      state.aiModelsNote ? h('div', { className: 'wl-hint', style: { marginTop: '4px' } }, state.aiModelsNote) : null,
      h('div', { className: 'wl-label' }, 'API Key'),
      h('input', {
        className: 'wl-input',
        type: 'password',
        value: draft.aiKey,
        placeholder: config.ai?.hasApiKey ? '已保存，留空保持不变' : 'sk-...',
        onInput: set('aiKey'),
      }),
      config.ai?.hasApiKey
        ? h(
            'div',
            { className: 'wl-toolbar' },
            h(
              'button',
              {
                className: 'wl-btn danger',
                disabled: state.busy === 'config-clear',
                onClick: () => {
                state.confirm = {
                  title: '清除 API Key？',
                  body: '将清除已保存的 Key，清除后需重新填写才能继续使用 AI 润色，确认？',
                  okLabel: '清除',
                  run: () =>
                    act('config-clear', async () => {
                      await call('config', { action: 'set', patch: { ai: { clearApiKey: true } } })
                      state.settings = null
                      setNotice('ok', '已清除 API Key')
                    }),
                }
                render()
              },
              },
              '清除 Key',
            ),
          )
        : null,
    ),
    wizardBlock(),
    dirtyBarNode(),
  )
}

// 诊断：来源健康 + 运行历史（原概览「最近运行」迁入）+ 调度执行历史
// + AI 用量 + 会话索引缓存（重扫 = 清空索引重新同步，op 枚举不变）。
function settingsDiagPage() {
  if (!state.schedData && !state.schedLoading) loadSched().then(render, () => render())
  loadSessIndex()
  const data = state.schedData
  const sources = data?.sources || []
  const history = data?.history || []
  const usage = state.status?.aiUsage
  return h(
    'div',
    { className: 'wl-stack' },
    noticeNode(),
    data?.error
      ? h(
          'div',
          { className: 'wl-card' },
          h('div', { className: 'wl-notice err', style: { marginBottom: '8px' } }, '诊断数据加载失败：' + data.error),
          h(
            'button',
            {
              className: 'wl-btn',
              disabled: state.schedLoading,
              onClick: () => {
                state.schedData = null
                loadSched().then(render, () => render())
              },
            },
            '重试',
          ),
        )
      : [
          h(
            'div',
            { className: 'wl-card' },
            h('div', { className: 'wl-section-title', style: { marginTop: '0' } }, '会话来源健康'),
            state.schedLoading && !data ? h('div', { className: 'wl-hint' }, '加载中…') : null,
            sources.map((source) =>
              h(
                'div',
                { className: 'wl-row', key: source.id + source.path },
                h('span', { className: 'wl-tag' }, source.label),
                h('span', { className: 'grow wl-hint', style: { wordBreak: 'break-all' } }, source.path),
                h('span', { className: source.exists ? 'wl-hint' : 'wl-carry' }, source.exists ? '✓' : '✗'),
              ),
            ),
            sources.some((source) => !source.exists)
              ? h('div', { className: 'wl-hint', style: { marginTop: '4px' } }, '✗ 的来源未安装或路径不对；可在「采集与调度」的额外会话目录里自行添加路径。')
              : null,
          ),
          h(
            'div',
            { className: 'wl-card' },
            h('div', { className: 'wl-section-title', style: { marginTop: '0' } }, '运行历史'),
            (state.status?.runHistory || []).length
              ? state.status.runHistory.slice(0, 8).map((item, index) =>
                  h(
                    'div',
                    { className: 'wl-row', key: index },
                    h('span', { className: 'wl-hint' }, String(item.date || '').slice(5)),
                    h('span', { className: 'wl-tag' }, item.mode || ''),
                    h('span', { className: item.status === 'ok' ? 'wl-hint grow' : 'wl-carry grow' }, (item.status || '') + (item.note ? ' · ' + item.note : '')),
                  ),
                )
              : h('div', { className: 'wl-hint' }, '暂无归档运行记录。'),
          ),
          history.length
            ? h(
                'div',
                { className: 'wl-card' },
                h('div', { className: 'wl-section-title', style: { marginTop: '0' } }, '调度执行历史'),
                history.slice(0, 8).map((item) =>
                  h(
                    'div',
                    { className: 'wl-row', key: item.at },
                    h('span', { className: 'wl-hint' }, String(item.at).slice(5, 16).replace('T', ' ')),
                    h('span', { className: 'grow wl-hint' }, item.title || item.id),
                    h(
                      'span',
                      { className: item.status === 'ok' ? 'wl-hint' : 'wl-carry' },
                      item.status +
                        (item.sessions !== undefined ? ' ' + item.sessions + ' 场' : '') +
                        (item.changed !== undefined ? ' 变化 ' + item.changed : ''),
                    ),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'wl-card' },
            h('div', { className: 'wl-section-title', style: { marginTop: '0' } }, 'AI 用量'),
            usage && usage.calls
              ? [
                  h('div', { className: 'wl-hint' }, `共 ${usage.calls} 次调用 · 输入 ${usage.in} · 输出 ${usage.out} · 合计 ${usage.total} tokens`),
                  (usage.byModel || []).map((row) =>
                    h(
                      'div',
                      { className: 'wl-row', key: row.model },
                      h('span', { className: 'wl-tag' }, row.model),
                      h('span', { className: 'grow wl-hint' }, `${row.calls} 次 · ${row.total} tokens`),
                    ),
                  ),
                ]
              : h('div', { className: 'wl-hint' }, '暂无 AI 调用记录。'),
          ),
          h(
            'div',
            { className: 'wl-card' },
            h('div', { className: 'wl-section-title', style: { marginTop: '0' } }, '会话索引缓存'),
            state.sessIndex?.total
              ? h('div', { className: 'wl-hint' }, `${state.sessIndex.total} 个会话 · 建于 ${String(state.sessIndex.builtAt).slice(5, 16).replace('T', ' ')}`)
              : h('div', { className: 'wl-hint' }, '暂无会话索引，点「强制重扫」建立。'),
            h(
              'div',
              { className: 'wl-row', style: { marginTop: '8px' } },
              h('button', { className: 'wl-btn', disabled: state.busy === 'sess-sync', onClick: () => syncAllSessions(true) }, '强制重扫（清空索引并重新同步）'),
            ),
          ),
        ],
  )
}

// 连接器子页：原折叠块 body 整体平移（新建/编辑/测试/同步/删除，删除需确认）。
function settingsConnPage() {
  return h('div', { className: 'wl-stack' }, noticeNode(), connBlock())
}

// 提示词模板子页：原折叠块 body 平移（5 场景编辑/恢复内置），失败可重试。
function settingsTplPage() {
  if (!state.tplList && !state.tplLoading) loadTpls().then(render, () => render())
  const list = state.tplList || []
  const draft = state.tplDraft
  const current = draft ? list.find((item) => item.scene === draft.scene) : null
  return h(
    'div',
    { className: 'wl-stack' },
    noticeNode(),
    h(
      'div',
      { className: 'wl-card' },
      state.tplError
        ? [
            h('div', { className: 'wl-notice err', style: { marginBottom: '8px' } }, '模板加载失败：' + state.tplError),
            h(
              'button',
              {
                className: 'wl-btn',
                disabled: state.tplLoading,
                onClick: () => {
                  state.tplList = null
                  state.tplError = ''
                  loadTpls().then(render, () => render())
                },
              },
              '重试',
            ),
          ]
        : !list.length
          ? h('div', { className: 'wl-hint' }, state.tplLoading ? '加载中…' : '暂无模板。')
          : [
              h(
                'div',
                { className: 'wl-row' },
                h(
                  'select',
                  {
                    className: 'wl-select',
                    style: { width: '150px' },
                    value: draft?.scene || '',
                    onChange: (event) => {
                      tplDraftFor(event.target.value)
                      render()
                    },
                  },
                  list.map((item) => h('option', { value: item.scene, selected: draft?.scene === item.scene }, item.name)),
                ),
                h('span', { className: 'wl-hint' }, current?.hint || ''),
                h('span', { className: `wl-tag ${current?.source === 'user' ? 'mid' : ''}` }, current?.source === 'user' ? '自定义' : '内置'),
              ),
              h('div', { className: 'wl-hint', style: { marginTop: '4px' } }, '变量：{{today}} {{rangeStart}} {{rangeEnd}} {{content}} {{todos}} {{question}} {{text}}，缺失安全置空'),
              draft
                ? h('input', {
                    className: 'wl-input',
                    value: draft.name,
                    placeholder: '模板名',
                    style: { marginTop: '8px' },
                    onInput: (event) => {
                      draft.name = event.target.value
                    },
                  })
                : null,
              draft
                ? h('textarea', {
                    className: 'wl-input',
                    rows: 5,
                    value: draft.system,
                    placeholder: 'SYSTEM 段（角色与硬性规则）',
                    style: { marginTop: '8px' },
                    onInput: (event) => {
                      draft.system = event.target.value
                    },
                  })
                : null,
              draft
                ? h('textarea', {
                    className: 'wl-input',
                    rows: 7,
                    value: draft.user,
                    placeholder: 'USER 段（内容与变量）',
                    style: { marginTop: '8px' },
                    onInput: (event) => {
                      draft.user = event.target.value
                    },
                  })
                : null,
              h(
                'div',
                { className: 'wl-row', style: { marginTop: '8px' } },
                h(
                  'button',
                  {
                    className: 'wl-btn primary',
                    disabled: state.busy === 'tpl-save',
                    onClick: () =>
                      act('tpl-save', async () => {
                        await call('templates', {
                          action: 'save',
                          scene: draft.scene,
                          name: draft.name,
                          system: draft.system,
                          user: draft.user,
                        })
                        state.tplList = null
                        setNotice('ok', '模板已保存：' + draft.name)
                      }),
                  },
                  '保存',
                ),
                h(
                  'button',
                  {
                    className: 'wl-btn',
                    disabled: state.busy === 'tpl-reset',
                    onClick: () => {
                      const resetTpl = () =>
                        act('tpl-reset', async () => {
                          await call('templates', { action: 'reset', scene: draft.scene })
                          state.tplList = null
                          state.tplDraft = null
                          setNotice('ok', '已恢复内置模板')
                        })
                      if (current?.source !== 'user') {
                        // built-in scene: nothing user-authored to lose
                        resetTpl()
                        return
                      }
                      state.confirm = {
                        title: '恢复内置模板？',
                        body: '将覆盖「' + (draft?.name || draft?.scene || '该场景') + '」的自定义模板，确认？',
                        okLabel: '恢复默认',
                        run: resetTpl,
                      }
                      render()
                    },
                  },
                  '恢复默认',
                ),
              ),
            ],
    ),
  )
}

// 备份与迁移：创建/恢复（确认）/删除（确认）+ 旧 WorkLog 导入。
function settingsBackupPage() {
  return h(
    'div',
    { className: 'wl-stack' },
    noticeNode(),
    h(
      'div',
      { className: 'wl-card' },
      h('div', { className: 'wl-section-title', style: { marginTop: '0' } }, '备份'),
      h(
        'div',
        { className: 'wl-toolbar', style: { margin: '4px 0 8px' } },
        h(
          'button',
          {
            className: 'wl-btn',
            disabled: state.busy === 'backup-create',
            onClick: () =>
              act('backup-create', async () => {
                const result = await call('backup', { action: 'create' })
                setNotice('ok', `已创建备份：${result.name}（${result.days} 天日志）`)
              }),
          },
          '创建备份',
        ),
      ),
      state.backups.length
        ? h(
            'div',
            { className: 'wl-list' },
            state.backups.slice(0, 10).map((backup) =>
              h(
                'div',
                { className: 'wl-item', key: backup.name },
                h(
                  'div',
                  { className: 'grow' },
                  h('div', { className: 'wl-item-title' }, backup.name),
                  h('div', { className: 'wl-item-meta' }, `${Math.round(backup.size / 1024)} KB · ${String(backup.mtime || '').replace('T', ' ').slice(0, 16)}`),
                ),
                h('button', { className: 'wl-btn tiny', disabled: state.busy === 'backup-restore', onClick: () => confirmBackup(backup, 'restore') }, '恢复'),
                h('button', { className: 'wl-btn danger tiny', disabled: state.busy === 'backup-delete', onClick: () => confirmBackup(backup, 'delete') }, '删除'),
              ),
            ),
          )
        : h('div', { className: 'wl-empty' }, '暂无备份，点「创建备份」生成。'),
    ),
    h(
      'div',
      { className: 'wl-card' },
      h('div', { className: 'wl-section-title', style: { marginTop: '0' } }, '从旧 WorkLog 导入'),
      h('div', { className: 'wl-hint' }, '填旧 WorkLog 安装目录（例如 E:\\WorkLog），复制其 data\\archive 到当前数据目录。'),
      h(
        'div',
        { className: 'wl-date-row', style: { marginTop: '8px' } },
        h('input', {
          className: 'wl-input',
          value: state.importDir,
          placeholder: 'E:\\WorkLog',
          onInput: (event) => {
            state.importDir = event.target.value
          },
        }),
        h(
          'button',
          {
            className: 'wl-btn',
            disabled: state.busy === 'import',
            onClick: () =>
              act('import', async () => {
                const result = await call('backup', { action: 'import', sourceDir: state.importDir })
                setNotice('ok', `已导入：${result.importedDays} 天日志`)
              }),
          },
          '导入',
        ),
      ),
    ),
  )
}

// Overwrite/destructive backup ops ask first (UX v3 global rule §2.6).
function confirmBackup(backup, what) {
  const restore = what === 'restore'
  state.confirm = {
    title: (restore ? '恢复备份 ' : '删除备份 ') + backup.name + '？',
    body: restore ? '将用该备份覆盖当前的日志与待办。' : '删除后不可恢复。',
    okLabel: restore ? '恢复' : '删除',
    run: () =>
      act(restore ? 'backup-restore' : 'backup-delete', async () => {
        if (restore) {
          const result = await call('backup', { action: 'restore', name: backup.name })
          setNotice('ok', `已恢复 ${result.restored} 天日志、${result.todos} 条待办`)
        } else {
          await call('backup', { action: 'delete', name: backup.name })
          setNotice('ok', '备份已删除')
        }
      }),
  }
  render()
}
async function loadSched() {
  // Guard both 'already loaded' and 'load in flight': schedSection re-renders
  // on every state change, and an unguarded call here once froze the panel
  // in a render loop while the fetch was in flight or failing.
  if (state.schedData || state.schedLoading) return
  state.schedLoading = true
  render()
  try {
    const data = await call('collect', { action: 'diagnostics' })
    state.schedData = data && typeof data === 'object' ? data : { error: '空响应', tasks: [], sources: [], watchDirs: [], history: [] }
  } catch (error) {
    state.schedData = { error: String(error?.message || error), tasks: [], sources: [], watchDirs: [], history: [] }
    setNotice('err', '采集诊断与调度加载失败：' + String(error?.message || error))
  } finally {
    state.schedLoading = false
  }
}

function refreshSched(next) {
  return act('sched', async () => {
    await next()
    state.schedData = await call('collect', { action: 'diagnostics' })
  })
}

function taskRow(task) {
  return h(
    'div',
    { style: { marginTop: '8px' }, key: task.id },
    h(
      'div',
      { className: 'wl-row' },
      h('input', {
        className: 'wl-check',
        type: 'checkbox',
        checked: Boolean(task.enabled),
        title: (task.enabled ? '停用 ' : '启用 ') + task.title,
        'aria-label': (task.enabled ? '停用 ' : '启用 ') + task.title,
        onChange: () => refreshSched(() => call('collect', { action: 'set', id: task.id, enabled: !task.enabled })),
      }),
      h(
        'div',
        { className: 'grow' },
        h('div', { className: 'wl-item-title' }, task.title),
        h('div', { className: 'wl-item-meta' }, task.description),
        h(
          'div',
          { className: 'wl-item-meta' },
          '间隔 ' + (Number(task.everyHours) || 0) + ' 小时',
          task.dailyAt ? ' · 每天 ' + task.dailyAt + ' 后' : '',
          task.lastRunAt ? ' · 上次 ' + String(task.lastRunAt).slice(5, 16).replace('T', ' ') : ' · 未运行',
          task.lastStatus === 'ok' ? ' · ✅' : task.lastStatus === 'error' ? ' · ❌ ' + (task.lastError || '') : '',
        ),
      ),
      h('input', {
        className: 'wl-input',
        type: 'number',
        min: 0,
        step: 1,
        value: task.everyHours,
        style: { width: '58px' },
        title: '间隔小时数，0=不按间隔',
        onChange: (event) =>
          refreshSched(() =>
            call('collect', { action: 'set', id: task.id, everyHours: Number(event.target.value) || 0 }),
          ),
      }),
      h('input', {
        className: 'wl-input',
        type: 'time',
        value: task.dailyAt || '',
        style: { width: '96px' },
        title: '每天固定时间（可选）',
        onChange: (event) => refreshSched(() => call('collect', { action: 'set', id: task.id, dailyAt: event.target.value })),
      }),
      h(
        'button',
        {
          className: 'wl-btn tiny',
          disabled: state.busy === 'sched',
          onClick: () => refreshSched(() => call('collect', { action: 'run', id: task.id })),
        },
        '立即运行',
      ),
    ),
  )
}

function schedRunBtn(label, action) {
  return h(
    'button',
    { className: 'wl-btn', disabled: state.busy === 'sched', onClick: () => refreshSched(() => call('collect', { action })) },
    label,
  )
}

// 采集与调度：调度任务 + 立即运行 + 采集开关 + 额外会话目录。
// 诊断加载器与「诊断」子页共用（双守卫；失败留哨兵供「重试」）。
function settingsCollectPage() {
  const draft = (state.settings = state.settings || draftFromConfig(state.config))
  const set = settingsSet(draft)
  if (!state.schedData && !state.schedLoading) loadSched().then(render, () => render())
  const data = state.schedData
  const tasks = data?.tasks || []
  return h(
    'div',
    { className: 'wl-stack' },
    noticeNode(),
    data?.error
      ? h(
          'div',
          { className: 'wl-card' },
          h('div', { className: 'wl-notice err', style: { marginBottom: '8px' } }, '采集与调度加载失败：' + data.error),
          h(
            'button',
            {
              className: 'wl-btn',
              disabled: state.schedLoading,
              onClick: () => {
                state.schedData = null
                loadSched().then(render, () => render())
              },
            },
            '重试',
          ),
        )
      : [
          h(
            'div',
            { className: 'wl-card' },
            h('div', { className: 'wl-section-title', style: { marginTop: '0' } }, '调度任务'),
            state.schedLoading && !data ? h('div', { className: 'wl-hint' }, '加载中…') : null,
            h(
              'div',
              { className: 'wl-row' },
              schedRunBtn('运行所有到期任务', 'run'),
              schedRunBtn('立即扫描会话', 'scan_sessions'),
              schedRunBtn('立即扫描目录', 'scan_watch'),
            ),
            tasks.length ? tasks.map(taskRow) : h('div', { className: 'wl-hint' }, data ? '无任务' : '加载中…'),
          ),
          h(
            'div',
            { className: 'wl-card' },
            h('div', { className: 'wl-section-title', style: { marginTop: '0' } }, '采集开关'),
            h(
              'div',
              { className: 'wl-checkline' },
              h('input', { type: 'checkbox', checked: draft.git, onChange: set('git') }),
              '扫描 Git 提交',
              h('input', { type: 'checkbox', checked: draft.docs, onChange: set('docs'), style: { marginLeft: '8px' } }),
              '扫描文档变更',
              h('input', { type: 'checkbox', checked: draft.sessions, onChange: set('sessions'), style: { marginLeft: '8px' } }),
              '汇总 AI 会话',
            ),
            h('div', { className: 'wl-label' }, '额外 AI 会话目录（每行一个，可选）'),
            h('textarea', { className: 'wl-area small', value: draft.sessionRoots, onInput: set('sessionRoots') }),
            h('div', { className: 'wl-hint' }, '自动扫描：~/.claude/projects、~/.codex/sessions、$DSH_HOME/sessions、~/.workbuddy/projects、~/.zcode（数据库）、~/.local/share/opencode、~/.gemini/tmp。'),
          ),
          h(
            'div',
            { className: 'wl-card' },
            h('div', { className: 'wl-section-title', style: { marginTop: '0' } }, '监控目录'),
            (data?.watchDirs || []).length
              ? data.watchDirs.map((dir) =>
                  h(
                    'div',
                    { className: 'wl-row', key: dir.path },
                    h('span', { className: 'wl-tag' }, dir.kind),
                    h('span', { className: 'grow wl-hint', style: { wordBreak: 'break-all' } }, dir.path),
                  ),
                )
              : h('div', { className: 'wl-hint' }, data ? '暂无。可在「通用」里添加：每行一条，格式 路径 或 路径|cloud 或 路径|git' : '加载中…'),
          ),
        ],
    dirtyBarNode(),
  )
}
// AI 工具配置向导（并入「AI 接口」子页；原折叠壳退役，body 平移）。
function wizardBlock() {
  const draft = state.wizardDraft
  const probe = state.wizardProbe
  return h(
    'div',
    { className: 'wl-card' },
    h('div', { className: 'wl-section-title', style: { marginTop: '0' } }, 'AI 工具配置向导'),
    h('div', { className: 'wl-hint' }, '按位置探测并一键应用'),
    h(
      'div',
      { className: 'wl-row', style: { marginTop: '8px' } },
      h(
        'select',
        {
          className: 'wl-select',
          style: { width: '150px' },
          value: draft.type,
          onChange: (event) => {
            draft.type = event.target.value
            state.wizardProbe = null
            render()
          },
        },
        (state.wizardTypes || []).length
          ? state.wizardTypes.map((item) => h('option', { value: item.type, selected: draft.type === item.type }, item.title))
          : h('option', { value: draft.type }, state.wizardTypesLoading ? '加载中…' : draft.type),
      ),
      h('input', {
        className: 'wl-input',
        placeholder: '位置（可选，默认扫标准路径）',
        value: draft.location,
        onInput: (event) => {
          draft.location = event.target.value
        },
      }),
      h(
        'button',
        {
          className: 'wl-btn',
          disabled: state.busy === 'wizard',
          onClick: () =>
            act('wizard', async () => {
              state.wizardProbe = await call('wizard', { action: 'probe', type: draft.type, location: draft.location })
              if (!state.wizardProbe.ok) setNotice('err', state.wizardProbe.error || '探测失败')
            }),
        },
        '探测',
      ),
    ),
    probe && probe.ok && probe.type === 'custom'
      ? h('div', { className: 'wl-hint', style: { marginTop: '8px' } }, '文件数 ' + probe.custom.fileCount + '。' + (probe.custom.note || ''))
      : null,
    probe && probe.ok && probe.type !== 'custom'
      ? (probe.candidates || []).map((candidate) =>
          h(
            'div',
            { className: 'wl-item', key: candidate.id, style: { marginTop: '8px' } },
            h(
              'div',
              { className: 'grow' },
              h('div', { className: 'wl-item-title' }, candidate.name || candidate.id),
              h(
                'div',
                { className: 'wl-item-meta' },
                candidate.baseUrl,
                ' · 模型 ' + (candidate.modelsCount || 0) + ' 个',
                candidate.model ? ' · 当前 ' + candidate.model : '',
                ' · Key ' + (candidate.hasKey ? '已配置 ' + (candidate.keyHint || '') : '未配置'),
              ),
              candidate.note ? h('div', { className: 'wl-item-meta' }, candidate.note) : null,
            ),
            h(
              'button',
              {
                className: 'wl-btn primary tiny',
                disabled: state.busy === 'wizard-apply',
                onClick: () =>
                  act('wizard-apply', async () => {
                    await call('ai', { action: 'apply', id: candidate.id })
                    setNotice('ok', '已应用：' + (candidate.name || candidate.id))
                  }),
              },
              '应用',
            ),
          ),
        )
      : null,
    probe && probe.ok && probe.hint ? h('div', { className: 'wl-hint', style: { marginTop: '4px' } }, probe.hint) : null,
    probe && !probe.ok ? h('div', { className: 'wl-carry', style: { marginTop: '8px' } }, probe.error || '探测失败') : null,
  )
}
function calKey(d) {
  const now = new Date()
  const y = d ? Number(String(d).slice(0, 4)) : now.getFullYear()
  const m = d ? Number(String(d).slice(5, 7)) : now.getMonth() + 1
  return y + '-' + String(m).padStart(2, '0')
}

// Calendar month payloads are cached per month so a week view spanning two
// months can merge both sides (the old single-payload version refetched in a
// loop on cross-month weeks).
async function fetchCalMonth(key) {
  if (state.calMonths[key]) return state.calMonths[key]
  state.calMonths[key] = 'loading'
  render()
  try {
    state.calMonths[key] = await call('calendar', { action: 'month', month: key })
  } catch (error) {
    setNotice('err', '日历加载失败：' + String(error?.message || error))
    state.calMonths[key] = { month: key, today: today(), days: {}, failed: true, error: String(error?.message || error) }
  }
  render()
  return state.calMonths[key]
}

async function loadCalMonth(month) {
  state.calMonth = month || state.calMonth || calKey()
  render()
  await fetchCalMonth(state.calMonth)
}

async function selectCalDay(date, { edit = false } = {}) {
  // Unsaved day-log edit is never silently discarded: a day switch while the
  // log textarea diverges from disk asks first (confirm then discard).
  if (logEditDirty()) {
    state.confirm = {
      title: '有未保存的日志修改',
      body: '切换日期将丢弃 ' + (state.log.date || '') + ' 的未保存修改。',
      okLabel: '丢弃并切换',
      run: () => {
        state.dayEdit = false
        selectCalDay(date, { edit })
      },
    }
    render()
    return
  }
  state.calSelected = date
  state.dayEdit = edit
  // Week view: the anchor follows the picked day so the shown week always
  // contains it (also across month boundaries).
  if (state.calMode === 'week') state.calAnchor = date
  if (state.calMonth !== date.slice(0, 7)) {
    state.calMonth = date.slice(0, 7)
  }
  state.calDayLoading = true
  render()
  try {
    state.calDay = await call('calendar', { action: 'day', date })
  } catch (error) {
    state.calDay = null
    setNotice('err', '当日详情加载失败：' + String(error?.message || error))
  } finally {
    state.calDayLoading = false
  }
  try {
    await loadLog(date)
  } catch (error) {
    setNotice('err', '日志加载失败：' + String(error?.message || error))
  }
  render()
}

// Re-pull the day detail after an in-place mutation (todo done/added,
// archive regenerated).
async function refreshDayDetail() {
  const date = state.calSelected
  if (!date) return
  state.calDay = null
  await selectCalDay(date)
}

function addDayTodo(date) {
  const input = document.getElementById('wl-daytodo-title')
  const title = String(input?.value || '').trim()
  if (!title) return
  act('daytodo-add', async () => {
    await call('todos', { action: 'add', title, due: date })
    await refreshDayDetail()
    setNotice('ok', '已添加：' + title)
  })
}

// Calendar marks are capped at three kinds (+ selection state): ● log,
// ▼ due todos, ◦ sessions. Counts and report info live only in the detail.
function calCell(day, today) {
  const marks = []
  if (day.archived) marks.push(h('span', { className: 'wl-cal-mark log', title: '有日志' }, '●'))
  if (day.todoDue) marks.push(h('span', { className: 'wl-cal-mark due', title: '有到期待办' }, '▼'))
  if (day.sessionCount) marks.push(h('span', { className: 'wl-cal-mark sess', title: '有会话' }, '◦'))
  return h(
    'button',
    {
      className:
        'wl-cal-cell' +
        (state.calSelected === day.date ? ' sel' : '') +
        (day.date === today ? ' today' : ''),
      onClick: () => selectCalDay(day.date),
    },
    h('div', { className: 'wl-cal-num' }, String(Number(day.date.slice(8, 10)))),
    h('div', { className: 'wl-cal-marks' }, marks),
  )
}
function weekDatesOf(anchor) {
  const base = new Date(anchor)
  const lead = (base.getDay() + 6) % 7
  const monday = new Date(base)
  monday.setDate(monday.getDate() - lead)
  const list = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday)
    d.setDate(d.getDate() + i)
    const pad = (n) => String(n).padStart(2, '0')
    list.push(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()))
  }
  return list
}

// Month arithmetic with year rollover ('2026-01' - 1 -> '2025-12').
function shiftMonth(month, delta) {
  const y = Number(String(month).slice(0, 4))
  const m = Number(String(month).slice(5, 7))
  const d = new Date(y, m - 1 + delta, 1)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1)
}
function calGrid() {
  const data = state.calMonths[state.calMonth]
  if (!data || data === 'loading') return h('div', { className: 'wl-hint' }, '加载中…')
  const now = data.today || today()
  let cells = []
  if (state.calMode === 'week') {
    const anchor = state.calAnchor || now
    const week = weekDatesOf(anchor)
    const days = {}
    const missing = new Set()
    for (const date of week) {
      const monthKey = date.slice(0, 7)
      const monthData = state.calMonths[monthKey]
      if (!monthData || monthData === 'loading') missing.add(monthKey)
      else if (monthData.days && monthData.days[date]) days[date] = monthData.days[date]
    }
    // Pull whatever months the week touches, then render — days without
    // records become blank cells instead of retrying forever.
    for (const monthKey of missing) fetchCalMonth(monthKey)
    cells = week.map((date) => calCell(days[date] || { date, archived: false, todoDue: 0, sessionCount: 0 }, now))
  } else {
    if (data.failed) {
      return h(
        'div',
        null,
        h('div', { className: 'wl-hint' }, '日历加载失败：' + (data.error || '未知错误')),
        h(
          'button',
          {
            className: 'wl-btn tiny',
            onClick: () => {
              delete state.calMonths[state.calMonth]
              fetchCalMonth(state.calMonth)
            },
          },
          '重试',
        ),
      )
    }
    const days = data.days || {}
    const first = (data.month || state.calMonth) + '-01'
    const lead = (new Date(first).getDay() + 6) % 7
    for (let i = 0; i < lead; i++) cells.push(h('span', { className: 'wl-cal-cell empty' }, ''))
    for (const date of Object.keys(days)) cells.push(calCell(days[date], now))
  }
  return h(
    'div',
    { className: 'wl-cal-grid' },
    ['一', '二', '三', '四', '五', '六', '日'].map((label) => h('div', { className: 'wl-cal-head' }, label)),
    cells,
  )
}

// Right pane of the time tab: the selected day's archive action, todos, log,
// sessions and records. Selecting a day never replaces the page — only this
// pane re-renders (UX v3 master-detail rule; the old "day hub" mode is gone).
function dayDetail() {
  if (state.calDayLoading && !state.calDay) return h('div', { className: 'wl-card' }, h('div', { className: 'wl-hint' }, '加载中…'))
  const detail = state.calDay
  if (!detail) return h('div', { className: 'wl-card' }, h('div', { className: 'wl-empty' }, '在左侧日历点一天，这里显示当天详情。'))
  const date = detail.date
  const todayText = today()
  const isToday = date === todayText
  const past = date < todayText
  const dueList = detail.todosDue || []
  const logForDay = state.log.date === date && state.log.loaded

  // One primary action per state: generate today / regenerate (confirm) /
  // backfill a past day without a log.
  const headAction = () => {
    if (isToday && !detail.archived) {
      return h(
        'button',
        {
          className: 'wl-btn primary',
          disabled: state.busy === 'day-archive',
          onClick: () =>
            act('day-archive', async () => {
              const result = await call('archive', { action: 'run', date, force: false })
              setNotice(
                'ok',
                result.created
                  ? `今日日志已生成：${result.commitCount} 个提交 / ${result.docCount} 个文档 / ${result.sessionCount || 0} 个会话`
                  : `${date} 已有归档，未覆盖。`,
              )
              state.log.loaded = false
            }),
        },
        state.busy === 'day-archive' ? '生成中…' : '生成今日日志',
      )
    }
    if (detail.archived || (logForDay && (state.log.exists || state.log.text))) {
      return h(
        'button',
        {
          className: 'wl-btn',
          disabled: state.busy === 'day-regen',
          onClick: () => {
            state.confirm = {
              title: '重新生成 ' + date + ' 的日志？',
              body: '将重新扫描该天的 Git 提交、文档与会话，并覆盖现有内容（含手写备注）。',
              okLabel: '重新生成',
              run: () =>
                act('day-regen', async () => {
                  const result = await call('archive', { action: 'run', date, force: true })
                  state.log.loaded = false
                  await loadLog(date)
                  await refreshDayDetail()
                  setNotice('ok', `已重新生成：${result.commitCount} 个提交 / ${result.docCount} 个文档`)
                }),
            }
            render()
          },
        },
        state.busy === 'day-regen' ? '生成中…' : '重新生成',
      )
    }
    if (past) {
      return h(
        'button',
        {
          className: 'wl-btn',
          disabled: state.busy === 'day-backfill',
          onClick: () =>
            act('day-backfill', async () => {
              const result = await call('archive', { action: 'run', date, force: false })
              state.log.loaded = false
              await refreshDayDetail()
              setNotice('ok', result.created ? `已回填 ${date}：${result.commitCount} 个提交 / ${result.docCount} 个文档` : `${date} 已有归档，未覆盖。`)
            }),
        },
        state.busy === 'day-backfill' ? '回填中…' : '回填归档',
      )
    }
    return null
  }

  // Log card: read mode first, explicit edit button — same behavior for old
  // and brand-new logs (UX v3 behavior unification, §5).
  const logCard = h(
    'div',
    { className: 'wl-card' },
    state.dayEdit
      ? [
          h('textarea', {
            className: 'wl-area',
            style: { minHeight: '160px' },
            value: state.log.text,
            placeholder: '# 工作日志\n\n## 今日概览\n…',
            onInput: (event) => {
              state.log.text = event.target.value
            },
          }),
          h(
            'div',
            { className: 'wl-row', style: { marginTop: '8px' } },
            h(
              'button',
              {
                className: 'wl-btn primary',
                disabled: state.busy === 'day-save',
                onClick: () =>
                  act(
                    'day-save',
                    async () => {
                      await call('day', { date, text: state.log.text })
                      state.log.exists = true
                      state.dayEdit = false
                      setNotice('ok', '已保存 ' + date)
                    },
                    { refresh: false },
                  ),
              },
              state.busy === 'day-save' ? '保存中…' : '保存',
            ),
            h(
              'button',
              {
                className: 'wl-btn',
                onClick: () => {
                  state.dayEdit = false
                  if (!state.log.exists) {
                    loadLog(date).then(render, () => render())
                  } else render()
                },
              },
              '取消',
            ),
          ),
        ]
      : logForDay
        ? [
            h('div', { className: 'wl-pre', style: { maxHeight: '300px' } }, state.log.text || '（内容为空）'),
            h(
              'button',
              {
                className: 'wl-btn',
                onClick: () => {
                  state.dayEdit = true
                  render()
                },
              },
              state.log.exists ? '编辑' : '写内容',
            ),
          ]
        : h('div', { className: 'wl-hint' }, '日志加载中…'),
  )

  return h(
    'div',
    { className: 'wl-stack' },
    h(
      'div',
      { className: 'wl-card' },
      h(
        'div',
        { className: 'wl-row' },
        h(
          'div',
          { className: 'grow' },
          h('div', { className: 'wl-item-title' }, `${cnDate(date)} 周${weekdayCn(date)}${isToday ? ' · 今天' : ''}`),
          h('div', { className: 'wl-item-meta' }, date + (detail.archived ? ' · 已生成日志' : '')),
        ),
        headAction(),
      ),
    ),
    h(
      'div',
      { className: 'wl-section-title' },
      '当天到期待办' + (dueList.length ? '（' + dueList.length + ' 条）' : ''),
    ),
    h(
      'div',
      { className: 'wl-card' },
      dueList.length
        ? dueList.map((todo) =>
            h(
              'div',
              { className: 'wl-row', key: todo.id },
              h('input', {
                className: 'wl-check',
                type: 'checkbox',
                onChange: () =>
                  act('daytodo-done', async () => {
                    await call('todos', { action: 'complete', id: todo.id })
                    await refreshDayDetail()
                  }),
              }),
              h(
                'div',
                { className: 'grow' },
                h('div', { className: 'wl-item-title' }, todo.title),
                h(
                  'div',
                  { className: 'wl-item-meta' },
                  todo.pri ? h('span', { className: 'wl-tag ' + (todo.pri === '高' ? 'high' : todo.pri === '中' ? 'mid' : 'low') }, todo.pri) : null,
                  todo.carries ? h('span', { className: 'wl-carry' }, '顺延 ' + todo.carries) : null,
                ),
              ),
            ),
          )
        : h('div', { className: 'wl-hint' }, '暂无当天到期待办。'),
      h(
        'div',
        { className: 'wl-row', style: { marginTop: '4px' } },
        h('input', {
          className: 'wl-input',
          id: 'wl-daytodo-title',
          placeholder: '给这天加个待办（回车添加）',
          style: { flex: '1' },
          onKeydown: (event) => {
            if (event.key === 'Enter') addDayTodo(date)
          },
        }),
        h('button', { className: 'wl-btn tiny', onClick: () => addDayTodo(date) }, '添加'),
      ),
    ),
    h('div', { className: 'wl-section-title' }, '日志'),
    logCard,
    detail.sessions?.length
      ? [
          h('div', { className: 'wl-section-title' }, '当天 AI 会话 ' + detail.sessions.length + ' 场'),
          h(
            'div',
            { className: 'wl-card' },
            detail.sessions.map((session) =>
              h(
                'div',
                { className: 'wl-row', key: session.title + session.timeRange },
                h('span', { className: 'wl-tag' }, session.label),
                h('span', { className: 'grow wl-hint' }, session.title),
                h('span', { className: 'wl-hint' }, (session.turns || 0) + ' 轮 ' + (session.timeRange || '')),
              ),
            ),
            h(
              'button',
              { className: 'wl-btn tiny', style: { marginTop: '8px' }, onClick: () => openLibrarySessions(date) },
              '在资料库打开这天',
            ),
          ),
        ]
      : null,
    detail.todosDone?.length
      ? [
          h('div', { className: 'wl-section-title' }, '完成待办 ' + detail.todosDone.length + ' 条'),
          h(
            'div',
            { className: 'wl-card' },
            detail.todosDone.map((todo) => h('div', { className: 'wl-row', key: todo.title }, '✓ ' + todo.title)),
          ),
        ]
      : null,
    detail.entries?.count
      ? [
          h('div', { className: 'wl-section-title' }, '当天记录 ' + detail.entries.count + ' 条'),
          h(
            'div',
            { className: 'wl-card' },
            h(
              'div',
              { className: 'wl-row' },
              Object.entries(detail.entries.bySource || {}).map(([source, count]) =>
                h('span', { className: 'wl-tag', key: source }, source + ' ' + count),
              ),
            ),
            (detail.entries.items || []).map((entry) =>
              h(
                'div',
                { className: 'wl-row', key: entry.ref + entry.title },
                h('span', { className: 'wl-hint' }, entry.time || ''),
                h('span', { className: 'grow wl-hint', style: { wordBreak: 'break-all' } }, entry.title),
              ),
            ),
          ),
        ]
      : null,
  )
}

// Calendar card — the only calendar in the panel (the session tab's month
// calendar was removed with UX v3).
function timeCalendar() {
  const data = state.calMonths[state.calMonth]
  const shiftWeek = (delta) => {
    const d = new Date(state.calAnchor || data?.today || today())
    d.setDate(d.getDate() + delta * 7)
    const p = (n) => String(n).padStart(2, '0')
    state.calAnchor = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    render()
  }
  return [
    h(
      'div',
      { className: 'wl-row' },
      h(
        'button',
        {
          className: 'wl-btn tiny',
          title: state.calMode === 'week' ? '上一周' : '上一月',
          'aria-label': state.calMode === 'week' ? '上一周' : '上一月',
          onClick: () => {
            if (state.calMode === 'week') shiftWeek(-1)
            else loadCalMonth(shiftMonth(state.calMonth, -1))
          },
        },
        '◀',
      ),
      h(
        'div',
        { className: 'wl-section-title' },
        state.calMode === 'week' ? (state.calAnchor || data?.today || today()).slice(5) + ' 起的一周' : state.calMonth,
      ),
      h(
        'button',
        {
          className: 'wl-btn tiny' + (state.calMode === 'week' ? '' : ' primary'),
          onClick: () => {
            state.calMode = 'month'
            // leaving week mode: land the month view on the week being shown
            state.calMonth = (state.calAnchor || today()).slice(0, 7)
            state.calAnchor = ''
            render()
          },
        },
        '月',
      ),
      h(
        'button',
        {
          className: 'wl-btn tiny' + (state.calMode === 'week' ? ' primary' : ''),
          onClick: () => {
            state.calMode = 'week'
            if (!state.calAnchor) state.calAnchor = data?.today || today()
            render()
          },
        },
        '周',
      ),
      h(
        'button',
        {
          className: 'wl-btn tiny',
          title: state.calMode === 'week' ? '下一周' : '下一月',
          'aria-label': state.calMode === 'week' ? '下一周' : '下一月',
          onClick: () => {
            if (state.calMode === 'week') shiftWeek(1)
            else loadCalMonth(shiftMonth(state.calMonth, 1))
          },
        },
        '▶',
      ),
      h('button', { className: 'wl-btn tiny', onClick: () => loadCalMonth(calKey()) }, '今天'),
    ),
    calGrid(),
    h('div', { className: 'wl-hint', style: { marginTop: '8px' } }, '标记：● 有日志 · ▼ 有到期待办 · ◦ 有会话'),
  ]
}

// Time tab: fixed master (calendar) / detail (selected day) layout with the
// todo workbench as a full-width band below. No "enter/exit" day mode —
// clicking a day only refreshes the right pane.
function timeTab() {
  if (!state.calMonth) state.calMonth = calKey()
  if (!state.calMonths[state.calMonth]) fetchCalMonth(state.calMonth)
  return h(
    'div',
    { className: 'wl-stack' },
    noticeNode(),
    h(
      'div',
      { className: 'wl-master' },
      h('div', { className: 'wl-card' }, timeCalendar()),
      h('div', null, dayDetail()),
    ),
    h(
      'div',
      { className: 'wl-section', id: 'wl-todo-workbench' },
      h('div', { className: 'wl-section-title' }, '全部待办'),
      todosWorkbench(),
    ),
  )
}
async function loadTpls() {
  if (state.tplList || state.tplLoading) return
  state.tplLoading = true
  render()
  try {
    const data = await call('templates', { action: 'list' })
    state.tplList = (data && Array.isArray(data.templates) ? data.templates : [])
    state.tplError = ''
    const first = state.tplList[0]
    if (first && !state.tplDraft) {
      state.tplDraft = { scene: first.scene, name: first.name, system: first.system, user: first.user, source: first.source }
    }
  } catch (error) {
    state.tplList = []
    state.tplError = String(error?.message || error)
  } finally {
    state.tplLoading = false
  }
}

function tplDraftFor(scene) {
  const found = (state.tplList || []).find((item) => item.scene === scene)
  if (!found) return state.tplDraft
  state.tplDraft = { scene, name: found.name, system: found.system, user: found.user, source: found.source }
  return state.tplDraft
}

async function loadConns() {
  if (state.connList || state.connLoading) return
  state.connLoading = true
  render()
  try {
    const list = await call('connectors', { action: 'list' })
    state.connList = list && typeof list === 'object' ? list : { connectors: [], types: [] }
    state.connError = ''
  } catch (error) {
    state.connList = { connectors: [], types: [] }
    state.connError = String(error?.message || error)
  } finally {
    state.connLoading = false
  }
}

function connTypeMeta(type) {
  return (state.connList?.types || []).find((item) => item.type === type)
}

function connRow(connector) {
  return h(
    'div',
    { style: { marginTop: '8px' }, key: connector.id },
    h(
      'div',
      { className: 'wl-row' },
      h('input', {
        className: 'wl-check',
        type: 'checkbox',
        checked: Boolean(connector.enabled),
        onChange: () =>
          act('conn-set', async () => {
            await call('connectors', { action: 'set', id: connector.id, type: connector.type, label: connector.label, enabled: !connector.enabled, config: connector.config })
            state.connList = null
          }),
      }),
      h(
        'div',
        { className: 'grow' },
        h('div', { className: 'wl-item-title' }, (connector.label || connector.id) + ' · ' + connector.type),
        h(
          'div',
          { className: 'wl-item-meta' },
          connector.lastSyncAt ? '上次同步 ' + String(connector.lastSyncAt).slice(5, 16).replace('T', ' ') : '未同步',
          connector.lastStatus === 'ok' ? ' · ✅' : connector.lastStatus === 'error' ? ' · ❌ ' + (connector.lastError || '') : '',
        ),
      ),
      h(
        'button',
        { className: 'wl-btn tiny', disabled: state.busy === 'conn-test', onClick: () => act('conn-test', async () => {
          const result = await call('connectors', { action: 'test', id: connector.id })
          setNotice(result.ok ? 'ok' : 'err', (result.ok ? '连接成功：' : '连接失败：') + (result.detail || ''))
        }) },
        '测试',
      ),
      h(
        'button',
        { className: 'wl-btn tiny', disabled: state.busy === 'conn-sync', onClick: () => act('conn-sync', async () => {
          const result = await call('connectors', { action: 'sync', id: connector.id })
          const item = result.results?.[0]
          setNotice(item?.status === 'error' ? 'err' : 'ok', item ? (item.status === 'error' ? '同步失败：' + item.error : '同步完成，新增 ' + item.added + ' 条') : '已触发')
          state.connList = null
        }) },
        '同步',
      ),
      h(
        'button',
        {
          className: 'wl-btn danger tiny',
          onClick: () => {
            state.confirm = {
              title: '删除连接器？',
              body: '将删除 ' + (connector.label || connector.id) + '，删除后需重新配置。',
              okLabel: '删除',
              run: () =>
                act('conn-del', async () => {
                  await call('connectors', { action: 'remove', id: connector.id })
                  state.connList = null
                }),
            }
            render()
          },
        },
        '删除',
      ),
    ),
  )
}

function connFieldInput(field, draft) {
  const value = draft.config[field.key]
  if (field.type === 'bool') {
    return h('input', {
      className: 'wl-check',
      type: 'checkbox',
      checked: Boolean(value),
      onChange: (event) => {
        draft.config[field.key] = event.target.checked
        render()
      },
    })
  }
  return h('input', {
    className: 'wl-input',
    type: field.type === 'password' ? 'password' : 'text',
    value: value || '',
    placeholder: field.hint || field.label,
    onInput: (event) => {
      draft.config[field.key] = event.target.value
    },
  })
}

function connEditor() {
  const draft = state.connDraft
  if (!draft) return null
  const meta = connTypeMeta(draft.type)
  const fields = meta?.fields || []
  return h(
    'div',
    { className: 'wl-section', style: { marginTop: '8px' } },
    h(
      'div',
      { className: 'wl-row' },
      h(
        'select',
        {
          className: 'wl-select',
          style: { width: '220px' },
          value: draft.type,
          onChange: (event) => {
            state.connDraft = { id: '', type: event.target.value, label: '', enabled: true, config: {} }
            render()
          },
        },
        (state.connList?.types || []).map((item) =>
          h('option', { value: item.type, selected: draft.type === item.type }, item.title),
        ),
      ),
      h('input', {
        className: 'wl-input',
        placeholder: '名称（可选）',
        value: draft.label,
        onInput: (event) => {
          draft.label = event.target.value
        },
      }),
    ),
    fields.map((field) =>
      h(
        'div',
        { className: 'wl-row', key: field.key, style: { marginTop: '4px' } },
        h('span', { className: 'wl-hint', style: { width: '120px' } }, field.label + (field.required ? ' *' : '')),
        connFieldInput(field, draft),
      ),
    ),
    h(
      'div',
      { className: 'wl-row', style: { marginTop: '8px' } },
      h(
        'button',
        {
          className: 'wl-btn primary',
          disabled: state.busy === 'conn-save',
          onClick: () =>
            act('conn-save', async () => {
              await call('connectors', {
                action: 'set',
                id: draft.id,
                type: draft.type,
                label: draft.label,
                enabled: draft.enabled !== false,
                config: draft.config,
              })
              state.connList = null
              state.connDraft = null
              setNotice('ok', '连接器已保存')
            }),
        },
        '保存连接器',
      ),
      h(
        'button',
        {
          className: 'wl-btn',
          onClick: () => {
            state.connDraft = null
            render()
          },
        },
        '取消',
      ),
      h('span', { className: 'wl-hint' }, '密钥回显为「已配置」占位，不改则保留原值'),
    ),
  )
}

// 连接器 body（原折叠壳退役）。加载失败留哨兵供「重试」；删除需确认。
function connBlock() {
  if (!state.connList && !state.connLoading && !state.connError) loadConns().then(render, () => render())
  const connectors = state.connList?.connectors || []
  return h(
    'div',
    { className: 'wl-card' },
    state.connError
      ? [
          h('div', { className: 'wl-notice err', style: { marginBottom: '8px' } }, '连接器加载失败：' + state.connError),
          h(
            'button',
            {
              className: 'wl-btn',
              disabled: state.connLoading,
              onClick: () => {
                state.connList = null
                state.connError = ''
                loadConns().then(render, () => render())
              },
            },
            '重试',
          ),
        ]
      : state.connLoading && !state.connList
        ? h('div', { className: 'wl-hint' }, '加载中…')
        : [
            connectors.length ? connectors.map(connRow) : h('div', { className: 'wl-hint' }, '暂无连接器，点「新建连接器」开始拉取外部数据。'),
            h(
              'div',
              { className: 'wl-row', style: { marginTop: '8px' } },
              h(
                'button',
                {
                  className: 'wl-btn',
                  disabled: state.connDraft !== null,
                  onClick: () => {
                    state.connDraft = { id: '', type: 'feishu', label: '', enabled: true, config: {} }
                    if (!state.connList) loadConns()
                    render()
                  },
                },
                '新建连接器',
              ),
              connectors.length
                ? h(
                    'button',
                    {
                      className: 'wl-btn',
                      disabled: state.busy === 'conn-sync',
                      onClick: () =>
                        act('conn-sync', async () => {
                          const result = await call('connectors', { action: 'sync' })
                          const okN = result.results.filter((item) => item.status === 'ok').length
                          setNotice('ok', '同步完成：' + okN + '/' + result.results.length + ' 成功')
                          state.connList = null
                        }),
                    },
                    '同步全部启用项',
                  )
                : null,
            ),
            state.connDraft ? connEditor() : null,
          ],
  )
}
async function loadReco() {
  if (state.recoData && state.recoData.date === today()) return
  if (state.recoLoading) return
  state.recoLoading = true
  render()
  try {
    // call() unwraps {items:[...]} envelopes to the bare array — normalize so
    // recoCard always sees { date, items } (the card has been silently blank
    // whenever the envelope unwrap hit; this is the 检视修复轮 fix).
    const data = await call('recommend', { action: 'get' })
    state.recoData = Array.isArray(data) ? { date: today(), items: data } : data
  } catch (error) {
    setNotice('err', '建议加载失败：' + String(error?.message || error))
  } finally {
    state.recoLoading = false
  }
  render()
}

function recoCard() {
  const data = state.recoData
  const items = data?.items || []
  if (!items.length) return null
  return h(
    'div',
    { className: 'wl-card wide' },
    h(
      'div',
      { className: 'wl-row' },
      h('div', { className: 'wl-section-title', style: { flex: '1' } }, '建议关注'),
      h('span', { className: 'wl-hint' }, '规则引擎 · 忽略会降低同类权重'),
      h(
        'button',
        { className: 'wl-btn tiny', disabled: state.recoLoading, onClick: () => { state.recoData = null; loadReco() } },
        '刷新',
      ),
    ),
    items.map((item) =>
      h(
        'div',
        { className: 'wl-row', key: item.kind + item.title },
        h('span', { className: 'wl-tag' }, item.kind),
        h(
          'div',
          { className: 'grow' },
          h(
            'button',
            {
              className: 'wl-click wl-item-title',
              title: '点跳到对应板块',
              onClick: () => {
                const d = item.refs?.date || item.date
                if (d) openDay(d)
                else gotoTab('time')
              },
            },
            item.title,
          ),
          item.detail ? h('div', { className: 'wl-item-meta' }, item.detail) : null,
        ),
        h('span', { className: 'wl-hint' }, String(item.final || item.score)),
        h(
          'button',
          {
            className: 'wl-btn tiny',
            disabled: state.busy === 'reco-fb',
              onClick: () =>
                act('reco-fb', async () => {
                  await call('recommend', { action: 'feedback', kind: item.kind, key: item.title, accepted: true })
                  state.recoData = null
                  await loadReco()
                }),
          },
          '采纳',
        ),
        h(
          'button',
          {
            className: 'wl-btn tiny',
            disabled: state.busy === 'reco-fb',
              onClick: () =>
                act('reco-fb', async () => {
                  await call('recommend', { action: 'feedback', kind: item.kind, key: item.title, accepted: false })
                  state.recoData = null
                  await loadReco()
                }),
          },
          '忽略',
        ),
      ),
    ),
  )
}
const GRAPH_TYPE_META = {
  project: { label: '项目' },
  person: { label: '人' },
  tool: { label: 'AI 工具' },
  source: { label: '外部系统' },
  topic: { label: '主题' },
}

function graphTypeLabel(type) {
  return GRAPH_TYPE_META[type]?.label || type
}

async function loadGraphView(entity) {
  state.graphLoading = true
  state.graphEntity = entity || ''
  render()
  try {
    state.graphData = await call('graph', { action: 'query', entity: state.graphEntity })
  } catch (error) {
    setNotice('err', '图谱加载失败：' + String(error?.message || error))
  } finally {
    state.graphLoading = false
  }
  render()
}

// Traverse from overview cards: a fresh trail. From inside a neighborhood the
// SVG node handler pushes the current entity onto the trail first.
function openGraphEntity(label) {
  state.graphTrail = []
  loadGraphView(label)
}

function resetGraphView() {
  state.graphData = null
  state.graphEntity = ''
  state.graphTrail = []
  state.graphType = ''
  loadGraphView('')
}

// Library · graph view: overview = type chips + entity card grid; clicking a
// card opens a deterministic SVG neighborhood (spokes from the entity, verb on
// each edge, clickable nodes to keep traversing) with the text detail kept
// below as a no-SVG fallback. Rebuilt with 更新图谱 (semantics unchanged).
function graphView() {
  if (!state.graphData && !state.graphLoading) loadGraphView('')
  const data = state.graphData
  const loading = h('div', { className: 'wl-hint' }, '加载中…')
  return h(
    'div',
    { className: 'wl-card' },
    data
      ? [
          h(
            'div',
            { className: 'wl-row' },
            h('div', { className: 'wl-section-title' }, data.found || data.entity ? '实体关系' : '知识图谱'),
            h(
              'span',
              { className: 'wl-hint' },
              data.builtAt ? '构建于 ' + String(data.builtAt).slice(5, 16).replace('T', ' ') : '未构建',
            ),
            h(
              'button',
              {
                className: 'wl-btn tiny',
                disabled: state.graphLoading,
                onClick: () =>
                  act('graph-rebuild', async () => {
                    const stats = await call('graph', { action: 'rebuild' })
                    setNotice('ok', '图谱已更新：' + stats.nodes + ' 节点 / ' + stats.edges + ' 关系')
                    state.graphData = null
                  }),
              },
              '更新图谱',
            ),
          ),
          state.graphLoading ? loading : null,
          !state.graphLoading && data.found === undefined && !data.entity ? graphOverview(data) : null,
          !state.graphLoading && data.entity ? graphEntityView(data) : null,
        ]
      : loading,
  )
}

function graphBreadcrumb(currentLabel) {
  const trail = state.graphTrail || []
  const crumbs = [
    h('button', {
      className: 'wl-chip',
      key: 'root',
      title: '回到全部实体',
      onClick: resetGraphView,
    }, '全部实体'),
  ]
  trail.forEach((item, index) => {
    crumbs.push(h('button', {
      className: 'wl-chip',
      key: 't' + index,
      onClick: () => {
        state.graphTrail = trail.slice(0, index)
        loadGraphView(item)
      },
    }, item))
  })
  crumbs.push(h('span', { className: 'wl-crumb-here', key: 'here' }, currentLabel))
  return h('div', { className: 'wl-row', style: { marginTop: '8px' } }, crumbs)
}

function graphOverview(data) {
  // Per-entity relation count comes from the edge list (additive field on the
  // graph query response) so each card can show how connected it is.
  const degree = {}
  for (const edge of data.edges || []) {
    degree[edge.from] = (degree[edge.from] || 0) + (edge.count || 1)
    degree[edge.to] = (degree[edge.to] || 0) + (edge.count || 1)
  }
  const nodes = (data.nodes || [])
    .map((node) => ({ ...node, relations: degree[node.key] || 0 }))
  const typeCounts = data.types || {}
  const typeChips = [
    ['', '全部 ' + nodes.length],
    ...Object.keys(GRAPH_TYPE_META)
      .filter((type) => typeCounts[type])
      .map((type) => [type, graphTypeLabel(type) + ' ' + typeCounts[type]]),
  ]
  const current = state.graphType
  const shown = current ? nodes.filter((node) => node.type === current) : nodes
  return h(
    'div',
    null,
    h('div', { className: 'wl-hint' },
      '节点 ' + (data.nodeCount || 0) + ' · 关系 ' + (data.edgeCount || 0) +
      (data.builtAt ? ' · 构建于 ' + String(data.builtAt).slice(5, 16).replace('T', ' ') : '') +
      '。点实体卡片看关系图。'),
    typeChips.length > 1
      ? h('div', { className: 'wl-row', style: { marginTop: '8px' } },
          typeChips.map(([type, label]) =>
            h('button', {
              className: 'wl-chip' + (current === type ? ' on' : ''),
              key: type || 'all',
              onClick: () => { state.graphType = type; render() },
            }, label),
          ))
      : null,
    shown.length
      ? h('div', { className: 'wl-grid-cards', style: { marginTop: '8px' } },
          shown.map((node) =>
            h('button', {
              className: 'wl-entity-card',
              key: node.key,
              title: node.label + '（' + graphTypeLabel(node.type) + '，' + node.relations + ' 条关系，' + node.weight + ' 次出现）',
              onClick: () => openGraphEntity(node.label),
            },
              h('span', { className: 'wl-entity-name' }, node.label),
              h('span', { className: 'wl-entity-meta' },
                h('span', { className: 'wl-tag ' + node.type }, graphTypeLabel(node.type)),
                h('span', { className: 'wl-hint' }, node.relations + ' 关系'),
              ),
            ),
          ))
      : h('div', { className: 'wl-empty' }, current ? '该类型下没有实体，换个类型看看。' : '暂无实体（在归档与采集积累后点「更新图谱」）'),
  )
}

// --- Neighborhood SVG (self-contained: the panel sandbox has no external
// resources, so the graph is built as an SVG string and mounted with
// innerHTML; clicks are delegated on the wrapper). Deterministic spoke
// layout — center entity, one relation per spoke, no force simulation.
function escapeXml(text) {
  return String(text ?? '').replace(/[<>&"']/g, (ch) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]
  ))
}

function clipLabel(text, max) {
  const value = String(text ?? '')
  return value.length > max ? value.slice(0, max) + '…' : value
}

function neighborhoodSvg(centerLabel, centerType, relations) {
  const W = 520
  const H = Math.max(200, Math.min(336, 104 + relations.length * 44))
  const cx = W / 2
  const cy = H / 2
  const rx = W / 2 - 74
  const ry = H / 2 - 46
  const NODE_W = 104
  const parts = []
  relations.forEach((relation, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / relations.length
    const nx = cx + rx * Math.cos(angle)
    const ny = cy + ry * Math.sin(angle)
    parts.push(`<line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" class="gedge"/>`)
    const verb = clipLabel(relation.kind, 6) + (relation.count > 1 ? ' ×' + relation.count : '')
    parts.push(`<text x="${((cx + nx) / 2).toFixed(1)}" y="${((cy + ny) / 2).toFixed(1)}" class="gverb">${escapeXml(verb)}</text>`)
    parts.push(
      '<g class="gnode" data-entity="' + escapeXml(relation.other) + '">' +
      `<title>${escapeXml(relation.other + '（' + graphTypeLabel(relation.otherType) + '）· 点击继续遍历')}</title>` +
      `<rect x="${nx - NODE_W / 2}" y="${ny - 14}" width="${NODE_W}" height="28" rx="8" class="gnbox t-${escapeXml(relation.otherType || 'topic')}"/>` +
      `<text x="${nx}" y="${ny + 3.5}" class="glabel">${escapeXml(clipLabel(relation.other, 8))}</text>` +
      '</g>',
    )
  })
  parts.push(
    '<g class="gnode center">' +
    `<title>${escapeXml(centerLabel + '（' + graphTypeLabel(centerType) + '）')}</title>` +
    `<rect x="${cx - 64}" y="${cy - 18}" width="128" height="36" rx="9" class="gnbox t-${escapeXml(centerType || 'topic')}"/>` +
    `<text x="${cx}" y="${cy + 4}" class="glabel strong">${escapeXml(clipLabel(centerLabel, 10))}</text>` +
    '</g>',
  )
  return `<svg viewBox="0 0 ${W} ${H}" class="wl-graph-svg" role="img" aria-label="${escapeXml(centerLabel)} 的关系图">${parts.join('')}</svg>`
}

function graphNeighborhood(data) {
  const relations = data.relations || []
  if (!relations.length) return null
  const box = h('div', { className: 'wl-graph-wrap', style: { marginTop: '8px' } })
  box.innerHTML = neighborhoodSvg(data.label, data.type, relations)
  box.addEventListener('click', (event) => {
    const node = event.target?.closest?.('g[data-entity]')
    if (!node) return
    state.graphTrail = [...(state.graphTrail || []), state.graphEntity].slice(-8)
    loadGraphView(node.getAttribute('data-entity'))
  })
  return box
}

function graphEntityView(data) {
  if (!data.found) {
    return h(
      'div',
      null,
      graphBreadcrumb(data.entity),
      h('div', { className: 'wl-empty' }, '没有找到实体：' + data.entity + '（回列表换个实体试试）'),
    )
  }
  const relations = data.relations || []
  return h(
    'div',
    null,
    graphBreadcrumb(data.label),
    h('div', { className: 'wl-hint', style: { marginTop: '4px' } },
      data.label + '（' + graphTypeLabel(data.type) + '）· ' + data.weight + ' 次出现 · ' + relations.length + ' 条关系'),
    graphNeighborhood(data),
    h(
      'div',
      { className: 'wl-section' },
      h('div', { className: 'wl-section-title' }, '关系明细'),
      relations.length
        ? relations.map((relation) =>
            h(
              'div',
              { className: 'wl-row', key: relation.kind + relation.other },
              h('span', { className: 'wl-tag' }, relation.kind),
              h(
                'button',
                {
                  className: 'wl-chip grow',
                  title: '跳到该实体',
                  onClick: () => {
                    state.graphTrail = [...(state.graphTrail || []), state.graphEntity].slice(-8)
                    loadGraphView(relation.other)
                  },
                },
                (relation.direction === 'out' ? '→ ' : '← ') + relation.other + '（' + graphTypeLabel(relation.otherType) + '）',
              ),
              h('span', { className: 'wl-hint' }, String(relation.count) + ' 次'),
            ),
          )
        : h('div', { className: 'wl-empty' }, '暂无关系记录。'),
    ),
  )
}

async function loadSessIndex() {
  if (state.sessIndex || state.sessIndexLoading) return
  state.sessIndexLoading = true
  try {
    state.sessIndex = await call('sessions', { action: 'index_status' })
  } catch {
    state.sessIndex = { builtAt: '', total: 0 }
  } finally {
    state.sessIndexLoading = false
  }
  render()
}

// Library · sessions view source filter options (matches querySessions's
// source equality filter). Multiple custom roots share id 'custom' — dedupe.
async function loadSessSources() {
  if (state.sessSources || state.sessSourcesLoading) return
  state.sessSourcesLoading = true
  try {
    const data = await call('sessions', { action: 'sources' })
    const list = Array.isArray(data?.sources) ? data.sources : []
    const seen = new Set()
    state.sessSources = list.filter((source) => (seen.has(source.id) ? false : seen.add(source.id)))
  } catch {
    state.sessSources = []
  } finally {
    state.sessSourcesLoading = false
  }
  render()
}

function sessFilterValue(key, value) {
  state.sessFilters[key] = value
}

function sessToggleKey(key) {
  const set = new Set(state.sessChecked)
  if (set.has(key)) set.delete(key)
  else set.add(key)
  state.sessChecked = [...set]
  render()
}

function sessAllKeys() {
  const page = state.sessResult?.sessions || []
  const set = new Set(state.sessChecked)
  if (set.size === page.length && page.length) state.sessChecked = []
  else state.sessChecked = page.map((item) => item.key)
  render()
}

async function runSessQuery() {
  await act('sess-query', async () => {
    const f = state.sessFilters
    state.sessResult = await call('sessions', {
      action: 'query',
      q: f.q, project: f.project, source: f.source, start: f.start, end: f.end,
      minTurns: Number(f.minTurns) || 0,
      workOnly: Boolean(f.workOnly),
      workKeywords: String(f.workKeywords || '').split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      groupBy: state.sessGroupBy,
    })
    state.sessChecked = []
  })
}

async function syncAllSessions(force) {
  await act('sess-sync', async () => {
    const result = await call('sessions', { action: 'sync_all', force })
    state.sessIndex = { builtAt: result.builtAt, total: result.total }
    setNotice('ok', '全量同步完成：' + result.total + ' 个会话' + (result.errors?.length ? '（' + result.errors.length + ' 个来源报错）' : ''))
  })
}

function sessRow(session) {
  const checked = state.sessChecked.includes(session.key)
  const expanded = (state.sessExpanded || []).includes(session.key)
  const toggleExpand = () => {
    const set = new Set(state.sessExpanded || [])
    if (set.has(session.key)) set.delete(session.key)
    else set.add(session.key)
    state.sessExpanded = [...set]
    render()
  }
  return h(
    'div',
    { className: 'wl-item', key: session.key },
    h('input', { className: 'wl-check', type: 'checkbox', checked, title: '选择该会话', 'aria-label': '选择会话：' + session.title, onChange: () => sessToggleKey(session.key) }),
    h(
      'div',
      { className: 'grow' },
      h(
        'button',
        { className: 'wl-click wl-item-title', onClick: toggleExpand, title: '点击展开/收起详情' },
        (expanded ? '▾ ' : '▸ ') + session.title,
      ),
      h(
        'div',
        { className: 'wl-item-meta' },
        h('span', { className: 'wl-tag' }, session.label),
        session.group ? h('span', { className: 'wl-tag mid' }, '@' + session.group) : null,
        (session.marks || []).map((mark) => h('span', { className: 'wl-carry' }, '#' + mark)),
        session.project ? h('span', null, session.project) : null,
        h('span', null, session.last + (session.datesCount > 1 ? '（' + session.datesCount + ' 天）' : '')),
        h('span', null, session.turns + ' 轮'),
      ),
      expanded
        ? [
            h(
              'div',
              { className: 'wl-hint', style: { marginTop: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } },
              (session.preview || '（无摘录）') +
                '\n目录：' + (session.cwd || '—') +
                '\n文件：' + (session.file || '—') +
                '\n日期：' + session.first + ' ~ ' + session.last,
            ),
            state.sessContent[session.key] === undefined
              ? h(
                  'button',
                  {
                    className: 'wl-btn tiny',
                    style: { marginTop: '4px' },
                    disabled: state.busy === 'sess-content',
                    onClick: () =>
                      act('sess-content', async () => {
                        const data = await call('sessions', { action: 'content', key: session.key })
                        state.sessContent[session.key] = data
                      }, { refresh: false }),
                  },
                  '加载完整摘录',
                )
              : sessContentNode(state.sessContent[session.key]),
          ]
        : null,
    ),
  )
}

function sessContentNode(data) {
  if (!data) return null
  if (!data.available) return h('div', { className: 'wl-carry', style: { marginTop: '4px' } }, data.note || '源文件不可读')
  if (!(data.dates || []).length) return h('div', { className: 'wl-hint', style: { marginTop: '4px' } }, '没有缓存的摘录（可在设置里把该工具目录加入会话目录后重新同步）')
  return h(
    'div',
    { className: 'wl-list', style: { marginTop: '4px' } },
    data.dates.map((day) =>
      h(
        'div',
        { className: 'wl-item', key: day.date },
        h(
          'div',
          { className: 'grow' },
          h('div', { className: 'wl-item-meta' }, day.date + ' · ' + day.turns + ' 轮 · 用户提问摘录 ' + day.texts.length + ' 条'),
          day.texts.map((text, index) =>
            h('div', { className: 'wl-hint', key: index, style: { marginTop: '2px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, '· ' + text),
          ),
        ),
      ),
    ),
  )
}

function sessionsV2Block() {
  loadSessIndex()
  loadSessSources()
  const f = state.sessFilters
  const result = state.sessResult
  const checkedCount = state.sessChecked.length
  const groupOptions = [['', '不分组'], ['project', '按项目'], ['source', '按来源'], ['date', '按日期'], ['mark', '按标记'], ['group', '按自定义组']]
  const groups = result?.groups || {}
  const groupEntries = Object.entries(groups)
  const groupedRender = state.sessGroupBy && groupEntries.length
    ? groupEntries.sort((a, b) => a[0].localeCompare(b[0])).map(([groupName, keys]) =>
        h(
          'div',
          { className: 'wl-section', key: groupName },
          h('div', { className: 'wl-section-title' }, groupName + '（' + keys.length + '）'),
          keys
            .map((key) => (result.sessions || []).find((item) => item.key === key))
            .filter(Boolean)
            .map(sessRow),
        ),
      )
    : null
  return h(
    'div',
    { className: 'wl-card wide' },
    h(
      'div',
      { className: 'wl-row' },
      h('button', { className: 'wl-btn primary', disabled: state.busy === 'sess-sync', onClick: () => syncAllSessions(false) }, '同步会话'),
      h('button', { className: 'wl-btn', disabled: state.busy === 'sess-sync', onClick: () => syncAllSessions(true) }, '强制重扫'),
      h('span', { className: 'wl-hint' }, '首次同步可能需要 1-2 分钟'),
      h('span', { className: 'wl-hint' },
        state.sessIndex?.total
          ? '索引 ' + state.sessIndex.total + ' 条 · ' + String(state.sessIndex.builtAt).slice(5, 16).replace('T', ' ')
          : '暂无会话索引，点「同步会话」开始。'),
    ),
    h(
      'div',
      { className: 'wl-row', style: { marginTop: '8px' } },
      h('input', { className: 'wl-input', placeholder: '关键词', value: f.q, onInput: (e) => sessFilterValue('q', e.target.value), style: { width: '120px' } }),
      h('input', { className: 'wl-input', placeholder: '项目/目录', value: f.project, onInput: (e) => sessFilterValue('project', e.target.value), style: { width: '120px' } }),
      state.sessSources?.length
        ? h(
            'select',
            {
              className: 'wl-select',
              value: f.source || '',
              title: '按会话来源筛选',
              onChange: (e) => sessFilterValue('source', e.target.value),
            },
            h('option', { value: '' }, '全部来源'),
            state.sessSources.map((source) => h('option', { value: source.id }, source.label)),
          )
        : null,
      h('input', { className: 'wl-input', type: 'date', value: f.start, onInput: (e) => sessFilterValue('start', e.target.value), style: { width: '128px' } }),
      h('input', { className: 'wl-input', type: 'date', value: f.end, onInput: (e) => sessFilterValue('end', e.target.value), style: { width: '128px' } }),
    ),
    h(
      'div',
      { className: 'wl-row', style: { marginTop: '8px' } },
      h('input', { className: 'wl-input', type: 'number', placeholder: '最少轮次', value: f.minTurns, onInput: (e) => sessFilterValue('minTurns', e.target.value), style: { width: '80px' } }),
      h('input', { className: 'wl-input', placeholder: '工作关键词(逗号)', value: f.workKeywords, onInput: (e) => sessFilterValue('workKeywords', e.target.value), style: { width: '150px' } }),
      h('label', { className: 'wl-hint' },
        h('input', { className: 'wl-check', type: 'checkbox', checked: Boolean(f.workOnly), onChange: (e) => { sessFilterValue('workOnly', e.target.checked); render() } }),
        ' 仅工作相关'),
      h('button', { className: 'wl-btn primary', disabled: state.busy === 'sess-query', onClick: runSessQuery }, '查询'),
      h('button', { className: 'wl-btn', onClick: () => { state.sessFilters = { q: '', project: '', source: '', start: '', end: '', minTurns: '', workOnly: false, workKeywords: '' }; state.sessResult = null; state.sessChecked = []; render() } }, '重置'),
    ),
    result && result.keywords?.length
      ? h('div', { className: 'wl-row', style: { marginTop: '8px' } },
          h('span', { className: 'wl-hint' }, '关键词：'),
          result.keywords.map((item) =>
            h('button', { className: 'wl-chip', key: item.word, onClick: () => { sessFilterValue('q', item.word); runSessQuery() } },
              item.word + ' ' + item.count)))
      : null,
    result
      ? h('div', { className: 'wl-hint', style: { marginTop: '8px' } },
          '命中 ' + result.matched + ' / 索引 ' + result.total + ' 条' + (result.matched > 200 ? '（显示前 200）' : ''))
      : null,
    result
      ? h(
          'div',
          { className: 'wl-row', style: { marginTop: '4px' } },
          h(
            'select',
            { className: 'wl-select', style: { width: '110px' }, value: state.sessGroupBy, onChange: (e) => { state.sessGroupBy = e.target.value; runSessQuery() } },
            groupOptions.map(([value, label]) => h('option', { value, selected: state.sessGroupBy === value }, label)),
          ),
          h('button', { className: 'wl-btn tiny', onClick: sessAllKeys }, checkedCount === (result.sessions || []).length && checkedCount ? '取消全选' : '全选本页'),
          h('input', { className: 'wl-input', placeholder: '标记名', value: state.sessMark, onInput: (e) => { state.sessMark = e.target.value }, style: { width: '90px' } }),
          h('button', { className: 'wl-btn tiny', disabled: !checkedCount || state.busy === 'sess-mark', onClick: () => act('sess-mark', async () => {
            await call('sessions', { action: 'mark', keys: state.sessChecked, mark: state.sessMark })
            setNotice('ok', '已标记 ' + state.sessChecked.length + ' 条')
            state.sessResult = null
          }) }, '标记'),
          h('button', { className: 'wl-btn tiny', disabled: !checkedCount || state.busy === 'sess-mark', onClick: () => act('sess-mark', async () => {
            await call('sessions', { action: 'unmark', keys: state.sessChecked, mark: state.sessMark })
            setNotice('ok', '已取消标记')
            state.sessResult = null
          }) }, '去标记'),
          h('input', { className: 'wl-input', placeholder: '自定义组名', value: state.sessGroupInput, onInput: (e) => { state.sessGroupInput = e.target.value }, style: { width: '100px' } }),
          h('button', { className: 'wl-btn tiny', disabled: !checkedCount || state.busy === 'sess-group', onClick: () => act('sess-group', async () => {
            await call('sessions', { action: 'group', keys: state.sessChecked, group: state.sessGroupInput })
            setNotice('ok', '已设组：' + (state.sessGroupInput || '(清除)'))
            state.sessResult = null
          }) }, '设组'),
        )
      : null,
    result
      ? groupedRender || h(
          'div',
          { className: 'wl-list', style: { marginTop: '4px' } },
          (result.sessions || []).map(sessRow),
        )
      : null,
  )
}

// Library tab: segmented sessions / logs / graph sub-views — the panel's
// single "look things up" surface. The only calendar stays on the time tab.
function libraryTab() {
  const views = [
    ['sessions', '会话'],
    ['logs', '日志'],
    ['graph', '图谱'],
  ]
  return h(
    'div',
    { className: 'wl-stack' },
    noticeNode(),
    h(
      'div',
      { className: 'wl-seg' },
      views.map(([value, label]) =>
        h(
          'button',
          {
            className: state.libView === value ? 'on' : '',
            onClick: () => {
              state.libView = value
              render()
            },
          },
          label,
        ),
      ),
    ),
    state.libView === 'sessions' ? sessionsV2Block() : state.libView === 'logs' ? logsView() : graphView(),
  )
}

// Overlay confirm dialog for overwrite/destructive actions (report regen,
// day regen). Purely a front-end gate: the op runs only from confirm.run.
function confirmModalNode() {
  const box = state.confirm
  if (!box) return null
  // Default focus lands on the least-destructive button; Escape and clicking
  // the backdrop both close without running the op.
  setTimeout(() => {
    if (state.confirm === box && !box.focusDone) {
      document.querySelector('.wl-modal button')?.focus?.()
      box.focusDone = true
    }
  }, 0)
  return h(
    'div',
    {
      className: 'wl-modal',
      onClick: (event) => {
        if (event.target === event.currentTarget) {
          state.confirm = null
          render()
        }
      },
    },
    h(
      'div',
      { className: 'wl-modal-box' },
      h('div', { className: 'wl-modal-title' }, box.title),
      h('div', { className: 'wl-modal-body' }, box.body),
      h(
        'div',
        { className: 'wl-row', style: { justifyContent: 'flex-end', marginTop: '12px' } },
        h(
          'button',
          {
            className: 'wl-btn',
            onClick: () => {
              state.confirm = null
              render()
            },
          },
          '取消',
        ),
        h(
          'button',
          {
            className: 'wl-btn primary',
            onClick: () => {
              const run = box.run
              state.confirm = null
              render()
              if (run) run()
            },
          },
          box.okLabel || '确认',
        ),
      ),
    ),
  )
}

function render() {
  if (!TABS.some(([key]) => key === state.tab)) state.tab = 'today'
  const root = document.getElementById('app')
  if (!root) return
  root.replaceChildren(
    h(
      'div',
      { className: 'wl-head' },
      h(
        'div',
        { className: 'wl-title-row' },
        h('span', { className: `wl-dot${state.status?.today?.archived ? '' : ' off'}` }),
        'WorkLog',
        h(
          'span',
          { className: 'wl-hint', style: { marginLeft: 'auto' } },
          state.status?.today?.date || '',
        ),
      ),
      h('div', { className: 'wl-head-sub' }, state.config?.dataDir || ''),
    ),
    h('div', { className: 'wl-tabs' }, TABS.map(([key, label]) => tabButton(key, label))),
    h(
      'div',
      { className: 'wl-body' },
      state.tab === 'today'
        ? todayTab()
        : state.tab === 'time'
          ? timeTab()
          : state.tab === 'library'
            ? libraryTab()
            : state.tab === 'report'
              ? reportTab()
              : settingsTab(),
      confirmModalNode(),
    ),
  )
}
function applyHostContext(context) {
  if (context?.theme) applyDocumentTheme(context.theme)
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables)
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts)
}

app.onhostcontextchanged = (context) => {
  applyHostContext(context)
}

// Escape closes the confirm dialog without running the op.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.confirm) {
    state.confirm = null
    render()
  }
})

async function main() {
  // The boot fallback in panel.html only covers "this bundle never ran";
  // bridge and call timeouts below produce their own messages.
  markMounted()
  try {
    await withTimeout(
      app.connect(),
      CONNECT_TIMEOUT_MS,
      '连接 ZCode 面板桥超时。面板由插件内置提供，不需要外部 WorkLog 应用；请关闭面板后重开，或重启 ZCode。',
    )
    applyHostContext(app.getHostContext())
    await refreshAll()
    render()
    // The default tab is today: run its lazy loaders once on boot too (they
    // are click-triggered for every later tab switch).
    loadYesterday().then(render, () => render())
    if (!state.recoData && !state.recoLoading) loadReco().then(render, () => render())
  } catch (error) {
    const root = document.getElementById('app')
    if (root) {
      root.replaceChildren(
        h(
          'div',
          { className: 'wl-notice err', style: { margin: '16px' } },
          `WorkLog 面板初始化失败：${String(error?.message || error)}`,
        ),
      )
    }
  }
}

main()
