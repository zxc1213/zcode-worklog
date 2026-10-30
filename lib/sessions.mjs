/**
 * Read-only scanners for local AI tool session records.
 *
 * Supported sources:
 *   - Claude Code:  ~/.claude/projects/**\/*.jsonl
 *   - Codex CLI:    ~/.codex/sessions/YYYY/MM/DD/*.jsonl
 *   - DeepSeek Harness: ~/.dsh/sessions/**\/session*.jsonl[.zstd]
 *   - WorkBuddy:    ~/.workbuddy/projects/**\/*.jsonl
 *   - ZCode:        ~/.zcode/cli/db/db.sqlite (session/message/part)
 *   - OpenCode:     ~/.local/share/opencode/storage/{session,message,part}
 *   - Gemini family: ~/.gemini|.qwen|.iflow/tmp/*\/chats/*.json
 *   - custom:       config.sessionRoots (generic json/jsonl)
 *
 * Parsed results are cached by mtime+size in data/session-cache.json so daily
 * archiving only re-reads changed files. Session text never leaves the machine.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { localDate, localTime } from './config.mjs'

const CACHE_VERSION = 1
const MAX_TEXT = 220
const MAX_TEXTS = 3
const MAX_FILE_BYTES = 40 * 1024 * 1024

const SOURCE_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'DeepSeek Harness',
  workbuddy: 'WorkBuddy',
  zcode: 'ZCode',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  custom: '自定义',
}

function labelFor(source) {
  return SOURCE_LABELS[source] || source
}

export function sessionCacheFile(config) {
  return join(config.dataDir, 'session-cache.json')
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

function toMs(value) {
  if (value == null || value === '') return 0
  if (typeof value === 'number') return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  if (value instanceof Date) return value.getTime()
  const text = String(value).trim()
  if (!text) return 0
  if (/^\d+$/.test(text)) return toMs(Number(text))
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime()
}

function dayBounds(dateString) {
  const [year, month, day] = String(dateString).split('-').map(Number)
  const start = new Date(year, (month || 1) - 1, day || 1).getTime()
  const end = new Date(year, (month || 1) - 1, (day || 1) + 1).getTime()
  return [start, end]
}

function textBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && ['text', 'input_text', 'output_text'].includes(part.type))
    .map((part) => part.text || '')
    .join('\n')
}

const NOISE_PREFIXES = [
  '<command-message',
  '<command-name',
  '<command-args',
  '<local-command',
  '<system-reminder',
  '<environment_context',
  '<agents-instructions',
  '<user_instructions',
  '<project_instructions',
  'Available agent types for the Agent tool',
  'The following deferred tools are available via LocalToolSearch',
  'Base directory for this skill',
  '# Project Instructions',
  '# AGENTS.md',
  'Caveat: The messages below',
  '[Request interrupted by user]',
]

export function cleanUserText(raw) {
  let text = String(raw ?? '').replace(/\r/g, '')
  if (!text.trim()) return ''
  const query = /<user_query>([\s\S]*?)<\/user_query>/i.exec(text)
  if (query) text = query[1]
  text = text
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<environment_context[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<agents-instructions[\s\S]*?<\/agents-instructions>/gi, '')
    .replace(/<user_instructions[\s\S]*?<\/user_instructions>/gi, '')
    .replace(/<project_instructions[\s\S]*?<\/project_instructions>/gi, '')
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const lower = text.toLowerCase()
  if (NOISE_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()))) return ''
  if (/^<[a-z][\w-]*[\s>]/i.test(text) && text.endsWith('>')) return ''
  if (text.length < 2) return ''
  return text.slice(0, MAX_TEXT)
}

function addTurn(session, timestamp, text, seen) {
  const ms = toMs(timestamp)
  if (!ms) return
  const key = text || ''
  if (key && seen) {
    if (seen.has(key)) return
    seen.add(key)
  }
  const date = localDate(new Date(ms))
  if (!session.dates[date]) session.dates[date] = { turns: 0, first: ms, last: ms, texts: [] }
  const day = session.dates[date]
  day.turns += 1
  if (ms < day.first) day.first = ms
  if (ms > day.last) day.last = ms
  if (key && day.texts.length < MAX_TEXTS && !day.texts.includes(key)) day.texts.push(key)
}

function newSession(source, file) {
  return { source, label: labelFor(source), file, title: '', cwd: '', dates: {} }
}

function finishSession(session, fallbackTitle = '') {
  if (!session) return null
  if (!Object.keys(session.dates).length) return null
  if (!session.title) {
    const dates = Object.keys(session.dates).sort()
    session.title = fallbackTitle || session.dates[dates[0]]?.texts[0] || '(无标题)'
  }
  return session
}

async function listFiles(root, { maxDepth = 4, match = () => true, limit = 20000 } = {}) {
  const out = []
  if (!root || !existsSync(root)) return out
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length && out.length < limit) {
    const { dir, depth } = queue.shift()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          queue.push({ dir: full, depth: depth + 1 })
        }
      } else if (entry.isFile() && match(full)) {
        out.push(full)
      }
    }
  }
  return out
}

/** DSH keeps session.v3 and session.v4 side by side; prefer the newest version. */
function latestDshFiles(files) {
  const byDir = new Map()
  for (const file of files) {
    const match = /session\.v(\d+)\.jsonl/.exec(file)
    const score = match ? Number(match[1]) : 0
    const previous = byDir.get(dirname(file))
    if (!previous || score > previous.score) byDir.set(dirname(file), { file, score })
  }
  return [...byDir.values()].map((entry) => entry.file)
}

