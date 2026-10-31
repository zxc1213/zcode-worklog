/**
 * Connector framework (REQ-C4/REQ-P1): registry + normalize + test + sync.
 * Each adapter exposes FIELDS (for the wizard/panel UI), test(cfg) and
 * fetchEntries(cfg) -> entries[]. Sync appends to the unified timeline via
 * appendEntries so calendar/reports/graph all see external data.
 */
import { localDate, localTime } from './config.mjs'
import { appendEntries } from './entries.mjs'
import * as feishu from './adapters/feishu.mjs'
import * as zentao from './adapters/zentao.mjs'
import * as generic from './adapters/generic.mjs'

export const ADAPTERS = { feishu, zentao, generic }

export const CONNECTOR_TYPES = [
  { type: 'feishu', title: '飞书（自建应用，只读）', description: '拉取群消息摘要与知识库节点变更；企业租户可能需要管理员审批 scope' },
  { type: 'zentao', title: '禅道（REST，只读）', description: '拉取指派给你的任务与缺陷' },
  { type: 'generic', title: '通用 JSON（Hermes 等占位）', description: '任意 HTTP JSON 接口 + 列表路径 + 字段映射' },
]

const SECRET_HINT = '已配置'

export function adapterFor(type) {
  const adapter = ADAPTERS[type]
  if (!adapter) throw new Error('未知连接器类型：' + type)
  return adapter
}

export function normalizeConnector(raw = {}) {
  const type = String(raw.type || '').trim()
  adapterFor(type)
  return {
    id: String(raw.id || '').trim() || type + ':' + String(raw.label || 'default').trim(),
    type,
    enabled: Boolean(raw.enabled),
    label: String(raw.label || '').slice(0, 40),
    config: normalizeConfigFor(type, raw.config || {}),
    lastSyncAt: String(raw.lastSyncAt || ''),
    lastStatus: String(raw.lastStatus || ''),
    lastError: String(raw.lastError || ''),
  }
}

function normalizeConfigFor(type, input) {
  const fields = adapterFor(type).FIELDS
  const out = {}
  for (const field of fields) {
    if (field.type === 'bool') {
      out[field.key] = Boolean(input[field.key])
    } else {
      out[field.key] = String(input[field.key] || '').slice(0, 2000)
    }
  }
  return out
}

/** Replace secret-ish values for display; config file keeps plaintext (local only). */
export function publicConnector(connector) {
  const fields = adapterFor(connector.type).FIELDS
  const masked = {}
  for (const field of fields) {
    const value = connector.config[field.key]
    if (field.type === 'bool') {
      masked[field.key] = Boolean(value)
      continue
    }
    if (field.type === 'password' || field.type === 'textarea') {
      masked[field.key] = value ? '已配置' : ''
      continue
    }
    masked[field.key] = value
  }
  return { ...connector, config: masked }
}

export function listConnectors(config) {
  return (Array.isArray(config.connectors) ? config.connectors : []).map(normalizeConnector)
}

export function publicConnectorList(config) {
  return listConnectors(config).map(publicConnector)
}

/**
 * Sync one connector (or all enabled ones when id omitted): fetch entries via
 * the adapter, append to the timeline, persist per-connector status in the
 * connectors config. Returns {added, results} summary.
 */
export async function syncConnectors(config, id = '') {
  const { saveConfig, loadConfig } = await import('./config.mjs')
  const connectors = listConnectors(config)
  const results = []
  for (const connector of connectors) {
    if (id && connector.id !== id) continue
    if (!id && !connector.enabled) continue
    const adapter = adapterFor(connector.type)
    let status = 'ok'
    let error = ''
    let added = 0
    try {
      const entries = await adapter.fetchEntries(connector.config, { sinceDate: '' })
      const outcome = await appendEntries(config, entries)
      added = outcome.added
    } catch (syncError) {
      status = 'error'
      error = String(syncError?.message || syncError)
    }
    results.push({ id: connector.id, type: connector.type, label: connector.label, status, error, added })
    await saveConfig({
      connectors: listConnectors(config).map((item) =>
        item.id === connector.id
          ? { ...item, lastSyncAt: new Date().toISOString(), lastStatus: status, lastError: error }
          : item,
      ),
    })
    config = loadConfig()
  }
  return { results }
}
