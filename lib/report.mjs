/**
 * Deterministic report drafts from the local archive, with optional
 * OpenAI-compatible polish when the user configures an AI endpoint.
 */
import {
  currentMonth,
  currentQuarter,
  localDate,
  mondayOf,
} from './config.mjs'
import { archiveDay } from './archive.mjs'
import {
  getDay,
  listDays,
  recordAiUsage,
  searchDays,
  writeReport,
} from './store.mjs'
import { parseSessionLines } from './sessions.mjs'

function pad(n) {
  return String(n).padStart(2, '0')
}

export function dateRange(start, end) {
  const out = []
  const from = new Date(`${start}T00:00:00`)
  const to = new Date(`${end}T00:00:00`)
  for (let date = new Date(from); date <= to; date.setDate(date.getDate() + 1)) {
    out.push(localDate(date))
  }
  return out
}

export function weekDates(dateString = localDate()) {
  const monday = mondayOf(dateString)
  return dateRange(monday, (() => {
    const date = new Date(`${monday}T00:00:00`)
    date.setDate(date.getDate() + 6)
    return localDate(date)
  })())
}

export function monthDates(month = currentMonth()) {
  const [year, monthNumber] = month.split('-').map(Number)
  const start = `${year}-${pad(monthNumber)}-01`
  const end = localDate(new Date(year, monthNumber, 0))
  return dateRange(start, end)
}

export function quarterDates(quarter = currentQuarter()) {
  const match = /^(\d{4})-Q([1-4])$/.exec(quarter)
  if (!match) throw new Error('季度格式应为 YYYY-Q1..Q4')
  const year = Number(match[1])
  const q = Number(match[2])
  const startMonth = (q - 1) * 3 + 1
  const start = `${year}-${pad(startMonth)}-01`
  const end = localDate(new Date(year, startMonth + 2, 0))
  return dateRange(start, end)
}

async function readDays(config, dates) {
  const out = []
  for (const dateString of dates) {
    const day = await getDay(config, dateString)
    if (day.exists) out.push({ date: dateString, text: day.text })
  }
  return out
}

function parseDaySections(text) {
  const projects = new Map()
  const docs = []
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const heading = /^###\s+(.+?)\s*$/.exec(line)
    if (heading) {
      current = heading[1].trim()
      if (!projects.has(current)) projects.set(current, [])
      continue
    }
    if (/^##\s+/.test(line)) {
      current = null
      continue
    }
    if (current && /^-\s+/.test(line)) projects.get(current).push(line.replace(/^-\s+/, '').trim())
    if (/^-\s+`[^`]+`\s+·\s+\d{2}:\d{2}/.test(line)) docs.push(line.replace(/^-\s+/, '').trim())
  }
  return { projects, docs }
}

function combineDays(days, title, subtitle) {
  const projectMap = new Map()
  const docs = []
  const sessionEntries = []
  let sessions = 0
  let turns = 0
  let commits = 0
  for (const day of days) {
    const parsed = parseDaySections(day.text)
    for (const [project, lines] of parsed.projects) {
      if (!projectMap.has(project)) projectMap.set(project, [])
      for (const line of lines) {
        projectMap.get(project).push({ date: day.date, line })
        if (/^`[0-9a-f]+`/i.test(line)) commits += 1
      }
    }
    for (const doc of parsed.docs) docs.push({ date: day.date, line: doc })
    const parsedSessions = parseSessionLines(day.text)
    sessions += parsedSessions.length
    for (const session of parsedSessions) {
      turns += session.turns
      sessionEntries.push({ date: day.date, ...session })
    }
  }

  const lines = [`# ${title}`, '', subtitle ? `> ${subtitle}` : '', '']
  lines.push('## 概览', '')
  lines.push(`- 归档天数：${days.length} 天`)
  lines.push(`- Git 提交：${commits} 个`)
  lines.push(`- 涉及项目：${projectMap.size} 个`)
  lines.push(`- 文档变更：${docs.length} 项`)
  lines.push(`- AI 会话：${sessions} 场，${turns} 轮`, '')

  if (projectMap.size) {
    lines.push('## 项目进展', '')
    for (const [project, entries] of [...projectMap.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`### ${project}`, '')
      for (const entry of entries) lines.push(`- ${entry.date} · ${entry.line}`)
      lines.push('')
    }
  } else {
    lines.push('## 项目进展', '', '本期没有从归档中解析到项目提交。', '')
  }

  if (sessionEntries.length) {
    lines.push('## AI 会话', '')
    for (const session of sessionEntries) {
      lines.push(`- ${session.date} · [${session.source}] ${session.title}（${session.turns} 轮）`)
    }
    lines.push('')
  }

  if (docs.length) {
    lines.push('## 文档变更', '')
    for (const doc of docs) lines.push(`- ${doc.date} · ${doc.line}`)
    lines.push('')
  }

  lines.push('## 备注', '', '（可在 WorkLog 面板中补充本期总结）', '')
  return lines.join('\n')
}

