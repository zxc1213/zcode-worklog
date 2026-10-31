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
  ['overview', '概览'],
  ['logs', '日志'],
  ['todos', '待办'],
  ['reports', '汇报'],
  ['sessions', '会话'],
  ['settings', '设置'],
]

const REPORT_KINDS = [
  ['weekly', '周报'],
  ['daily', '日报'],
  ['month', '月报'],
  ['quarter', '季报'],
  ['perf', '绩效素材'],
  ['project', '项目档案'],
]

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

const state = {
  tab: 'overview',
  busy: '',
  notice: null,
  status: null,
  days: [],
  todos: [],
  todoFilter: { pri: '', tag: '' },
  editingTodo: null,
  editingDraft: null,
  reports: [],
  backups: [],
  config: null,
  settings: null,
  log: { date: today(), text: '', exists: false, loaded: false },
  hits: [],
  reportText: '',
  reportKind: 'weekly',
  reportPeriod: today(),
  reportUseAi: false,
  importDir: '',
  sessions: { date: today(), result: null, sources: null },
  aiCandidates: null,
  aiBusy: false,
  aiPick: '',
  aiModels: [],
  aiModelsBusy: false,
  aiModelsNote: '',
  settingsOpen: { data: false, ai: false, backup: false, import: false },
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
  if (state.busy) return
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
        if (key === 'logs' && !state.log.loaded) {
          loadLog(state.log.date).then(render, (error) => {
            setNotice('err', String(error?.message || error))
            render()
          })
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

function card(label, value, sub, wide) {
  return h(
    'div',
    { className: `wl-card${wide ? ' wide' : ''}` },
    h('div', { className: 'wl-k' }, label),
    h('div', { className: `wl-v${String(value).length > 16 ? ' small' : ''}` }, value),
    sub ? h('div', { className: 'wl-hint' }, sub) : null,
  )
}

function priorityTag(pri) {
  if (!pri) return null
  const tone = pri === '高' ? 'high' : pri === '中' ? 'mid' : 'low'
  return h('span', { className: `wl-tag ${tone}` }, pri)
}

async function loadLog(date) {
  const data = await call('day', { date })
  state.log = { date: data.date || date, text: data.text || '', exists: Boolean(data.exists), loaded: true }
  return data
}

function overviewTab() {
  const status = state.status
  if (!status) return h('div', { className: 'wl-empty' }, '加载中…')
  const projects = status.projects || []
  const config = status.config || {}

  return h(
    'div',
    null,
    noticeNode(),
    h(
      'div',
      { className: 'wl-grid' },
      card('今天', status.today?.archived ? '已归档' : '未归档', status.today?.date),
      card('日志总数', `${status.days?.count || 0} 天`, `最近 ${status.days?.latest?.[0]?.date || '—'}`),
      card(
        '待办',
        `${status.todos?.open || 0} 进行中`,
        status.todos?.overdue ? `${status.todos.overdue} 条已逾期` : `共 ${status.todos?.count || 0} 条`,
      ),
      card('项目', `${projects.length} 个`, `${status.backups?.count || 0} 份备份`),
      card('AI 会话', `${status.sessions?.count || 0} 场`, `${status.sessions?.turns || 0} 轮`),
    ),
    h(
      'div',
      { className: 'wl-toolbar' },
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
                  ? `已归档 ${result.date}：${result.commitCount} 个提交 / ${result.docCount} 个文档 / ${result.sessionCount || 0} 个会话`
                  : `${result.date} 已有归档，未覆盖。可在「日志」页强制重新归档。`,
              )
              if (state.log.date === today()) state.log.loaded = false
            }),
        },
        state.busy === 'archive-today' ? '归档中…' : '归档今天',
      ),
      h(
        'button',
        {
          className: 'wl-btn',
          onClick: () => {
            state.tab = 'logs'
            if (!state.log.loaded) loadLog(state.log.date).then(render, () => render())
            render()
          },
        },
        '打开日志',
      ),
      h(
        'button',
        {
          className: 'wl-btn',
          onClick: () => act('refresh', async () => setNotice('ok', '已刷新')),
        },
        '刷新',
      ),
    ),
    config.scanRoots?.length || config.effectiveScanRoots?.length
      ? null
      : h('div', { className: 'wl-notice info' }, '还没有配置扫描根目录；归档时默认扫描当前工作区。可在「设置」里添加。'),
    h('div', { className: 'wl-label' }, '最近日志'),
    state.days.length
      ? h(
          'div',
          { className: 'wl-list' },
          state.days.slice(0, 8).map((day) =>
            h(
              'div',
              { className: 'wl-item', key: day.date },
              h(
                'button',
                {
                  className: 'wl-click grow',
                  onClick: () => {
                    state.tab = 'logs'
                    loadLog(day.date).then(render, (error) => {
                      setNotice('err', String(error?.message || error))
                      render()
                    })
                  },
                },
                h('div', { className: 'wl-item-title' }, day.date),
                h('div', { className: 'wl-item-meta' }, day.relative),
              ),
            ),
          ),
        )
      : h('div', { className: 'wl-empty' }, '还没有归档。点「归档今天」开始。'),
    h('div', { className: 'wl-label' }, '项目'),
    projects.length
      ? h(
          'div',
          { className: 'wl-list' },
          projects.slice(0, 8).map((project) =>
            h(
              'div',
              { className: 'wl-item', key: project.name },
              h(
                'div',
                { className: 'grow' },
                h('div', { className: 'wl-item-title' }, project.name),
                h('div', { className: 'wl-item-meta' }, `${project.days.length} 天 · ${project.commits} 提交`),
              ),
            ),
          ),
        )
      : h('div', { className: 'wl-empty' }, '还没有从归档中解析到项目。'),
    h('div', { className: 'wl-label' }, '今天的 AI 会话'),
    status.sessions?.items?.length
      ? h(
          'div',
          { className: 'wl-list' },
          status.sessions.items.map((session, index) =>
            h(
              'div',
              { className: 'wl-item', key: index },
              h(
                'div',
                { className: 'grow' },
                h('div', { className: 'wl-item-title' }, session.title),
                h(
                  'div',
                  { className: 'wl-item-meta' },
                  h('span', { className: 'wl-tag low' }, session.source),
                  h('span', null, `${session.turns} 轮`),
                  h('span', null, `${session.turns} 轮`),
                  h('span', null, session.start === session.end ? session.start : `${session.start}–${session.end}`),
                ),
              ),
            ),
          ),
        )
      : h('div', { className: 'wl-empty' }, status.today?.archived ? '今天的归档里没有 AI 会话记录。' : '今天还没归档；归档时会自动汇总本机 AI 会话。'),
    status.runHistory?.length
      ? h(
          'div',
          { className: 'wl-section' },
          h('div', { className: 'wl-section-title' }, '最近运行'),
          h(
            'div',
            { className: 'wl-list' },
            status.runHistory.slice(0, 5).map((item, index) =>
              h(
                'div',
                { className: 'wl-item', key: index },
                h(
                  'div',
                  { className: 'grow' },
                  h('div', { className: 'wl-item-title' }, `${item.status || ''} · ${item.date || ''} · ${item.mode || ''}`),
                  h('div', { className: 'wl-item-meta' }, item.note || ''),
                ),
              ),
            ),
          ),
        )
      : null,
  )
}

