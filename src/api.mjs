/**
 * Shared WorkLog operations used by the MCP server and the hooks.
 * Every entry returns plain JSON-serializable data.
 */
import {
  PLUGIN_VERSION,
  archiveDir,
  assertDate,
  loadConfig,
  localDate,
  localTime,
  publicConfig,
  saveConfig,
  scanRootsOf,
} from '../lib/config.mjs'
import { archiveDay, archiveDays } from '../lib/archive.mjs'
import {
  addTodo,
  carryOverTodos,
  cleanTodoDraft,
  clearDoneTodos,
  createBackup,
  deleteBackup,
  deleteTodo,
  extractProjects,
  getDay,
  getTodoStats,
  importWorkLog,
  listBackups,
  listDays,
  listReports,
  loadState,
  loadTodos,
  queryTodos,
  readReport,
  recordRun,
  restoreBackup,
  saveDay,
  searchDays,
  sortTodos,
  todoStats,
  updateTodo,
} from '../lib/store.mjs'
import { askArchive, aiComplete, generateReport, listAiModels, summarizeAiUsage, summarizeRange } from '../lib/report.mjs'
import { listTemplates, render as renderTpl, resetTemplate, saveTemplate } from '../lib/templates.mjs'
import { detectAiCandidates, findAiCandidate, publicCandidate } from '../lib/ai-detect.mjs'
import { listSessionSources, parseSessionLines, scanSessions } from '../lib/sessions.mjs'
import { getHistory, getTasks, runDueTasks, updateTask } from '../lib/scheduler.mjs'
import { calendarDay, calendarMonth } from '../lib/calendar.mjs'
import { CONNECTOR_TYPES, adapterFor, listConnectors, normalizeConnector, publicConnectorList, syncConnectors } from '../lib/connectors.mjs'
import { buildRecommendations, recordFeedback } from '../lib/recommend.mjs'
import { scanWatchDirs } from '../lib/watch.mjs'
import { probeAiTool, WIZARD_TYPES } from '../lib/wizard.mjs'

export async function statusPayload(config = loadConfig()) {
  // Panel open is one of the two scheduler trigger points (the other is the
  // SessionStart hook); disabled tasks make this a cheap no-op.
  await runDueTasks(config, { budgetMs: 3000 })
  const [days, todos, state, backups, projects] = await Promise.all([
    listDays(config),
    loadTodos(config),
    loadState(config),
    listBackups(config),
    extractProjects(config),
  ])
  const today = localDate()
  const todayDay = days.find((day) => day.date === today)
  const todaySessions = todayDay ? parseSessionLines((await getDay(config, today)).text) : []
  return {
    version: PLUGIN_VERSION,
    home: publicConfig(config).home,
    dataDir: config.dataDir,
    archiveDir: archiveDir(config),
    config: publicConfig(config),
    projectDir: publicConfig(config).projectDir,
    today: { date: today, archived: Boolean(todayDay), path: todayDay?.path || '' },
    sessions: {
      count: todaySessions.length,
      turns: todaySessions.reduce((sum, item) => sum + item.turns, 0),
      items: todaySessions.slice(0, 10),
    },
    days: {
      count: days.length,
      latest: days.slice(0, 12).map((day) => ({ date: day.date, size: day.size, mtime: day.mtime })),
    },
    todos: {
      count: todos.length,
      open: todos.filter((todo) => todo.status !== 'done').length,
      overdue: todos.filter((todo) => todo.status !== 'done' && todo.due && todo.due < today).length,
      stats: todoStats(todos, today),
      recent: todos
        .filter((todo) => todo.status !== 'done')
        .sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')))
        .slice(0, 12),
    },
    backups: {
      count: backups.length,
      latest: backups[0] || null,
    },
    projects: projects.slice(0, 30),
    lastArchive: state.lastArchive || '',
    lastAutoDate: state.lastAutoDate || '',
    runHistory: (state.runHistory || []).slice(0, 12),
    aiUsage: summarizeAiUsage(state.aiUsage || []),
  }
}

