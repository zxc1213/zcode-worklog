/**
 * Generic JSON connector: any HTTP JSON endpoint + dot-path list extraction +
 * field mapping. This is the Hermes placeholder until its real interface is
 * known (swap in a dedicated adapter then).
 */
import { createHash } from 'node:crypto'
import { localDate, localTime } from '../config.mjs'
import { fetchJson } from './core.mjs'

export const FIELDS = [
  { key: 'url', label: '接口地址', type: 'text', required: true },
  { key: 'headersJson', label: '请求头 JSON', type: 'textarea', hint: '可含 Token 等密钥，回显掩码' },
  { key: 'listPath', label: '列表路径', type: 'text', hint: '点路径，如 data.items[]' },
  { key: 'titleField', label: '标题字段', type: 'text', hint: '点路径，如 title' },
  { key: 'timeField', label: '时间字段', type: 'text', hint: '点路径，如 updatedAt' },
  { key: 'projectField', label: '项目字段', type: 'text', hint: '点路径,如 project.name' },
]

export async function test(config) {
  if (!/^https?:\/\//.test(String(config.url || ''))) return { ok: false, detail: '需要 http(s) 地址' }
  const data = await fetchJson(config.url, { headers: parseHeaders(config.headersJson) })
  const list = walk(data, config.listPath || '')
  return { ok: true, detail: '可达，按列表路径取到 ' + (Array.isArray(list) ? list.length : 0) + ' 条' }
}

export async function fetchEntries(config) {
  const data = await fetchJson(config.url, { headers: parseHeaders(config.headersJson) })
  const list = walk(data, config.listPath || "")
  if (!Array.isArray(list)) return []
  const now = new Date()
  return list.slice(0, 100).map((item) => {
    const title = String(pick(item, config.titleField) || pick(item, "title") || "(无标题)")
    const timeValue = String(pick(item, config.timeField) || "")
    const dayMatch = timeValue.match(/^\d{4}-\d{2}-\d{2}/)
    return {
      source: "generic", type: "item",
      date: dayMatch ? dayMatch[0].slice(0, 10) : localDate(now),
      time: timeValue.length >= 16 ? timeValue.slice(11, 16) : "",
      title: title.slice(0, 160),
      detail: "",
      project: String(pick(item, config.projectField) || "").slice(0, 60),
      tags: ["外部"],
      ref: config.url,
      nativeId: "gen:" + createHash("sha1").update(JSON.stringify(item)).digest("hex").slice(0, 16),
    }
  })
}

function parseHeaders(text) {
  try { return JSON.parse(String(text || "{}")) } catch { return {} }
}

function walk(value, path) {
  const parts = String(path || "").replace(/\[\]/g, "").split(".").filter(Boolean)
  let current = value
  for (const part of parts) {
    if (current === undefined || current === null) return current
    current = current[part]
  }
  return current
}

function pick(obj, path) {
  if (!path) return ""
  return walk(obj, path)
}
