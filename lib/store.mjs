/**
 * Local data store: archive files, todos, state, search, reports, backups.
 * All data lives under config.dataDir; never touches WorkLog.exe.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import {
  backupsDir,
  dayFile,
  localDate,
  mondayOf,
  reportsDir,
  stateFile,
  todosFile,
} from './config.mjs'

const MAX_SEARCH_HITS = 50
const MAX_SNIPPET = 180
export const PRI_VALUES = ['高', '中', '低']
const PRI_RANK = { 高: 0, 中: 1, 低: 2 }
const MAX_TAGS = 8
const MAX_SUBTASKS = 20

function cleanTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[,，#\s]+/)
  const out = []
  for (const raw of list) {
    const tag = String(raw || '').trim().replace(/^#/, '')
    if (tag && !out.includes(tag)) out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

function cleanSubtasks(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const item of input) {
    const title = String(typeof item === 'string' ? item : item?.title || '').trim()
    if (!title) continue
    out.push({
      id: typeof item === 'object' && item && String(item.id || '') ? String(item.id) : randomUUID(),
      title,
      done: typeof item === 'object' && item ? Boolean(item.done) : false,
    })
    if (out.length >= MAX_SUBTASKS) break
  }
  return out
}

function normalizeTodo(todo) {
  if (!todo || typeof todo !== 'object' || !todo.id || !todo.title) return null
  return {
    ...todo,
    md: String(todo.md || ''),
    status: todo.status === 'done' ? 'done' : 'open',
    pri: PRI_VALUES.includes(todo.pri) ? todo.pri : '',
    due: String(todo.due || '').slice(0, 10),
    repeat: String(todo.repeat || ''),
    tags: cleanTags(todo.tags),
    subtasks: cleanSubtasks(todo.subtasks),
    carries: Number.isInteger(todo.carries) && todo.carries > 0 ? todo.carries : 0,
    lastCarry: String(todo.lastCarry || '').slice(0, 10),
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export async function loadTodos(config) {
  const todos = await readJson(todosFile(config), [])
  if (!Array.isArray(todos)) return []
  return todos.map(normalizeTodo).filter(Boolean)
}

export async function saveTodos(config, todos) {
  await writeJson(todosFile(config), todos)
  return todos
}

/**
 * Shared smart order for todo lists. The panel keeps a mirrored copy in
 * src/panel.js (it cannot import this module); test/todo-v2.test.mjs pins
 * both to the same fixtures, keep them in sync.
 * Order: done last (by done_at desc), then overdue open (due asc), then
 * 高/中/低 (due asc within rank, no-due last by created desc).
 */
export function compareTodos(a, b, today) {
  const aDone = a.status === 'done'
  const bDone = b.status === 'done'
  if (aDone !== bDone) return aDone ? 1 : -1
  if (aDone) return String(b.done_at || '').localeCompare(String(a.done_at || ''))
  const aOver = a.due && a.due < today ? 1 : 0
  const bOver = b.due && b.due < today ? 1 : 0
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

export function sortTodos(todos, today = localDate()) {
  return [...todos].sort((a, b) => compareTodos(a, b, today))
}

export function queryTodos(todos, query = {}, today = localDate()) {
  const { status, pri, tag, q, sort = 'smart' } = query
  let list = todos
  if (status === 'open' || status === 'done') list = list.filter((todo) => todo.status === status)
  if (PRI_VALUES.includes(pri)) list = list.filter((todo) => todo.pri === pri)
  if (tag) list = list.filter((todo) => todo.tags.includes(String(tag)))
  const needle = String(q || '').trim().toLowerCase()
  if (needle) {
    list = list.filter(
      (todo) =>
        todo.title.toLowerCase().includes(needle) ||
        String(todo.md || '').toLowerCase().includes(needle) ||
        todo.tags.some((item) => item.toLowerCase().includes(needle)),
    )
  }
  if (sort === 'due') {
    return [...list].sort((a, b) => {
      if (a.due === b.due) return String(a.created || '').localeCompare(String(b.created || ''))
      if (!a.due) return 1
      if (!b.due) return -1
      return a.due.localeCompare(b.due)
    })
  }
  if (sort === 'created') {
    return [...list].sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))
  }
  return sortTodos(list, today)
}

export async function addTodo(config, input = {}) {
  const title = String(input.title || '').trim()
  if (!title) throw new Error('待办标题不能为空')
  const now = new Date().toISOString()
  const todo = {
    id: randomUUID(),
    title,
    md: String(input.md || input.detail || ''),
    status: input.status === 'done' ? 'done' : 'open',
    pri: PRI_VALUES.includes(input.pri || input.priority) ? (input.pri || input.priority) : '',
    due: String(input.due || '').slice(0, 10),
    repeat: String(input.repeat || ''),
    tags: cleanTags(input.tags),
    subtasks: cleanSubtasks(input.subtasks),
    carries: 0,
    lastCarry: '',
    created: now,
    updated: now,
    done_at: input.status === 'done' ? now : '',
  }
  const todos = await loadTodos(config)
  todos.push(todo)
  await saveTodos(config, todos)
  return todo
}