async function parseClaudeFile(file) {
  const text = await readFile(file, 'utf8')
  const session = newSession('claude', file)
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let data
    try {
      data = JSON.parse(line)
    } catch {
      continue
    }
    if (data.type === 'ai-title' && data.aiTitle) session.title = String(data.aiTitle)
    if (!session.cwd && data.cwd) session.cwd = String(data.cwd)
    if (data.type !== 'user' || data.isMeta) continue
    if (data.origin?.kind && data.origin.kind !== 'human') continue
    if (data.promptSource && data.promptSource !== 'typed') continue
    const clean = cleanUserText(textBlocks(data.message?.content ?? data.content))
    if (clean) addTurn(session, data.timestamp, clean, seen)
  }
  return finishSession(session)
}

async function parseCodexFile(file) {
  const text = await readFile(file, 'utf8')
  const session = newSession('codex', file)
  const seen = new Set()
  let header = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let data
    try {
      data = JSON.parse(line)
    } catch {
      continue
    }
    if (data.type === 'session_meta') {
      header = data.payload || {}
      if (!session.cwd && header.cwd) session.cwd = String(header.cwd)
      continue
    }
    if (data.type === 'event_msg' && data.payload?.type === 'user_message') {
      const clean = cleanUserText(data.payload.message)
      if (clean) addTurn(session, data.timestamp || header?.timestamp, clean, seen)
      continue
    }
    if (data.type === 'response_item' && data.payload?.role === 'user') {
      const clean = cleanUserText(textBlocks(data.payload.content))
      if (clean) addTurn(session, data.timestamp, clean, seen)
    }
  }
  return finishSession(session)
}

async function zstdDecompress(buffer) {
  let zlib
  try {
    zlib = await import('node:zlib')
  } catch {
    return ''
  }
  if (typeof zlib.zstdDecompressSync !== 'function') return ''
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const parts = []
  let start = buffer.indexOf(magic)
  if (start < 0) return ''
  while (start >= 0) {
    const next = buffer.indexOf(magic, start + 4)
    const end = next < 0 ? buffer.length : next
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      /* skip a damaged frame */
    }
    start = next
  }
  return Buffer.concat(parts).toString('utf8')
}

