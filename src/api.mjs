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
  clearDoneTodos,
  createBackup,
  deleteBackup,
  deleteTodo,
  extractProjects,
  getDay,
  importWorkLog,
  listBackups,
  listDays,
  listReports,
  loadState,
  loadTodos,
  readReport,
  recordRun,
  restoreBackup,
  saveDay,
  searchDays,
  updateTodo,
} from '../lib/store.mjs'
import { askArchive, generateReport, summarizeAiUsage } from '../lib/report.mjs'

export async function statusPayload(config = loadConfig()) {
  const [days, todos, state, backups, projects] = await Promise.all([
    listDays(config),
    loadTodos(config),
    loadState(config),
    listBackups(config),
    extractProjects(config),
  ])
  const today = localDate()
  const todayDay = days.find((day) => day.date === today)
  return {
    version: PLUGIN_VERSION,
    home: publicConfig(config).home,
    dataDir: config.dataDir,
    archiveDir: archiveDir(config),
    config: publicConfig(config),
    projectDir: publicConfig(config).projectDir,
    today: { date: today, archived: Boolean(todayDay), path: todayDay?.path || '' },
    days: {
      count: days.length,
      latest: days.slice(0, 12).map((day) => ({ date: day.date, size: day.size, mtime: day.mtime })),
    },
    todos: {
      count: todos.length,
      open: todos.filter((todo) => todo.status !== 'done').length,
      overdue: todos.filter((todo) => todo.status !== 'done' && todo.due && todo.due < today).length,
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
        ? `${result.commitCount} 提交 / ${result.docCount} 文档`
        : '当天已有归档',
      commitCount: result.commitCount || 0,
      docCount: result.docCount || 0,
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

export async function todoAction(config, args = {}) {
  const action = args.action || 'list'
  if (action === 'list') return loadTodos(config)
  if (action === 'add') return addTodo(config, args)
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
      ? `自动归档：${result.commitCount} 提交 / ${result.docCount} 文档`
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
    case 'days':
      return listDays(config)
    case 'reports':
      return listReports(config)
    default:
      throw new Error(`未知操作：${op}`)
  }
}

export { loadConfig, publicConfig, saveConfig }
