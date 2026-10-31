/**
 * R3: prompt template engine (resolve/render/save/reset), summarize range
 * action (with and without AI), templates api surface.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'zcode-worklog-r3-'))
process.env.WORKLOG_HOME = home
delete process.env.ZCODE_PLUGIN_DATA
delete process.env.WORKLOG_SCAN_ROOTS
delete process.env.WORKLOG_DOC_ROOTS
delete process.env.WORKLOG_DATA_DIR

const { loadConfig, saveConfig, localDate } = await import('../lib/config.mjs')
const store = await import('../lib/store.mjs')
const templates = await import('../lib/templates.mjs')
const api = await import('../src/api.mjs')

const config = loadConfig()
const TODAY = localDate()

describe('r3 templates engine', () => {
  it('resolves builtin templates with variables and safe fallbacks', () => {
    const tpl = templates.render(config, 'summarize', {
      rangeStart: '2026-10-01', rangeEnd: '2026-10-31', todos: '- a', content: '内容X',
    })
    assert.equal(tpl.source, 'builtin')
    assert.ok(tpl.system.includes('工作总结助手'))
    assert.ok(tpl.user.includes('2026-10-01'))
    assert.ok(tpl.user.includes('内容X'))
    const sparse = templates.renderTemplate('a {{missing}} b {{content}}', { content: 'C' })
    assert.equal(sparse, 'a  b C', 'missing vars render empty')
  })

  it('save/reset roundtrip switches source between user and builtin', async () => {
    await templates.saveTemplate(config, 'ask', { name: '我的问答', system: 'SYS-自定义', user: 'Q:{{question}}' })
    const custom = templates.render(config, 'ask', { question: '上线了吗', content: '' })
    assert.equal(custom.source, 'user')
    assert.equal(custom.system, 'SYS-自定义')
    assert.equal(custom.user, 'Q:上线了吗')
    const exists = join(config.dataDir, 'templates', 'ask.md')
    assert.equal(existsSync(exists), true)

    await templates.resetTemplate(config, 'ask')
    const back = templates.render(config, 'ask', { question: 'x', content: '' })
    assert.equal(back.source, 'builtin')
    assert.equal(existsSync(exists), false)
  })

  it('lists all scenes with resolved source', () => {
    const list = templates.listTemplates(config)
    assert.equal(list.length, templates.SCENES.length)
    assert.ok(list.every((item) => item.system && item.user))
  })
})

describe('r3 summarize', () => {
  it('works without AI as a deterministic digest', async () => {
    await store.saveDay(config, TODAY, '# 日志\n\n巡检正常。\n')
    await store.saveTodos(config, [
      { id: 'z1', title: '总结范围内完成', status: 'done', pri: '', due: '', repeat: '', created: TODAY + 'T01:00:00.000Z', updated: TODAY + 'T01:00:00.000Z', done_at: TODAY + 'T09:00:00.000Z' },
    ])
    const result = await api.reportAction(config, { action: 'summarize', start: TODAY, end: TODAY, useAi: false })
    assert.equal(result.ai, false)
    assert.match(result.text, /规则摘要/)
    assert.match(result.text, /巡检正常|覆盖/)
  })

  it('uses the summarize template against a mock AI endpoint', async () => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const payload = JSON.parse(body)
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '总结正文：一切正常。' } }],
            usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
          }),
        )
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await saveConfig({ ai: { baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'mock' } })
    try {
      const fresh = loadConfig()
      const result = await api.reportAction(fresh, { action: 'summarize', start: TODAY, end: TODAY })
      assert.equal(result.ai, true)
      assert.match(result.text, /总结正文/)
      const state = await store.loadState(fresh)
      assert.equal(state.aiUsage[0].kind, 'summarize')
    } finally {
      server.close()
      await saveConfig({ ai: { baseUrl: '', model: '', clearApiKey: true } })
    }
  })

  it('templates api saves and resets through the action layer', async () => {
    const saved = await api.templatesAction(config, {
      action: 'save', scene: 'report', name: '测试报告', system: 'SYS-R', user: 'U-{{content}}',
    })
    assert.equal(saved.template.source, 'user')
    const listed = await api.templatesAction(config, { action: 'list' })
    const report = listed.templates.find((item) => item.scene === 'report')
    assert.equal(report.system, 'SYS-R')
    await api.templatesAction(config, { action: 'reset', scene: 'report' })
    const listed2 = await api.templatesAction(config, { action: 'list' })
    assert.equal(listed2.templates.find((item) => item.scene === 'report').source, 'builtin')
  })
})
