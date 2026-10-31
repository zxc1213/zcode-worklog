/**
 * Compensating scheduler: the plugin has no resident process, so "scheduled"
 * collection runs whenever a trigger point (SessionStart hook or panel
 * bootstrap) finds a task overdue. Per-task status and a short history are
 * persisted in state; a single failing task never blocks the others.
 */
import { localDate, localTime } from './config.mjs'
import { loadState, saveState } from './store.mjs'

export const TASK_DEFS = [
  {
    id: 'collect-sessions',
    kind: 'collect-sessions',
    title: 'AI 会话采集',
    everyHours: 4,
    dailyAt: '',
    description: '扫描本机 AI 工具会话并预热缓存，归档与日报直接复用结果。',
  },
  {
    id: 'connector-sync',
    kind: 'connector-sync',
    title: '外部连接器同步',
    everyHours: 6,
    dailyAt: '',
    description: '同步所有启用的外部连接器（飞书/禅道/通用 JSON），产出统一条目。',
  },
  {
    id: 'collect-watch',
    kind: 'collect-watch',
    title: '目录监控扫描',
    everyHours: 2,
    dailyAt: '',
    description: '对 watchDirs（本地/网盘/git）做指纹增量扫描，检测文件变化。',
  },
]

export async function getTasks(config) {
  const state = await loadState(config)
  const existing = Array.isArray(state.schedulerTasks) ? state.schedulerTasks : []
  return TASK_DEFS.map((def) => {
    const saved = existing.find((task) => task.id === def.id)
    return {
      ...def,
      ...(saved || {}),
      id: def.id,
      kind: def.kind,
      title: def.title,
      enabled: saved ? Boolean(saved.enabled) : false,
    }
  })
}

export async function updateTask(config, patch = {}) {
  const tasks = await getTasks(config)
  const task = tasks.find((item) => item.id === patch.id)
  if (!task) throw new Error(`找不到调度任务：${patch.id || '(空)'}`)
  if (patch.enabled !== undefined) task.enabled = Boolean(patch.enabled)
  if (patch.everyHours !== undefined) {
    const hours = Number(patch.everyHours)
    if (!Number.isFinite(hours) || hours < 0) throw new Error('everyHours 需要是非负数字')
    task.everyHours = hours
  }
  if (patch.dailyAt !== undefined) {
    const at = String(patch.dailyAt || '').trim()
    if (at && !/^\d{2}:\d{2}$/.test(at)) throw new Error('dailyAt 格式应为 HH:MM')
    task.dailyAt = at
  }
  await persistTasks(config, tasks)
  return task
}

async function persistTasks(config, tasks) {
  const state = await loadState(config)
  state.schedulerTasks = tasks
  await saveState(config, state)
}

export function isTaskDue(task, now = new Date()) {
  if (!task.enabled) return false
  const at = String(task.dailyAt || '').trim()
  if (at) {
    if (String(task.lastRunAt || '').slice(0, 10) === localDate(now)) return false
    return localTime(now) >= at
  }
  const hours = Number(task.everyHours)
  if (!Number.isFinite(hours) || hours <= 0) return false
  if (!task.lastRunAt) return true
  const last = new Date(task.lastRunAt)
  if (Number.isNaN(last.getTime())) return true
  return now.getTime() - last.getTime() >= hours * 3600 * 1000
}

async function runTask(config, task) {
  if (task.kind === 'collect-sessions') {
    const { scanSessions } = await import('./sessions.mjs')
    const { appendEntries } = await import('./entries.mjs')
    const { basename } = await import('node:path')
    const result = await scanSessions(config, localDate())
    const sessions = result?.sessions || []
    await appendEntries(
      config,
      sessions.map((session) => ({
        source: 'sessions', type: 'session', date: localDate(),
        time: String(session.timeRange || '').split('–')[0].trim(),
        title: session.title, project: session.cwd ? basename(session.cwd) : '',
        tags: session.label ? [session.label] : [], ref: session.file,
        nativeId: (session.file || session.title) + '|' + (session.first || ''),
      })),
    )
    return { sessions: sessions.length }
  }
  if (task.kind === 'connector-sync') {
    const { syncConnectors } = await import('./connectors.mjs')
    const outcome = await syncConnectors(config)
    return { added: outcome.results.reduce((sum, item) => sum + item.added, 0), connectors: outcome.results.length }
  }
  if (task.kind === 'collect-watch') {
    const { scanWatchDirs } = await import('./watch.mjs')
    const result = await scanWatchDirs(config)
    return {
      changed: result.results.reduce((sum, item) => sum + item.changed, 0),
      errors: (result.results || []).filter((item) => item.error).map((item) => ({ path: item.path, error: item.error })),
    }
  }
  return { skipped: true }
}

export async function runDueTasks(config, { budgetMs = 8000, force = false, id = '' } = {}) {
  const tasks = await getTasks(config)
  const ran = []
  const start = Date.now()
  let budgetLeft = true
  for (const task of tasks) {
    if (id && task.id !== id) continue
    if (!force && !isTaskDue(task)) continue
    if (!force && Date.now() - start > budgetMs) {
      budgetLeft = false
      break
    }
    const startedAt = Date.now()
    let status = 'ok'
    let error = ''
    let detail = {}
    try {
      detail = await runTask(config, task)
    } catch (taskError) {
      status = 'error'
      error = String(taskError?.message || taskError)
    }
    task.lastRunAt = new Date().toISOString()
    task.lastStatus = status
    task.lastError = error
    ran.push({ id: task.id, title: task.title, status, error, ms: Date.now() - startedAt, ...detail })
    await persistTasks(config, tasks)
  }
  await appendHistory(config, ran)
  return { ran, budgetLeft }
}

async function appendHistory(config, ran) {
  if (!ran.length) return
  const state = await loadState(config)
  state.schedulerHistory = [
    ...ran.map((item) => ({ ...item, at: new Date().toISOString() })),
    ...(Array.isArray(state.schedulerHistory) ? state.schedulerHistory : []),
  ].slice(0, 50)
  await saveState(config, state)
}

export async function getHistory(config) {
  const state = await loadState(config)
  return Array.isArray(state.schedulerHistory) ? state.schedulerHistory.slice(0, 20) : []
}