function reportName(kind, key) {
  return `${kind}-${key}.md`
}

async function ensureDay(config, dateString) {
  const day = await getDay(config, dateString)
  if (day.exists) return day
  const archived = await archiveDay(config, dateString)
  if (!archived.created) return getDay(config, dateString)
  return getDay(config, dateString)
}

export async function generateReport(config, options = {}) {
  const kind = String(options.kind || 'daily')
  let key = localDate()
  let title = '日报'
  let subtitle = ''
  let dates = []

  if (kind === 'daily') {
    const dateString = options.date || localDate()
    key = dateString
    title = `${dateString} 日报`
    const day = await ensureDay(config, dateString)
    if (!day.exists) throw new Error(`没有 ${dateString} 的归档，请先归档`)
    const name = reportName('daily', key)
    const path = await writeReport(config, name, day.text)
    return { kind, key, name, path: path.path, text: day.text, ai: false }
  }

  if (kind === 'weekly') {
    const monday = options.monday ? mondayOf(options.monday) : mondayOf(options.date || localDate())
    key = monday
    dates = weekDates(monday)
    title = `周报（${dates[0]} ~ ${dates[dates.length - 1]}）`
    subtitle = `统计周期：${dates[0]} 至 ${dates[dates.length - 1]}`
  } else if (kind === 'month') {
    const month = options.month || currentMonth()
    key = month
    dates = monthDates(month)
    title = `${month} 月度总览`
    subtitle = `统计周期：${dates[0]} 至 ${dates[dates.length - 1]}`
  } else if (kind === 'quarter') {
    const quarter = options.quarter || currentQuarter()
    key = quarter
    dates = quarterDates(quarter)
    title = `${quarter} 季度复盘`
    subtitle = `统计周期：${dates[0]} 至 ${dates[dates.length - 1]}`
  } else if (kind === 'project') {
    const project = String(options.project || '').trim()
    if (!project) throw new Error('project 报告需要项目名')
    key = project.replace(/[\\/:*?"<>|]/g, '_')
    const allDays = await readDays(config, (await listDays(config)).map((day) => day.date))
    const filtered = allDays.filter((day) => day.text.includes(`### ${project}`))
    const draft = combineDays(filtered, `${project} 项目档案`, `基于 ${filtered.length} 天归档`)
    const name = reportName('project', key)
    const path = await writeReport(config, name, draft)
    return { kind, key, name, path: path.path, text: draft, days: filtered.length, ai: false }
  } else if (kind === 'perf') {
    const month = options.month || currentMonth()
    key = month
    dates = monthDates(month)
    const days = await readDays(config, dates)
    const base = combineDays(days, `${month} 绩效考核素材`, `统计周期：${dates[0]} 至 ${dates[dates.length - 1]}`)
    const draft = `${base}\n## 绩效自评草稿\n\n### 本月工作内容\n\n（从上方项目进展中提炼）\n\n### 主要产出\n\n（列出可量化结果）\n\n### 问题与解决\n\n（补充排查过程和结论）\n\n### 下月计划\n\n（列出 2-3 项）\n`
    const name = reportName('perf', key)
    const path = await writeReport(config, name, draft)
    return { kind, key, name, path: path.path, text: draft, days: days.length, ai: false }
  } else {
    throw new Error(`未知报告类型：${kind}`)
  }

  const days = await readDays(config, dates)
  const draft = combineDays(days, title, subtitle)
  let finalText = draft
  let ai = false
  if (options.useAi && config.ai.baseUrl && config.ai.model) {
    try {
      const polished = await aiComplete(
        config,
        '你是工作日志整理助手。请把给定的素材整理成结构清晰、可直接交付的中文周报/月报/季报。保留项目名、提交 hash 和关键数字，不要编造没有的事实。',
        draft,
      )
      finalText = polished.text
      ai = true
    } catch (error) {
      finalText = `${draft}\n## AI 润色失败\n\n${String(error?.message || error)}\n`
    }
  }
  const name = reportName(kind, key)
  const path = await writeReport(config, name, finalText)
  return { kind, key, name, path: path.path, text: finalText, days: days.length, ai }
}

export function aiEndpoint(baseUrl, apiFormat = 'openai') {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  return apiFormat === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`
}

export async function listAiModels({ baseUrl, apiFormat = 'openai', apiKey = '', timeoutMs = 15000 } = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('需要先填写 Base URL')
  const format = apiFormat === 'anthropic' ? 'anthropic' : 'openai'
  const url = format === 'anthropic' ? `${base}/v1/models` : `${base}/models`
  const headers = { accept: 'application/json' }
  const key = String(apiKey || '').trim()
  if (key) {
    if (format === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01'
      headers['x-api-key'] = key
      if (!/api\.anthropic\.com/i.test(base)) headers.authorization = `Bearer ${key}`
    } else {
      headers.authorization = `Bearer ${key}`
    }
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = {}
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${data?.error?.message || data?.message || text.slice(0, 200)}`)
  }
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []
  const models = rows
    .map((row) => (typeof row === 'string' ? row : row?.id || row?.name || ''))
    .map((id) => String(id || '').trim())
    .filter(Boolean)
  return [...new Set(models)].sort((a, b) => a.localeCompare(b))
}