export async function archiveAction(config, args = {}) {
  const action = args.action || 'run'
  if (action === 'status') {
    const state = await loadState(config)
    return {
      lastArchive: state.lastArchive || '',
      lastAutoDate: state.lastAutoDate || '',
      runHistory: (state.runHistory || []).slice(0, 20),
      effectiveScanRoots: scanRootsOf(config),
    }
  }
  if (action === 'run') {
    const dateString = assertDate(args.date || localDate())
    const result = await archiveDay(config, dateString, { force: Boolean(args.force), note: args.note || '' })
    await recordRun(config, {
      date: dateString,
      mode: args.mode === 'auto' ? 'auto' : 'manual',
      status: result.created ? 'ok' : 'skip',
      note: result.created
        ? `${result.commitCount} 提交 / ${result.docCount} 文档 / ${result.sessionCount || 0} 会话${
            result.carriedCount ? ` / 顺延 ${result.carriedCount} 待办` : ''
          }`
        : '当天已有归档',
      commitCount: result.commitCount || 0,
      docCount: result.docCount || 0,
      sessionCount: result.sessionCount || 0,
      turnCount: result.turnCount || 0,
    })
    return result
  }
  if (action === 'backfill') {
    const dates = Array.isArray(args.dates) ? args.dates : []
    if (!dates.length) throw new Error('backfill 需要 dates 数组')
    for (const dateString of dates) assertDate(dateString)
    const results = await archiveDays(config, dates, { force: Boolean(args.force) })
    const ok = results.filter((item) => item.created).length
    await recordRun(config, {
      date: localDate(),
      mode: 'manual',
      status: ok ? 'ok' : 'skip',
      note: `补录 ${ok}/${results.length} 天`,
      commitCount: results.reduce((sum, item) => sum + (item.commitCount || 0), 0),
      docCount: results.reduce((sum, item) => sum + (item.docCount || 0), 0),
    })
    return { dates, results }
  }
  throw new Error(`未知 action: ${action}`)
}

/** Pull the first JSON object out of a model reply (tolerates code fences). */
function extractJson(text) {
  const raw = String(text || '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI 没有返回 JSON')
  return JSON.parse(candidate.slice(start, end + 1))
}

function weekdayName(dateString) {
  const [year, month, day] = String(dateString).split('-').map(Number)
  const name = ['日', '一', '二', '三', '四', '五', '六'][new Date(year, month - 1, day).getDay()]
  return '星期' + name
}

/**
 * AI 待办解析：把自然语言解析成待办草稿（不直接入库，返回给面板/命令确认）。
 */
export async function parseTodoDrafts(config, args = {}) {
  if (!config.ai.baseUrl || !config.ai.model) throw new Error('还没有配置 AI 接口（baseUrl/model）')
  const text = String(args.text || '').trim()
  if (!text) throw new Error('需要解析的文本不能为空')
  const batch = args.mode === 'batch'
  const today = localDate()
  const tpl = renderTpl(config, 'todo-parse', {
    today,
    weekday: weekdayName(today),
    modeHint: batch ? '把文本拆成多条相互独立的待办。' : '只解析出 1 条待办。',
    text,
  })
  const result = await aiComplete(config, tpl.system, tpl.user, { kind: tpl.scene })
  const data = extractJson(result.text)
  const list = Array.isArray(data.todos) ? data.todos : []
  const drafts = []
  for (const item of list.slice(0, batch ? 10 : 1)) {
    try {
      drafts.push(cleanTodoDraft(item))
    } catch {
      /* skip malformed draft entries */
    }
  }
  if (!drafts.length) throw new Error('AI 没有解析出有效待办，请换个说法或手动添加')
  return { drafts, mode: batch ? 'batch' : 'one' }
}

/**
 * AI 每日建议：从进行中的待办里挑今天最值得做的 3 件要事（带一句话理由）。
 */
export async function suggestTopTodos(config) {
  if (!config.ai.baseUrl || !config.ai.model) throw new Error('还没有配置 AI 接口（baseUrl/model）')
  const today = localDate()
  const open = sortTodos(
    (await loadTodos(config)).filter((todo) => todo.status !== 'done'),
    today,
  ).slice(0, 30)
  if (!open.length) return { picks: [], note: '没有进行中的待办' }
  const lines = open.map(
    (todo, index) =>
      (index + 1) +
      '. ' +
      todo.title +
      ' | 优先级:' +
      (todo.pri || '无') +
      ' | 到期:' +
      (todo.due || '无') +
      ' | 已顺延:' +
      (todo.carries || 0) +
      '次 | 标签:' +
      ((todo.tags || []).join(',') || '无') +
      ' | id:' +
      todo.id,
  )
  const tpl = renderTpl(config, 'todo-suggest', { content: lines.join('\n') })
  const result = await aiComplete(config, tpl.system, tpl.user, { kind: tpl.scene })
  const data = extractJson(result.text)
  const picks = (Array.isArray(data.picks) ? data.picks : [])
    .map((pick) => {
      const todo = open.find((item) => item.id === pick?.id)
      if (!todo) return null
      return {
        id: todo.id,
        title: todo.title,
        pri: todo.pri,
        due: todo.due,
        carries: todo.carries || 0,
        reason: String(pick.reason || '').slice(0, 80),
      }
    })
    .filter(Boolean)
    .slice(0, 3)
  return { picks }
}

