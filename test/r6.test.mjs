/**
 * R6: knowledge graph — rule extraction from entries, query overview/entity,
 * archive-triggered rebuild.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'zcode-worklog-r6-'))
process.env.WORKLOG_HOME = home
delete process.env.ZCODE_PLUGIN_DATA
delete process.env.WORKLOG_SCAN_ROOTS
delete process.env.WORKLOG_DOC_ROOTS
delete process.env.WORKLOG_DATA_DIR

const { loadConfig, saveConfig, localDate } = await import('../lib/config.mjs')
const entriesMod = await import('../lib/entries.mjs')
const graph = await import('../lib/graph.mjs')
const api = await import('../src/api.mjs')

const config = loadConfig()
const TODAY = localDate()

describe('r6 graph', () => {
  it('extracts entities and relations from entries', async () => {
    await entriesMod.appendEntries(config, [
      { source: 'git', type: 'commit', date: TODAY, title: 'feat: a', project: '商城', tags: ['Ray'], ref: 'h1', nativeId: 'r6:1' },
      { source: 'git', type: 'commit', date: TODAY, title: 'fix: b', project: '商城', tags: ['Ray'], ref: 'h2', nativeId: 'r6:2' },
      { source: 'git', type: 'commit', date: TODAY, title: 'docs: c', project: '中台', tags: ['Ray'], ref: 'h3', nativeId: 'r6:3' },
      { source: 'sessions', type: 'session', date: TODAY, title: '排查登录', project: '商城', tags: ['Claude Code'], ref: 'f1', nativeId: 'r6:4' },
      { source: 'zentao', type: 'task', date: TODAY, title: '[任务 P1] 完成登录', project: '商城', tags: ['禅道'], ref: 't1', nativeId: 'r6:5' },
      { source: 'watch', type: 'watch', date: TODAY, title: '文件变化 a.md', project: '商城', tags: ['cloud', '周报'], ref: 'w1', nativeId: 'r6:6' },
    ])
    await graph.rebuildGraph(config)
    const overview = await api.graphAction(config, { action: 'query' })
    assert.ok(overview.nodeCount >= 5, 'nodes: ' + JSON.stringify(overview))
    assert.ok(overview.edgeCount >= 5)

    const project = await api.graphAction(config, { action: 'query', entity: '商城' })
    assert.equal(project.found, true)
    const kinds = project.relations.map((item) => item.kind)
    assert.ok(kinds.includes('提交了'))
    assert.ok(kinds.includes('用于'))
    assert.ok(kinds.includes('提供'))
    assert.ok(kinds.includes('出现于'))

    const person = await api.graphAction(config, { action: 'query', entity: 'Ray' })
    assert.equal(person.found, true)
    assert.ok(person.relations.some((item) => item.kind === '提交了' && item.other === '商城'))

    const missing = await api.graphAction(config, { action: 'query', entity: '不存在' })
    assert.equal(missing.found, false)
  })

  it('rebuild is deterministic (same inputs, same counts)', async () => {
    const first = await graph.rebuildGraph(config)
    const second = await graph.rebuildGraph(config)
    assert.equal(first.nodes, second.nodes)
    assert.equal(first.edges, second.edges)
  })

  it('archive rebuilds the graph automatically', async () => {
    const repoDir = join(home, 'repos', 'graph-repo')
    mkdirSync(repoDir, { recursive: true })
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Ray', GIT_AUTHOR_EMAIL: 'r@x.com', GIT_COMMITTER_NAME: 'Ray', GIT_COMMITTER_EMAIL: 'r@x.com' }
    execFileSync('git', ['init', '-q'], { cwd: repoDir, env })
    execFileSync('git', ['config', 'user.name', 'Ray'], { cwd: repoDir, env })
    execFileSync('git', ['config', 'user.email', 'r@x.com'], { cwd: repoDir, env })
    writeFileSync(join(repoDir, 'README.md'), 'x\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: repoDir, env })
    execFileSync('git', ['commit', '-q', '-m', 'feat: 图谱来源'], { cwd: repoDir, env: { ...env, GIT_AUTHOR_DATE: TODAY + 'T10:00:00', GIT_COMMITTER_DATE: TODAY + 'T10:00:00' } })
    await saveConfig({ scanRoots: [join(home, 'repos')] })
    const archived = await import('../lib/archive.mjs')
    await archived.archiveDay(loadConfig(), TODAY)
    const overview = await api.graphAction(loadConfig(), { action: 'query' })
    assert.ok(overview.nodeCount >= 5, 'graph refreshed by archive')
  })
})