function logsTab() {
  const log = state.log
  return h(
    'div',
    null,
    noticeNode(),
    h(
      'div',
      { className: 'wl-date-row' },
      h('input', {
        className: 'wl-input',
        value: log.date,
        placeholder: 'YYYY-MM-DD',
        onInput: (event) => {
          log.date = event.target.value
        },
      }),
      h(
        'button',
        {
          className: 'wl-btn',
          disabled: state.busy === 'load',
          onClick: () =>
            act(
              'load',
              async () => {
                await loadLog(log.date)
              },
              { refresh: false },
            ),
        },
        '读取',
      ),
    ),
    h(
      'div',
      { className: 'wl-toolbar' },
      h(
        'button',
        {
          className: 'wl-btn primary',
          disabled: state.busy === 'save',
          onClick: () =>
            act(
              'save',
              async () => {
                await call('day', { date: log.date, text: log.text })
                setNotice('ok', `已保存 ${log.date}`)
                log.exists = true
              },
              { refresh: false },
            ),
        },
        '保存',
      ),
      h(
        'button',
        {
          className: 'wl-btn',
          disabled: state.busy === 'rearchive',
          onClick: () =>
            act(
              'rearchive',
              async () => {
                const result = await call('archive', { action: 'run', date: log.date, force: true })
                await loadLog(log.date)
                setNotice('ok', `已重新归档：${result.commitCount} 个提交 / ${result.docCount} 个文档`)
              },
              { refresh: false },
            ),
        },
        state.busy === 'rearchive' ? '归档中…' : '重新归档',
      ),
      h(
        'button',
        {
          className: 'wl-btn',
          disabled: state.busy === 'daily',
          onClick: () =>
            act(
              'daily',
              async () => {
                const result = await call('report', { action: 'generate', kind: 'daily', date: log.date })
                state.reportText = result.text || ''
                state.tab = 'reports'
                setNotice('ok', `日报已生成：${result.name}`)
              },
              { refresh: false },
            ),
        },
        '生成日报',
      ),
    ),
    log.exists ? null : h('div', { className: 'wl-notice info' }, '这一天还没有归档，可以直接写，或点「重新归档」扫描 Git/文档。'),
    h('textarea', {
      className: 'wl-area',
      value: log.text,
      placeholder: '# 工作日志\n\n## 今日概览\n…',
      onInput: (event) => {
        log.text = event.target.value
      },
    }),
    h('div', { className: 'wl-label' }, '搜索归档'),
    h(
      'div',
      { className: 'wl-date-row' },
      h('input', {
        className: 'wl-input',
        id: 'wl-query',
        placeholder: '关键词，例如 巡检 / 数据采集',
        onKeydown: (event) => {
          if (event.key === 'Enter') runSearch()
        },
      }),
      h('button', { className: 'wl-btn', onClick: runSearch }, '搜索'),
    ),
    state.hits.length
      ? h(
          'div',
          { className: 'wl-list' },
          state.hits.map((hit) =>
            h(
              'div',
              { className: 'wl-item', key: hit.date },
              h(
                'button',
                {
                  className: 'wl-click grow',
                  onClick: () => {
                    loadLog(hit.date).then(render, (error) => {
                      setNotice('err', String(error?.message || error))
                      render()
                    })
                  },
                },
                h('div', { className: 'wl-item-title' }, `${hit.date}（${hit.count} 处）`),
                h('div', { className: 'wl-item-meta' }, hit.snippet),
              ),
            ),
          ),
        )
      : null,
    h('div', { className: 'wl-label' }, '全部日志'),
    state.days.length
      ? h(
          'div',
          { className: 'wl-list' },
          state.days.slice(0, 60).map((day) =>
            h(
              'div',
              { className: 'wl-item', key: day.date },
              h(
                'button',
                {
                  className: 'wl-click grow',
                  onClick: () => {
                    loadLog(day.date).then(render, (error) => {
                      setNotice('err', String(error?.message || error))
                      render()
                    })
                  },
                },
                h('div', { className: 'wl-item-title' }, day.date),
                h('div', { className: 'wl-item-meta' }, day.relative),
              ),
            ),
          ),
        )
      : h('div', { className: 'wl-empty' }, '还没有日志。'),
  )
}