async function parseDshFile(file) {
  const buffer = await readFile(file)
  const text = file.endsWith('.zstd') ? await zstdDecompress(buffer) : buffer.toString('utf8')
  if (!text) return null
  const session = newSession('dsh', file)
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let data
    try {
      data = JSON.parse(line)
    } catch {
      continue
    }
    if (data.type === 'session') {
      if (!session.cwd && data.cwd) session.cwd = String(data.cwd)
      continue
    }
    if (data.type === 'session/title' && data.data?.title) {
      session.title = String(data.data.title)
      continue
    }
    if (data.type !== 'user/message') continue
    const sourceKind = data.data?.source?.kind
    if (sourceKind && sourceKind !== 'user') continue
    const clean = cleanUserText(textBlocks(data.data?.content))
    if (clean) addTurn(session, data.time, clean, seen)
  }
  return finishSession(session)
}

async function parseWorkBuddyFile(file) {
  const text = await readFile(file, 'utf8')
  const session = newSession('workbuddy', file)
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let data
    try {
      data = JSON.parse(line)
    } catch {
      continue
    }
    if (!session.cwd && data.cwd) session.cwd = String(data.cwd)
    if (data.type !== 'message' || data.role !== 'user') continue
    const clean = cleanUserText(textBlocks(data.content) || data.content)
    if (clean) addTurn(session, data.timestamp, clean, seen)
  }
  return finishSession(session)
}

async function parseGeminiFile(file) {
  const data = await readJson(file)
  if (!data) return null
  const messages = Array.isArray(data) ? data : data.messages
  if (!Array.isArray(messages)) return null
  const session = newSession('gemini', file)
  session.title = String(data.title || '')
  session.cwd = String(data.workspace || data.cwd || data.directory || '')
  const seen = new Set()
  for (const message of messages) {
    const role = message?.role || message?.type
    if (role !== 'user') continue
    const clean = cleanUserText(textBlocks(message.content) || message.content || message.text)
    if (clean) addTurn(session, message.timestamp ?? message.time ?? message.createdAt, clean, seen)
  }
  return finishSession(session)
}

async function parseGenericFile(file) {
  if (file.endsWith('.json')) {
    const data = await readJson(file)
    if (!data) return null
    if (Array.isArray(data)) {
      const session = newSession('custom', file)
      const seen = new Set()
      for (const message of data) {
        if ((message?.role || message?.type) !== 'user') continue
        const clean = cleanUserText(textBlocks(message.content) || message.content || message.text)
        if (clean) addTurn(session, message.timestamp ?? message.time, clean, seen)
      }
      return finishSession(session)
    }
    if (Array.isArray(data.messages)) {
      const session = newSession('custom', file)
      session.title = String(data.title || '')
      session.cwd = String(data.cwd || data.directory || '')
      const seen = new Set()
      for (const message of data.messages) {
        if ((message?.role || message?.type) !== 'user') continue
        const clean = cleanUserText(textBlocks(message.content) || message.content || message.text)
        if (clean) addTurn(session, message.timestamp ?? message.time, clean, seen)
      }
      return finishSession(session)
    }
    return null
  }

  const text = await readFile(file, 'utf8')
  const session = newSession('custom', file)
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let data
    try {
      data = JSON.parse(line)
    } catch {
      continue
    }
    if (data.cwd && !session.cwd) session.cwd = String(data.cwd)
    const role = data.role || data.message?.role || data.payload?.role || data.data?.role
    if (role !== 'user') continue
    const clean = cleanUserText(
      textBlocks(data.content ?? data.message?.content ?? data.payload?.content ?? data.data?.content),
    )
    if (clean) addTurn(session, data.timestamp ?? data.time ?? data.createdAt, clean, seen)
  }
  return finishSession(session)
}

