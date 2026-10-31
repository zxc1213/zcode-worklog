/**
 * R2: unified entries (dedupe/range/section), archive+watch producers,
 * calendar month/day aggregation, calendar api.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'zcode-worklog-r2-'))
process.env.WORKLOG_HOME = home
delete process.env.ZCODE_PLUGIN_DATA
delete process.env.WORKLOG_SCAN_ROOTS
delete process.env.WORKLOG_DOC_ROOTS
delete process.env.WORKLOG_DATA_DIR

const { loadConfig, saveConfig, localDate } = await import('../lib/config.mjs')
const store = await import('../lib/store.mjs')
const entriesMod = await import('../lib/entries.mjs')
const watch = await import('../lib/watch.mjs')
const calendarMod = await import('../lib/calendar.mjs')
const api = await import('../src/api.mjs')

const config = loadConfig()
const TODAY = localDate()

function makeRepo(dir, name, subject) {
  mkdirSync(dir, { recursive: true })
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: name + '@example.com',
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: name + '@example.com',
  }
  execFileSync('git', ['init', '-q'], { cwd: dir, env })
  execFileSync('git', ['config', 'user.name', name], { cwd: dir, env })
  execFileSync('git', ['config', 'user.email', name + '@example.com'], { cwd: dir, env })
  writeFileSync(join(dir, 'README.md'), '# ' + name + '\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: dir, env })
  execFileSync('git', ['commit', '-q', '-m', subject], {
    cwd: dir,
    env: { ...env, GIT_AUTHOR_DATE: TODAY + 'T10:00:00', GIT_COMMITTER_DATE: TODAY + 'T10:00:00' },
  })
}

describe('r2 entries', () => {
  it('appends, dedupes by fingerprint, and trims to cap', async () => {
    const first = await entriesMod.appendEntries(config, [
      { source: 'git', type: 'commit', date: TODAY, title: 'feat: 一次提交', project: 'demo', ref: 'abc123', nativeId: 'repo:abc123' },
      { source: 'watch', type: 'watch', date: TODAY, title: '文件变化 a.md', project: 'dir', nativeId: 'a.md|fp1' },
      { title: '缺 source 落 manual', date: TODAY },
    ])
    assert.equal(first.added, 3)
    const again = await entriesMod.appendEntries(config, [
      { source: 'git', type: 'commit', date: TODAY, title: 'feat: 一次提交', project: 'demo', ref: 'abc123', nativeId: 'repo:abc123' },
      { source: 'watch', type: 'watch', date: TODAY, title: '文件变化 a.md', project: 'dir', nativeId: 'a.md|fp1' },
    ])
    assert.equal(again.added, 0, 'same nativeId dedupes')
    const list = await entriesMod.loadEntries(config)
    assert.equal(list.length, 3)
    assert.equal(list[2].source, 'manual')
    assert.ok(list[0].fp)
    assert.ok(list[0].id)
  })

  it('queries by date and range and buckets by month', async () => {
    await entriesMod.appendEntries(config, [
      { source: 'git', title: '旧条目', date: '2026-10-01', nativeId: 'old:1' },
      { source: 'git', title: '本月条目', date: TODAY, nativeId: 'new:1' },
    ])
    const dayList = await entriesMod.entriesForDate(config, TODAY)
    assert.ok(dayList.some((entry) => entry.title === '本月条目'))
    assert.ok(!dayList.some((entry) => entry.title === '旧条目'))
    const range = await entriesMod.entriesRange(config, '2026-10-01', TODAY)
    assert.ok(range.length >= 5)
    const bucket = await entriesMod.entriesBucketByDate(config, TODAY.slice(0, 7))
    assert.ok(bucket[TODAY].count >= 2)
    const section = await entriesMod.entriesDaySection(config, TODAY)
    assert.match(section[0], /采集条目/)
    assert.match(section[0], /git/)
  })
})

describe('r2 producers', () => {
  it('archiveDay produces git/doc/session entries and the 采集条目 section', async () => {
    const repoDir = join(home, 'repos', 'demo-repo')
    makeRepo(repoDir, 'Ray', 'feat: 条目来源验证')
    await saveConfig({ scanRoots: [join(home, 'repos')] })
    const fresh = loadConfig()

    await entriesMod.appendEntries(config, [])
    const before = (await entriesMod.loadEntries(config)).length
    const archived = await import('../lib/archive.mjs')
    const result = await archived.archiveDay(fresh, TODAY)
    assert.equal(result.created, true)
    assert.match(result.text, /## 采集条目/)
    const after = (await entriesMod.loadEntries(fresh)).length
    assert.ok(after > before, 'archive appended entries')

    const commits = (await entriesMod.loadEntries(fresh)).filter(
      (entry) => entry.source === 'git' && entry.project === 'demo-repo',
    )
    assert.ok(commits.some((entry) => entry.title === 'feat: 条目来源验证'))
    assert.ok(commits.every((entry) => entry.ref && entry.nativeTag !== false))

    // force re-archive must not duplicate entries
    await archived.archiveDay(fresh, TODAY, { force: true })
    const after2 = (await entriesMod.loadEntries(fresh)).length
    assert.equal(after2, after, 're-archive dedupes entries')
  })

  it('watch scan produces entries for first-seen and changed files', async () => {
    const dir = join(home, 'watched2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'note.md'), 'v1', 'utf8')
    await saveConfig({ watchDirs: [{ path: dir, kind: 'cloud' }] })
    const fresh = loadConfig()
    const watchEntries = async () =>
      (await entriesMod.loadEntries(fresh)).filter((entry) => entry.source === 'watch' && entry.ref.startsWith(dir))
    await watch.scanWatchDirs(fresh)
    assert.equal((await watchEntries()).length, 0, 'first scan only seeds the cache, no entries')

    utimesSync(join(dir, 'note.md'), new Date(), new Date(Date.now() + 9000))
    await watch.scanWatchDirs(fresh)
    const second = await watchEntries()
    assert.equal(second.length, 1, 'mtime change produces exactly one entry')
    assert.match(second[0].title, /文件变化 note\.md/)
  })
})

describe('r2 calendar', () => {
  it('month aggregation blends entries, todos, archives, and reports', async () => {
    const month = TODAY.slice(0, 7)
    await store.saveTodos(config, [
      { id: 'cd1', title: '已完成', status: 'done', pri: '', due: '', repeat: '', created: TODAY + 'T01:00:00.000Z', updated: TODAY + 'T01:00:00.000Z', done_at: TODAY + 'T09:00:00.000Z' },
      { id: 'co1', title: '未完成', status: 'open', pri: '', due: '', repeat: '', created: TODAY + 'T01:00:00.000Z', updated: TODAY + 'T01:00:00.000Z', done_at: '' },
    ])
    await store.saveDay(config, TODAY, '# 日志\n\n内容\n')
    const result = await api.calendarAction(config, { action: 'month', month })
    assert.equal(result.month, month)
    const cell = result.days[TODAY]
    assert.equal(cell.archived, true)
    assert.ok(cell.todoDone >= 1)
    assert.ok(cell.entryCount >= 1)
    assert.equal(cell.hasDailyReport, false)
  })

  it('day detail blends sessions, todos, and entries', async () => {
    const detail = await api.calendarAction(config, { action: 'day', date: TODAY })
    assert.equal(detail.date, TODAY)
    assert.equal(detail.archived, true)
    assert.ok(detail.todosDone.some((todo) => todo.title === '已完成'))
    assert.ok(detail.entries.count >= 1)
    assert.ok(Array.isArray(detail.entries.items))
  })
})
