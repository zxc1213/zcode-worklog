import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'zcode-worklog-test-'))
process.env.WORKLOG_HOME = home
delete process.env.ZCODE_PLUGIN_DATA
delete process.env.WORKLOG_AUTO_ARCHIVE
delete process.env.WORKLOG_TASK_TIME
delete process.env.WORKLOG_SCAN_ROOTS
delete process.env.WORKLOG_DOC_ROOTS
delete process.env.WORKLOG_DATA_DIR

const { loadConfig, saveConfig, publicConfig, dayFile, localDate, weekPathFor } = await import('../lib/config.mjs')
const { composePanelHtml } = await import('../lib/panel.mjs')
const store = await import('../lib/store.mjs')
const reports = await import('../lib/report.mjs')
const api = await import('../src/api.mjs')

function makeRepo(dir, name) {
  mkdirSync(dir, { recursive: true })
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: `${name}@example.com`,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: `${name}@example.com`,
  }
  execFileSync('git', ['init', '-q'], { cwd: dir, env })
  execFileSync('git', ['config', 'user.name', name], { cwd: dir, env })
  execFileSync('git', ['config', 'user.email', `${name}@example.com`], { cwd: dir, env })
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`, 'utf8')
  execFileSync('git', ['add', '.'], { cwd: dir, env })
  const date = localDate()
  execFileSync('git', ['commit', '-q', '-m', 'feat: 初始化仓库'], {
    cwd: dir,
    env: { ...env, GIT_AUTHOR_DATE: `${date}T10:00:00`, GIT_COMMITTER_DATE: `${date}T10:00:00` },
  })
}

describe('config', () => {
  it('creates data directories under WORKLOG_HOME', () => {
    const config = loadConfig()
    assert.equal(config.dataDir, join(home, 'data'))
    assert.ok(publicConfig(config).archiveDir.endsWith('archive'))
    assert.equal(weekPathFor('2026-10-29', config).month, '2026-10')
    assert.match(dayFile(config, '2026-10-29'), /第5周\(10\.26-11\.01\)/)
  })

  it('persists patches and redacts the AI key in public config', () => {
    const next = saveConfig({ gitAuthor: 'Ray', ai: { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'secret' } })
    assert.equal(next.gitAuthor, 'Ray')
    const pub = publicConfig(next)
    assert.equal(pub.ai.hasApiKey, true)
    assert.equal('apiKey' in pub.ai, false)
    saveConfig({ gitAuthor: '', ai: { clearApiKey: true } })
    assert.equal(publicConfig().ai.hasApiKey, false)
  })
})

describe('store', () => {
  it('saves and reads a day, then finds it by search', async () => {
    const config = loadConfig()
    await store.saveDay(config, '2026-10-20', '# 工作\n\n巡检完成，采集链路正常。\n')
    const day = await store.getDay(config, '2026-10-20')
    assert.equal(day.exists, true)
    assert.match(day.text, /巡检完成/)
    const hits = await store.searchDays(config, '采集')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].date, '2026-10-20')
  })

  it('manages todos and spawns repeating ones', async () => {
    const config = loadConfig()
    const todo = await store.addTodo(config, { title: '巡检', pri: '高', due: '2026-10-21' })
    assert.equal(todo.pri, '高')
    const done = await store.updateTodo(config, { id: todo.id, status: 'done' })
    assert.equal(done.todo.status, 'done')
    const repeat = await store.addTodo(config, { title: '日报', repeat: 'daily' })
    const finished = await store.updateTodo(config, { id: repeat.id, status: 'done' })
    assert.ok(finished.spawned)
    assert.equal(finished.spawned.status, 'open')
    assert.equal(finished.spawned.repeat, 'daily')
    const cleared = await store.clearDoneTodos(config)
    assert.ok(cleared.removed >= 2)
  })

  it('creates a backup and restores it', async () => {
    const config = loadConfig()
    const backup = await store.createBackup(config)
    assert.ok(backup.days >= 1)
    await store.saveDay(config, '2026-10-20', '# 被改坏\n')
    const restored = await store.restoreBackup(config, backup.name)
    assert.ok(restored.restored >= 1)
    const day = await store.getDay(config, '2026-10-20')
    assert.match(day.text, /巡检完成/)
    await store.deleteBackup(config, backup.name)
  })
})

describe('archive and reports', () => {
  let workspace
  before(() => {
    workspace = mkdtempSync(join(tmpdir(), 'zcode-worklog-ws-'))
    makeRepo(join(workspace, 'demo-project'), 'Ray')
    writeFileSync(join(workspace, 'notes.md'), '# notes\n', 'utf8')
  })

  it('archives git commits and documents', async () => {
    saveConfig({ scanRoots: [workspace], docRoots: [workspace], gitAuthor: 'Ray', sources: { git: true, docs: true } })
    const config = loadConfig()
    const result = await api.archiveAction(config, { action: 'run', date: localDate(), force: true })
    assert.equal(result.created, true)
    assert.ok(result.commitCount >= 1)
    assert.match(result.text, /demo-project/)
    assert.match(result.text, /feat: 初始化仓库/)
    const day = await store.getDay(config, localDate())
    assert.equal(day.exists, true)
  })

  it('does not overwrite an existing day without force', async () => {
    const config = loadConfig()
    const result = await api.archiveAction(config, { action: 'run', date: localDate() })
    assert.equal(result.created, false)
    assert.equal(result.existing, true)
  })

  it('generates deterministic weekly and project reports', async () => {
    const config = loadConfig()
    const weekly = await reports.generateReport(config, { kind: 'weekly', monday: localDate() })
    assert.match(weekly.text, /周报/)
    assert.match(weekly.text, /demo-project/)
    const project = await reports.generateReport(config, { kind: 'project', project: 'demo-project' })
    assert.match(project.text, /项目档案/)
    assert.ok((await store.listReports(config)).length >= 2)
  })
})

describe('mcp api', () => {
  it('bootstrap returns status, todos, reports and config', async () => {
    const data = await api.dispatch('bootstrap')
    assert.ok(data.status.days.count >= 1)
    assert.ok(Array.isArray(data.todos))
    assert.ok(Array.isArray(data.reports))
    assert.ok(data.config.dataDir)
  })

  it('auto-archives once when due', async () => {
    saveConfig({ autoArchive: true, taskTime: '00:00', skipWeekends: false })
    const config = loadConfig()
    const result = await api.maybeAutoArchive(config)
    assert.equal(result?.date, localDate())
    const again = await api.maybeAutoArchive(loadConfig())
    assert.equal(again, null)
    saveConfig({ autoArchive: false })
  })
})

describe('panel document', () => {
  it('inlines the panel script and stylesheet', () => {
    const html = composePanelHtml(
      '<html><head><!-- ZCODE_WORKLOG_STYLE --></head><body><!-- ZCODE_WORKLOG_SCRIPT --></body></html>',
      '.wl-root { color: red }',
      'window.ok = true',
    )
    assert.match(html, /<style>\n\.wl-root \{ color: red \}\n<\/style>/)
    assert.match(html, /<script>\nwindow\.ok = true\n<\/script>/)
    assert.equal(html.includes('ui://'), false)
  })

  it('escapes closing tags inside the bundled script and stylesheet', () => {
    const html = composePanelHtml(
      '<html><head><!-- ZCODE_WORKLOG_STYLE --></head><body><!-- ZCODE_WORKLOG_SCRIPT --></body></html>',
      'a::after { content: "</style>" }',
      'const tpl = "</script>"; const keep = "$& $` $\'"',
    )
    assert.equal(html.includes('</style></style>'), false)
    assert.equal(html.includes('</script></script>'), false)
    assert.match(html, /<\\\/script>/)
    assert.match(html, /<\\\/style>/)
    assert.ok(html.includes(`$& $\` $'`), 'replacement must not expand $-patterns')
  })
})

after(() => {
  process.stderr.write(`test home: ${home}\n`)
})