export async function collectAction(config, args = {}) {
  const action = args.action || 'diagnostics'
  if (action === 'diagnostics') {
    const [tasks, history, sources] = await Promise.all([
      getTasks(config),
      getHistory(config),
      listSessionSources(config),
    ])
    const dirs = Array.isArray(config.watchDirs) ? config.watchDirs : []
    return { tasks, history, sources, watchDirs: dirs }
  }
  if (action === 'scan_watch') return scanWatchDirs(config)
  if (action === 'scan_sessions') {
    const result = await scanSessions(config, localDate(), { force: true })
    return { sessions: result?.sessions?.length || 0, errors: result?.errors || [] }
  }
  if (action === 'run') {
    return runDueTasks(config, { force: true, id: args.id || '' })
  }
  if (action === 'set') return updateTask(config, args)
  throw new Error(`未知 action: ${action}`)
}

export async function recommendAction(config, args = {}) {
  const action = args.action || 'get'
  if (action === 'get') return buildRecommendations(config, { date: args.date || localDate() })
  if (action === 'feedback') {
    if (!args.kind) throw new Error('feedback 需要 kind')
    const entry = await recordFeedback(config, args.key || '', String(args.kind), Boolean(args.accepted))
    return { kind: args.kind, feedback: entry }
  }
  throw new Error(`未知 action: ${action}`)
}

export async function connectorsAction(configArg, args = {}) {
  // Mutating action: always read the freshest config from disk so stale
  // handles (panel bootstrap / long-lived tool calls) never clobber secrets.
  const config = loadConfig()
  const action = args.action || 'list'
  if (action === 'list') {
    return { connectors: publicConnectorList(loadConfig()), types: CONNECTOR_TYPES.map((item) => ({ ...item, fields: adapterFor(item.type).FIELDS })) }
  }
  if (action === 'set') {
    const existing = listConnectors(config)
    const base = existing.find((item) => item.id === String(args.id || ''))
    const mergedConfig = { ...(base?.config || {}) }
    if (args.config && typeof args.config === 'object') {
      for (const field of adapterFor(String(args.type || base?.type || '')).FIELDS) {
        const incoming = args.config[field.key]
        if (incoming === undefined) continue
        if (field.type === 'bool') { mergedConfig[field.key] = Boolean(incoming); continue }
        if (incoming === '已配置') continue
        mergedConfig[field.key] = String(incoming)
      }
    }
    const normalized = normalizeConnector({ id: args.id, type: args.type || base?.type, enabled: args.enabled, label: args.label, config: mergedConfig })
    const merged = existing.some((item) => item.id === normalized.id)
      ? existing.map((item) => (item.id === normalized.id ? normalized : item))
      : [...existing, normalized]
    saveConfig({ connectors: merged })
    return { connector: publicConnectorList(loadConfig()).find((item) => item.id === normalized.id) }
  }
  if (action === 'remove') {
    const remaining = listConnectors(config).filter((item) => item.id !== String(args.id || ''))
    saveConfig({ connectors: remaining })
    return { ok: true }
  }
  if (action === 'test') {
    const connector = listConnectors(config).find((item) => item.id === String(args.id || ''))
    if (!connector) throw new Error('找不到连接器：' + String(args.id || ''))
    return adapterFor(connector.type).test(connector.config)
  }
  if (action === 'sync') return syncConnectors(config, args.id || '')
  throw new Error(`未知 action: ${action}`)
}

export async function templatesAction(config, args = {}) {
  const action = args.action || 'list'
  if (action === 'list') return { templates: listTemplates(config) }
  if (action === 'save') {
    const template = await saveTemplate(config, args.scene, { name: args.name, system: args.system, user: args.user })
    return { saved: true, template }
  }
  if (action === 'reset') return { template: await resetTemplate(config, args.scene) }
  throw new Error(`未知 action: ${action}`)
}

