/**
 * Feishu (Lark) connector, read-only: tenant_access_token via app_id/app_secret,
 * then optional sub-feeds: group message digests (im-v1) and wiki node changes
 * (wiki-v2). Enterprise tenants may need admin approval for scopes.
 */
import { fetchJson, firstPage } from './core.mjs'

export const FIELDS = [
  { key: 'apiDomain', label: 'API 域名', type: 'text', hint: '默认 https://open.feishu.cn' },
  { key: 'appId', label: 'App ID', type: 'text', required: true },
  { key: 'appSecret', label: 'App Secret', type: 'password', required: true },
  { key: 'feedMessages', label: '群消息摘要', type: 'bool' },
  { key: 'feedWiki', label: '知识库节点变更', type: 'bool' },
]

const DEFAULT_DOMAIN = 'https://open.feishu.cn'

async function token(config) {
  const data = await fetchJson((config.apiDomain || DEFAULT_DOMAIN) + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: { app_id: config.appId, app_secret: config.appSecret },
  })
  if (!data.tenant_access_token) {
    throw new Error('获取 tenant_access_token 失败：' + String(data.msg || 'code ' + data.code))
  }
  return data.tenant_access_token
}

export async function test(config) {
  const accessToken = await token(config)
  return { ok: true, detail: 'token 获取成功（' + accessToken.slice(0, 6) + '…）' }
}

export async function fetchEntries(config, { sinceDate = '' } = {}) {
  const accessToken = await token(config)
  const domain = config.apiDomain || DEFAULT_DOMAIN
  const headers = { authorization: 'Bearer ' + accessToken }
  const now = new Date()
  const entries = []

  if (config.feedMessages !== false && config.feedMessages) {
    try {
      const chats = await fetchJson(firstPage(domain + '/open-apis/im/v1/chats', { page_size: 20 }), { headers })
      const chatList = chats?.data?.items || []
      const startTime = sinceDate
        ? Math.floor(new Date(sinceDate + 'T00:00:00').getTime() / 1000) + ''
        : Math.floor((Date.now() - 86400000) / 1000) + ''
      for (const chat of chatList.slice(0, 10)) {
        const messages = await fetchJson(
          firstPage(domain + '/open-apis/im/v1/messages', {
            container_id_type: 'chat', container_id: chat.chat_id, start_time: startTime, page_size: 20, sort_type: 'ByCreateTimeDesc',
          }),
          { headers },
        )
        for (const message of (messages?.data?.items || []).slice(0, 10)) {
          const body = safeParse(message.body?.content)
          const text = String(body?.text || body?.content || message.msg_type || '').slice(0, 200)
          entries.push({
            source: 'feishu', type: 'message', date: localDayOf(Number(message.create_time)),
            time: localTimeOf(Number(message.create_time)),
            title: (chat.name || '群') + '：' + (text || '(卡片/媒体消息)'),
            project: chat.name || '', tags: ['飞书'], ref: message.message_id,
            nativeId: 'msg:' + message.message_id,
          })
        }
      }
    } catch (error) {
      entries.push(errorEntry('feishu-messages', error))
    }
  }

  if (config.feedWiki) {
    try {
      const spaces = await fetchJson(firstPage(domain + '/open-apis/wiki/v2/spaces', { page_size: 20 }), { headers })
      for (const space of (spaces?.data?.items || []).slice(0, 5)) {
        const nodes = await fetchJson(
          firstPage(domain + '/open-apis/wiki/v2/spaces/' + space.space_id + '/nodes', { page_size: 30 }),
          { headers },
        )
        for (const node of (nodes?.data?.items || []).slice(0, 20)) {
          const edited = Number(node.obj_edit_time) * 1000
          if (sinceDate && edited && new Date(edited).toISOString().slice(0, 10) < sinceDate) continue
          entries.push({
            source: 'feishu', type: 'wiki', date: localDayOf(edited || Date.now()),
            time: localTimeOf(edited || Date.now()),
            title: '文档 ' + (node.title || '(无标题)') + ' 有变更',
            project: space.name || '', tags: ['飞书', 'wiki'], ref: node.url || node.node_token,
            nativeId: 'wiki:' + node.node_token + ':' + (node.obj_edit_time || ''),
          })
        }
      }
    } catch (error) {
      entries.push(errorEntry('feishu-wiki', error))
    }
  }

  return entries
}

function safeParse(text) {
  try {
    return JSON.parse(String(text || '{}'))
  } catch {
    return {}
  }
}

function localDayOf(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function localTimeOf(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function errorEntry(tag, error) {
  const now = new Date()
  return {
    source: 'feishu', type: 'error', date: localDayOf(now.getTime()), time: localTimeOf(now.getTime()),
    title: '飞书 ' + tag + ' 拉取失败：' + String(error?.message || error).slice(0, 120),
    tags: ['飞书', '错误'], nativeId: 'err:' + tag + ':' + now.toISOString().slice(0, 16),
  }
}
