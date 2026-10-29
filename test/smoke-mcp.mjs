import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'worklog-mcp-'))
const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'dist', 'server.mjs')], {
  env: { ...process.env, WORKLOG_HOME: home, ZCODE_PROJECT_DIR: process.cwd() },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

let buffer = ''
const pending = new Map()
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
})

let nextId = 1
function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 20000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0' },
})
console.log('server:', init.serverInfo)
notify('notifications/initialized', {})

const tools = await request('tools/list', {})
console.log('tools:', tools.tools.map((tool) => tool.name).join(', '))
const panelTool = tools.tools.find((tool) => tool.name === 'worklog_api')
if (!panelTool?._meta?.ui?.visibility?.includes('app')) {
  throw new Error('worklog_api must be app-visible only')
}
const openTool = tools.tools.find((tool) => tool.name === 'worklog_open')
if (openTool?._meta?.ui?.resourceUri !== 'ui://zcode-worklog/panel.html') {
  throw new Error('worklog_open must target the panel resource')
}

const status = await request('tools/call', { name: 'worklog_status', arguments: {} })
console.log('status:', status.content[0].text.slice(0, 300))

const day = await request('tools/call', {
  name: 'worklog_day',
  arguments: { date: '2026-10-29', text: '# test\n\nhello worklog\n' },
})
console.log('save:', day.content[0].text.slice(0, 200))

const search = await request('tools/call', { name: 'worklog_search', arguments: { query: 'hello' } })
console.log('search:', search.content[0].text.slice(0, 200))
if (!Array.isArray(search.structuredContent?.items)) {
  throw new Error('list results must be wrapped in structuredContent.items')
}

const boot = await request('tools/call', { name: 'worklog_api', arguments: { op: 'bootstrap' } })
if (!boot.structuredContent?.status || !Array.isArray(boot.structuredContent?.days)) {
  throw new Error('bootstrap did not return status/days')
}
console.log('bootstrap:', boot.structuredContent.status.today)

const resources = await request('resources/list', {})
console.log('resources:', resources.resources.map((item) => item.uri).join(', '))

const panel = await request('resources/read', { uri: 'ui://zcode-worklog/panel.html' })
console.log('panel html bytes:', panel.contents[0].text.length)

const panelJs = await request('resources/read', { uri: 'ui://zcode-worklog/panel.js' })
console.log('panel js bytes:', panelJs.contents[0].text.length)

child.stdin.end()
child.kill()
console.log('OK', home)