async function parseOpenCodeSession(root, sessionFile, dateString) {
  const data = await readJson(sessionFile)
  if (!data?.id) return null
  const [start, end] = dayBounds(dateString)
  const created = toMs(data.time?.created)
  const updated = toMs(data.time?.updated) || created
  if ((created && created >= end) || (updated && updated < start)) return null

  const session = newSession('opencode', sessionFile)
  session.title = String(data.title || '')
  session.cwd = String(data.directory || '')
  const seen = new Set()
  const messageDir = join(root, 'message', data.id)
  for (const file of await listFiles(messageDir, { maxDepth: 0, match: (path) => path.endsWith('.json') })) {
    const message = await readJson(file)
    if (!message || message.role !== 'user') continue
    const createdMs = toMs(message.time?.created)
    if (createdMs < start || createdMs >= end) continue
    const partDir = join(root, 'part', message.id)
    const parts = []
    for (const partFile of await listFiles(partDir, { maxDepth: 0, match: (path) => path.endsWith('.json') })) {
      const part = await readJson(partFile)
      if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    }
    const clean = cleanUserText(parts.join('\n'))
    if (clean) addTurn(session, createdMs, clean, seen)
  }
  return finishSession(session)
}

async function scanOpenCode(config, dateString, home = homedir()) {
  const root = join(home, '.local', 'share', 'opencode', 'storage')
  const sessionRoot = join(root, 'session')
  if (!existsSync(sessionRoot)) return []
  const sessions = []
  for (const file of await listFiles(sessionRoot, { maxDepth: 2, match: (path) => path.endsWith('.json') })) {
    const session = await parseOpenCodeSession(root, file, dateString)
    if (session) sessions.push(session)
  }
  return sessions
}

async function scanZcode(config, dateString, home = homedir()) {
  const dbFile = join(home, '.zcode', 'cli', 'db', 'db.sqlite')
  if (!existsSync(dbFile)) return []
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return []
  }
  const [start, end] = dayBounds(dateString)
  let db
  try {
    db = new DatabaseSync(dbFile, { readOnly: true })
    const rows = db.prepare(`
      select m.id as mid, m.session_id as sid, m.data as mdata, m.time_created as mt,
             p.data as pdata, s.title as title, s.directory as dir
      from message m
      join session s on s.id = m.session_id
      join part p on p.message_id = m.id
      where m.time_created >= ? and m.time_created < ?
      order by m.time_created
    `).all(start, end)
    const bySession = new Map()
    const byMessage = new Map()
    for (const row of rows) {
      let message
      try {
        message = JSON.parse(row.mdata || '{}')
      } catch {
        continue
      }
      if (message.role !== 'user') continue
      const meta = message.metadata || {}
      if (meta.visibility === 'model-only' || meta.runtimeMessage) continue
      if (message.semantics?.origin === 'agent_runtime') continue
      let part
      try {
        part = JSON.parse(row.pdata || '{}')
      } catch {
        continue
      }
      if (part.type !== 'text' || typeof part.text !== 'string') continue
      const clean = cleanUserText(part.text)
      if (!clean) continue
      let session = bySession.get(row.sid)
      if (!session) {
        session = newSession('zcode', dbFile)
        session.title = String(row.title || '')
        session.cwd = String(row.dir || '')
        bySession.set(row.sid, session)
      }
      const key = `${row.sid}|${row.mid}`
      if (!byMessage.has(key)) byMessage.set(key, { session, ms: row.mt, texts: [] })
      const bucket = byMessage.get(key)
      if (!bucket.texts.includes(clean)) bucket.texts.push(clean)
    }
    for (const bucket of byMessage.values()) {
      addTurn(bucket.session, bucket.ms, bucket.texts.join(' '))
    }
    return [...bySession.values()].map((session) => finishSession(session)).filter(Boolean)
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}

async function loadCache(config) {
  const data = await readJson(sessionCacheFile(config))
  if (!data || data.version !== CACHE_VERSION || typeof data.files !== 'object') {
    return { version: CACHE_VERSION, files: {} }
  }
  return { version: CACHE_VERSION, files: data.files || {} }
}

async function saveCache(config, cache) {
  await mkdir(config.dataDir, { recursive: true })
  await writeFile(sessionCacheFile(config), JSON.stringify(cache) + '\n', 'utf8')
}

