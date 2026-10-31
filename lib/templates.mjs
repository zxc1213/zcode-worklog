/**
 * Prompt template system (REQ-D1): every AI call site resolves its prompt
 * through a scene template. User overrides live in data/templates/<scene>.md
 * (frontmatter + "### SYSTEM" / "### USER" sections); scenes without a user
 * file fall back to the builtin text, so behavior only changes when the user
 * actually edits something.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { localDate, localTime } from './config.mjs'

const SECTION_MARK = '### '
const MAX_USER_FILE = 64 * 1024

export const SCENES = [
  { scene: 'report', name: '报告润色', kind: 'report', hint: '周报/月报/季报的 AI 润色' },
  { scene: 'ask', name: '日志问答', kind: 'ask', hint: 'worklog_ask 的回答口径' },
  { scene: 'todo-parse', name: '待办解析', kind: 'todo', hint: 'AI 填单/批量解析' },
  { scene: 'todo-suggest', name: '每日三件事', kind: 'todo', hint: '今日 3 件要事' },
  { scene: 'summarize', name: '自由总结', kind: 'summarize', hint: '对任意范围内容的总结' },
]

export function templatesDir(config) {
  return join(config.dataDir, 'templates')
}

function templateFile(config, scene) {
  return join(templatesDir(config), scene + '.md')
}

function validScene(scene) {
  return SCENES.some((item) => item.scene === scene)
}

export function builtinTemplate(scene) {
  return BUILTINS[scene] || null
}

function parseTemplateFile(text) {
  let frontmatter = {}
  let body = String(text || '')
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const idx = line.indexOf(':')
      if (idx > 0) frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
    body = body.slice(match[0].length)
  }
  const system = []
  const user = []
  let target = user
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === '### SYSTEM') {
      target = system
      continue
    }
    if (line.trim() === '### USER') {
      target = user
      continue
    }
    target.push(line)
  }
  return {
    name: frontmatter.name || '',
    system: system.join('\n').trim(),
    user: user.join('\n').trim(),
  }
}

function readTemplateFile(config, scene) {
  const file = templateFile(config, scene)
  if (!existsSync(file)) return null
  try {
    return parseTemplateFile(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Resolve a scene to concrete {name, system, user, source}. User file wins,
 * builtin fills any missing section, unknown scene throws.
 */
export function resolveTemplate(config, scene) {
  if (!validScene(scene)) throw new Error('未知模板场景：' + scene)
  const builtin = builtinTemplate(scene) || { name: '', system: '', user: '{{content}}' }
  const custom = readTemplateFile(config, scene)
  if (!custom) return { scene, name: builtin.name, system: builtin.system, user: builtin.user, source: 'builtin' }
  return {
    scene,
    name: custom.name || builtin.name,
    system: custom.system || builtin.system,
    user: custom.user || builtin.user,
    source: 'user',
  }
}

/** Replace {{var}} placeholders; missing vars become empty strings. */
export function renderTemplate(text, vars = {}) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (all, key) => {
    const value = vars[key]
    if (value === undefined || value === null) return ''
    return String(value)
  })
}

export function render(config, scene, vars = {}) {
  const resolved = resolveTemplate(config, scene)
  return {
    scene: resolved.scene,
    name: resolved.name,
    source: resolved.source,
    system: renderTemplate(resolved.system, vars),
    user: renderTemplate(resolved.user, vars),
  }
}

export function listTemplates(config) {
  return SCENES.map((item) => {
    const resolved = resolveTemplate(config, item.scene)
    return {
      scene: item.scene,
      name: resolved.name,
      hint: item.hint,
      kind: item.kind,
      source: resolved.source,
      system: resolved.system,
      user: resolved.user,
    }
  })
}

export async function saveTemplate(config, scene, { name, system, user } = {}) {
  if (!validScene(scene)) throw new Error('未知模板场景：' + scene)
  const body =
    '---\n' +
    'scene: ' + scene + '\n' +
    'name: ' + String(name || SCENES.find((s) => s.scene === scene)?.name || scene) + '\n' +
    '---\n\n' +
    '### SYSTEM\n' + String(system || '') + '\n\n' +
    '### USER\n' + String(user || '')
  await mkdir(templatesDir(config), { recursive: true })
  await writeFile(templateFile(config, scene), body, 'utf8')
  return resolveTemplate(config, scene)
}

export async function resetTemplate(config, scene) {
  if (!validScene(scene)) throw new Error('未知模板场景：' + scene)
  try {
    await unlink(templateFile(config, scene))
  } catch {
    /* already absent */
  }
  return resolveTemplate(config, scene)
}

const BUILTINS = {
  report: {
    name: '报告润色',
    system: [
      '你是工作日志整理助手。请把给定的素材整理成结构清晰、可直接交付的中文周报/月报/季报。',
      '保留项目名、提交 hash 和关键数字，不要编造没有的事实。',
    ].join('\n'),
    user: '{{content}}',
  },
  ask: {
    name: '日志问答',
    system: [
      '你是工作日志问答助手。回答要简洁、有依据，引用日期和项目名；不要编造不存在的记录。',
    ].join('\n'),
    user: ['问题：{{question}}', '', '以下是本地工作日志摘录，请只依据这些内容回答；如果材料不足，直接说明。', '', '{{content}}'].join('\n'),
  },
  'todo-parse': {
    name: '待办解析',
    system: [
      '你是待办解析助手。把用户文本解析成待办 JSON，只输出 JSON，不要输出其他文字。',
      '格式：{"todos":[{"title":"一句话标题","pri":"高|中|低或空","due":"YYYY-MM-DD或空","repeat":"daily|weekly:0-6|monthly:1-28或空","tags":["标签"]}]}',
      '今天是 {{today}}（{{weekday}}）。时间规则：周五→最近的周五、下周一→下周、月底→本月最后一天、N天后→今天+N；没有时间信息 due 留空。',
      '每天/每日→daily；每周X→weekly:X（0=周日）；每月X号→monthly:X（1-28）。',
      '紧急/尽快/马上→高；不急/有空时→低；#词 提取为 tags（去掉#号）。',
      'title 不要包含日期、优先级、#标签记号。',
      '{{modeHint}}',
      '只依据文本内容，不要编造。',
    ].join('\n'),
    user: '{{text}}',
  },
  'todo-suggest': {
    name: '每日三件事',
    system: [
      '你是每日计划助手。从待办列表中选出今天最值得做的 3 件要事，只输出 JSON：{"picks":[{"id":"待办id","reason":"一句话理由"}]}。',
      '选择规则：逾期且顺延次数多的优先，其次高优先级，再次到期日临近；理由要具体到待办内容。',
      '只输出 JSON，不要输出其他文字。',
    ].join('\n'),
    user: '{{content}}',
  },
  summarize: {
    name: '自由总结',
    system: [
      '你是工作总结助手。基于给定材料写一份结构化总结：先一句话结论，再分「主要进展」「待跟进」「风险」三段。',
      '保留具体项目名、数字与日期，不要编造材料里没有的内容。',
    ].join('\n'),
    user: ['总结范围：{{rangeStart}} 至 {{rangeEnd}}', '', '待办完成情况：{{todos}}', '', '材料：', '{{content}}'].join('\n'),
  },
}
