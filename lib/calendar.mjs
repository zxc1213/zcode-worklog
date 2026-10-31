/**
 * Calendar aggregation (REQ-O2): blend existing signals into per-day activity
 * for an interactive month view — archived day files, entries by source,
 * todo completion, daily reports, parsed AI sessions. Historical days keep
 * whatever signals exist on disk; entries accrue from the R2 launch onward.
 */
import { getDay, listDays, listReports, loadTodos } from './store.mjs'
import { entriesBucketByDate, entriesForDate } from './entries.mjs'
import { localDate } from './config.mjs'
import { parseSessionLines } from './sessions.mjs'

function monthPrefix(month) {
  const text = String(month || '').trim()
  if (!/^\d{4}-\d{2}$/.test(text)) return localDate().slice(0, 7)
  return text
}

function daysInMonth(month) {
  const [year, mon] = month.split('-').map(Number)
  return new Date(year, mon, 0).getDate()
}

export async function calendarMonth(config, month) {
  const key = monthPrefix(month)
  const bucket = await entriesBucketByDate(config, key)
  const todos = await loadTodos(config)
  const doneDates = {}
  const dueDates = {}
  for (const todo of todos) {
    if (todo.status === 'done') {
      const day = String(todo.done_at || '').slice(0, 10)
      if (day) doneDates[day] = (doneDates[day] || 0) + 1
    } else if (todo.due) {
      dueDates[todo.due] = (dueDates[todo.due] || 0) + 1
    }
  }
  const archived = new Set()
  for (const day of await listDays(config)) {
    if (day.date.startsWith(key)) archived.add(day.date)
  }
  const dailyReports = new Set(
    (await listReports(config))
      .map((report) => report.name)
      .filter((name) => name.startsWith('daily-'))
      .map((name) => name.slice(6, 16)),
  )
  const days = {}
  for (let i = 1; i <= daysInMonth(key); i++) {
    const date = key + '-' + String(i).padStart(2, '0')
    const counts = bucket[date] || { count: 0, bySource: {} }
    days[date] = {
      date,
      archived: archived.has(date),
      hasDailyReport: dailyReports.has(date),
      entryCount: counts.count,
      bySource: counts.bySource,
      todoDone: doneDates[date] || 0,
      todoDue: dueDates[date] || 0,
      sessionCount: counts.bySource.sessions || 0,
      commitCount: counts.bySource.git || 0,
    }
  }
  return { month: key, today: localDate(), days }
}

export async function calendarDay(config, dateString) {
  const day = await getDay(config, dateString)
  const sessions = day.exists ? parseSessionLines(day.text) : []
  const allTodos = await loadTodos(config)
  const todosDue = allTodos
    .filter((todo) => todo.status !== 'done' && todo.due === dateString)
    .map((todo) => ({ id: todo.id, title: todo.title, pri: todo.pri, carries: todo.carries || 0 }))
  const todosDone = allTodos
    .filter((todo) => todo.status === 'done' && String(todo.done_at || '').slice(0, 10) === dateString)
    .map((todo) => ({ title: todo.title, doneAt: todo.done_at }))
  const entries = await entriesForDate(config, dateString)
  const bySource = {}
  for (const entry of entries) bySource[entry.source] = (bySource[entry.source] || 0) + 1
  const dailyReport = (await listReports(config)).some((report) => report.name === 'daily-' + dateString + '.md')
  return {
    date: dateString,
    archived: day.exists,
    path: day.path,
    sessions: sessions.map((session) => ({
      title: session.title, label: session.label, turns: session.turns, timeRange: session.timeRange,
    })),
    todosDone,
    todosDue,
    entries: {
      count: entries.length,
      bySource,
      items: entries
        .slice(-20)
        .reverse()
        .map((entry) => ({
          time: entry.time, title: entry.title, project: entry.project, source: entry.source, ref: entry.ref,
        })),
    },
    hasDailyReport: Boolean(dailyReport),
  }
}
