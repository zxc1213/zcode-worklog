/**
 * Watched-directory fingerprint scanning. Each configured dir (local / cloud
 * drive / git) is walked with a bounded depth; per-file mtime+size fingerprints
 * are diffed against data/watch-cache.json so repeated scans only surface
 * changes. Entries production lands in R2; R1 surfaces counts for diagnostics.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { localDate, localTime } from './config.mjs'
import { appendEntries } from './entries.mjs'

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', 'venv', '.venv', '__pycache__',
  'AppData', 'Library', 'System32', 'WinSxS', '$RECYCLE.BIN', 'System Volume Information',
])
const MAX_FILES_PER_DIR = 5000
const MAX_DEPTH = 6

function watchCacheFile(config) {
  return join(config.dataDir, 'watch-cache.json')
}

export async function loadWatchCache(config) {
  try {
    const parsed = JSON.parse(await readFile(watchCacheFile(config), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function saveWatchCache(config, cache) {
  await writeFile(watchCacheFile(config), JSON.stringify(cache, null, 2) + '\n', 'utf8')
}

export function normalizeWatchDirs(input) {
  const list = Array.isArray(input) ? input : []
  const out = []
  for (const item of list) {
    const raw = typeof item === 'string' ? { path: item } : item
    const path = String(raw?.path || '').trim()
    if (!path) continue
    const kind = ['local', 'cloud', 'git'].includes(raw?.kind) ? raw.kind : 'local'
    out.push({ path, kind, label: String(raw?.label || '').trim() })
    if (out.length >= 12) break
  }
  return out
}

async function walk(dir, depth, visit) {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(full, depth + 1, visit)
    } else if (entry.isFile()) {
      await visit(full)
      if (visit.count > MAX_FILES_PER_DIR) return
    }
  }
}

/**
 * Scan every configured watch dir: returns per-dir {total, changed, error}
 * and refreshes the fingerprint cache. Files added/removed also count as
 * changed; the cache keeps only paths still present.
 */
export async function scanWatchDirs(config) {
  const dirs = normalizeWatchDirs(config.watchDirs)
  const cache = await loadWatchCache(config)
  const nextCache = {}
  const results = []
  const changedFiles = []
  for (const dir of dirs) {
    const fingerprints = {}
    let total = 0
    let changed = 0
    let truncated = false
    let error = ''
    const visit = async (file) => {
      total += 1
      visit.count = total
      try {
        const info = await stat(file)
        const fp = info.mtimeMs + ':' + info.size
        fingerprints[file] = fp
        const previous = cache[dir.path]?.[file]
        if (previous !== fp) {
          changed += 1
          if (cache[dir.path]) changedFiles.push({ file: file, kind: dir.kind, label: dir.label, fp })
        }
      } catch {
        /* file vanished mid-walk */
      }
    }
    visit.count = 0
    try {
      if (!existsSync(dir.path)) throw new Error('目录不存在')
      await walk(dir.path, 0, visit)
      if (visit.count > MAX_FILES_PER_DIR) truncated = true
    } catch (walkError) {
      error = String(walkError?.message || walkError)
    }
    nextCache[dir.path] = fingerprints
    results.push({ path: dir.path, kind: dir.kind, label: dir.label, total, changed, truncated, error })
  }
  if (changedFiles.length) {
    const now = new Date()
    await appendEntries(
      config,
      changedFiles.slice(0, 200).map((item) => ({
        source: 'watch', type: 'watch', date: localDate(now), time: localTime(now),
        title: '文件变化 ' + basename(item.file), project: basename(dirname(item.file)),
        tags: [item.kind], ref: item.file, nativeId: item.file + '|' + (item.fp || ''), 
      })),
    )
  }
  await saveWatchCache(config, nextCache)
  return { results, scannedAt: new Date().toISOString() }
}