async function parseWithCache(file, source, parser, cache, force, seen) {
  seen.add(file)
  let info
  try {
    info = await stat(file)
  } catch {
    return null
  }
  if (info.size > MAX_FILE_BYTES) return null
  const previous = cache.files[file]
  if (
    !force &&
    previous &&
    previous.source === source &&
    previous.mtimeMs === info.mtimeMs &&
    previous.size === info.size
  ) {
    return previous.session || null
  }
  let session = null
  try {
    session = await parser(file)
  } catch {
    session = null
  }
  cache.files[file] = { source, mtimeMs: info.mtimeMs, size: info.size, session }
  return session
}

async function scanFileRoot(config, cache, options, seen, force) {
  const { root, match, source, parser, maxDepth = 4 } = options
  const sessions = []
  let files = await listFiles(root, { maxDepth, match })
  if (source === 'dsh') files = latestDshFiles(files)
  for (const file of files) {
    const session = await parseWithCache(file, source, parser, cache, force, seen)
    if (session) sessions.push(session)
  }
  return sessions
}

function sessionForDay(session, dateString) {
  const day = session.dates?.[dateString]
  if (!day) return null
  const first = day.first || day.last
  const last = day.last || day.first
  const range = first && last
    ? `${localTime(new Date(first))}${localTime(new Date(first)) === localTime(new Date(last)) ? '' : '–' + localTime(new Date(last))}`
    : ''
  return {
    source: session.source,
    label: session.label || labelFor(session.source),
    title: String(session.title || '(无标题)').slice(0, 120),
    cwd: session.cwd || '',
    turns: day.turns,
    first,
    last,
    timeRange: range,
    texts: day.texts || [],
    file: session.file,
  }
}

export async function scanSessions(config, dateString, { force = false, home = homedir(), dshHome } = {}) {
  if (config.sources?.sessions === false) {
    return { date: dateString, sessions: [], totals: { sessions: 0, turns: 0 }, errors: [] }
  }
  const resolvedDshHome = dshHome || process.env.DSH_HOME || join(home, '.dsh')
  const cache = force ? { version: CACHE_VERSION, files: {} } : await loadCache(config)
  const seen = new Set()
  const all = []
  const errors = []

  const roots = [
    {
      source: 'claude',
      label: 'Claude Code',
      root: join(home, '.claude', 'projects'),
      maxDepth: 3,
      match: (file) => file.endsWith('.jsonl'),
      parser: parseClaudeFile,
    },
    {
      source: 'codex',
      label: 'Codex',
      root: join(home, '.codex', 'sessions'),
      maxDepth: 6,
      match: (file) => file.endsWith('.jsonl'),
      parser: parseCodexFile,
    },
    {
      source: 'dsh',
      label: 'DeepSeek Harness',
      root: join(resolvedDshHome, 'sessions'),
      maxDepth: 4,
      match: (file) => /session.*\.jsonl(\.zstd)?$/.test(file),
      parser: parseDshFile,
    },
    {
      source: 'workbuddy',
      label: 'WorkBuddy',
      root: join(home, '.workbuddy', 'projects'),
      maxDepth: 3,
      match: (file) => file.endsWith('.jsonl') && !file.includes('.file-rollback.'),
      parser: parseWorkBuddyFile,
    },
  ]

  for (const source of roots) {
    try {
      all.push(...await scanFileRoot(config, cache, source, seen, force))
    } catch (error) {
      errors.push({ source: source.source, error: String(error?.message || error) })
    }
  }

  for (const family of ['gemini', 'qwen', 'iflow']) {
    const base = join(home, `.${family}`, 'tmp')
    if (!existsSync(base)) continue
    try {
      all.push(...await scanFileRoot(config, cache, {
        source: 'gemini',
        root: base,
        maxDepth: 4,
        match: (file) => file.endsWith('.json') && /[\\/]chats[\\/]/.test(file),
        parser: parseGeminiFile,
      }, seen, force))
    } catch (error) {
      errors.push({ source: family, error: String(error?.message || error) })
    }
  }

  const customRoots = Array.isArray(config.sessionRoots) ? config.sessionRoots : []
  for (const root of customRoots) {
    try {
      all.push(...await scanFileRoot(config, cache, {
        source: 'custom',
        root,
        maxDepth: 5,
        match: (file) => file.endsWith('.jsonl') || file.endsWith('.json'),
        parser: parseGenericFile,
      }, seen, force))
    } catch (error) {
      errors.push({ source: 'custom', root, error: String(error?.message || error) })
    }
  }

  try {
    all.push(...await scanZcode(config, dateString, home))
  } catch (error) {
    errors.push({ source: 'zcode', error: String(error?.message || error) })
  }
  try {
    all.push(...await scanOpenCode(config, dateString, home))
  } catch (error) {
    errors.push({ source: 'opencode', error: String(error?.message || error) })
  }

  for (const key of Object.keys(cache.files)) {
    if (!seen.has(key)) delete cache.files[key]
  }
  try {
    await saveCache(config, cache)
  } catch {
    /* cache is an optimization only */
  }

  const sessions = all
    .map((session) => sessionForDay(session, dateString))
    .filter(Boolean)
    .sort((a, b) => a.first - b.first || a.label.localeCompare(b.label))
  const turns = sessions.reduce((sum, session) => sum + session.turns, 0)
  return { date: dateString, sessions, totals: { sessions: sessions.length, turns }, errors }
}

