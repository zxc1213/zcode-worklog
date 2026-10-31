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
import { askArchive, aiComplete, generateReport, listAiModels, summarizeAiUsage } from '../lib/report.mjs'
import { detectAiCandidates, findAiCandidate, publicCandidate } from '../lib/ai-detect.mjs'
import { listSessionSources, parseSessionLines, scanSessions } from '../lib/sessions.mjs'
import { getHistory, getTasks, runDueTasks, updateTask } from '../lib/scheduler.mjs'
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
  const system = [
    '你是待办解析助手。把用户文本解析成待办 JSON，只输出 JSON，不要输出其他文字。',
    '格式：{"todos":[{"title":"一句话标题","pri":"高|中|低或空","due":"YYYY-MM-DD或空","repeat":"daily|weekly:0-6|monthly:1-28或空","tags":["标签"]}]}',
    '今天是 ' + today + '（' + weekdayName(today) + '）。时间规则：周五→最近的周五、下周一→下周、月底→本月最后一天、N天后→今天+N；没有时间信息 due 留空。',
    '每天/每日→daily；每周X→weekly:X（0=周日）；每月X号→monthly:X（1-28）。',
    '紧急/尽快/马上→高；不急/有空时→低；#词 提取为 tags（去掉#号）。',
    'title 不要包含日期、优先级、#标签记号。',
    batch ? '把文本拆成多条相互独立的待办。' : '只解析出 1 条待办。',
    '只依据文本内容，不要编造。',
  ].join('\n')
  const result = await aiComplete(config, system, text, { kind: 'todo' })
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
  const system = [
    '你是每日计划助手。从待办列表中选出今天最值得做的 3 件要事，只输出 JSON：{"picks":[{"id":"待办id","reason":"一句话理由"}]}。',
    '选择规则：逾期且顺延次数多的优先，其次高优先级，再次到期日临近；理由要具体到待办内容。',
    '只输出 JSON，不要输出其他文字。',
  ].join('\n')
  const result = await aiComplete(config, system, lines.join('\n'), { kind: 'todo' })
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
    case 'days':
      return listDays(config)
    case 'reports':
      return listReports(config)
    default:
      throw new Error(`未知操作：${op}`)
  }
}

export { loadConfig, publicConfig, saveConfig }
