/**
 * Configuration and path helpers for the ZCode WorkLog plugin.
 *
 * Everything lives under ZCODE_PLUGIN_DATA (the plugin-owned writable
 * directory) or ~/.zcode/plugins-data/zcode-worklog on hosts that do not
 * provide it. No dependency on WorkLog.exe or its 8377 API.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

export const PLUGIN_NAME = 'zcode-worklog'
export const PLUGIN_VERSION = '0.2.6'

export function pluginHome() {
  const explicit = String(process.env.WORKLOG_HOME || '').trim()
  if (explicit) return resolve(explicit)
  const pluginData = String(process.env.ZCODE_PLUGIN_DATA || '').trim()
  if (pluginData) return resolve(pluginData)
  return join(homedir(), '.zcode', 'plugins-data', PLUGIN_NAME)
}

export function configFile() {
  return join(pluginHome(), 'config.json')
}

function defaultDataDir() {
  return join(pluginHome(), 'data')
}

function splitList(value) {
  return String(value || '')
    .split(/[\r\n;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function envSeed() {
  const seed = {}
  const dataDir = String(process.env.WORKLOG_DATA_DIR || '').trim()
  if (dataDir) seed.dataDir = dataDir
  const scanRoots = splitList(process.env.WORKLOG_SCAN_ROOTS)
  if (scanRoots.length) seed.scanRoots = scanRoots
  const docRoots = splitList(process.env.WORKLOG_DOC_ROOTS)
  if (docRoots.length) seed.docRoots = docRoots
  const gitAuthor = String(process.env.WORKLOG_GIT_AUTHOR || '').trim()
  if (gitAuthor) seed.gitAuthor = gitAuthor
  const taskTime = String(process.env.WORKLOG_TASK_TIME || '').trim()
  if (taskTime) seed.taskTime = taskTime
  if (String(process.env.WORKLOG_AUTO_ARCHIVE || '').trim()) {
    seed.autoArchive = /^(1|true|yes|on)$/i.test(String(process.env.WORKLOG_AUTO_ARCHIVE).trim())
  }
  return seed
}

export function defaultConfig() {
  return {
    dataDir: defaultDataDir(),
    scanRoots: [],
    docRoots: [],
    sessionRoots: [],
    gitAuthor: '',
    sources: { git: true, docs: true, sessions: true },
    autoArchive: false,
    skipWeekends: true,
    taskTime: '18:30',
    ai: { baseUrl: '', apiKey: '', model: '', apiFormat: 'openai' },
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
}

function normalizeTime(value, fallback) {
  const text = String(value || '').trim()
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!match) return fallback
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return fallback
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function mergeConfig(base, patch = {}) {
  const sources = { ...(base.sources || {}), ...(patch.sources || {}) }
  const ai = { ...(base.ai || {}), ...(patch.ai || {}) }
  const rawDataDir = String(patch.dataDir || base.dataDir || defaultDataDir()).trim() || defaultDataDir()
  const dataDir = isAbsolute(rawDataDir) ? rawDataDir : join(pluginHome(), rawDataDir)
  return {
    ...base,
    ...patch,
    dataDir,
    scanRoots: normalizeStringArray(patch.scanRoots ?? base.scanRoots),
    docRoots: normalizeStringArray(patch.docRoots ?? base.docRoots),
    sessionRoots: normalizeStringArray(patch.sessionRoots ?? base.sessionRoots),
    gitAuthor: String(patch.gitAuthor ?? base.gitAuthor ?? '').trim(),
    sources: { git: Boolean(sources.git), docs: Boolean(sources.docs), sessions: sources.sessions !== false },
    autoArchive: Boolean(patch.autoArchive ?? base.autoArchive),
    skipWeekends: Boolean(patch.skipWeekends ?? base.skipWeekends),
    taskTime: normalizeTime(patch.taskTime ?? base.taskTime, base.taskTime || '18:30'),
    ai: {
      baseUrl: String(ai.baseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(ai.apiKey || ''),
      model: String(ai.model || '').trim(),
      apiFormat: ai.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
    },
  }
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function loadConfig() {
  let disk = {}
  try {
    disk = JSON.parse(readFileSync(configFile(), 'utf8'))
  } catch {
    disk = {}
  }
  const config = mergeConfig(mergeConfig(defaultConfig(), envSeed()), disk)
  ensureDir(config.dataDir)
  ensureDir(archiveDir(config))
  ensureDir(reportsDir(config))
  ensureDir(backupsDir(config))
  return config
}

export function saveConfig(patch = {}) {
  const current = loadConfig()
  const nextPatch = { ...patch }
  if (nextPatch.ai) {
    const aiPatch = { ...nextPatch.ai }
    if (aiPatch.clearApiKey) {
      aiPatch.apiKey = ''
    } else if (!aiPatch.apiKey) {
      delete aiPatch.apiKey
    }
    delete aiPatch.clearApiKey
    nextPatch.ai = aiPatch
  }
  const next = mergeConfig(current, nextPatch)
  ensureDir(pluginHome())
  writeFileSync(configFile(), JSON.stringify(next, null, 2) + '\n', 'utf8')
  ensureDir(next.dataDir)
  ensureDir(archiveDir(next))
  ensureDir(reportsDir(next))
  ensureDir(backupsDir(next))
  return next
}

export function projectDir() {
  return String(process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || '').trim()
}

/** Roots actually scanned: configured first, workspace as a fallback. */
export function scanRootsOf(config) {
  if (config.scanRoots?.length) return config.scanRoots
  const workspace = projectDir()
  return workspace ? [workspace] : []
}

