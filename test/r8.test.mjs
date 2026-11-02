/**
 * R8 / UX v3.1 fixes: getSessionDetail must be a PURE session-cache read.
 * The 0.21.0 real-machine bug: every 「加载完整摘录」click ran a full disk
 * scan (collectAllSessions), timed out and got the panel killed by the host.
 * These tests lock the cache-only contract in (no scan, no cache rewrite).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'zcode-worklog-r8-'))
// A deliberately EMPTY fake home: if getSessionDetail ever rescanned, it would
// find nothing AND purge the handcrafted cache entry (collectAllSessions
// deletes unseen files from the cache) — both assertions below would fail.
process.env.WORKLOG_HOME = home
delete process.env.ZCODE_PLUGIN_DATA
delete process.env.WORKLOG_SCAN_ROOTS
delete process.env.WORKLOG_DOC_ROOTS
delete process.env.WORKLOG_DATA_DIR
delete process.env.WORKLOG_SESSION_HOME

const { loadConfig } = await import('../lib/config.mjs')
const manager = await import('../lib/session-manager.mjs')

const config = loadConfig()
const FAKE_FILE = 'X:\\fake\\projects\\demo\\s1.jsonl'
const KEY = 'key-cache-hit'

writeFileSync(
  join(config.dataDir, 'sessions-index.json'),
  JSON.stringify({
    version: 1,
    builtAt: '2026-11-02T09:00:00.000Z',
    total: 2,
    sessions: [
      {
        key: KEY,
        source: 'claude',
        label: 'Claude Code',
        title: '缓存命中的会话',
        cwd: 'E:\\demo',
        project: 'demo',
        file: FAKE_FILE,
        first: '2026-11-01',
        last: '2026-11-02',
        datesCount: 2,
        turns: 2,
        preview: '缓存摘录甲',
        marks: [],
        group: '',
      },
      {
        key: 'key-cache-miss',
        source: 'codex',
        label: 'Codex',
        title: '缓存缺失的会话',
        cwd: '',
        project: '',
        file: 'X:\\fake\\gone.jsonl',
        first: '2026-11-01',
        last: '2026-11-01',
        datesCount: 1,
        turns: 1,
        preview: '',
        marks: [],
        group: '',
      },
    ],
  }, null, 2) + '\n',
  'utf8',
)

const cachePath = join(config.dataDir, 'session-cache.json')
const cachePayload = {
  version: 1,
  files: {
    [FAKE_FILE]: {
      source: 'claude',
      mtimeMs: 1,
      size: 1,
      session: {
        source: 'claude',
        label: 'Claude Code',
        file: FAKE_FILE,
        title: '缓存命中的会话',
        cwd: 'E:\\demo',
        dates: {
          '2026-11-01': { turns: 1, first: 1000, last: 2000, texts: ['缓存摘录甲'] },
          '2026-11-02': { turns: 1, first: 3000, last: 4000, texts: ['缓存摘录乙'] },
        },
      },
    },
  },
}
writeFileSync(cachePath, JSON.stringify(cachePayload), 'utf8')

describe('r8 session detail cache-only contract', () => {
  it('serves excerpts straight from session-cache.json without scanning', async () => {
    const before = readFileSync(cachePath, 'utf8')
    const started = Date.now()
    const detail = await manager.getSessionDetail(config, KEY, { home, dshHome: join(home, '.dsh') })
    const elapsed = Date.now() - started
    assert.equal(detail.available, true)
    assert.equal(detail.title, '缓存命中的会话')
    assert.equal(detail.dates.length, 2, 'both cached dates are returned')
    assert.ok(detail.dates[0].date < detail.dates[1].date, 'dates sorted ascending')
    assert.deepEqual(
      detail.dates.map((day) => day.texts[0]),
      ['缓存摘录甲', '缓存摘录乙'],
    )
    // No-scan proof #1: an empty home would yield zero sessions and purge this
    // cache entry — the cache file must be byte-identical after the call.
    assert.equal(readFileSync(cachePath, 'utf8'), before, 'cache file untouched (no rescan, no rewrite)')
    // No-scan proof #2: a real scan takes minutes; the cache read is instant.
    assert.ok(elapsed < 1000, `detail read stayed fast (${elapsed}ms)`)
  })

  it('returns available:false with guidance when the cache lacks the session', async () => {
    const before = readFileSync(cachePath, 'utf8')
    const detail = await manager.getSessionDetail(config, 'key-cache-miss', { home })
    assert.equal(detail.available, false)
    assert.ok(detail.note.includes('摘录尚未同步'), 'note guides to 同步会话: ' + detail.note)
    assert.ok(detail.note.includes('同步会话'))
    assert.equal(readFileSync(cachePath, 'utf8'), before, 'cache untouched on miss either')
  })

  it('rejects keys that are not in the index', async () => {
    await assert.rejects(
      async () => manager.getSessionDetail(config, 'ghost-key', { home }),
      /不在索引中/,
    )
  })

  it('keeps collectAllSessions out of the getSessionDetail call chain (source assertion)', async () => {
    const { readFileSync: rf } = await import('node:fs')
    const src = rf(new URL('../lib/session-manager.mjs', import.meta.url), 'utf8')
    const fnStart = src.indexOf('export async function getSessionDetail')
    assert.ok(fnStart > 0, 'getSessionDetail found in session-manager.mjs')
    const fnSrc = src.slice(fnStart)
    assert.ok(!fnSrc.includes('collectAllSessions'), 'getSessionDetail body must not reference the scanner')
    // The scanner is still allowed exactly once in this module: the explicit
    // 同步会话 rebuild (buildSessionIndex). Any other reference is a leak.
    const remainingUses = src.split('collectAllSessions(').length - 1
    assert.equal(remainingUses, 1, 'collectAllSessions only called from buildSessionIndex')
  })

  it('exposes the cache reader used by the detail path', async () => {
    const { loadCache } = await import('../lib/sessions.mjs')
    const cache = await loadCache(config)
    assert.equal(cache.version, 1)
    assert.ok(cache.files[FAKE_FILE], 'cache reader sees the handcrafted entry')
  })
})