export async function calendarAction(config, args = {}) {
  const action = args.action || 'month'
  if (action === 'month') return calendarMonth(config, args.month)
  if (action === 'day') {
    return calendarDay(config, assertDate(args.date || localDate()))
  }
  throw new Error(`未知 action: ${action}`)
}

export async function wizardAction(args = {}) {
  const action = args.action || 'types'
  if (action === 'types') return { types: WIZARD_TYPES }
  if (action === 'probe') return probeAiTool(args)
  throw new Error(`未知 action: ${action}`)
}

export async function todoAction(config, args = {}) {
  const action = args.action || 'list'
  if (action === 'list') {
    const todos = await loadTodos(config)
    return queryTodos(todos, { status: args.status, pri: args.pri, tag: args.tag, q: args.q, sort: args.sort })
  }
  if (action === 'add') return addTodo(config, args)
  if (action === 'update') {
    return updateTodo(config, {
      id: args.id,
      title: args.title,
      md: args.md ?? args.detail,
      pri: args.pri,
      due: args.due,
      repeat: args.repeat,
      tags: args.tags,
      subtasks: args.subtasks,
    })
  }
  if (action === 'complete' || action === 'reopen') {
    return updateTodo(config, {
      id: args.id,
      status: action === 'complete' ? 'done' : 'open',
      title: args.title,
      md: args.md,
      pri: args.pri,
      due: args.due,
      repeat: args.repeat,
    })
  }
  if (action === 'delete') return deleteTodo(config, args.id)
  if (action === 'clear_done') return clearDoneTodos(config)
  if (action === 'carry_over') return carryOverTodos(config, { date: args.date || localDate() })
  if (action === 'stats') return getTodoStats(config)
  if (action === 'parse') return parseTodoDrafts(config, args)
  if (action === 'suggest') return suggestTopTodos(config)
  throw new Error(`未知 action: ${action}`)
}

export async function reportAction(config, args = {}) {
  const action = args.action || 'generate'
  if (action === 'list') return listReports(config)
  if (action === 'summarize') return summarizeRange(config, args)
  if (action === 'read') return readReport(config, args.name)
  if (action === 'generate') return generateReport(config, args)
  throw new Error(`未知 action: ${action}`)
}

export async function backupAction(config, args = {}) {
  const action = args.action || 'list'
  if (action === 'list') return listBackups(config)
  if (action === 'create') return createBackup(config)
  if (action === 'restore') return restoreBackup(config, args.name)
  if (action === 'delete') return deleteBackup(config, args.name)
  if (action === 'import') return importWorkLog(config, args.sourceDir)
  throw new Error(`未知 action: ${action}`)
}

export async function usagePayload(config) {
  const state = await loadState(config)
  return { summary: summarizeAiUsage(state.aiUsage || []), recent: (state.aiUsage || []).slice(0, 20) }
}

export async function configAction(args = {}) {
  if ((args.action || 'get') === 'get') return publicConfig(loadConfig())
  return publicConfig(saveConfig(args.patch || {}))
}

export async function aiAction(args = {}) {
  const action = args.action || 'detect'
  if (action === 'detect') {
    return { candidates: detectAiCandidates().map(publicCandidate) }
  }
  if (action === 'models') {
    const saved = loadConfig()
    const baseUrl = String(args.baseUrl || saved.ai.baseUrl || '').trim().replace(/\/+$/, '')
    if (!baseUrl) throw new Error('需要先填写 Base URL')
    const apiFormat =
      args.apiFormat === 'anthropic' ? 'anthropic' : args.apiFormat === 'openai' ? 'openai' : saved.ai.apiFormat
    const sameBase = saved.ai.baseUrl.replace(/\/+$/, '') === baseUrl
    const apiKey = String(args.apiKey || (sameBase ? saved.ai.apiKey : '') || '').trim()
    let apiError = null
    try {
      const models = await listAiModels({ baseUrl, apiFormat, apiKey })
      if (models.length) return { models, source: 'api' }
    } catch (error) {
      apiError = error
    }
    // Many gateways do not implement /models (or return an empty list); fall
    // back to models already known from the locally detected provider config.
    const local = detectAiCandidates().find(
      (candidate) => candidate.baseUrl.replace(/\/+$/, '') === baseUrl && candidate.models?.length,
    )
    if (local) {
      return {
        models: local.models,
        source: 'local',
        warning: apiError ? String(apiError.message || apiError) : '接口返回了空模型列表',
      }
    }
    throw apiError || new Error('接口没有返回模型列表，本机配置里也没有已知模型')
  }
  if (action === 'apply') {
    const candidate = findAiCandidate(args.id)
    if (!candidate) throw new Error(`没有找到本机 AI 配置：${args.id || '(空)'}`)
    if (!candidate.baseUrl) throw new Error('该配置缺少 baseUrl')
    if (!candidate.model) throw new Error('该配置缺少 model')
    const next = saveConfig({
      ai: {
        baseUrl: candidate.baseUrl,
        model: candidate.model,
        apiFormat: candidate.apiFormat,
        // Applying a candidate means "use exactly this endpoint": never carry
        // a key from a different provider over to a new base URL.
        ...(candidate.apiKey ? { apiKey: candidate.apiKey } : { clearApiKey: true }),
      },
    })
    return { applied: publicCandidate(candidate), config: publicConfig(next) }
  }
  throw new Error(`未知 action: ${action}`)
}