function runSearch() {
  const input = document.getElementById('wl-query')
  const query = input?.value?.trim() || ''
  if (!query) return
  act(
    'search',
    async () => {
      state.hits = await call('search', { query })
      if (!state.hits.length) setNotice('info', '没有找到匹配的归档。')
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

function todosTab() {
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
    null,
    noticeNode(),
    h(
      'div',
      { className: 'wl-card wide' },
      h(
        'div',
        { className: 'wl-row' },
        h('input', {
          className: 'wl-input',
          id: 'wl-todo-title',
          placeholder: '新待办，支持 !高 / @2026-10-31',
          onKeydown: (event) => {
            if (event.key === 'Enter') addTodoFromForm()
          },
        }),
        h(
          'button',
          {
            className: 'wl-btn primary',
            disabled: state.busy === 'todo-add',
            onClick: addTodoFromForm,
          },
          '添加',
        ),
      ),
      h(
        'div',
        { className: 'wl-row', style: { marginTop: '6px' } },
        h(
          'select',
          { className: 'wl-select', id: 'wl-todo-pri', style: { width: '86px' } },
          h('option', { value: '' }, '优先级'),
          h('option', { value: '高' }, '高'),
          h('option', { value: '中' }, '中'),
          h('option', { value: '低' }, '低'),
        ),
        h('input', { className: 'wl-input', id: 'wl-todo-due', type: 'date', style: { width: '136px' } }),
        h(
          'button',
          {
            className: 'wl-btn',
            disabled: state.busy === 'todo-clear',
            onClick: () =>
              act('todo-clear', async () => {
                const result = await call('todos', { action: 'clear_done' })
                setNotice('ok', `已清空 ${result.removed} 条已完成待办`)
              }),
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
        onClick: () =>
          act('todo-del', async () => {
            await call('todos', { action: 'delete', id: todo.id })
          }),
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
        { className: 'wl-row', style: { marginTop: '6px' } },
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
        style: { marginTop: '6px' },
        onInput: harvest,
      }, draft.md || ''),
      h('input', {
        className: 'wl-input',
        id: 'wl-edit-tags',
        placeholder: '标签，空格分隔，如：周报 okr',
        style: { marginTop: '6px' },
        onInput: harvest,
      }, draft.tags || ''),
      h(
        'div',
        { className: 'wl-section', style: { marginTop: '6px' } },
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
              '删',
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
        { className: 'wl-row', style: { marginTop: '6px' } },
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

function addTodoFromForm() {
  const titleInput = document.getElementById('wl-todo-title')
  const raw = titleInput?.value?.trim() || ''
  if (!raw) return
  const priSelect = document.getElementById('wl-todo-pri')
  const addPri = priSelect?.value || ''
  const dueInput = document.getElementById('wl-todo-due')
  const addDue = dueInput?.value || ''
  const priMatch = raw.match(/!(高|中|低)/)
  const dueMatch = raw.match(/@(\d{4}-\d{2}-\d{2})/)
  const repeatMatch = raw.match(/repeat=(daily|weekly:[0-6]|monthly:(?:[1-9]|[12]\d|3[01]))/)
  const tagMatches = raw.match(/#[^\s#@!]+/g) || []
  const tags = [...new Set(tagMatches.map((item) => item.slice(1)))]
  const title = raw
    .replace(/!(高|中|低)/g, '')
    .replace(/@\d{4}-\d{2}-\d{2}/g, '')
    .replace(/repeat=\S+/g, '')
    .replace(/#[^\s#@!]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title) {
    setNotice('err', '标题不能为空（只留下了标记符号）')
    render()
    return
  }
  const pri = addPri || (priMatch ? priMatch[1] : '')
  const due = addDue || (dueMatch ? dueMatch[1] : '')
  const repeat = repeatMatch ? repeatMatch[1] : ''
  act('todo-add', async () => {
    await call('todos', { action: 'add', title, pri, due, repeat, tags })
    if (titleInput) titleInput.value = ''
    setNotice('ok', `已添加：${title}`)
  })
}

function reportsTab() {
  const kind = state.reportKind
  const placeholder =
    kind === 'weekly'
      ? '周一日期（可填任意日期）'
      : kind === 'project'
        ? '项目名'
        : kind === 'month' || kind === 'perf'
          ? 'YYYY-MM'
          : kind === 'quarter'
            ? 'YYYY-Q1..Q4'
            : 'YYYY-MM-DD'
  const aiReady = Boolean(state.config?.ai?.model && state.config?.ai?.hasApiKey)

  return h(
    'div',
    null,
    noticeNode(),
    h(
      'div',
      { className: 'wl-card wide' },
      h(
        'div',
        { className: 'wl-row' },
        h(
          'select',
          {
            className: 'wl-select',
            style: { width: '108px' },
            onChange: (event) => {
              state.reportKind = event.target.value
              state.reportPeriod =
                state.reportKind === 'month' || state.reportKind === 'perf'
                  ? month()
                  : state.reportKind === 'quarter'
                    ? quarter()
                    : state.reportKind === 'project'
                      ? ''
                      : today()
              render()
            },
          },
          REPORT_KINDS.map(([value, label]) =>
            h('option', { value, selected: value === kind }, label),
          ),
        ),
        h('input', {
          className: 'wl-input',
          value: state.reportPeriod,
          placeholder,
          onInput: (event) => {
            state.reportPeriod = event.target.value
          },
        }),
        h(
          'button',
          {
            className: 'wl-btn primary',
            disabled: state.busy === 'report',
            onClick: () =>
              act(
                'report',
                async () => {
                  const body = { action: 'generate', kind: state.reportKind, useAi: state.reportUseAi }
                  if (state.reportKind === 'daily') body.date = state.reportPeriod || today()
                  if (state.reportKind === 'weekly') body.monday = state.reportPeriod || today()
                  if (state.reportKind === 'month' || state.reportKind === 'perf') body.month = state.reportPeriod || month()
                  if (state.reportKind === 'quarter') body.quarter = state.reportPeriod || quarter()
                  if (state.reportKind === 'project') body.project = state.reportPeriod
                  const result = await call('report', body)
                  state.reportText = result.text || ''
                  setNotice('ok', `已生成 ${result.name}${result.ai ? '（AI 润色）' : ''}`)
                },
                { refresh: false },
              ),
          },
          state.busy === 'report' ? '生成中…' : '生成',
        ),
      ),
      aiReady
        ? h(
            'label',
            { className: 'wl-checkline' },
            h('input', {
              type: 'checkbox',
              checked: state.reportUseAi,
              onChange: (event) => {
                state.reportUseAi = event.target.checked
              },
            }),
            '使用已配置的 AI 润色（否则生成确定性草稿）',
          )
        : h('div', { className: 'wl-hint', style: { marginTop: '6px' } }, '未配置 AI 接口，将生成确定性草稿；可在「设置」里配置。'),
    ),
    state.reportText ? h('pre', { className: 'wl-pre' }, state.reportText) : null,
    h('div', { className: 'wl-label' }, '已生成报告'),
    state.reports.length
      ? h(
          'div',
          { className: 'wl-list' },
          state.reports.slice(0, 40).map((report) =>
            h(
              'div',
              { className: 'wl-item', key: report.name },
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
            ),
          ),
        )
      : h('div', { className: 'wl-empty' }, '还没有生成报告。'),
  )
}

async function detectAi() {
  if (state.aiBusy) return
  state.aiBusy = true
  render()
  try {
    const data = await call('ai', { action: 'detect' })
    state.aiCandidates = Array.isArray(data?.candidates) ? data.candidates : []
    state.aiPick = ''
    if (!state.aiCandidates.length) setNotice('info', '没有发现可复用的本机 AI 配置，可在下方手动填写。')
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

async function scanSessionsNow() {
  await act('sessions-scan', async () => {
    const data = await call('sessions', { date: state.sessions.date || today() })
    state.sessions.result = data
    setNotice('ok', `已扫描 ${data.date || state.sessions.date}：${data.totals?.sessions || 0} 场会话 / ${data.totals?.turns || 0} 轮`)
  }, { refresh: false })
}

async function loadSessionSources() {
  await act('sessions-sources', async () => {
    const data = await call('sessions', { action: 'sources' })
    state.sessions.sources = data.sources || []
  }, { refresh: false })
}

function sessionsTab() {
  const sessions = state.sessions
  const result = sessions.result
  return h(
    'div',
    null,
    noticeNode(),
    h(
      'div',
      { className: 'wl-date-row' },
      h('input', {
        className: 'wl-input',
        value: sessions.date,
        placeholder: 'YYYY-MM-DD',
        onInput: (event) => {
          sessions.date = event.target.value
        },
      }),
      h(
        'button',
        {
          className: 'wl-btn primary',
          disabled: state.busy === 'sessions-scan',
          onClick: scanSessionsNow,
        },
        state.busy === 'sessions-scan' ? '扫描中…' : '扫描会话',
      ),
      h(
        'button',
        {
          className: 'wl-btn',
          disabled: state.busy === 'sessions-sources',
          onClick: loadSessionSources,
        },
        '会话源',
      ),
    ),
    h('div', { className: 'wl-hint' }, '只读本机 AI 工具会话（Claude Code / Codex / DeepSeek Harness / WorkBuddy / ZCode / OpenCode / Gemini CLI）；归档时会自动写入日文档。首次扫描解析历史文件，之后按文件 mtime+size 增量缓存。'),
    result
      ? h(
          'div',
          null,
          h(
            'div',
            { className: 'wl-grid', style: { marginTop: '8px' } },
            card('会话', `${result.totals?.sessions || 0} 场`),
            card('用户轮数', `${result.totals?.turns || 0} 轮`),
          ),
          result.errors?.length
            ? h(
                'div',
                { className: 'wl-notice err', style: { marginTop: '7px' } },
                `部分来源读取失败：${result.errors.map((item) => item.source).join('、')}`,
              )
            : null,
          result.sessions?.length
            ? h(
                'div',
                { className: 'wl-list' },
                result.sessions.map((session, index) =>
                  h(
                    'div',
                    { className: 'wl-item', key: index },
                    h(
                      'div',
                      { className: 'grow' },
                      h('div', { className: 'wl-item-title' }, session.title),
                      h(
                        'div',
                        { className: 'wl-item-meta' },
                        h('span', { className: 'wl-tag low' }, session.label),
                        h('span', null, `${session.turns} 轮`),
                        h('span', null, session.timeRange || ''),
                      ),
                      session.cwd
                        ? h('div', { className: 'wl-hint', style: { fontFamily: 'var(--wl-mono)' } }, session.cwd)
                        : null,
                      session.texts?.[0] && session.texts[0] !== session.title
                        ? h('div', { className: 'wl-item-meta' }, session.texts[0])
                        : null,
                    ),
                  ),
                ),
              )
            : h('div', { className: 'wl-empty' }, '这一天没有扫描到 AI 会话。'),
        )
      : null,
    sessions.sources
      ? h(
          'div',
          null,
          h('div', { className: 'wl-label' }, '会话源'),
          h(
            'div',
            { className: 'wl-list' },
            sessions.sources.map((source) =>
              h(
                'div',
                { className: 'wl-item', key: source.id + source.path },
                h(
                  'div',
                  { className: 'grow' },
                  h('div', { className: 'wl-item-title' }, source.label),
                  h('div', { className: 'wl-item-meta', style: { fontFamily: 'var(--wl-mono)' } }, source.path),
                ),
                h('span', { className: `wl-tag ${source.exists ? 'low' : ''}` }, source.exists ? '已找到' : '未安装'),
              ),
            ),
          ),
        )
      : null,
  )
}

function settingsSection(key, title, hint, ...children) {
  const open = Boolean(state.settingsOpen[key])
  return h(
    'div',
    { className: `wl-fold${open ? ' open' : ''}` },
    h(
      'button',
      {
        className: 'wl-fold-head',
        type: 'button',
        'aria-expanded': open ? 'true' : 'false',
        onClick: () => {
          state.settingsOpen[key] = !state.settingsOpen[key]
          render()
        },
      },
      h('span', { className: 'wl-fold-caret' }, open ? '▾' : '▸'),
      h('span', { className: 'wl-fold-title' }, title),
      hint ? h('span', { className: 'wl-hint' }, hint) : null,
    ),
    open ? h('div', { className: 'wl-fold-body' }, ...children) : null,
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

function settingsTab() {
  const draft = state.settings || draftFromConfig(state.config)
  const config = state.config || {}
  const set = (key) => (event) => {
    draft[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value
  }
  const aiHint = config.ai?.model
    ? `${config.ai.model}${config.ai.hasApiKey ? ' · 已配置 Key' : ' · 无 Key'}`
    : '未配置'
  const dataHint = draft.dataDir || config.dataDir || ''

  return h(
    'div',
    null,
    noticeNode(),
    h(
      'div',
      { className: 'wl-savebar' },
      h(
        'button',
        { className: 'wl-btn primary', disabled: state.busy === 'config-save', onClick: saveSettings },
        state.busy === 'config-save' ? '保存中…' : '保存设置',
      ),
      h(
        'button',
        {
          className: 'wl-btn',
          onClick: () => {
            state.settings = draftFromConfig(state.config)
            setNotice('info', '已恢复为上次保存的设置')
            render()
          },
        },
        '撤销修改',
      ),
      h('span', { className: 'wl-hint' }, '折叠分块，改完点保存'),
    ),

    settingsSection(
      'data',
      '数据与扫描',
      dataHint,
      h('div', { className: 'wl-label' }, '数据目录'),
      h('input', { className: 'wl-input', value: draft.dataDir, onInput: set('dataDir') }),
      h('div', { className: 'wl-hint' }, `配置：${config.configFile || ''}`),

      h('div', { className: 'wl-label' }, 'Git 扫描根目录（每行一个，最多向下 3 层）'),
      h('textarea', { className: 'wl-area small', value: draft.scanRoots, onInput: set('scanRoots') }),
      h('div', { className: 'wl-label' }, '文档扫描目录（每行一个，最多向下 6 层）'),
      h('textarea', { className: 'wl-area small', value: draft.docRoots, onInput: set('docRoots') }),
      h('div', { className: 'wl-label' }, '额外 AI 会话目录（每行一个，可选）'),
      h('textarea', { className: 'wl-area small', value: draft.sessionRoots, onInput: set('sessionRoots') }),
      h('div', { className: 'wl-hint' }, '自动扫描：~/.claude/projects、~/.codex/sessions、$DSH_HOME/sessions、~/.workbuddy/projects、~/.zcode（数据库）、~/.local/share/opencode、~/.gemini/tmp。'),
      h('div', { className: 'wl-label' }, 'Git 作者（留空 = 各仓库 git config user.name）'),
      h('input', { className: 'wl-input', value: draft.gitAuthor, onInput: set('gitAuthor') }),

      h(
        'div',
        { className: 'wl-checkline' },
        h('input', { type: 'checkbox', checked: draft.git, onChange: set('git') }),
        '扫描 Git 提交',
        h('input', { type: 'checkbox', checked: draft.docs, onChange: set('docs'), style: { marginLeft: '10px' } }),
        '扫描文档变更',
        h('input', { type: 'checkbox', checked: draft.sessions, onChange: set('sessions'), style: { marginLeft: '10px' } }),
        '归档时汇总 AI 会话',
      ),
      h(
        'div',
        { className: 'wl-checkline' },
        h('input', { type: 'checkbox', checked: draft.autoArchive, onChange: set('autoArchive') }),
        '自动归档',
        h('input', { type: 'checkbox', checked: draft.skipWeekends, onChange: set('skipWeekends'), style: { marginLeft: '10px' } }),
        '跳过周末',
        h('input', {
          className: 'wl-input',
          type: 'time',
          value: draft.taskTime,
          onInput: set('taskTime'),
          style: { width: '96px', marginLeft: 'auto' },
        }),
      ),
    ),

    settingsSection(
      'ai',
      'AI 润色',
      aiHint,
      h(
        'div',
        { className: 'wl-toolbar' },
        h(
          'button',
          {
            className: 'wl-btn',
            disabled: state.aiBusy,
            onClick: detectAi,
          },
          state.aiBusy ? '扫描中…' : '扫描本机 AI 工具',
        ),
        h('span', { className: 'wl-hint' }, '只在本机读取 ZCode / DeepSeek Harness / Claude Code / Codex / Gemini / 环境变量'),
      ),
      state.aiCandidates === null
        ? null
        : state.aiCandidates.length
          ? aiCandidateRow(state.aiCandidates)
          : h('div', { className: 'wl-empty' }, '没有发现可复用的本机 AI 配置。'),
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
              state.aiModels.map((model) =>
                h('option', { value: model, selected: model === draft.aiModel }, model),
              ),
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
        h(
          'button',
          {
            className: 'wl-btn',
            disabled: state.aiModelsBusy,
            onClick: loadAiModels,
          },
          state.aiModelsBusy ? '加载中…' : '加载模型',
        ),
      ),
      state.aiModels.length
        ? h('input', {
            className: 'wl-input',
            value: draft.aiModel,
            placeholder: '或手动填写模型名',
            onInput: set('aiModel'),
            style: { marginTop: '6px' },
          })
        : null,
      state.aiModelsNote ? h('div', { className: 'wl-hint' }, state.aiModelsNote) : null,
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
                onClick: () =>
                  act('config-clear', async () => {
                    await call('config', { action: 'set', patch: { ai: { clearApiKey: true } } })
                    state.settings = null
                    setNotice('ok', '已清除 API Key')
                  }),
              },
              '清除 Key',
            ),
          )
        : null,
    ),

    settingsSection(
      'backup',
      '备份与恢复',
      `${state.backups.length} 份备份`,
      h(
        'div',
        { className: 'wl-toolbar' },
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
                  h(
                    'div',
                    { className: 'wl-item-meta' },
                    `${Math.round(backup.size / 1024)} KB · ${String(backup.mtime || '').replace('T', ' ').slice(0, 16)}`,
                  ),
                ),
                h(
                  'button',
                  {
                    className: 'wl-btn tiny',
                    disabled: state.busy === 'backup-restore',
                    onClick: () =>
                      act('backup-restore', async () => {
                        const result = await call('backup', { action: 'restore', name: backup.name })
                        setNotice('ok', `已恢复 ${result.restored} 天日志、${result.todos} 条待办`)
                      }),
                  },
                  '恢复',
                ),
                h(
                  'button',
                  {
                    className: 'wl-btn danger tiny',
                    disabled: state.busy === 'backup-delete',
                    onClick: () =>
                      act('backup-delete', async () => {
                        await call('backup', { action: 'delete', name: backup.name })
                        setNotice('ok', '备份已删除')
                      }),
                  },
                  '删除',
                ),
              ),
            ),
          )
        : h('div', { className: 'wl-empty' }, '还没有备份。'),
    ),

    settingsSection(
      'import',
      '从旧 WorkLog 导入',
      '迁移旧 data\\archive',
      h('div', { className: 'wl-hint' }, '填旧 WorkLog 安装目录（例如 E:\\WorkLog），复制其 data\\archive 到当前数据目录。'),
      h(
        'div',
        { className: 'wl-date-row', style: { marginTop: '6px' } },
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

function render() {
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
      state.tab === 'overview'
        ? overviewTab()
        : state.tab === 'logs'
          ? logsTab()
          : state.tab === 'todos'
            ? todosTab()
            : state.tab === 'reports'
              ? reportsTab()
              : state.tab === 'sessions'
                ? sessionsTab()
                : settingsTab(),
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
