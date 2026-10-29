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
  reportsDir,
  stateFile,
  todosFile,
} from './config.mjs'

const MAX_SEARCH_HITS = 50
const MAX_SNIPPET = 180

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
  return Array.isArray(todos) ? todos : []
}

export async function saveTodos(config, todos) {
  await writeJson(todosFile(config), todos)
  return todos
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
    pri: ['高', '中', '低'].includes(input.pri || input.priority) ? (input.pri || input.priority) : '',
    due: String(input.due || '').slice(0, 10),
    repeat: String(input.repeat || ''),
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
    pri: ['高', '中', '低'].includes(patch.pri ?? patch.priority ?? current.pri)
      ? (patch.pri ?? patch.priority ?? current.pri)
      : current.pri,
    due: String(patch.due ?? current.due ?? '').slice(0, 10),
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