export async function updateTodo(config, patch = {}) {
  const id = String(patch.id || '')
  if (!id) throw new Error('缺少待办 id')
  const todos = await loadTodos(config)
  const index = todos.findIndex((todo) => todo.id === id)
  if (index < 0) throw new Error(`找不到待办 ${id}`)
  const current = todos[index]
  const next = {
    ...current,
    ...patch,
    id,
    title: String(patch.title ?? current.title).trim() || current.title,
    md: String(patch.md ?? current.md ?? ''),
    pri: PRI_VALUES.includes(patch.pri ?? patch.priority ?? current.pri)
      ? (patch.pri ?? patch.priority ?? current.pri)
      : current.pri,
    due: String(patch.due ?? current.due ?? '').slice(0, 10),
    repeat: String(patch.repeat ?? current.repeat ?? ''),
    tags: patch.tags === undefined ? current.tags : cleanTags(patch.tags),
    subtasks: patch.subtasks === undefined ? current.subtasks : cleanSubtasks(patch.subtasks),
    carries: Number.isInteger(patch.carries) && patch.carries >= 0 ? patch.carries : current.carries || 0,
    lastCarry: String(patch.lastCarry ?? current.lastCarry ?? '').slice(0, 10),
    updated: new Date().toISOString(),
  }
  if (patch.status === 'done' && current.status !== 'done') next.done_at = new Date().toISOString()
  if (patch.status === 'open') next.done_at = ''
  todos[index] = next
  await saveTodos(config, todos)

  let spawned = null
  if (patch.status === 'done' && current.status !== 'done' && next.repeat) {
    spawned = await spawnRepeatedTodo(config, next, todos)
  }
  return { todo: next, spawned }
}

async function spawnRepeatedTodo(config, todo, todos) {
  const base = new Date()
  const due = nextRepeatDue(todo.repeat, base)
  if (!due) return null
  const next = {
    ...todo,
    id: randomUUID(),
    status: 'open',
    done_at: '',
    tags: [...(todo.tags || [])],
    subtasks: (todo.subtasks || []).map((sub) => ({ ...sub, done: false })),
    carries: 0,
    lastCarry: '',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    due,
  }
  todos.push(next)
  await saveTodos(config, todos)
  return next
}

export function nextRepeatDue(rule, fromDate = new Date()) {
  const date = new Date(fromDate)
  const text = String(rule || '').trim()
  if (text === 'daily') {
    date.setDate(date.getDate() + 1)
    return localDate(date)
  }
  const weekly = /^weekly:([0-6])$/.exec(text)
  if (weekly) {
    const target = Number(weekly[1])
    const current = date.getDay()
    let diff = (target - current + 7) % 7
    if (diff === 0) diff = 7
    date.setDate(date.getDate() + diff)
    return localDate(date)
  }
  const monthly = /^monthly:([1-9]|[12]\d|3[01])$/.exec(text)
  if (monthly) {
    const target = Math.min(28, Number(monthly[1]))
    date.setMonth(date.getMonth() + 1, target)
    return localDate(date)
  }
  return ''
}

export async function deleteTodo(config, id) {
  const todos = await loadTodos(config)
  const next = todos.filter((todo) => todo.id !== id)
  if (next.length === todos.length) throw new Error(`找不到待办 ${id}`)
  await saveTodos(config, next)
  return { ok: true, id }
}

export async function clearDoneTodos(config) {
  const todos = await loadTodos(config)
  const next = todos.filter((todo) => todo.status !== 'done')
  const removed = todos.length - next.length
  await saveTodos(config, next)
  return { ok: true, removed }
}

/**
 * Carry overdue open todos: due := date (default today), carries += 1.
 * Idempotent per todo per day via lastCarry; called by archiveDay when
 * archiving today, also exposed as worklog_todos action=carry_over.
 */
export async function carryOverTodos(config, { date = localDate() } = {}) {
  const day = String(date || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`非法日期：${date}`)
  const todos = await loadTodos(config)
  const carried = []
  let skipped = 0
  for (const todo of todos) {
    if (todo.status !== 'open' || !todo.due || todo.due >= day) continue
    if (todo.lastCarry === day) {
      skipped += 1
      continue
    }
    todo.due = day
    todo.carries = (todo.carries || 0) + 1
    todo.lastCarry = day
    todo.updated = new Date().toISOString()
    carried.push({ id: todo.id, title: todo.title, pri: todo.pri, due: todo.due, carries: todo.carries })
  }
  if (carried.length) await saveTodos(config, todos)
  return { carried, skipped, date: day }
}