export async function listSessionSources(config, { home = homedir(), dshHome } = {}) {
  const resolvedDshHome = dshHome || process.env.DSH_HOME || join(home, '.dsh')
  const sources = [
    { id: 'claude', label: 'Claude Code', path: join(home, '.claude', 'projects'), kind: 'dir' },
    { id: 'codex', label: 'Codex', path: join(home, '.codex', 'sessions'), kind: 'dir' },
    { id: 'dsh', label: 'DeepSeek Harness', path: join(resolvedDshHome, 'sessions'), kind: 'dir' },
    { id: 'workbuddy', label: 'WorkBuddy', path: join(home, '.workbuddy', 'projects'), kind: 'dir' },
    { id: 'zcode', label: 'ZCode', path: join(home, '.zcode', 'cli', 'db', 'db.sqlite'), kind: 'db' },
    { id: 'opencode', label: 'OpenCode', path: join(home, '.local', 'share', 'opencode', 'storage'), kind: 'dir' },
    { id: 'gemini', label: 'Gemini CLI', path: join(home, '.gemini', 'tmp'), kind: 'dir' },
  ]
  for (const root of Array.isArray(config.sessionRoots) ? config.sessionRoots : []) {
    sources.push({ id: 'custom', label: '自定义', path: root, kind: 'dir' })
  }
  return sources.map((source) => ({ ...source, exists: existsSync(source.path), enabled: config.sources?.sessions !== false }))
}

/** Parse the "## AI 会话" section written into a daily archive. */
export function parseSessionLines(markdown) {
  const items = []
  let inSection = false
  for (const line of String(markdown || '').split(/\r?\n/)) {
    if (/^##\s+/.test(line)) {
      inSection = /^##\s+AI 会话\s*$/.test(line)
      continue
    }
    if (!inSection) continue
    const match = /^-\s+\[(.+?)\]\s+(\d{2}:\d{2})(?:[–-](\d{2}:\d{2}))?\s+·\s+(\d+)\s+轮\s+·\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    items.push({
      source: match[1],
      start: match[2],
      end: match[3] || match[2],
      turns: Number(match[4]) || 0,
      title: match[5],
    })
  }
  return items
}

export function sessionMarkdownSection(result) {
  const sessions = result?.sessions || []
  const lines = ['## AI 会话', '']
  if (!sessions.length) {
    lines.push('今天没有扫描到 AI 会话。', '')
    return lines
  }
  for (const session of sessions) {
    const title = String(session.title || '(无标题)').replace(/\s+/g, ' ').slice(0, 120)
    const range = session.timeRange ? ` ${session.timeRange} ·` : ''
    lines.push(`- [${session.label}]${range} ${session.turns} 轮 · ${title}`)
    if (session.cwd) lines.push(`  - 项目：\`${String(session.cwd).replace(/`/g, "'")}\``)
  }
  lines.push('')
  return lines
}

export { dayBounds, toMs }
