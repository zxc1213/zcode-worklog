/**
 * R5: rule-based recommendations — scoring sources, feedback weighting,
 * weekly report injection.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'zcode-worklog-r5-'))
process.env.WORKLOG_HOME = home
delete process.env.ZCODE_PLUGIN_DATA
delete process.env.WORKLOG_SCAN_ROOTS
delete process.env.WORKLOG_DOC_ROOTS
delete process.env.WORKLOG_DATA_DIR

const { loadConfig, localDate } = await import('../lib/config.mjs')
const store = await import('../lib/store.mjs')
const entriesMod = await import('../lib/entries.mjs')
const recommend = await import('../lib/recommend.mjs')
const api = await import('../src/api.mjs')
const reports = await import('../lib/report.mjs')

const config = loadConfig()
const TODAY = localDate()

describe('r5 recommend', () => {
  it('scores overdue, stale, and watch-driven items', async () => {
    await store.saveTodos(config, [
      { id: 'o1', title: '逾期三天', status: 'open', pri: '', due: '2026-10-28', repeat: '', created: TODAY + 'T01:00:00.000Z', updated: TODAY + 'T01:00:00.000Z', done_at: '', carries: 2 },
      { id: 'o2', title: '两周未动', status: 'open', pri: '', due: '', repeat: '', created: '2026-10-10T01:00:00.000Z', updated: TODAY + 'T01:00:00.000Z', done_at: '' },
      { id: 'o3', title: '今天到期', status: 'open', pri: '', due: TODAY, repeat: '', created: TODAY + 'T01:00:00.000Z', updated: TODAY + 'T01:00:00.000Z', done_at: '' },
    ])
    await entriesMod.appendEntries(config, [
      { source: 'watch', type: 'watch', date: TODAY, title: '文件变化 网盘文件', project: '网盘', nativeId: 'w:1' },
    ])
    const result = await api.recommendAction(config, { action: 'get' })
    const kinds = result.items.map((item) => item.kind)
    assert.ok(kinds.includes('overdue'), 'overdue present: ' + JSON.stringify(kinds))
    assert.ok(kinds.includes('stale'))
    assert.ok(kinds.includes('upcoming'))
    const overdue = result.items.find((item) => item.kind === 'overdue')
    assert.ok(overdue.score > 10, 'carries boost score')
    assert.ok(result.items[0].final >= result.items[result.items.length - 1].final, 'sorted desc')
  })

  it('feedback lowers the same-kind weight', async () => {
    await store.saveTodos(config, [
      { id: 'f1', title: '老是逾期的那条', status: 'open', pri: '', due: '2026-10-20', repeat: '', created: TODAY + 'T01:00:00.000Z', updated: TODAY + 'T01:00:00.000Z', done_at: '', carries: 0 },
    ])
    const before = await api.recommendAction(config, { action: 'get' })
    const beforeItem = before.items.find((item) => item.kind === 'overdue')
    await api.recommendAction(config, { action: 'feedback', kind: 'overdue', accepted: false })
    await api.recommendAction(config, { action: 'feedback', kind: 'overdue', accepted: false })
    const after = await api.recommendAction(config, { action: 'get' })
    const afterItem = after.items.find((item) => item.kind === 'overdue')
    assert.ok(afterItem.final < beforeItem.final, 'ignored twice lowers weight: ' + beforeItem.final + ' -> ' + afterItem.final)
  })
})