function shiftDate(dateString, days) {
  const [year, month, day] = String(dateString).split('-').map(Number)
  const date = new Date(year, (month || 1) - 1, day || 1)
  date.setDate(date.getDate() + days)
  return localDate(date)
}

/** Counters shared by the panel stats bar and the report 待办概况 section. */
export function todoStats(todos, today = localDate()) {
  const list = Array.isArray(todos) ? todos : []
  const open = list.filter((todo) => todo.status !== 'done')
  const done = list.filter((todo) => todo.status === 'done')
  const dayOf = (todo) => String(todo.done_at || '').slice(0, 10)
  const byPri = { 高: 0, 中: 0, 低: 0, 无: 0 }
  for (const todo of open) byPri[PRI_RANK[todo.pri] === undefined ? '无' : todo.pri] += 1
  return {
    open: open.length,
    overdue: open.filter((todo) => todo.due && todo.due < today).length,
    dueToday: open.filter((todo) => todo.due === today).length,
    doneToday: done.filter((todo) => dayOf(todo) === today).length,
    doneWeek: done.filter((todo) => dayOf(todo) && dayOf(todo) >= mondayOf(today)).length,
    total: list.length,
    byPri,
  }
}

export async function getTodoStats(config) {
  return todoStats(await loadTodos(config))
}

export async function loadState(config) {
  return readJson(stateFile(config), {
    lastArchive: '',
    lastAutoDate: '',
    runHistory: [],
    aiUsage: [],
  })
}

export async function saveState(config, state) {
  await writeJson(stateFile(config), state)
  return state
}

export async function recordRun(config, entry) {
  const state = await loadState(config)
  state.lastArchive = entry.date || state.lastArchive
  if (entry.mode === 'auto') state.lastAutoDate = entry.date || state.lastAutoDate
  state.runHistory = [
    { ...entry, at: new Date().toISOString() },
    ...(Array.isArray(state.runHistory) ? state.runHistory : []),
  ].slice(0, 100)
  await saveState(config, state)
  return state.runHistory[0]
}

export async function recordAiUsage(config, usage) {
  const state = await loadState(config)
  state.aiUsage = [
    { ...usage, at: new Date().toISOString() },
    ...(Array.isArray(state.aiUsage) ? state.aiUsage : []),
  ].slice(0, 500)
  await saveState(config, state)
}

async function walkFiles(dir, visitor) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'reports' || entry.name === 'backups') continue
      await walkFiles(full, visitor)
    } else if (entry.isFile()) {
      await visitor(full, entry)
    }
  }
}

export async function listDays(config) {
  const root = join(config.dataDir, 'archive')
  const days = []
  await walkFiles(root, async (full) => {
    const name = basename(full)
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) return
    try {
      const info = await stat(full)
      days.push({
        date: name.slice(0, 10),
        path: full,
        relative: relative(root, full),
        size: info.size,
        mtime: info.mtime.toISOString(),
      })
    } catch {
      /* ignore */
    }
  })
  days.sort((a, b) => b.date.localeCompare(a.date))
  return days
}

export async function getDay(config, dateString) {
  const target = dayFile(config, dateString)
  if (existsSync(target)) {
    return { date: dateString, exists: true, text: await readFile(target, 'utf8'), path: target }
  }
  const days = await listDays(config)
  const found = days.find((day) => day.date === dateString)
  if (found) {
    return { date: dateString, exists: true, text: await readFile(found.path, 'utf8'), path: found.path }
  }
  return { date: dateString, exists: false, text: '', path: target }
}

export async function saveDay(config, dateString, text) {
  const target = dayFile(config, dateString)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, String(text ?? ''), 'utf8')
  return getDay(config, dateString)
}

export async function searchDays(config, query) {
  const q = String(query || '').trim()
  if (!q) throw new Error('搜索关键词不能为空')
  const lower = q.toLowerCase()
  const days = await listDays(config)
  const hits = []
  for (const day of days) {
    let text
    try {
      text = await readFile(day.path, 'utf8')
    } catch {
      continue
    }
    const haystack = text.toLowerCase()
    let from = 0
    let count = 0
    let first = -1
    while (true) {
      const index = haystack.indexOf(lower, from)
      if (index < 0) break
      count += 1
      if (first < 0) first = index
      from = index + lower.length
    }
    if (!count) continue
    const start = Math.max(0, first - Math.floor(MAX_SNIPPET / 2))
    const end = Math.min(text.length, first + q.length + Math.floor(MAX_SNIPPET / 2))
    hits.push({
      date: day.date,
      count,
      snippet: `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`,
    })
    if (hits.length >= MAX_SEARCH_HITS) break
  }
  return hits
}

