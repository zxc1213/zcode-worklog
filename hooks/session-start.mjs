#!/usr/bin/env node
/**
 * SessionStart hook: inject a short WorkLog status line and run the daily
 * auto-archive when it is due. Always exits 0; diagnostics go to stderr.
 *
 * Usage: node session-start.mjs [pluginDataDir]
 */
import { archiveDir, loadConfig, localDate, pluginHome } from '../lib/config.mjs'
import { listDays, loadState, loadTodos, sortTodos } from '../lib/store.mjs'
import { runDueTasks } from '../lib/scheduler.mjs'
import { maybeAutoArchive } from '../src/api.mjs'

const dataDirArg = process.argv[2]
if (dataDirArg && !process.env.WORKLOG_HOME) {
  process.env.WORKLOG_HOME = dataDirArg
}

async function readInput() {
  let raw = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) raw += chunk
  try {
    return raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function finish(text) {
  if (text) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: text,
        },
      }),
    )
  }
  process.exitCode = 0
}

try {
  const input = await readInput()
  const config = loadConfig()

  // Run the daily archive before building the status line so the line is true.
  let autoNote = ''
  try {
    const archived = await maybeAutoArchive(config)
    if (archived) {
      autoNote = archived.created
        ? `（已自动归档：${archived.commitCount} 个提交 / ${archived.docCount} 个文档）`
        : '（今日已有归档，自动归档跳过）'
    }
  } catch (error) {
    autoNote = `（自动归档失败：${String(error?.message || error)}）`
  }

  // Second half of the compensating scheduler: the hook is the reliable
  // trigger point. Disabled tasks make this a cheap no-op; a single failing
  // task is reported in the status line, never fatal.
  let schedNote = ''
  try {
    const scheduled = await runDueTasks(config, { budgetMs: 5000 })
    const okRan = scheduled.ran.filter((item) => item.status === 'ok')
    const errRan = scheduled.ran.filter((item) => item.status === 'error')
    if (okRan.length) {
      const detail = okRan
        .map((item) => (item.sessions !== undefined ? `${item.title} ${item.sessions} 场` : item.title))
        .join('、')
      schedNote = `（定时采集：${detail}）`
    }
    if (errRan.length) schedNote += `（定时任务失败 ${errRan.length} 项）`
  } catch (hookError) {
    schedNote = `（定时任务异常：${String(hookError?.message || hookError)}）`
  }

  const today = localDate()
  const [days, todos, state] = await Promise.all([
    listDays(config),
    loadTodos(config),
    loadState(config),
  ])
  const archivedToday = days.some((day) => day.date === today)
  const open = todos.filter((todo) => todo.status !== 'done')
  const overdue = open.filter((todo) => todo.due && todo.due < today)
  const last = days.find((day) => day.date !== today)

  const parts = [
    `[WorkLog] 今天 ${today} ${archivedToday ? '已归档' : '尚未归档'}`,
  ]
  if (!archivedToday && last) parts.push(`最近归档 ${last.date}`)
  if (last === undefined && !archivedToday) parts.push('还没有任何归档')
  parts.push(`待办 ${open.length} 条进行中${overdue.length ? `（${overdue.length} 条逾期，归档后自动顺延到今天）` : ''}`)
  if (open.length) {
    // Smart order (overdue first) — same rule as the panel and worklog_todos list.
    const preview = sortTodos(open, today)
      .slice(0, 3)
      .map((todo) => {
        const carry = todo.carries >= 2 ? `（已顺延 ${todo.carries} 次）` : ''
        return todo.title + carry
      })
      .join('；')
    parts.push(`优先处理：${preview}`)
  }
  if (state.lastAutoDate) parts.push(`上次自动归档 ${state.lastAutoDate}`)
  if (autoNote) parts.push(autoNote)
  if (schedNote) parts.push(schedNote)

  const hint = archivedToday
    ? '需要补充日志、生成汇报或管理待办时，调用 worklog_* 工具或打开 WorkLog 面板。'
    : '如需归档今天，调用 worklog_archive（action=run），或让用户在 WorkLog 面板点「归档今天」。'

  process.stderr.write(
    `[zcode-worklog] SessionStart source=${input.source || 'unknown'} home=${pluginHome()} archive=${archiveDir(config)}\n`,
  )
  finish(`${parts.join('；')}。${hint}`)
} catch (error) {
  process.stderr.write(`[zcode-worklog] session-start hook failed: ${String(error?.message || error)}\n`)
  process.exitCode = 0
}
