/**
 * Session management v2 (R7): one-click full sync builds a persistent index
 * (data/sessions-index.json) of every discovered session across all sources
 * and dates. On top of the index: work-relevance filtering (work dirs from
 * scanRoots + user keywords), grouping, keyword analysis, and user marks.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { localDate, scanRootsOf } from './config.mjs'
import { collectAllSessions, loadCache } from './sessions.mjs'

const MAX_SESSIONS = 5000
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'file', 'using', 'into', 'from', 'have', 'what', 'when', 'please', 'should', 'there', 'about', 'which', 'your',
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '如何', '可以', '需要', '现在', '今天', '昨天', '明天', '然后', '还是', '如果', '这些', '那些', '或者', '以及', '通过', '进行', '使用', '支持', '检查', '问题', '相关', '内容', '信息', '数据', '文件', '目录', '工作', '项目', '测试', '确认', '完成', '处理', '开始', '继续', '帮忙', '帮我', '看看', '一下',
])

function indexFile(config) {
  return join(config.dataDir, 'sessions-index.json')
}

export async function loadSessionIndex(config) {
  try {
    const parsed = JSON.parse(await readFile(indexFile(config), 'utf8'))
    if (parsed && Array.isArray(parsed.sessions)) return parsed
  } catch {
    /* fresh index */
  }
  return { version: 1, builtAt: '', total: 0, sessions: [] }
}

async function saveSessionIndex(config, index) {
  await mkdir(dirname(indexFile(config)), { recursive: true })
  await writeFile(indexFile(config), JSON.stringify(index, null, 2) + '\n', 'utf8')
  return index
}

function sessionKey(source, file) {
  return createHash('sha1').update(String(source) + '|' + String(file)).digest('hex').slice(0, 16)
}

/**
 * One-click full sync: scan every source (cache-backed) and persist a flat
 * index. User marks/groups survive rebuilds by session key.
 */
export async function buildSessionIndex(config, { force = false, windowDays = 120, home = homedir(), dshHome } = {}) {
  const { all, errors } = await collectAllSessions(config, { force, windowDays, home, dshHome })
  const previous = await loadSessionIndex(config)
  const meta = new Map(previous.sessions.map((item) => [item.key, { marks: item.marks || [], group: item.group || '' }]))
  const sessions = all
    .map((session) => {
      const dates = Object.keys(session.dates || {}).sort()
      if (!dates.length) return null
      const texts = []
      let size = 0
      for (const date of dates.slice(0, 3)) {
        for (const text of session.dates[date]?.texts || []) {
          texts.push(text)
          size += text.length
          if (size > 400) break
        }
        if (size > 400) break
      }
      const metaEntry = meta.get(sessionKey(session.source, session.file))
      return {
        key: sessionKey(session.source, session.file),
        source: session.source,
        label: session.label || session.source,
        title: String(session.title || '(无标题)').slice(0, 140),
        cwd: String(session.cwd || '').slice(0, 200),
        project: session.cwd ? String(session.cwd).split(/[\\/]/).filter(Boolean).pop() || '' : '',
        file: session.file,
        first: dates[0],
        last: dates[dates.length - 1],
        datesCount: dates.length,
        turns: Object.values(session.dates || {}).reduce((sum, day) => sum + (day.turns || 0), 0),
        preview: texts.join(' ').slice(0, 400),
        marks: metaEntry?.marks || [],
        group: metaEntry?.group || '',
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.last).localeCompare(String(a.last)))
    .slice(0, MAX_SESSIONS)
  const index = { version: 1, builtAt: new Date().toISOString(), total: sessions.length, sessions }
  await saveSessionIndex(config, index)
  return { builtAt: index.builtAt, total: index.total, errors }
}

export function isWorkRelated(session, workKeywords = [], workDirs = []) {
  const cwd = String(session.cwd || '')
  if (workDirs.some((dir) => cwd.toLowerCase().startsWith(String(dir).toLowerCase()))) return true
  const keywords = (Array.isArray(workKeywords) ? workKeywords : []).map((item) => String(item).toLowerCase()).filter(Boolean)
  if (!keywords.length) return false
  const haystack = (session.title + ' ' + session.preview + ' ' + cwd).toLowerCase()
  return keywords.some((keyword) => haystack.includes(keyword))
}

/**
 * Filter the index: q/project/source/date range/minTurns/mark/group/workOnly.
 * Returns matched sessions (cap 200) plus keyword analysis of the filtered
 * set and a grouped map when groupBy is given.
 */
export async function querySessions(config, filter = {}) {
  const index = await loadSessionIndex(config)
  const q = String(filter.q || '').trim().toLowerCase()
  const project = String(filter.project || filter.cwd || '').trim().toLowerCase()
  const source = String(filter.source || '').trim()
  const start = String(filter.start || '').slice(0, 10)
  const end = String(filter.end || '').slice(0, 10)
  const minTurns = Number(filter.minTurns) || 0
  const mark = String(filter.mark || '').trim()
  const group = String(filter.group || '').trim()
  let list = index.sessions
  if (q) list = list.filter((s) => (s.title + ' ' + s.preview).toLowerCase().includes(q))
  if (project) list = list.filter((s) => (s.cwd + ' ' + s.project).toLowerCase().includes(project))
  if (source) list = list.filter((s) => s.source === source)
  if (start) list = list.filter((s) => s.last >= start)
  if (end) list = list.filter((s) => s.first <= end)
  if (minTurns) list = list.filter((s) => s.turns >= minTurns)
  if (mark) list = list.filter((s) => (s.marks || []).includes(mark))
  if (group) list = list.filter((s) => s.group === group)
  if (filter.workOnly) {
    const workKeywords = Array.isArray(filter.workKeywords) ? filter.workKeywords : []
    const workDirs = scanRootsOf(config)
    list = list.filter((s) => isWorkRelated(s, workKeywords, workDirs))
  }
  const matched = list.length
  const page = list.slice(0, 200)
  return {
    total: index.total,
    builtAt: index.builtAt,
    matched,
    sessions: page,
    keywords: analyzeSessionKeywords(list),
    groups: groupSessions(page, filter.groupBy || ''),
  }
}

export function groupSessions(sessions, by) {
  const map = {}
  for (const session of sessions) {
    let keys = []
    if (by === 'project') keys = [session.project || '(无项目)']
    else if (by === 'source') keys = [session.label]
    else if (by === 'date') keys = [session.last]
    else if (by === 'mark') keys = (session.marks || []).length ? session.marks : ['(未标记)']
    else if (by === 'group') keys = [session.group || '(未分组)']
    else continue
    for (const key of keys) {
      map[key] = map[key] || []
      map[key].push(session.key)
    }
  }
  return map
}

export function analyzeSessionKeywords(sessions, { top = 15 } = {}) {
  const counts = new Map()
  const bump = (word) => counts.set(word, (counts.get(word) || 0) + 1)
  for (const session of sessions.slice(0, 500)) {
    const haystack = String(session.title + ' ' + (session.preview || ''))
    for (const word of haystack.match(/[a-zA-Z][a-zA-Z0-9_.-]{3,}/g) || []) {
      const key = word.toLowerCase()
      if (!STOPWORDS.has(key)) bump(key)
    }
    for (const run of haystack.match(/[一-龥]{2,}/g) || []) {
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= run.length; i++) {
          const gram = run.slice(i, i + n)
          if (!STOPWORDS.has(gram)) bump(gram)
        }
      }
    }
  }
  return [...counts.entries()]
    .filter(([word, count]) => count >= 2 && word.length >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, top)
    .map(([word, count]) => ({ word, count }))
}

