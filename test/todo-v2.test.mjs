/**
 * todos v2: normalization, smart order (store + panel mirror), carry-over,
 * stats, update/carry_over/stats actions, archive integration, report section.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'zcode-worklog-todov2-'))
process.env.WORKLOG_HOME = home
delete process.env.ZCODE_PLUGIN_DATA
delete process.env.WORKLOG_AUTO_ARCHIVE
delete process.env.WORKLOG_TASK_TIME
delete process.env.WORKLOG_SCAN_ROOTS
delete process.env.WORKLOG_DOC_ROOTS
delete process.env.WORKLOG_DATA_DIR

const { loadConfig, todosFile, localDate } = await import('../lib/config.mjs')
const store = await import('../lib/store.mjs')
const api = await import('../src/api.mjs')
const reports = await import('../lib/report.mjs')
const { archiveDay } = await import('../lib/archive.mjs')

const config = loadConfig()
const TODAY = localDate()

function seedTodos(items) {
  return store.saveTodos(
    config,
    items.map((item, index) => ({
      id: item.id || 't' + (index + 1),
      title: item.title || 'todo ' + (index + 1),
      md: '',
      status: item.status || 'open',
      pri: item.pri || '',
      due: item.due || '',
      repeat: item.repeat || '',
      created: item.created || '2026-10-28T09:00:00.000Z',
      updated: item.created || '2026-10-28T09:00:00.000Z',
      done_at: item.done_at || '',
      ...(item.extra || {}),
    })),
  )
}

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start >= 0, 'panel source has ' + name)
  let depth = 0
  let end = -1
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  return source.slice(start, end)
}

describe('todos v2 store', () => {
  it('normalizes legacy todos with v2 defaults on load', async () => {
    await store.saveTodos(config, [
      { id: 'raw', title: 'raw', status: 'open', pri: '中', due: '', repeat: '', created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z', done_at: '' },
    ])
    const todos = await store.loadTodos(config)
    const raw = todos.find((todo) => todo.id === 'raw')
    assert.deepEqual(raw.tags, [])
    assert.deepEqual(raw.subtasks, [])
    assert.equal(raw.carries, 0)
    assert.equal(raw.lastCarry, '')
  })

  it('cleans tags and subtasks on add and update', async () => {
    const added = await store.addTodo(config, {
      title: '发周报',
      tags: ['#周报', '周报', 'okr', '', '  '],
      subtasks: ['收集数据', { title: '写结论', done: true }, { title: '' }, null],
    })
    assert.deepEqual(added.tags, ['周报', 'okr'])
    assert.equal(added.subtasks.length, 2)
    assert.equal(added.subtasks[0].done, false)
    assert.equal(added.subtasks[1].done, true)
    assert.equal(added.carries, 0)

    const updated = await store.updateTodo(config, { id: added.id, tags: ['新标签'], subtasks: [{ title: 'only' }] })
    assert.deepEqual(updated.todo.tags, ['新标签'])
    assert.equal(updated.todo.subtasks.length, 1)

    const untouched = await store.updateTodo(config, { id: added.id, title: '发周报改' })
    assert.deepEqual(untouched.todo.tags, ['新标签'], 'tags survive a patch without tags')
  })

  it('orders todos by smart order and matches the panel mirror', () => {
    const today = '2026-10-31'
    const todos = [
      { id: 'd1', status: 'done', done_at: '2026-10-30T09:00:00.000Z' },
      { id: 'o1', status: 'open', pri: '高', due: '2026-10-29' },
      { id: 'o2', status: 'open', pri: '低', due: '2026-10-30' },
      { id: 'n1', status: 'open', pri: '高', due: '2026-11-02' },
      { id: 'n2', status: 'open', pri: '高', created: '2026-10-28T09:00:00.000Z' },
      { id: 'n3', status: 'open', pri: '高', created: '2026-10-29T09:00:00.000Z' },
      { id: 'n4', status: 'open', pri: '中' },
      { id: 'n5', status: 'open', pri: '低', due: '2026-11-05' },
      { id: 'n6', status: 'open' },
    ]
    const expected = ['o1', 'o2', 'n1', 'n3', 'n2', 'n4', 'n5', 'n6', 'd1']
    const actual = store.sortTodos(todos, today).map((todo) => todo.id)
    assert.deepEqual(actual, expected)

    const panelSource = readFileSync(join(import.meta.dirname, '..', 'src', 'panel.js'), 'utf8')
    const priRank = panelSource.match(/const PRI_RANK = \{[^\n]*\}/)[0]
    const fn = extractFunction(panelSource, 'compareTodos')
    const panelCompare = new Function(priRank + '; return ' + fn)()
    const panelOrder = [...todos].sort((a, b) => panelCompare(a, b, today)).map((todo) => todo.id)
    assert.deepEqual(panelOrder, expected, 'panel compareTodos mirror diverged from store')
  })

  it('carries overdue todos idempotently per day', async () => {
    await seedTodos([
      { id: 'a', due: '2026-10-30' },
      { id: 'b', due: '2026-10-31' },
      { id: 'c' },
      { id: 'd', due: '2026-10-29', extra: { lastCarry: '2026-10-31' } },
    ])
    const first = await store.carryOverTodos(config, { date: '2026-10-31' })
    assert.equal(first.carried.length, 1)
    assert.equal(first.skipped, 1)
    const after = await store.loadTodos(config)
    const a = after.find((todo) => todo.id === 'a')
    assert.equal(a.due, '2026-10-31')
    assert.equal(a.carries, 1)
    assert.equal(a.lastCarry, '2026-10-31')
    assert.equal(after.find((todo) => todo.id === 'b').due, '2026-10-31', 'due today untouched')
    assert.equal(after.find((todo) => todo.id === 'c').due, '', 'no due untouched')
    assert.equal(after.find((todo) => todo.id === 'd').carries, 0, 'already carried today skipped')

    const again = await store.carryOverTodos(config, { date: '2026-10-31' })
    assert.equal(again.carried.length, 0, 'same-day rerun is a no-op')

    const nextDay = await store.carryOverTodos(config, { date: '2026-11-01' })
    assert.equal(nextDay.carried.length, 3, 'next day carries all overdue open items (a, b, d)')
    const round2 = await store.loadTodos(config)
    assert.equal(round2.find((todo) => todo.id === 'a').carries, 2)
    assert.equal(round2.find((todo) => todo.id === 'b').carries, 1, 'b is overdue on 11-01')
    assert.equal(round2.find((todo) => todo.id === 'd').carries, 1, 'd carried on the later day')
  })

  it('computes stats counters', async () => {
    await seedTodos([
      { id: 's1', due: '2026-10-30' },
      { id: 's2', due: TODAY },
      { id: 's3', status: 'done', done_at: TODAY + 'T08:00:00.000Z' },
      { id: 's4', status: 'done', done_at: '2026-10-20T08:00:00.000Z' },
    ])
    const stats = store.todoStats(await store.loadTodos(config), TODAY)
    assert.equal(stats.open, 2)
    assert.equal(stats.overdue, 1)
    assert.equal(stats.dueToday, 1)
    assert.equal(stats.doneToday, 1)
    assert.ok(stats.doneWeek >= 1)
  })
})

describe('todos v2 api', () => {
  it('update/carry_over/stats and filtered list work', async () => {
    const added = await api.todoAction(config, { action: 'add', title: 'API 待办', pri: '中', due: '2026-10-30' })
    const updated = await api.todoAction(config, { action: 'update', id: added.id, title: 'API 待办改', due: '' })
    assert.equal(updated.todo.title, 'API 待办改')
    assert.equal(updated.todo.due, '')

    const carried = await api.todoAction(config, { action: 'carry_over', date: '2026-10-31' })
    assert.ok(Array.isArray(carried.carried))

    const stats = await api.todoAction(config, { action: 'stats' })
    assert.ok(typeof stats.open === 'number')

    const byPri = await api.todoAction(config, { action: 'list', status: 'open', pri: '中' })
    assert.ok(byPri.every((todo) => todo.pri === '中'))
    const searched = await api.todoAction(config, { action: 'list', q: 'API 待办改' })
    assert.ok(searched.some((todo) => todo.id === added.id))
    const byDue = await api.todoAction(config, { action: 'list', sort: 'due', status: 'open' })
    const dues = byDue.map((todo) => todo.due || '9999').filter((due) => due !== '9999')
    assert.deepEqual(dues, [...dues].sort())
  })
})

describe('todos v2 archive integration', () => {
  it('archiving today carries overdue todos and writes the todo section', async () => {
    await seedTodos([
      { id: 'arc1', title: '逾期项', pri: '高', due: '2026-10-30' },
      { id: 'arc2', title: '今日完成项', status: 'done', done_at: TODAY + 'T09:00:00.000Z' },
    ])
    const result = await archiveDay(config, TODAY)
    assert.equal(result.carriedCount, 1)
    assert.match(result.text, /## 待办/)
    assert.match(result.text, /顺延 1 条/)
    assert.match(result.text, /今日完成 1 条/)
    const after = await store.loadTodos(config)
    assert.equal(after.find((todo) => todo.id === 'arc1').due, TODAY)

    const again = await archiveDay(config, TODAY, { force: true })
    assert.equal(again.carriedCount, 0, 'same-day force re-archive does not double carry')
  })

  it('backfilling a past day never carries', async () => {
    await seedTodos([{ id: 'old1', title: '旧逾期', due: '2026-10-30' }])
    const result = await archiveDay(config, '2026-10-20')
    assert.equal(result.carriedCount, 0)
    assert.match(result.text, /当前逾期 1 条/)
    const after = await store.loadTodos(config)
    assert.equal(after.find((todo) => todo.id === 'old1').due, '2026-10-30', 'todo untouched by backfill')
  })
})

describe('todos v2 report section', () => {
  it('weekly report appends the todo digest with completion rate', async () => {
    await seedTodos([
      { id: 'r1', title: '按时完成', status: 'done', done_at: TODAY + 'T08:00:00.000Z', due: TODAY },
      { id: 'r2', title: '逾期完成', status: 'done', done_at: TODAY + 'T08:00:00.000Z', due: '2026-10-20' },
      { id: 'r3', title: '老拖延', pri: '高', due: '2026-10-30', extra: { carries: 3 } },
    ])
    const report = await reports.generateReport(config, { kind: 'weekly' })
    assert.match(report.text, /## 待办概况/)
    assert.match(report.text, /周期内完成 2 条，按时完成率 50%/)
    assert.match(report.text, /当前逾期 1 条/)
    assert.match(report.text, /顺延最多：老拖延（顺延 3 次，仍未完成）/)
  })
})

describe('todos v2 m2', () => {
  it('repeating a todo carries tags and resets subtask done flags', async () => {
    const added = await store.addTodo(config, {
      title: '每日巡检',
      repeat: 'daily',
      tags: ['巡检'],
      subtasks: [{ title: '看日志', done: true }, { title: '发通报' }],
    })
    const done = await store.updateTodo(config, { id: added.id, status: 'done' })
    assert.ok(done.spawned, 'daily todo spawns the next instance')
    assert.deepEqual(done.spawned.tags, ['巡检'])
    assert.equal(done.spawned.subtasks.length, 2)
    assert.ok(done.spawned.subtasks.every((sub) => !sub.done), 'subtask done flags reset on spawn')
    assert.equal(done.spawned.carries, 0)
    assert.equal(done.spawned.status, 'open')
  })

  it('adds todos with tags through the api and filters by tag', async () => {
    await api.todoAction(config, { action: 'add', title: '带标签任务', tags: ['周报', 'okr'], pri: '高' })
    const byTag = await api.todoAction(config, { action: 'list', tag: '周报' })
    assert.ok(byTag.some((todo) => todo.title === '带标签任务'))
    assert.ok(byTag.every((todo) => todo.tags.includes('周报')))
  })
})
