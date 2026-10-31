/**
 * ZenTao connector, read-only: token via account/password, then my tasks and
 * bugs. Some ZenTao builds need cookie fallback for API auth; failures are
 * surfaced per-feed as error entries instead of failing the whole sync.
 */
import { localDate, localTime } from '../config.mjs'
import { fetchJson, firstPage } from './core.mjs'

export const FIELDS = [
  { key: 'url', label: '禅道地址', type: 'text', required: true, hint: '如 http://zentao.example.com/zentao' },
  { key: 'account', label: '账号', type: 'text', required: true },
  { key: 'password', label: '密码', type: 'password', required: true },
]

function joinUrl(base, path) {
  return base.replace(/\/+$/, '') + '/api.php/v1' + path
}

async function token(config) {
  const data = await fetchJson(joinUrl(config.url, '/tokens'), {
    method: 'POST',
    body: { account: config.account, password: config.password },
  })
  if (!data.token) throw new Error('获取禅道 token 失败：' + String(data.message || data.raw || '未知错误'))
  return data.token
}

export async function test(config) {
  const accessToken = await token(config)
  return { ok: true, detail: '登录成功' }
}

function mapItem(kind, item, baseUrl) {
  const day = String(item.deadline || item.lastEditedDate || item.openedDate || '').slice(0, 10)
  return {
    source: 'zentao', type: kind,
    date: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : localDate(),
    time: /^\d{2}:\d{2}/.test(String(item.openedDate || '')) ? String(item.openedDate).slice(11, 16) : '',
    title: '[' + kindLabel(kind) + (item.pri ? ' P' + item.pri : '') + '] ' + String(item.name || item.title || '(无标题)').slice(0, 120),
    detail: '状态 ' + (item.status || '-') + '，负责人 ' + (item.assignedToRealName || item.assignedTo || '-'),
    project: String(item.product || item.execution || '').slice(0, 60),
    tags: ['禅道'], ref: String(baseUrl || '').replace(/\/+$/, '') + '/bug-browse-' + (item.product || '') + '.html',
    nativeId: kind + ':' + item.id,
  }
}

function kindLabel(kind) {
  return kind === 'bug' ? '缺陷' : '任务'
}

export async function fetchEntries(config, { sinceDate = '' } = {}) {
  const accessToken = await token(config)
  const headers = { Token: accessToken }
  const entries = []
  const feeds = [
    { key: 'tasks', path: '/tasks', paramKey: 'assignedTo' },
    { key: 'bugs', path: '/bugs', paramKey: 'assignedTo' },
  ]
  for (const feed of feeds) {
    try {
      const data = await fetchJson(firstPage(joinUrl(config.url, feed.path), { limit: 100, zaccount: undefined, [feed.paramKey]: config.account }), { headers })
      const list = data?.data?.tasks || data?.data?.bugs || data?.data || []
      const items = Array.isArray(list) ? list : (list.tasks || list.bugs || [])
      for (const item of items.slice(0, 100)) {
        if (item.assignedTo && config.account && item.assignedTo !== config.account && item.assignedTo !== 'all') continue
        entries.push(mapItem(feed.key === 'tasks' ? 'task' : 'bug', item, config.url))
      }
    } catch (error) {
      entries.push({
        source: 'zentao', type: 'error', date: localDate(), time: localTime(),
        title: '禅道 ' + feed.key + ' 拉取失败：' + String(error?.message || error).slice(0, 120),
        tags: ['禅道', '错误'], nativeId: 'err:' + feed.key + ':' + localDate() + localTime(),
      })
    }
  }
  return entries
}
