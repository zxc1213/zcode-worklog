/**
 * R4: connector framework — mask/placeholder semantics, zentao and generic
 * adapters against mock HTTP servers, sync producing entries.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'zcode-worklog-r4-'))
process.env.WORKLOG_HOME = home
delete process.env.ZCODE_PLUGIN_DATA
delete process.env.WORKLOG_SCAN_ROOTS
delete process.env.WORKLOG_DOC_ROOTS
delete process.env.WORKLOG_DATA_DIR

const { loadConfig, saveConfig, localDate } = await import('../lib/config.mjs')
const store = await import('../lib/store.mjs')
const entriesMod = await import('../lib/entries.mjs')
const api = await import('../src/api.mjs')

const config = loadConfig()
const TODAY = localDate()

function startMock(handler) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(handler(req.url || '/', body)))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

describe('r4 connectors framework', () => {
  it('masks secrets and preserves them via the placeholder', async () => {
    const saved = await api.connectorsAction(config, {
      action: 'set', type: 'zentao', label: '主站', enabled: true,
      config: { url: 'http://zt.test', account: 'ray', password: 'pw-secret' },
    })
    assert.equal(saved.connector.config.password, '已配置', 'secret masked in public view')

    await api.connectorsAction(config, {
      action: 'set', id: saved.connector.id, type: 'zentao', label: '主站', enabled: true,
      config: { url: 'http://zt.test', account: 'ray', password: '已配置' },
    })
    const raw = loadConfig().connectors.find((item) => item.id === saved.connector.id)
    assert.equal(raw.config.password, 'pw-secret', 'placeholder keeps stored secret')

    await api.connectorsAction(config, { action: 'remove', id: saved.connector.id })
    const after = await api.connectorsAction(config, { action: 'list' })
    assert.equal(after.connectors.length, 0)
  })

  it('rejects unknown connector types', async () => {
    await assert.rejects(
      () => api.connectorsAction(config, { action: 'set', type: 'nope', config: {} }),
      /未知连接器类型/,
    )
  })
})

describe('r4 zentao adapter', () => {
  it('syncs tasks and bugs into entries against a mock server', async () => {
    const server = await startMock((url, body) => {
      if (url.endsWith('/tokens')) return { token: 'ZT-TOKEN' }
      if (url.includes('/tasks')) {
        return { data: { tasks: [
          { id: 5, name: '完成登录模块', pri: 1, status: 'wait', assignedTo: 'ray', deadline: TODAY, product: '商城' },
        ] } }
      }
      if (url.includes('/bugs')) {
        return { data: { bugs: [
          { id: 9, name: '首页白屏', pri: 2, status: 'active', assignedTo: 'ray', openedDate: TODAY + ' 10:00:00', product: '商城' },
        ] } }
      }
      return {}
    })
    const port = server.address().port
    await saveConfig({ connectors: [{ id: 'zentao:qa', type: 'zentao', enabled: true, label: 'qa', config: { url: 'http://127.0.0.1:' + port, account: 'ray', password: 'pw' } }] })
    const fresh = loadConfig()
    try {
      const result = await api.connectorsAction(fresh, { action: 'sync', id: 'zentao:qa' })
      assert.equal(result.results[0].status, 'ok')
      assert.ok(result.results[0].added >= 2, 'tasks and bugs appended: ' + JSON.stringify(result.results))
      const entries = await entriesMod.loadEntries(fresh)
      const task = entries.find((entry) => entry.source === 'zentao' && entry.type === 'task')
      const bug = entries.find((entry) => entry.source === 'zentao' && entry.type === 'bug')
      assert.ok(task && task.title.includes('完成登录模块'))
      assert.ok(bug && bug.title.includes('首页白屏'))
      const again = await api.connectorsAction(fresh, { action: 'sync', id: 'zentao:qa' })
      assert.equal(again.results[0].added, 0, 'second sync dedupes')
    } finally {
      server.close()
      await saveConfig({ connectors: [] })
    }
  })
})

describe('r4 generic adapter', () => {
  it('maps listPath and fields into entries', async () => {
    const server = await startMock(() => ({
      code: 0,
      data: {
        items: [
          { id: 'H1', title: '需求评审会', updatedAt: TODAY + ' 09:30', project: { name: 'Hermes项目' } },
          { id: 'H2', title: '发布窗口确认', updatedAt: TODAY + 'T14:00' },
        ],
      },
    }))
    const port = server.address().port
    await saveConfig({
      connectors: [{
        id: 'generic:hermes', type: 'generic', enabled: true, label: 'hermes',
        config: {
          url: 'http://127.0.0.1:' + port + '/api',
          headersJson: '{"Token":"abc"}',
          listPath: 'data.items[]',
          titleField: 'title',
          timeField: 'updatedAt',
          projectField: 'project.name',
        },
      }],
    })
    const fresh = loadConfig()
    try {
      const result = await api.connectorsAction(fresh, { action: 'sync', id: 'generic:hermes' })
      assert.equal(result.results[0].status, 'ok')
      assert.ok(result.results[0].added >= 2)
      const entries = await entriesMod.loadEntries(fresh)
      const h1 = entries.find((entry) => entry.source === 'generic' && String(entry.ref).includes('hermes') || entry.title === '需求评审会')
      assert.ok(h1, 'generic entry landed')
      const named = entries.find((entry) => entry.title === '需求评审会')
      assert.equal(named.project, 'Hermes项目')
    } finally {
      server.close()
      await saveConfig({ connectors: [] })
    }
  })
})

describe('r4 feishu adapter', () => {
  it('authenticates and reports ready against a mock token endpoint', async () => {
    const server = await startMock((url, body) => {
      const parsed = JSON.parse(body || '{}')
      assert.equal(parsed.app_id, 'cli-x')
      return { code: 0, tenant_access_token: 't-x' }
    })
    const port = server.address().port
    await saveConfig({
      connectors: [{
        id: 'feishu:demo', type: 'feishu', enabled: false, label: 'demo',
        config: { apiDomain: 'http://127.0.0.1:' + port, appId: 'cli-x', appSecret: 's', feedMessages: false, feedWiki: false },
      }],
    })
    const fresh = loadConfig()
    try {
      const result = await api.connectorsAction(fresh, { action: 'test', id: 'feishu:demo' })
      assert.equal(result.ok, true)
    } finally {
      server.close()
      await saveConfig({ connectors: [] })
    }
  })
})
