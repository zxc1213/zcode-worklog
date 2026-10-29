/**
 * End-to-end smoke test in a throwaway directory:
 * archive a git repo, save a log, add/finish a todo, generate a report,
 * create and restore a backup. No ZCode process is required.
 *
 *   node test/smoke.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'zcode-worklog-smoke-'))
process.env.WORKLOG_HOME = home
delete process.env.ZCODE_PLUGIN_DATA
process.env.ZCODE_PROJECT_DIR = mkdtempSync(join(tmpdir(), 'zcode-worklog-smoke-ws-'))

const { loadConfig, localDate, saveConfig } = await import('../lib/config.mjs')
const { getDay, listDays, loadTodos } = await import('../lib/store.mjs')
const api = await import('../src/api.mjs')

const workspace = process.env.ZCODE_PROJECT_DIR
const repo = join(workspace, 'smoke-project')
mkdirSync(repo, { recursive: true })
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Smoke',
  GIT_AUTHOR_EMAIL: 'smoke@example.com',
  GIT_COMMITTER_NAME: 'Smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.com',
}
execFileSync('git', ['init', '-q'], { cwd: repo, env: gitEnv })
execFileSync('git', ['config', 'user.name', 'Smoke'], { cwd: repo, env: gitEnv })
execFileSync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: repo, env: gitEnv })
writeFileSync(join(repo, 'a.txt'), 'smoke\n', 'utf8')
execFileSync('git', ['add', '.'], { cwd: repo, env: gitEnv })
execFileSync('git', ['commit', '-q', '-m', 'smoke: 首次提交'], {
  cwd: repo,
  env: { ...gitEnv, GIT_AUTHOR_DATE: `${localDate()}T09:00:00`, GIT_COMMITTER_DATE: `${localDate()}T09:00:00` },
})

saveConfig({ scanRoots: [workspace], docRoots: [workspace], gitAuthor: 'Smoke' })
const config = loadConfig()

const archived = await api.archiveAction(config, { action: 'run', date: localDate(), force: true })
console.log(`archive        ${archived.date}: ${archived.commitCount} commits, ${archived.docCount} docs, created=${archived.created}`)

await api.dayAction({ date: localDate(), text: '# 今日\n\n冒烟测试完成。\n' })
console.log(`day            ${(await getDay(config, localDate())).exists ? 'saved' : 'missing'}`)

const todo = await api.todoAction(config, { action: 'add', title: '冒烟待办', pri: '高', due: localDate() })
await api.todoAction(config, { action: 'complete', id: todo.id })
console.log(`todos          ${(await loadTodos(config)).length} total`)

const report = await api.reportAction(config, { action: 'generate', kind: 'weekly', monday: localDate() })
console.log(`report         ${report.name} (${report.text.length} chars)`)

const backup = await api.backupAction(config, { action: 'create' })
const restored = await api.backupAction(config, { action: 'restore', name: backup.name })
console.log(`backup         ${backup.name}: ${backup.days} days -> restored ${restored.restored}`)
await api.backupAction(config, { action: 'delete', name: backup.name })

const days = await listDays(config)
console.log(`days           ${days.length} (${days[0]?.date})`)
console.log(`home           ${home}`)
console.log('SMOKE OK')
