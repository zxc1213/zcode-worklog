/**
 * R7: session management v2 — full index build from a fake Claude home,
 * work-relevance filter, keyword analysis, grouping, marks.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const { loadConfig, saveConfig, localDate } = await import('../lib/config.mjs')
const manager = await import('../lib/session-manager.mjs')
const api = await import('../src/api.mjs')

const TODAY = localDate()
const YESTERDAY = (() => {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
})()

function makeFakeHome() {
  const fakeHome = mkdtempSync(join(tmpdir(), 'zcode-worklog-r7-'))
  const projectDir = join(fakeHome, '.claude', 'projects', 'demo')
  mkdirSync(projectDir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'ai-title', aiTitle: '调整 zcode worklog 会话扫描' }),
    JSON.stringify({ type: 'user', timestamp: YESTERDAY + 'T09:30:00', cwd: 'E:\\AI_Project\\research', message: { content: [{ type: 'text', text: '优化 session 管理功能' }] } }),
    JSON.stringify({ type: 'user', timestamp: TODAY + 'T10:30:00', cwd: 'E:\\AI_Project\\research', message: { content: [{ type: 'text', text: '继续完善 worklog 插件的筛选与标记' }] } }),
  ]
  writeFileSync(join(projectDir, 'demo.jsonl'), lines.join('\n'), 'utf8')
  // a non-work session (cwd outside scan roots, title without keywords)
  const chatDir = join(fakeHome, '.claude', 'projects', 'misc')
  mkdirSync(chatDir, { recursive: true })
  writeFileSync(
    join(chatDir, 'misc.jsonl'),
    [
      JSON.stringify({ type: 'ai-title', aiTitle: '闲聊：晚饭吃什么' }),
      JSON.stringify({ type: 'user', timestamp: TODAY + 'T12:00:00', cwd: 'C:\\Users\\x', message: { content: [{ type: 'text', text: '随便聊聊' }] } }),
    ].join('\n'),
    'utf8',
  )
  return fakeHome
}

const fakeHome = makeFakeHome()

describe('r7 session manager', () => {
  it('syncs all sessions into a persistent index across dates', async () => {
    const config = loadConfig()
    const result = await api.sessionAction(config, {
      action: 'sync_all', home: fakeHome, dshHome: join(fakeHome, '.dsh'), windowDays: 7,
    })
    assert.ok(result.total >= 2, 'both fake sessions indexed: ' + JSON.stringify(result).slice(0, 200))
    const status = await api.sessionAction(config, { action: 'index_status' })
    assert.equal(status.total, result.total)
    const index = await manager.loadSessionIndex(config)
    const work = index.sessions.find((item) => item.title.includes('worklog'))
    assert.ok(work, 'work session present')
    assert.equal(work.datesCount, 2, 'multi-day session keeps both dates')
    assert.equal(work.project, 'research')
    assert.ok(work.preview.includes('session 管理功能'))
  })

  it('filters work-related sessions by dir and keywords', async () => {
    const config = loadConfig()
    await saveConfig({ scanRoots: ['E:' + sep() + 'AI_Project' + sep() + 'research'] })
    const fresh = loadConfig()
    const query = (extra) => api.sessionAction(fresh, {
      action: 'query', home: fakeHome, dshHome: join(fakeHome, '.dsh'),
      groupBy: '', ...extra,
    })
    const all = await query({})
    assert.equal(all.matched, 2)
    const workOnly = await query({ workOnly: true })
    assert.equal(workOnly.matched, 1, 'only the in-workdir session passes')
    assert.ok(workOnly.sessions[0].title.includes('worklog'))
    const byKeyword = await query({ q: '筛选' })
    assert.equal(byKeyword.matched, 1, 'q matches title or preview')
    assert.ok(byKeyword.sessions[0].preview.includes('筛选'))
    const byDate = await query({ end: YESTERDAY })
    assert.equal(byDate.matched, 1, 'end filter keeps sessions active on/before that day')
  })

  it('groups, marks, and assigns custom groups through the api', async () => {
    const config = loadConfig()
    await saveConfig({ scanRoots: ['E:' + sep() + 'AI_Project' + sep() + 'research'] })
    const fresh = loadConfig()
    const queried = await api.sessionAction(fresh, { action: 'query', home: fakeHome, dshHome: join(fakeHome, '.dsh') })
    const keys = queried.sessions.map((item) => item.key)
    const marked = await api.sessionAction(config, { action: 'mark', keys, mark: '工作' })
    assert.equal(marked.touched, 2)
    const byMark = await api.sessionAction(fresh, { action: 'query', home: fakeHome, dshHome: join(fakeHome, '.dsh'), mark: '工作' })
    assert.equal(byMark.matched, 2)
    assert.ok(byMark.sessions.every((item) => item.marks.includes('工作')))

    const one = keys[0]
    const grouped = await api.sessionAction(config, { action: 'group', keys: [one], group: '插件开发' })
    assert.equal(grouped.touched, 1)
    const byGroup = await api.sessionAction(fresh, { action: 'query', home: fakeHome, dshHome: join(fakeHome, '.dsh'), group: '插件开发' })
    assert.equal(byGroup.matched, 1)
    const groupedView = await api.sessionAction(fresh, { action: 'query', home: fakeHome, dshHome: join(fakeHome, '.dsh'), groupBy: 'group' })
    assert.ok(groupedView.groups['插件开发'])
    assert.ok(groupedView.groups['(未分组)'])

    await api.sessionAction(config, { action: 'unmark', keys, mark: '工作' })
    const after = await api.sessionAction(fresh, { action: 'query', home: fakeHome, dshHome: join(fakeHome, '.dsh'), mark: '工作' })
    assert.equal(after.matched, 0)
  })

  it('extracts keywords from the filtered set', async () => {
    const config = loadConfig()
    const analysis = await manager.analyzeSessionKeywords([
      { title: 'worklog 插件筛选功能', preview: 'worklog 筛选 worklog 标记 worklog 筛选' },
      { title: 'worklog 筛选设计', preview: '' },
    ])
    assert.ok(analysis.some((item) => item.word === 'worklog'), 'english keyword counted')
    assert.ok(analysis.some((item) => item.word.includes('筛选')), 'chinese keyword counted')
  })
})

function sep() {
  return process.platform === 'win32' ? '\\' : '/'
}
