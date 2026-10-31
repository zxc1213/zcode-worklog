/**
 * Unified entry timeline (REQ-O1): every collected fact becomes one entry —
 * git commits, doc changes, AI sessions, watched-file changes, later external
 * connectors. Append-only with fingerprint dedupe so repeated collection runs
 * are idempotent; history is never rewritten.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { localDate, localTime } from './config.mjs'

const MAX_DETAIL = 400
const MAX_TITLE = 160
const MAX_ENTRIES = 20000
const SOURCES = ['git', 'docs', 'sessions', 'watch', 'feishu', 'zentao', 'hermes', 'manual']

function entriesFile(config) {
  return join(config.dataDir, 'entries.json')
}

export function makeFingerprint(source, nativeId) {
  return createHash('sha1').update(String(source) + '|' + String(nativeId)).digest('hex').slice(0, 16)
}

function normalizeEntry(input = {}) {
  const title = String(input.title || '').trim()
  if (!title) return null
  const source = SOURCES.includes(input.source) ? input.source : 'manual'
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) ? input.date : localDate()
  const time = /^\d{1,2}:\d{2}$/.test(String(input.time || '')) ? input.time : ''
  const fp = String(input.fp || '') || makeFingerprint(source, nativeKey(input) || title + '|' + date + '|' + time)
  return {
    id: String(input.id || '').trim() || fp,
    fp,
    source,
    type: String(input.type || source),
    date,
    time,
    title: title.slice(0, MAX_TITLE),
    detail: String(input.detail || '').slice(0, MAX_DETAIL),
    project: String(input.project || '').slice(0, 80),
    tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).slice(0, 40)).filter(Boolean).slice(0, 6) : [],
    ref: String(input.ref || '').slice(0, 300),
  }
}

function nativeKey(input) {
  return String(input.nativeId || input.ref || '')
}

export async function loadEntries(config) {
  let parsed = []
  try {
    const raw = JSON.parse(await readFile(entriesFile(config), 'utf8'))
    if (Array.isArray(raw)) parsed = raw
  } catch {
    parsed = []
  }
  return parsed.map(normalizeEntry).filter(Boolean)
}

export async function appendEntries(config, list = []) {
  const entries = await loadEntries(config)
  const seen = new Set(entries.map((entry) => entry.fp))
  let added = 0
  for (const item of Array.isArray(list) ? list : []) {
    const entry = normalizeEntry(item)
    if (!entry) continue
    if (seen.has(entry.fp)) continue
    seen.add(entry.fp)
    entries.push(entry)
    added += 1
  }
  let trimmed = 0
  if (entries.length > MAX_ENTRIES) {
    trimmed = entries.length - MAX_ENTRIES
    entries.splice(0, trimmed)
  }
  if (added || trimmed) {
    await mkdir(dirname(entriesFile(config)), { recursive: true })
    await writeFile(entriesFile(config), JSON.stringify(entries, null, 2) + '\n', 'utf8')
  }
  return { added, trimmed }
}

export async function entriesForDate(config, dateString) {
  return (await loadEntries(config)).filter((entry) => entry.date === dateString)
}

export async function entriesRange(config, start, end) {
  return (await loadEntries(config)).filter((entry) => entry.date >= start && entry.date <= end)
}

/** Bucket entries by date for calendar month views: {date: {count, bySource}}. */
export async function entriesBucketByDate(config, monthPrefix = '') {
  const buckets = {}
  for (const entry of await loadEntries(config)) {
    if (monthPrefix && !entry.date.startsWith(monthPrefix)) continue
    const bucket = buckets[entry.date] || (buckets[entry.date] = { count: 0, bySource: {} })
    bucket.count += 1
    bucket.bySource[entry.source] = (bucket.bySource[entry.source] || 0) + 1
  }
  return buckets
}

/** Section lines for the daily archive: per-source counts + sample titles. */
export async function entriesDaySection(config, dateString) {
  const entries = await entriesForDate(config, dateString)
  if (!entries.length) return []
  const bySource = {}
  for (const entry of entries) bySource[entry.source] = (bySource[entry.source] || 0) + 1
  const lines = [ '- 采集条目 ' + entries.length + ' 条：' + Object.entries(bySource).map(([source, count]) => source + ' ' + count).join('、') ]
  const sample = entries.slice(0, 8).map((entry) => {
    const prefix = entry.project ? '[' + entry.project + '] ' : ''
    return prefix + entry.title
  })
  if (entries.length > 8) sample.push('等 ' + entries.length + ' 条')
  lines.push('- ' + sample.join('、'))
  return lines
}
