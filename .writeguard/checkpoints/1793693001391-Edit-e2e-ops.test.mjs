/**
 * Full-surface sweep: drive every panel-facing op through dispatch() exactly
 * like the side panel does, against a temp home. Catches op-enum/action wiring
 * gaps and accidental breakage across the whole feature set.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'zcode-worklog-e2e-'))
process.env.WORKLOG_HOME = home
process.env.WORKLOG_SESSION_HOME = home
delete process.env.ZCODE_PLUGIN_DATA
delete process.env.WORKLOG_SCAN_ROOTS
delete process.env.WORKLOG_DOC_ROOTS
delete process.env.WORKLOG_DATA_DIR

const { loadConfig, saveConfig, localDate } = await import('../lib/config.mjs')
const api = await import('../src/api.mjs')

const config = loadConfig()
const TODAY = localDate()
const call = (op, args = {}) => api.dispatch(op, args)

describe('e2e dispatch sweep', () => {
  it('01 bootstrap + status return the core shape', async () => {
    const boot = await call('bootstrap')
    assert.equal(boot.status.version, '0.24.0')
    assert.ok(Array.isArray(boot.todos))
    const status = await call('status')
    assert.ok(status.today?.date)
  })

  it('02 day save/read/search/days', async () => {
    await call('day', { date: TODAY, text: '# 工作日志\n\n巡检完成。\n' })
    const day = await call('day', { date: TODAY })
    assert.ok(day.exists && day.text.includes('巡检'))
    const hits = await call('search', { query: '巡检' })
    assert.ok(hits.some((hit) => hit.date === TODAY))
    const ranged = await call('search', { query: '巡检', start: TODAY, end: TODAY })
    assert.equal(ranged.length, 1, 'date window keeps the in-range hit')
    const outside = await call('search', { query: '巡检', start: TODAY + '-x' })
    assert.equal(outside.length, 0, 'start beyond today yields no hits')
    const days = await call('days')
    assert.ok(days.some((item) => item.date === TODAY))
  })

  it('03 todos full lifecycle', async () => {
    const added = await call('todos', { action: 'add', title: 'e2e 待办', pri: '高', due: TODAY, tags: ['e2e'] })
    assert.ok(added.id)
    await call('todos', { action: 'update', id: added.id, title: 'e2e 待办改' })
    const list = await call('todos', { action: 'list' })
    assert.ok(list.some((todo) => todo.title === 'e2e 待办改'))
    const stats = await call('todos', { action: 'stats' })
    assert.ok(stats.open >= 1)
    await call('todos', { action: 'complete', id: added.id })
    await call('todos', { action: 'reopen', id: added.id })
    await call('todos', { action: 'delete', id: added.id })
  })

  it('04 archive run + carriedCount + 待办/条目 sections', async () => {
    await call('todos', { action: 'add', title: '归档日待办', pri: '中', due: TODAY })
    const result = await call('archive', { action: 'run', date: TODAY, force: true })
    assert.equal(result.created, true)
    assert.match(result.text, /## 待办/)
    assert.match(result.text, /## 采集条目/)
  })

  it('05 sessions ops (fake home fast paths)', async () => {
    const sources = await call('sessions', { action: 'sources' })
    assert.ok(sources.sources.length >= 7)
    const status = await call('sessions', { action: 'index_status' })
    assert.equal(status.total, 0, 'fresh index is empty')
    const synced = await call('sessions', { action: 'sync_all', home, dshHome: join(home, '.dsh'), windowDays: 7 })
    assert.equal(synced.total, 0, 'no session files in fake home')
    const month = await call('sessions', { action: 'month', month: TODAY.slice(0, 7) })
    assert.ok(month.days[TODAY] === 0)
    const query = await call('sessions', { action: 'query', groupBy: 'project' })
    assert.equal(query.matched, 0)
  })

  it('06 reports: generate daily + summarize + list/read', async () => {
    const daily = await call('report', { action: 'generate', kind: 'daily', date: TODAY })
    assert.ok(daily.text)
    const summary = await call('report', { action: 'summarize', start: TODAY, end: TODAY, useAi: false })
    assert.match(summary.text, /规则摘要/)
    const list = await call('report', { action: 'list' })
    assert.ok(list.some((report) => report.name === daily.name))
    const read = await call('report', { action: 'read', name: daily.name })
    assert.ok(read.text)
  })

  it('07 ask degrades to search without AI', async () => {
    const answer = await call('ask', { question: '工作日志' })
    assert.ok(answer.ai === false)
    assert.ok(answer.answer.includes('相关日期'), 'search fallback lists hit dates')
  })

  it('08 projects + usage + backup roundtrip', async () => {
    const projects = await call('projects')
    assert.ok(Array.isArray(projects))
    const usage = await call('usage')
    assert.ok(usage.summary)
    const backup = await call('backup', { action: 'create' })
    assert.ok(backup.name)
    const list = await call('backup', { action: 'list' })
    assert.ok(list.some((item) => item.name === backup.name))
    const restored = await call('backup', { action: 'restore', name: backup.name })
    assert.ok(restored.ok)
  })

  it('09 config get/set roundtrip', async () => {
    const cfg = await call('config', { action: 'get' })
    assert.ok(cfg.ai, 'config op returns publicConfig at top level')
    assert.ok(cfg.watchDirs !== undefined)
    await call('config', { action: 'set', patch: { gitAuthor: 'e2e' } })
    const cfg2 = await call('config', { action: 'get' })
    assert.equal(cfg2.gitAuthor, 'e2e')
  })

  it('10 collect diagnostics/set/run', async () => {
    const diag = await call('collect', { action: 'diagnostics' })
    assert.ok(diag.tasks.length >= 3)
    await call('collect', { action: 'set', id: 'collect-sessions', enabled: false })
    const run = await call('collect', { action: 'run', id: 'collect-watch' })
    assert.ok(run.ran)
  })

  it('11 wizard types + custom probe', async () => {
    const types = await call('wizard', { action: 'types' })
    assert.equal(types.types.length, 6)
    const dir = join(home, 'probe-dir')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.jsonl'), '{}', 'utf8')
    const probe = await call('wizard', { action: 'probe', type: 'custom', location: dir })
    assert.equal(probe.ok, true)
  })

  it('12 calendar month/day carry todoDue/todosDue', async () => {
    await call('todos', { action: 'add', title: '到期标记', pri: '高', due: TODAY })
    const month = await call('calendar', { action: 'month', month: TODAY.slice(0, 7) })
    assert.ok(month.days[TODAY].todoDue >= 1)
    const day = await call('calendar', { action: 'day', date: TODAY })
    assert.ok(day.todosDue.some((todo) => todo.title === '到期标记'))
  })

  it('13 templates list/save/reset', async () => {
    const list = await call('templates', { action: 'list' })
    assert.equal(list.templates.length, 5)
    await call('templates', { action: 'save', scene: 'report', name: 'e2e', system: 'S', user: 'U' })
    await call('templates', { action: 'reset', scene: 'report' })
  })

  it('14 connectors list/set/remove + recommend/graph', async () => {
    const list = await call('connectors', { action: 'list' })
    assert.ok(list.types.length >= 3)
    await call('connectors', { action: 'set', type: 'generic', label: 'e2e', enabled: false, config: { url: 'http://127.0.0.1:9/x' } })
    await call('connectors', { action: 'remove', id: 'generic:e2e' })
    const reco = await call('recommend', { action: 'get' })
    assert.ok(Array.isArray(reco.items))
    await call('recommend', { action: 'feedback', kind: 'overdue', accepted: false })
    const graph = await call('graph', { action: 'query' })
    assert.ok(typeof graph.nodeCount === 'number')
    const rebuilt = await call('graph', { action: 'rebuild' })
    assert.ok(rebuilt.nodes >= 0)
  })
})