export function docRootsOf(config) {
  if (config.docRoots?.length) return config.docRoots
  const workspace = projectDir()
  return workspace ? [workspace] : []
}

export function publicConfig(config = loadConfig()) {
  return {
    home: pluginHome(),
    dataDir: config.dataDir,
    archiveDir: archiveDir(config),
    reportsDir: reportsDir(config),
    backupsDir: backupsDir(config),
    configFile: configFile(),
    scanRoots: config.scanRoots,
    effectiveScanRoots: scanRootsOf(config),
    docRoots: config.docRoots,
    effectiveDocRoots: docRootsOf(config),
    sessionRoots: config.sessionRoots,
    gitAuthor: config.gitAuthor,
    sources: config.sources,
    autoArchive: config.autoArchive,
    skipWeekends: config.skipWeekends,
    taskTime: config.taskTime,
    projectDir: projectDir(),
    ai: {
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
      apiFormat: config.ai.apiFormat,
      hasApiKey: Boolean(config.ai.apiKey),
    },
  }
}

export function archiveDir(config) {
  return join(config.dataDir, 'archive')
}

export function reportsDir(config) {
  return join(archiveDir(config), 'reports')
}

export function backupsDir(config) {
  return join(config.dataDir, 'backups')
}

export function todosFile(config) {
  return join(config.dataDir, 'todos.json')
}

export function stateFile(config) {
  return join(config.dataDir, 'state.json')
}

export function localDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function localTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function mondayOf(dateString = localDate()) {
  const [year, month, day] = String(dateString).split('-').map(Number)
  const date = new Date(year, (month || 1) - 1, day || 1)
  const weekday = date.getDay() || 7
  date.setDate(date.getDate() - (weekday - 1))
  return localDate(date)
}

export function currentMonth(dateString = localDate()) {
  return String(dateString).slice(0, 7)
}

export function currentQuarter(dateString = localDate()) {
  const [year, month] = String(dateString).split('-').map(Number)
  return `${year}-Q${Math.floor(((month || 1) - 1) / 3) + 1}`
}

/**
 * Same weekly layout the original WorkLog used, so existing archive folders can
 * be copied in without rewriting paths:
 *   archive/YYYY-MM/第N周(MM.DD-MM.DD)/YYYY-MM-DD.md
 * A week is Monday..Sunday and belongs to the month containing its Thursday.
 */
export function weekPathFor(dateString, config = loadConfig()) {
  const [year, month, day] = String(dateString).split('-').map(Number)
  const date = new Date(year, (month || 1) - 1, day || 1)
  const weekday = date.getDay() || 7
  const monday = new Date(date)
  monday.setDate(date.getDate() - (weekday - 1))
  const thursday = new Date(monday)
  thursday.setDate(monday.getDate() + 3)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  const monthKey = `${thursday.getFullYear()}-${String(thursday.getMonth() + 1).padStart(2, '0')}`
  const weekNo = Math.floor((thursday.getDate() - 1) / 7) + 1
  const week = `第${weekNo}周(${String(monday.getMonth() + 1).padStart(2, '0')}.${String(monday.getDate()).padStart(2, '0')}-${String(sunday.getMonth() + 1).padStart(2, '0')}.${String(sunday.getDate()).padStart(2, '0')})`
  return {
    month: monthKey,
    week,
    relative: join(monthKey, week),
    dir: join(archiveDir(config), monthKey, week),
  }
}

export function dayFile(config, dateString) {
  const { month, week } = weekPathFor(dateString, config)
  return join(archiveDir(config), month, week, `${dateString}.md`)
}

export function isDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false
  const date = new Date(`${value}T00:00:00`)
  return !Number.isNaN(date.getTime()) && localDate(date) === value
}

export function assertDate(value) {
  if (!isDateString(value)) throw new Error(`日期格式应为 YYYY-MM-DD：${value}`)
  return value
}

export function isWithin(parent, child) {
  const base = resolve(parent)
  const target = resolve(child)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}