export async function markSessions(config, keys, mark, { remove = false } = {}) {
  const wanted = new Set((Array.isArray(keys) ? keys : [keys]).filter(Boolean))
  if (!wanted.size) throw new Error('标记需要至少一个会话 key')
  const label = String(mark || '').trim().slice(0, 16)
  if (!label) throw new Error('标记内容不能为空')
  const index = await loadSessionIndex(config)
  let touched = 0
  for (const session of index.sessions) {
    if (!wanted.has(session.key)) continue
    const marks = new Set(session.marks || [])
    if (remove) marks.delete(label)
    else marks.add(label)
    session.marks = [...marks].slice(0, 6)
    touched += 1
  }
  await saveSessionIndex(config, index)
  return { touched, mark: label }
}

export async function setSessionGroup(config, keys, group) {
  const wanted = new Set((Array.isArray(keys) ? keys : [keys]).filter(Boolean))
  if (!wanted.size) throw new Error('分组需要至少一个会话 key')
  const label = String(group || '').trim().slice(0, 24)
  const index = await loadSessionIndex(config)
  let touched = 0
  for (const session of index.sessions) {
    if (!wanted.has(session.key)) continue
    session.group = label
    touched += 1
  }
  await saveSessionIndex(config, index)
  return { touched, group: label }
}

/**
 * Per-day session counts for the sessions month calendar: a session counts
 * for every day it was active (first <= day <= last).
 */
export function sessionMonthCounts(sessions, month) {
  const days = {}
  const [year, mon] = String(month).split('-').map(Number)
  const total = new Date(year, mon, 0).getDate()
  for (let i = 1; i <= total; i++) {
    const date = month + '-' + String(i).padStart(2, '0')
    days[date] = 0
  }
  for (const session of sessions) {
    const first = String(session.first || '')
    const last = String(session.last || '')
    for (const date of Object.keys(days)) {
      if (first <= date && date <= last) days[date] += 1
    }
  }
  return days
}

/**
 * Full excerpt view for one session. Pure cache read: the excerpt data is
 * already persisted in data/session-cache.json by 同步会话 (buildSessionIndex
 * → collectAllSessions), so opening the detail must NEVER rescan the machine
 * — a full scan on a real machine takes minutes, times out the panel call and
 * gets the panel killed by the host (the 0.21.0 "加载完整摘录就卡死" bug).
 */
export async function getSessionDetail(config, key, { home = homedir(), dshHome } = {}) {
  const index = await loadSessionIndex(config)
  const meta = index.sessions.find((item) => item.key === String(key || ''))
  if (!meta) throw new Error('会话不在索引中，请先同步会话')
  const cache = await loadCache(config)
  const entry = Object.values(cache.files || {}).find(
    (item) => item && item.source === meta.source && item.session?.file === meta.file,
  )
  const session = entry?.session
  if (!session) {
    return { ...meta, available: false, note: '摘录尚未同步——先点「同步会话」，完成后再加载完整摘录' }
  }
  const dates = Object.entries(session.dates || {})
    .map(([date, day]) => ({ date, turns: day.turns || 0, texts: day.texts || [] }))
    .sort((a, b) => a.date.localeCompare(b.date))
  return { ...meta, available: true, dates }
}
