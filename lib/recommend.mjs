/**
 * Rule-based recommendation engine (REQ-D2): deterministic scoring over local
 * signals (todos, entries, day-file coverage), no AI required. Feedback
 * (accept/ignore counts) nudges same-kind weights so repeated ignores sink
 * a suggestion kind. Explainable: every item carries kind + score + refs.
 */
import { localDate } from './config.mjs'
import { loadTodos, listDays, loadState } from './store.mjs'
import { loadEntries } from './entries.mjs'
import { listConnectors } from './connectors.mjs'

const BASE_WEIGHTS = {
  overdue: 10,
  external: 8,
  'no-log-project': 6,
  upcoming: 5,
  stale: 3,
}

export async function loadFeedback(config) {
  const state = await loadState(config)
  return state.recommendFeedback || {}
}

export async function recordFeedback(config, key, kind, accepted) {
  const { saveState } = await import('./store.mjs')
  const state = await loadState(config)
  const feedback = state.recommendFeedback || {}
  const entry = feedback[kind] || { accepted: 0, ignored: 0 }
  if (accepted) entry.accepted += 1
  else entry.ignored += 1
  feedback[kind] = entry
  state.recommendFeedback = feedback
  await saveState(config, state)
  return entry
}

function kindWeight(feedback, kind) {
  const entry = feedback[kind]
  if (!entry) return 1
  const total = entry.accepted + entry.ignored
  if (!total) return 1
  // dampened acceptance rate: 1 ignored / 1 accepted -> 0.75; 4 ignored / 1 accepted -> ~0.5
  return Math.max(0.2, (entry.accepted + 1) / (total + 2) * 1.5)
}

export async function buildRecommendations(config, { date = localDate(), limit = 8 } = {}) {
  const today = String(date)
  const feedback = await loadFeedback(config)
  const items = []

  // 1. overdue / carried todos
  const todos = await loadTodos(config)
  for (const todo of todos) {
    if (todo.status === 'done') continue
    if (todo.due && todo.due < today) {
      const carries = todo.carries || 0
      items.push({
        kind: 'overdue', score: BASE_WEIGHTS.overdue + carries * 2, weight: kindWeight(feedback, 'overdue'),
        title: '逾期待办：' + todo.title, detail: '到期 ' + todo.due + (carries ? '，已顺延 ' + carries + ' 次' : ''),
        refs: { todoId: todo.id },
      })
    } else if (!todo.due && String(todo.created || '').slice(0, 10) < shiftDays(today, -14)) {
      items.push({
        kind: 'stale', score: BASE_WEIGHTS.stale, weight: kindWeight(feedback, 'stale'),
        title: '长期未动待办：' + todo.title, detail: '创建于 ' + String(todo.created).slice(0, 10) + '，两周以上未处理',
        refs: { todoId: todo.id },
      })
    }
  }

  // 2. external connector items due soon / high priority (zentao/feishu entries)
  const entries = await loadEntries(config)
  const soonStart = today
  const soonEnd = shiftDays(today, 3)
  const seen = new Set()
  for (const entry of entries) {
    if (!['zentao', 'feishu', 'generic'].includes(entry.source)) continue
    if (entry.type === 'error') continue
    const isTaskish = entry.source === 'zentao' && ['task', 'bug'].includes(entry.type)
    if (!isTaskish) continue
    const key = entry.fp
    if (seen.has(key)) continue
    seen.add(key)
    if (entry.date >= soonStart && entry.date <= soonEnd) {
      items.push({
        kind: 'external', score: BASE_WEIGHTS.external, weight: kindWeight(feedback, 'external'),
        title: '外部任务临期：' + entry.title, detail: '来源 ' + entry.source + '，日期 ' + entry.date,
        refs: { entryId: entry.id },
      })
    }
  }

  // 3. active projects without a log today
  const gitProjects = new Set()
  for (const entry of entries) {
    if (entry.source === 'git' && entry.date === today && entry.project) gitProjects.add(entry.project)
  }
  const loggedProjects = new Set()
  const todayDay = (await listDays(config)).find((day) => day.date === today)
  if (todayDay) {
    const { getDay } = await import('./store.mjs')
    const day = await getDay(config, today)
    for (const line of day.text.split('\n')) {
      const match = line.match(/^### (.+)$/)
      if (match) loggedProjects.add(match[1].trim())
    }
  }
  for (const project of gitProjects) {
    if (loggedProjects.has(project)) continue
    items.push({
      kind: 'no-log-project', score: BASE_WEIGHTS['no-log-project'], weight: kindWeight(feedback, 'no-log-project'),
      title: '项目今天有提交但日志未覆盖：' + project,
      detail: '归档前补一条说明，周报才有内容',
      refs: { project },
    })
  }

  // 4. near-term items from calendar-ish sources (watch/feishu wiki today)
  for (const entry of entries) {
    if (entry.date !== today) continue
    if (entry.source === 'watch' || (entry.source === 'feishu' && entry.type === 'wiki')) {
      items.push({
        kind: 'upcoming', score: BASE_WEIGHTS.upcoming, weight: kindWeight(feedback, 'upcoming'),
        title: '今日动态：' + entry.title,
        detail: '来源 ' + entry.source + (entry.project ? ' · ' + entry.project : ''),
        refs: { entryId: entry.id },
      })
      break
    }
  }

  const ranked = items
    .map((item) => ({ ...item, final: Math.round(item.score * item.weight * 10) / 10 }))
    .sort((a, b) => b.final - a.final)
    .slice(0, limit)
  return { date: today, items: ranked }
}

function shiftDays(dateString, days) {
  const [y, m, d] = String(dateString).split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + days)
  const pad = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

/** Render the 「建议关注」 report section from recommendations. */
export function recommendSection(recommendations) {
  if (!recommendations.items.length) return []
  const lines = ['- 建议关注 ' + recommendations.items.length + ' 项（按评分排序）：']
  for (const item of recommendations.items.slice(0, 6)) {
    lines.push('  - [' + item.kind + '] ' + item.title + (item.detail ? '（' + item.detail + '）' : ''))
  }
  return ['## 建议关注', ...lines, '']
}