export async function extractProjects(config) {
  const days = await listDays(config)
  const projects = new Map()
  for (const day of days) {
    let text
    try {
      text = await readFile(day.path, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    let current = null
    for (const line of lines) {
      const heading = /^###\s+(.+?)\s*$/.exec(line)
      if (heading) {
        current = heading[1].trim()
        if (!projects.has(current)) projects.set(current, { name: current, days: [], commits: 0 })
        projects.get(current).days.push(day.date)
        continue
      }
      if (/^##\s+/.test(line)) current = null
      if (current && /^-\s+`[0-9a-f]+`/i.test(line)) projects.get(current).commits += 1
    }
  }
  return [...projects.values()]
    .map((project) => ({
      ...project,
      days: [...new Set(project.days)].sort(),
    }))
    .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name))
}

export async function listReports(config) {
  const dir = reportsDir(config)
  const reports = []
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return reports
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const full = join(dir, entry.name)
    const info = await stat(full)
    reports.push({ name: entry.name, size: info.size, mtime: info.mtime.toISOString() })
  }
  reports.sort((a, b) => b.mtime.localeCompare(a.mtime))
  return reports
}

export async function readReport(config, name) {
  const safe = basename(String(name || ''))
  if (!safe.endsWith('.md')) throw new Error('报告文件名不合法')
  const full = join(reportsDir(config), safe)
  if (!existsSync(full)) throw new Error(`报告不存在：${safe}`)
  return { name: safe, text: await readFile(full, 'utf8') }
}

export async function writeReport(config, name, text) {
  const safe = basename(String(name || ''))
  if (!safe.endsWith('.md')) throw new Error('报告文件名不合法')
  const full = join(reportsDir(config), safe)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, String(text ?? ''), 'utf8')
  return { name: safe, path: full }
}

export async function createBackup(config) {
  const days = await listDays(config)
  const archive = []
  for (const day of days) {
    try {
      archive.push({ date: day.date, relative: day.relative, text: await readFile(day.path, 'utf8') })
    } catch {
      /* ignore */
    }
  }
  const reports = []
  for (const report of await listReports(config)) {
    try {
      reports.push({ name: report.name, text: (await readReport(config, report.name)).text })
    } catch {
      /* ignore */
    }
  }
  const payload = {
    format: 'zcode-worklog-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    config: {
      ...config,
      ai: { ...config.ai, apiKey: config.ai.apiKey ? '__redacted__' : '' },
    },
    todos: await loadTodos(config),
    archive,
    reports,
  }
  const name = `zcode-worklog-backup-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')}.json`
  const file = join(backupsDir(config), name)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(payload, null, 2), 'utf8')
  return { file, name, days: archive.length, reports: reports.length, size: (await stat(file)).size }
}

export async function listBackups(config) {
  const dir = backupsDir(config)
  const out = []
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const full = join(dir, entry.name)
    const info = await stat(full)
    out.push({ name: entry.name, size: info.size, mtime: info.mtime.toISOString() })
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime))
  return out
}

export async function restoreBackup(config, name) {
  const safe = basename(String(name || ''))
  const file = join(backupsDir(config), safe)
  if (!existsSync(file)) throw new Error(`备份不存在：${safe}`)
  const payload = JSON.parse(await readFile(file, 'utf8'))
  if (!Array.isArray(payload.archive)) throw new Error('备份格式不正确')
  let restored = 0
  for (const item of payload.archive) {
    if (!item?.date || typeof item.text !== 'string') continue
    await saveDay(config, item.date, item.text)
    restored += 1
  }
  if (Array.isArray(payload.todos)) await saveTodos(config, payload.todos)
  for (const report of payload.reports || []) {
    if (report?.name && typeof report.text === 'string') {
      await writeReport(config, report.name, report.text)
    }
  }
  return { ok: true, restored, todos: Array.isArray(payload.todos) ? payload.todos.length : 0 }
}

export async function importWorkLog(config, sourceDir) {
  const candidates = [
    join(sourceDir, 'data', 'archive'),
    join(sourceDir, 'archive'),
  ]
  const source = candidates.find((candidate) => existsSync(candidate))
  if (!source) throw new Error('没有找到 data\\archive 或 archive 目录')
  const target = join(config.dataDir, 'archive')
  await mkdir(target, { recursive: true })
  await cp(source, target, { recursive: true, force: false, errorOnExist: false })
  const days = await listDays(config)
  return { ok: true, source, importedDays: days.length }
}

export async function deleteBackup(config, name) {
  const safe = basename(String(name || ''))
  const file = join(backupsDir(config), safe)
  if (!existsSync(file)) throw new Error(`备份不存在：${safe}`)
  await unlink(file)
  return { ok: true, name: safe }
}
