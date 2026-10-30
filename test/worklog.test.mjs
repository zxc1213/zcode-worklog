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
const { detectAiCandidates, publicCandidate, findAiCandidate, parseTomlLite, parseYamlLite } = await import('../lib/ai-detect.mjs')
const store = await import('../lib/store.mjs')
const reports = await import('../lib/report.mjs')
const api = await import('../src/api.mjs')
const { cleanUserText, sessionMarkdownSection, parseSessionLines, scanSessions, listSessionSources } = await import(
  '../lib/sessions.mjs'
)

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

  it('persists the AI api format', () => {
    saveConfig({ ai: { baseUrl: 'https://api.example.com/v1', model: 'm', apiFormat: 'anthropic' } })
    assert.equal(publicConfig().ai.apiFormat, 'anthropic')
    saveConfig({ ai: { apiFormat: 'openai' } })
    assert.equal(publicConfig().ai.apiFormat, 'openai')
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
    saveConfig({ scanRoots: [workspace], docRoots: [workspace], gitAuthor: 'Ray', sources: { git: true, docs: true, sessions: false } })
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

describe('ai detection', () => {
  function makeHome() {
    const root = mkdtempSync(join(tmpdir(), 'worklog-ai-'))
    mkdirSync(join(root, '.zcode', 'v2'), { recursive: true })
    writeFileSync(
      join(root, '.zcode', 'v2', 'config.json'),
      JSON.stringify({
        provider: {
          'builtin:demo': {
            name: 'Demo Provider',
            kind: 'anthropic',
            enabled: true,
            options: { apiKey: 'sk-demo-1234567890', baseURL: 'https://example.test/api/anthropic' },
            models: { 'GLM-5.2': {} },
          },
          'openai-demo': {
            name: 'OpenAI Demo',
            kind: 'openai',
            options: { apiKey: 'sk-oa-1234567890', baseURL: 'https://oa.test/v1' },
            models: { m1: { name: 'model-1' } },
          },
          encrypted: {
            name: 'Encrypted',
            kind: 'anthropic',
            options: { apiKey: 'enc:v1:abc.def.ghi', baseURL: 'https://enc.test/api/anthropic' },
            models: { m2: {} },
          },
        },
      }),
      'utf8',
    )
    writeFileSync(
      join(root, '.zcode', 'v2', 'setting.json'),
      JSON.stringify({ modelProviderFamilySelectedKeys: { bigmodel: 'coding-plan:builtin:demo' } }),
      'utf8',
    )
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://claude.test/api/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'tok-abcdefgh',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-x',
        },
      }),
      'utf8',
    )
    return root
  }

  it('detects ZCode and Claude Code configs, selected provider first', () => {
    const home = makeHome()
    const list = detectAiCandidates({ home, env: {} })
    assert.equal(list.length, 4)
    assert.equal(list[0].id, 'zcode:builtin:demo')
    assert.equal(list[0].model, 'GLM-5.2')
    assert.equal(list[0].apiFormat, 'anthropic')
    assert.equal(list[1].model, 'model-1')

    const encrypted = list.find((item) => item.id === 'zcode:encrypted')
    assert.equal(encrypted.apiKey, '')
    assert.match(encrypted.note, /加密/)

    const claude = findAiCandidate('claude-code', { home, env: {} })
    assert.equal(claude.baseUrl, 'https://claude.test/api/anthropic')
    assert.equal(claude.model, 'claude-x')

    const pub = publicCandidate(list[0])
    assert.equal('apiKey' in pub, false)
    assert.equal(pub.hasKey, true)
    assert.match(pub.keyHint, /^sk-d/)
    assert.match(pub.note, /当前选择/)
  })

  it('parses codex toml and reuses env keys', () => {
    const toml = parseTomlLite(
      'model = "gpt-x"\nmodel_provider = "openai"\n[model_providers.openai]\nbase_url = "https://api.test/v1"\nenv_key = "TEST_KEY"\n',
    )
    assert.equal(toml.model, 'gpt-x')
    assert.equal(toml.model_providers.openai.base_url, 'https://api.test/v1')
    assert.equal(toml.model_providers.openai.env_key, 'TEST_KEY')

    const list = detectAiCandidates({
      home: join(tmpdir(), 'worklog-ai-missing'),
      env: { OPENAI_API_KEY: 'sk-env-1234567890' },
    })
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'env:openai')
    assert.equal(list[0].baseUrl, 'https://api.openai.com/v1')
  })

  it('builds the right endpoint for each api format', async () => {
    const { aiEndpoint } = await import('../lib/report.mjs')
    assert.equal(aiEndpoint('https://api.test/v1', 'openai'), 'https://api.test/v1/chat/completions')
    assert.equal(
      aiEndpoint('https://api.test/api/anthropic/', 'anthropic'),
      'https://api.test/api/anthropic/v1/messages',
    )
  })

  it('detects DeepSeek Harness providers from the active profile', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'worklog-dsh-'))
    const profileDir = join(dshHome, '.dsh', 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, 'cordis.patch.yml'),
      [
        '- insert:',
        '    - id: agent-default-model',
        '      name: "@deepseek-ai/dsh-agent-default-model"',
        '      config:',
        '        provider: zai-coding-cn',
        '        model: glm-5.3',
        '    - id: llm-pi-ai',
        '      name: "@deepseek-ai/dsh-llm-pi-ai"',
        '      config:',
        '        providers:',
        '          zai-coding-cn:',
        '            displayName: Z.ai Coding CN',
        '            baseURL: https://profile.example/api/coding/paas/v4',
        '            apiKeyEnv: ZAI_CODING_CN_API_KEY',
        '            api: openai-completions',
        '            models:',
        '              - id: glm-5.3',
        '                name: GLM-5.3',
        '          headroom:',
        '            apiKeyEnv: HEADROOM_API_KEY',
        '            api: anthropic-messages',
        '            baseURL: http://127.0.0.1:8787',
        '            models:',
        '              - id: glm-5.3',
        '          keyless:',
        '            apiKeyEnv: MISSING_KEY',
        '            baseURL: https://missing.example/v1',
        '            models:',
        '              - id: m',
      ].join('\n'),
      'utf8',
    )
    // A stale legacy file must not win over the active profile.
    writeFileSync(
      join(dshHome, '.dsh', 'settings-legacy.yaml'),
      [
        'llm-pi-ai:',
        '  providers:',
        '    legacy:',
        '      baseURL: https://legacy.example/v1',
        '      models:',
        '        - id: old',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(dshHome, '.dsh', '.credentials.yaml'),
      [
        'version: 1',
        'refs:',
        "  ZAI_CODING_CN_API_KEY: 'sk-zai-1234567890'",
        "  DEEPSEEK_API_KEY: 'sk-ds-1234567890'",
      ].join('\n'),
      'utf8',
    )

    const list = detectAiCandidates({ home: dshHome, env: {} })
    assert.equal(list.length, 4)
    const zai = list.find((item) => item.id === 'dsh:zai-coding-cn')
    assert.equal(zai.apiFormat, 'openai')
    assert.equal(zai.model, 'glm-5.3')
    assert.equal(zai.baseUrl, 'https://profile.example/api/coding/paas/v4')
    assert.equal(zai.apiKey, 'sk-zai-1234567890')
    assert.match(zai.note, /默认/)
    const headroom = list.find((item) => item.id === 'dsh:headroom')
    assert.equal(headroom.apiFormat, 'anthropic')
    const keyless = list.find((item) => item.id === 'dsh:keyless')
    assert.equal(keyless.apiKey, '')
    assert.match(keyless.note, /MISSING_KEY/)
    const deepseek = list.find((item) => item.id === 'dsh:deepseek-api')
    assert.equal(deepseek.baseUrl, 'https://api.deepseek.com')
    assert.equal(deepseek.model, 'deepseek-chat')
    assert.equal('apiKey' in publicCandidate(zai), false)
    assert.equal(list.some((item) => item.id === 'dsh:legacy'), false)
  })

  it('falls back to legacy dsh settings without a profile config', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'worklog-dsh-legacy-'))
    mkdirSync(join(dshHome, '.dsh'), { recursive: true })
    writeFileSync(
      join(dshHome, '.dsh', 'settings-legacy.yaml'),
      [
        'agent-default-model:',
        '  provider: legacy',
        '  model: old',
        'llm-pi-ai:',
        '  providers:',
        '    legacy:',
        '      baseURL: https://legacy.example/v1',
        '      models:',
        '        - id: old',
      ].join('\n'),
      'utf8',
    )
    const list = detectAiCandidates({ home: dshHome, env: {} })
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'dsh:legacy')
    assert.equal(list[0].model, 'old')
  })

  it('parses dsh yaml structure', () => {
    const parsed = parseYamlLite(
      [
        '- insert:',
        '    - id: agent-default-model',
        '      config:',
        '        provider: p1',
        '    - id: llm-pi-ai',
        '      config:',
        '        providers:',
        '          p1:',
        '            api: openai-completions',
        '            models:',
        '              - id: m1',
        '                name: M1',
        '              - id: m2',
      ].join('\n'),
    )
    assert.ok(Array.isArray(parsed))
    const entries = parsed[0].insert
    assert.equal(entries[0].config.provider, 'p1')
    assert.equal(entries[1].config.providers.p1.api, 'openai-completions')
    assert.deepEqual(
      entries[1].config.providers.p1.models.map((model) => model.id),
      ['m1', 'm2'],
    )
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

describe('sessions', () => {
  it('cleanUserText strips runtime noise and keeps real prompts', () => {
    assert.equal(cleanUserText('<system-reminder>x</system-reminder>真正的提问'), '真正的提问')
    assert.equal(cleanUserText('<command-name>/worklog</command-name>'), '')
    assert.equal(cleanUserText('[Request interrupted by user]'), '')
    assert.equal(cleanUserText('   '), '')
  })

  it('writes and re-parses the AI session section', () => {
    const text = sessionMarkdownSection({
      sessions: [
        { label: 'Claude Code', title: '调试会话扫描', turns: 3, timeRange: '09:12–09:40', cwd: 'E:\\Demo`x' },
      ],
    }).join('\n')
    assert.match(text, /## AI 会话/)
    const items = parseSessionLines(text)
    assert.equal(items.length, 1)
    assert.equal(items[0].source, 'Claude Code')
    assert.equal(items[0].turns, 3)
    assert.equal(items[0].title, '调试会话扫描')
  })

  it('scans a fake Claude project file for the requested day', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'worklog-sessions-'))
    const day = localDate()
    const stamp = `${day}T09:30:00`
    const projectDir = join(fakeHome, '.claude', 'projects', 'demo')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'demo.jsonl'),
      [
        JSON.stringify({ type: 'ai-title', aiTitle: '测试会话标题' }),
        JSON.stringify({
          type: 'user',
          timestamp: stamp,
          cwd: 'E:\\Demo',
          message: { content: [{ type: 'text', text: '扫描器要能解析这一行' }] },
        }),
        JSON.stringify({
          type: 'user',
          timestamp: stamp,
          isMeta: true,
          message: { content: [{ type: 'text', text: '元信息不该计数' }] },
        }),
        JSON.stringify({
          type: 'user',
          timestamp: `${day}T09:31:00`,
          message: { content: [{ type: 'text', text: '<system-reminder>注入</system-reminder>第二条提问' }] },
        }),
      ].join('\n'),
      'utf8',
    )
    const config = { ...loadConfig(), sources: { git: true, docs: true, sessions: true } }
    const result = await scanSessions(config, day, { home: fakeHome, dshHome: join(fakeHome, '.dsh') })
    assert.equal(result.totals.sessions, 1)
    assert.equal(result.totals.turns, 2)
    assert.equal(result.sessions[0].title, '测试会话标题')
    assert.equal(result.sessions[0].cwd, 'E:\\Demo')
    const again = await scanSessions(config, day, { home: fakeHome, dshHome: join(fakeHome, '.dsh') })
    assert.equal(again.totals.sessions, 1)
  })

  it('respects sources.sessions=false and lists session sources', async () => {
    const config = { ...loadConfig(), sources: { git: true, docs: true, sessions: false } }
    const result = await scanSessions(config, localDate(), { home: join(tmpdir(), 'worklog-sessions-missing') })
    assert.equal(result.totals.sessions, 0)
    const sources = await listSessionSources(config, { home: join(tmpdir(), 'worklog-sessions-missing') })
    assert.ok(sources.every((source) => source.enabled === false))
  })
})

after(() => {
  process.stderr.write(`test home: ${home}\n`)
})
