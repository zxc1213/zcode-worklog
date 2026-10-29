/**
 * Standalone archive engine: git commits + local document changes -> one
 * Markdown file per day. No WorkLog.exe, no 8377 API.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { dayFile, docRootsOf, localDate, localTime, scanRootsOf } from './config.mjs'

const execFileAsync = promisify(execFile)

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', 'venv', '.venv', '__pycache__',
  'AppData', 'Library', 'System32', 'WinSxS',
])

export const DOC_EXTS = new Set([
  '.md', '.markdown', '.txt',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf',
])

function isSkippedDir(name) {
  return SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.')
}

async function walk(root, maxDepth, visitDir, visitFile) {
  const base = resolve(root)
  if (!existsSync(base)) return
  const queue = [{ dir: base, depth: 0 }]
  let seen = 0
  while (queue.length) {
    const { dir, depth } = queue.shift()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    await visitDir?.(dir, depth)
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth && !isSkippedDir(entry.name)) queue.push({ dir: full, depth: depth + 1 })
      } else if (entry.isFile()) {
        seen += 1
        if (seen > 50000) return
        await visitFile?.(full, entry)
      }
    }
  }
}

async function git(repo, args, timeout = 20000) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  return String(stdout || '')
}

export async function findGitRepos(roots = []) {
  const repos = []
  for (const root of roots) {
    await walk(root, 3, async (dir) => {
      if (existsSync(join(dir, '.git'))) repos.push(dir)
    })
  }
  return [...new Set(repos)]
}

export async function scanGit(roots, dateString, author = '') {
  const repos = await findGitRepos(roots)
  const out = []
  const errors = []
  for (const repo of repos) {
    try {
      const currentAuthor = author || (await git(repo, ['config', 'user.name'])).trim()
      const args = [
        'log',
        `--since=${dateString} 00:00:00`,
        `--until=${dateString} 23:59:59`,
        '--all',
        '--pretty=format:%h%x09%an%x09%s',
      ]
      if (currentAuthor) args.push(`--author=${currentAuthor}`)
      const text = await git(repo, args)
      const commits = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [hash, commitAuthor, ...subject] = line.split('\t')
          return { hash, author: commitAuthor || '', subject: subject.join('\t') }
        })
      if (commits.length) {
        out.push({
          name: basename(repo),
          path: repo,
          author: currentAuthor,
          commits,
        })
      }
    } catch (error) {
      errors.push({ repo, error: String(error?.message || error) })
    }
  }
  return { repos: out, errors }
}

export async function scanDocs(roots, dateString) {
  const files = []
  const errors = []
  for (const root of roots) {
    try {
      await walk(root, 6, null, async (full) => {
        if (!DOC_EXTS.has(extname(full).toLowerCase())) return
        try {
          const info = await stat(full)
          if (localDate(info.mtime) !== dateString) return
          files.push({
            path: full,
            relative: relative(root, full),
            size: info.size,
            mtime: info.mtime.toISOString(),
            time: localTime(info.mtime),
          })
        } catch {
          /* file disappeared while walking */
        }
      })
    } catch (error) {
      errors.push({ root, error: String(error?.message || error) })
    }
  }
  return { files, errors }
}

function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function buildDayMarkdown(dateString, gitResult, docResult, note = '') {
  const repos = gitResult.repos || []
  const docs = docResult.files || []
  const commitCount = repos.reduce((sum, repo) => sum + repo.commits.length, 0)
  const lines = [
    `# ${dateString} 工作日志`,
    '',
    `> 自动归档 · ${localTime()}`,
    '',
    '## 今日概览',
    '',
    `- Git 提交：${commitCount} 个，涉及 ${repos.length} 个项目`,
    `- 文档变更：${docs.length} 个`,
    '',
  ]

  if (repos.length) {
    lines.push('## 项目进展', '')
    for (const repo of repos) {
      lines.push(`### ${repo.name}`, '')
      for (const commit of repo.commits) {
        lines.push(`- \`${commit.hash}\` ${commit.subject}${commit.author ? `（${commit.author}）` : ''}`)
      }
      lines.push('')
    }
  } else {
    lines.push('## 项目进展', '', '今天没有扫描到 Git 提交。', '')
  }

  if (docs.length) {
    lines.push('## 文档变更', '')
    for (const doc of docs) {
      lines.push(`- \`${doc.relative || basename(doc.path)}\` · ${doc.time} · ${sizeText(doc.size)}`)
    }
    lines.push('')
  } else {
    lines.push('## 文档变更', '', '今天没有扫描到文档变更。', '')
  }

  lines.push('## 备注', '', note.trim() || '（可在此补充今天的工作说明）', '')
  return lines.join('\n')
}

export async function archiveDay(config, dateString, { force = false, note = '' } = {}) {
  const target = dayFile(config, dateString)
  if (!force && existsSync(target)) {
    return { date: dateString, path: target, created: false, existing: true }
  }

  const gitResult = config.sources?.git === false
    ? { repos: [], errors: [] }
    : await scanGit(scanRootsOf(config), dateString, config.gitAuthor || '')
  const docResult = config.sources?.docs === false
    ? { files: [], errors: [] }
    : await scanDocs(docRootsOf(config), dateString)

  const text = buildDayMarkdown(dateString, gitResult, docResult, note)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, text, 'utf8')

  return {
    date: dateString,
    path: target,
    created: true,
    existing: false,
    text,
    commitCount: gitResult.repos.reduce((sum, repo) => sum + repo.commits.length, 0),
    repoCount: gitResult.repos.length,
    docCount: docResult.files.length,
    repos: gitResult.repos.map((repo) => ({
      name: repo.name,
      path: repo.path,
      commits: repo.commits.length,
    })),
    errors: [...gitResult.errors, ...docResult.errors],
  }
}

export async function archiveDays(config, dates, options = {}) {
  const results = []
  for (const dateString of dates) {
    try {
      results.push(await archiveDay(config, dateString, options))
    } catch (error) {
      results.push({ date: dateString, error: String(error?.message || error) })
    }
  }
  return results
}
