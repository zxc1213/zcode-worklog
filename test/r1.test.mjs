/**
 * R1: scheduler due/run/history, watch-dir fingerprints, wizard probe,
 * collect api surface.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'zcode-worklog-r1-'))
process.env.WORKLOG_HOME = home
delete process.env.ZCODE_PLUGIN_DATA
delete process.env.WORKLOG_SCAN_ROOTS
delete process.env.WORKLOG_DOC_ROOTS
delete process.env.WORKLOG_DATA_DIR

const { loadConfig, saveConfig } = await import('../lib/config.mjs')
const store = await import('../lib/store.mjs')
const scheduler = await import('../lib/scheduler.mjs')
const watch = await import('../lib/watch.mjs')
const wizard = await import('../lib/wizard.mjs')
const api = await import('../src/api.mjs')

const config = loadConfig()

describe('r1 scheduler', () => {
  it('defaults tasks, updates them, and persists patches', async () => {
    const tasks = await scheduler.getTasks(config)
    assert.equal(tasks.length, scheduler.TASK_DEFS.length, 'task count follows TASK_DEFS')
    assert.ok(tasks.find((task) => task.id === 'collect-sessions'))
    assert.ok(tasks.find((task) => task.id === 'collect-watch'))
    assert.ok(tasks.find((task) => task.id === 'connector-sync'))
    assert.equal(tasks[0].id, 'collect-sessions')
    assert.equal(tasks[0].enabled, false)

    const updated = await scheduler.updateTask(config, { id: 'collect-sessions', enabled: true, everyHours: 6 })
    assert.equal(updated.enabled, true)
    assert.equal(updated.everyHours, 6)
    const again = await scheduler.getTasks(config)
    assert.equal(again.find((task) => task.id === 'collect-sessions').enabled, true)
  })

  it('runs due tasks with compensation semantics', async () => {
    // make collect-watch due: enabled, interval elapsed
    await scheduler.updateTask(config, { id: 'collect-watch', enabled: true, everyHours: 0.001 })
    const state1 = await store.loadState(config)
    const task1 = state1.schedulerTasks.find((task) => task.id === 'collect-watch')
    task1.lastRunAt = new Date(Date.now() - 3600 * 1000).toISOString()
    await store.saveState(config, state1)

    const first = await scheduler.runDueTasks(config)
    assert.ok(first.ran.some((item) => item.id === 'collect-watch' && item.status === 'ok'))
    assert.ok(first.ran.find((item) => item.id === 'collect-watch').changed !== undefined)
    assert.ok(first.ran.find((item) => item.id === 'collect-sessions'), 'sessions task ran and produced entries')

    // immediately after a run it is no longer due
    const second = await scheduler.runDueTasks(config)
    assert.equal(second.ran.length, 0, 'just-ran task is not due again')

    // force run targets one task
    const forced = await scheduler.runDueTasks(config, { force: true, id: 'collect-watch' })
    assert.equal(forced.ran.length, 1)
    assert.equal(forced.ran[0].id, 'collect-watch')

    const history = await scheduler.getHistory(config)
    assert.ok(history.length >= 2)
  })

  it('records task errors without blocking other tasks', async () => {
    await scheduler.updateTask(config, { id: 'collect-sessions', enabled: true, everyHours: 1 })
    await saveConfig({ watchDirs: [{ path: join(home, 'no-such-dir'), kind: 'local' }] })
    const freshConfig = loadConfig()
    const state = await store.loadState(freshConfig)
    const past = new Date(Date.now() - 7200 * 1000).toISOString()
    state.schedulerTasks.find((item) => item.id === 'collect-sessions').lastRunAt = past
    state.schedulerTasks.find((item) => item.id === 'collect-watch').lastRunAt = past
    await store.saveState(freshConfig, state)
    const result = await scheduler.runDueTasks(freshConfig)
    assert.ok(result.ran.length >= 2, 'both due tasks ran')
    const watchRan = result.ran.find((item) => item.id === 'collect-watch')
    assert.equal(watchRan.status, 'ok', 'per-dir errors do not fail the task')
    assert.equal(watchRan.errors.length, 1, 'dir error surfaced in task detail')
    assert.ok(watchRan.errors[0].error.includes('目录不存在'))
    const okOne = result.ran.find((item) => item.id === 'collect-sessions')
    assert.equal(okOne.status, 'ok', 'sessions task unaffected by watch dir failure')
  })
})

describe('r1 watch', () => {
  it('detects new/changed files and stays quiet when nothing changes', async () => {
    const dir = join(home, 'watched')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.md'), 'hello', 'utf8')
    await saveConfig({ watchDirs: [{ path: dir, kind: 'cloud', label: '网盘' }] })
    const freshConfig = loadConfig()

    const first = await watch.scanWatchDirs(freshConfig)
    assert.equal(first.results[0].total, 1)
    assert.equal(first.results[0].changed, 1, 'first scan counts everything as changed')

    const second = await watch.scanWatchDirs(freshConfig)
    assert.equal(second.results[0].changed, 0, 'no changes on rescan')

    utimesSync(join(dir, 'a.md'), new Date(), new Date(Date.now() + 5000))
    const third = await watch.scanWatchDirs(freshConfig)
    assert.equal(third.results[0].changed, 1, 'mtime bump detected')
  })

  it('reports missing dirs as errors without throwing', async () => {
    await saveConfig({ watchDirs: [{ path: join(home, 'ghost'), kind: 'local' }] })
    const result = await watch.scanWatchDirs(loadConfig())
    assert.equal(result.results[0].error.includes('目录不存在'), true)
  })
})

describe('r1 wizard', () => {
  it('probes a custom session directory', async () => {
    const dir = join(home, 'custom-sessions')
    mkdirSync(join(dir, 'proj'), { recursive: true })
    writeFileSync(join(dir, 'proj', 'chat.jsonl'), '{}', 'utf8')
    const probe = await wizard.probeAiTool({ type: 'custom', location: dir })
    assert.equal(probe.ok, true)
    assert.ok(probe.custom.fileCount >= 1)
  })

  it('rejects unknown types and missing custom locations', async () => {
    await assert.rejects(() => wizard.probeAiTool({ type: 'nope' }), /未知 AI 工具类型/)
    const missing = await wizard.probeAiTool({ type: 'custom', location: join(home, 'ghost') })
    assert.equal(missing.ok, false)
  })
})

describe('r1 collect api', () => {
  it('diagnostics/set/run roundtrip', async () => {
    const diag = await api.collectAction(config, { action: 'diagnostics' })
    assert.ok(Array.isArray(diag.tasks))
    assert.ok(Array.isArray(diag.sources))
    assert.ok(Array.isArray(diag.watchDirs))

    await api.collectAction(config, { action: 'set', id: 'collect-sessions', everyHours: 3 })
    const diag2 = await api.collectAction(config, { action: 'diagnostics' })
    assert.equal(diag2.tasks.find((task) => task.id === 'collect-sessions').everyHours, 3)

    const run = await api.collectAction(config, { action: 'run', id: 'collect-sessions' })
    assert.equal(run.ran[0].id, 'collect-sessions')
  })
})