export async function sessionAction(config, args = {}) {
  const action = args.action || 'list'
  if (action === 'sources') return { sources: await listSessionSources(config) }
  const dateString = assertDate(args.date || localDate())
  return scanSessions(config, dateString, { force: action === 'refresh' })
}

export async function dayAction(args = {}) {
  const config = loadConfig()
  const dateString = assertDate(args.date || localDate())
  if (typeof args.text === 'string') return saveDay(config, dateString, args.text)
  return getDay(config, dateString)
}

/**
 * Run the same auto-archive rule the desktop app used: enabled, sources
 * present, weekday allowed, past taskTime, and not already archived today.
 * Returns null when nothing needed doing.
 */
export async function maybeAutoArchive(config = loadConfig()) {
  if (!config.autoArchive) return null
  if (!config.sources.git && !config.sources.docs) return null
  const now = new Date()
  if (config.skipWeekends && (now.getDay() === 0 || now.getDay() === 6)) return null
  if (localTime(now) < config.taskTime) return null
  const today = localDate(now)
  const state = await loadState(config)
  if (state.lastAutoDate === today) return null
  const result = await archiveDay(config, today, { force: false })
  await recordRun(config, {
    date: today,
    mode: 'auto',
    status: result.created ? 'ok' : 'skip',
      note: result.created
        ? `自动归档：${result.commitCount} 提交 / ${result.docCount} 文档 / ${
            result.sessionCount || 0
          } 会话${result.carriedCount ? ` / 顺延 ${result.carriedCount} 待办` : ''}`
        : '当天已有归档',
    commitCount: result.commitCount || 0,
    docCount: result.docCount || 0,
  })
  return result
}

export async function dispatch(op, args = {}) {
  const config = loadConfig()
  switch (op) {
    case 'bootstrap': {
      const [status, days, todos, reports, backups] = await Promise.all([
        statusPayload(config),
        listDays(config),
        loadTodos(config),
        listReports(config),
        listBackups(config),
      ])
      return { status, days, todos, reports, backups, config: publicConfig(config) }
    }
    case 'status':
      return statusPayload(config)
    case 'day':
      return dayAction(args)
    case 'search':
      return searchDays(config, args.query)
    case 'todos':
      return todoAction(config, args)
    case 'archive':
      return archiveAction(config, args)
    case 'sessions':
      return sessionAction(config, args)
    case 'report':
      return reportAction(config, args)
    case 'ask':
      return askArchive(config, args.question, { useAi: args.useAi !== false })
    case 'projects':
      return extractProjects(config)
    case 'usage':
      return usagePayload(config)
    case 'backup':
      return backupAction(config, args)
    case 'config':
      return configAction(args)
    case 'ai':
      return aiAction(args)
    case 'collect':
      return collectAction(config, args)
    case 'wizard':
      return wizardAction(args)
    case 'calendar':
      return calendarAction(config, args)
    case 'templates':
      return templatesAction(config, args)
    case 'connectors':
      return connectorsAction(config, args)
    case 'recommend':
      return recommendAction(config, args)
    case 'days':
      return listDays(config)
    case 'reports':
      return listReports(config)
    default:
      throw new Error(`未知操作：${op}`)
  }
}

export { loadConfig, publicConfig, saveConfig }