function aiHeaders(config, baseUrl) {
  const apiKey = String(config.ai.apiKey || '').trim()
  const format = config.ai.apiFormat === 'anthropic' ? 'anthropic' : 'openai'
  if (format === 'anthropic') {
    const headers = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (apiKey) {
      headers['x-api-key'] = apiKey
      // Anthropic-compatible gateways (Zhipu/Z.ai, etc.) expect Bearer auth.
      if (!/api\.anthropic\.com/i.test(baseUrl)) headers.authorization = `Bearer ${apiKey}`
    }
    return headers
  }
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  }
}

function aiBody(config, system, user) {
  if (config.ai.apiFormat === 'anthropic') {
    return {
      model: config.ai.model,
      max_tokens: 4096,
      temperature: 0.3,
      system,
      messages: [{ role: 'user', content: user }],
    }
  }
  return {
    model: config.ai.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
  }
}

function aiResult(config, data) {
  if (config.ai.apiFormat === 'anthropic') {
    const content = Array.isArray(data?.content)
      ? data.content
          .filter((block) => block?.type === 'text' && block.text)
          .map((block) => block.text)
          .join('')
      : ''
    if (!content) throw new Error('AI 接口没有返回 content[].text')
    const usage = data.usage || null
    return {
      text: String(content).trim(),
      usage: usage
        ? {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          }
        : null,
    }
  }
  const content = data?.choices?.[0]?.message?.content
  if (!content) throw new Error('AI 接口没有返回 choices[0].message.content')
  return { text: String(content).trim(), usage: data.usage || null }
}

export async function aiComplete(config, system, user) {
  if (!config.ai.baseUrl || !config.ai.model) {
    throw new Error('还没有配置 AI 接口（baseUrl/model）')
  }
  const url = aiEndpoint(config.ai.baseUrl, config.ai.apiFormat)
  const response = await fetch(url, {
    method: 'POST',
    headers: aiHeaders(config, config.ai.baseUrl),
    body: JSON.stringify(aiBody(config, system, user)),
    signal: AbortSignal.timeout(180000),
  })
  const raw = await response.text()
  let data
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = { raw }
  }
  if (!response.ok) {
    throw new Error(`AI 接口 HTTP ${response.status}: ${data?.error?.message || data?.message || raw.slice(0, 300)}`)
  }
  const result = aiResult(config, data)
  if (result.usage) {
    await recordAiUsage(config, {
      kind: 'report',
      model: data.model || config.ai.model,
      in: result.usage.prompt_tokens || 0,
      out: result.usage.completion_tokens || 0,
      total: result.usage.total_tokens || 0,
    })
  }
  return result
}

export async function askArchive(config, question, { useAi = true } = {}) {
  const q = String(question || '').trim()
  if (!q) throw new Error('问题不能为空')
  const hits = await searchDays(config, q)
  const refs = hits.slice(0, 5).map((hit) => hit.date)
  if (!useAi || !config.ai.baseUrl || !config.ai.model) {
    return {
      answer: hits.length
        ? `在本地归档中找到 ${hits.length} 个相关日期：\n\n${hits.map((hit) => `- ${hit.date}（${hit.count} 处）：${hit.snippet}`).join('\n')}`
        : '本地归档里没有找到相关记录。',
      refs,
      ai: false,
    }
  }

  const excerpts = []
  for (const dateString of refs) {
    const day = await getDay(config, dateString)
    if (day.exists) excerpts.push(`## ${dateString}\n\n${day.text.slice(0, 6000)}`)
  }
  const prompt = `问题：${q}\n\n以下是本地工作日志摘录，请只依据这些内容回答；如果材料不足，直接说明。\n\n${excerpts.join('\n\n')}`
  const result = await aiComplete(
    config,
    '你是工作日志问答助手。回答要简洁、有依据，引用日期和项目名；不要编造不存在的记录。',
    prompt,
  )
  return { answer: result.text, refs, ai: true, usage: result.usage }
}

export function summarizeAiUsage(entries = []) {
  const totals = { calls: 0, in: 0, out: 0, total: 0 }
  const byModel = new Map()
  for (const entry of entries) {
    const input = Number(entry.in || 0)
    const output = Number(entry.out || 0)
    const total = Number(entry.total || input + output)
    totals.calls += 1
    totals.in += input
    totals.out += output
    totals.total += total
    const model = entry.model || '(unknown)'
    if (!byModel.has(model)) byModel.set(model, { model, calls: 0, in: 0, out: 0, total: 0 })
    const bucket = byModel.get(model)
    bucket.calls += 1
    bucket.in += input
    bucket.out += output
    bucket.total += total
  }
  return { ...totals, byModel: [...byModel.values()] }
}

export { combineDays, parseDaySections, reportName }
