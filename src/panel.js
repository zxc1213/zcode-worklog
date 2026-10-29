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
    gitAuthor: c.gitAuthor || '',
    git: c.sources?.git !== false,
    docs: c.sources?.docs !== false,
    autoArchive: Boolean(c.autoArchive),
    skipWeekends: Boolean(c.skipWeekends),
    taskTime: c.taskTime || '18:30',
    aiBaseUrl: c.ai?.baseUrl || '',
    aiModel: c.ai?.model || '',
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
        if (key === 'settings' && state.config) state.settings = state.settings || draftFromConfig(state.config)
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
                  ? `已归档 ${result.date}：${result.commitCount} 个提交 / ${result.docCount} 个文档`
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

function todosTab() {
  const open = state.todos.filter((item) => item.status !== 'done')
  const done = state.todos.filter((item) => item.status === 'done')
  const todayText = today()

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
          placeholder: '新待办，支持 !高 / @2026-10-30',
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
        h('span', { className: 'wl-hint' }, `${open.length} 进行中 / ${done.length} 已完成`),
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
    h('div', { className: 'wl-label' }, '进行中'),
    open.length
      ? h(
          'div',
          { className: 'wl-list' },
          open.map((todo) => todoItem(todo, todayText)),
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
        todo.repeat ? h('span', null, todo.repeat) : null,
        isDone && todo.done_at ? h('span', null, `完成于 ${String(todo.done_at).slice(0, 10)}`) : null,
      ),
    ),
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

function addTodoFromForm() {
  const titleInput = document.getElementById('wl-todo-title')
  const raw = titleInput?.value?.trim() || ''
  if (!raw) return
  const priSelect = document.getElementById('wl-todo-pri')
  const dueInput = document.getElementById('wl-todo-due')
  const priMatch = raw.match(/!(高|中|低)/)
  const dueMatch = raw.match(/@(\d{4}-\d{2}-\d{2})/)
  const title = raw.replace(/!(高|中|低)/g, '').replace(/@\d{4}-\d{2}-\d{2}/g, '').trim()
  const pri = priSelect?.value || (priMatch ? priMatch[1] : '')
  const due = dueInput?.value || (dueMatch ? dueMatch[1] : '')
  act('todo-add', async () => {
    await call('todos', { action: 'add', title, pri, due })
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

function settingsTab() {
  const draft = state.settings || draftFromConfig(state.config)
  const config = state.config || {}
  const set = (key) => (event) => {
    draft[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value
  }

  return h(
    'div',
    null,
    noticeNode(),
    h('div', { className: 'wl-label' }, '数据目录'),
    h('input', { className: 'wl-input', value: draft.dataDir, onInput: set('dataDir') }),
    h('div', { className: 'wl-hint' }, `配置：${config.configFile || ''}`),

    h('div', { className: 'wl-label' }, 'Git 扫描根目录（每行一个，最多向下 3 层）'),
    h('textarea', { className: 'wl-area small', value: draft.scanRoots, onInput: set('scanRoots') }),
    h('div', { className: 'wl-label' }, '文档扫描目录（每行一个，最多向下 6 层）'),
    h('textarea', { className: 'wl-area small', value: draft.docRoots, onInput: set('docRoots') }),
    h('div', { className: 'wl-label' }, 'Git 作者（留空 = 各仓库 git config user.name）'),
    h('input', { className: 'wl-input', value: draft.gitAuthor, onInput: set('gitAuthor') }),

    h(
      'div',
      { className: 'wl-checkline' },
      h('input', { type: 'checkbox', checked: draft.git, onChange: set('git') }),
      '扫描 Git 提交',
      h('input', { type: 'checkbox', checked: draft.docs, onChange: set('docs'), style: { marginLeft: '10px' } }),
      '扫描文档变更',
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

    h('div', { className: 'wl-section-title', style: { marginTop: '14px' } }, 'AI 润色（OpenAI 兼容）'),
    h('div', { className: 'wl-label' }, 'Base URL'),
    h('input', {
      className: 'wl-input',
      value: draft.aiBaseUrl,
      placeholder: 'https://api.openai.com/v1',
      onInput: set('aiBaseUrl'),
    }),
    h('div', { className: 'wl-label' }, '模型'),
    h('input', { className: 'wl-input', value: draft.aiModel, placeholder: 'gpt-4o-mini', onInput: set('aiModel') }),
    h('div', { className: 'wl-label' }, 'API Key'),
    h('input', {
      className: 'wl-input',
      type: 'password',
      value: draft.aiKey,
      placeholder: config.ai?.hasApiKey ? '已保存，留空保持不变' : 'sk-...',
      onInput: set('aiKey'),
    }),
    h(
      'div',
      { className: 'wl-toolbar' },
      h(
        'button',
        {
          className: 'wl-btn primary',
          disabled: state.busy === 'config-save',
          onClick: () =>
            act('config-save', async () => {
              const patch = {
                dataDir: draft.dataDir,
                scanRoots: splitLines(draft.scanRoots),
                docRoots: splitLines(draft.docRoots),
                gitAuthor: draft.gitAuthor,
                sources: { git: draft.git, docs: draft.docs },
                autoArchive: draft.autoArchive,
                skipWeekends: draft.skipWeekends,
                taskTime: draft.taskTime,
                ai: {
                  baseUrl: draft.aiBaseUrl,
                  model: draft.aiModel,
                  ...(draft.aiKey ? { apiKey: draft.aiKey } : {}),
                },
              }
              await call('config', { action: 'set', patch })
              state.settings = null
              setNotice('ok', '设置已保存')
            }),
        },
        '保存设置',
      ),
      config.ai?.hasApiKey
        ? h(
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
          )
        : null,
    ),

    h(
      'div',
      { className: 'wl-section' },
      h('div', { className: 'wl-section-title' }, '备份'),
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

    h(
      'div',
      { className: 'wl-section' },
      h('div', { className: 'wl-section-title' }, '从旧 WorkLog 导入'),
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
