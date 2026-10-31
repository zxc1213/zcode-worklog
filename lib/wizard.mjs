/**
 * AI tool configuration wizard (server side): probe a tool type (and an
 * optional location hint) and return its detected configuration details —
 * models, endpoint, key presence — without ever returning key plaintext.
 * Applying a candidate reuses the existing ai apply path in src/api.mjs.
 */
import { statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { detectAiCandidates, publicCandidate } from './ai-detect.mjs'

const TYPE_MATCHERS = {
  zcode: (id) => id.startsWith('zcode:'),
  dsh: (id) => id.startsWith('dsh:'),
  claude: (id) => id === 'claude-code',
  codex: (id) => id === 'codex',
  gemini: (id) => id === 'gemini-cli',
}

export const WIZARD_TYPES = [
  { type: 'claude', title: 'Claude Code', hint: 'settings.json 位置，默认 ~/.claude' },
  { type: 'codex', title: 'Codex CLI', hint: 'config.toml 位置，默认 ~/.codex' },
  { type: 'dsh', title: 'DeepSeek Harness', hint: 'profiles 目录，默认 ~/.dsh' },
  { type: 'zcode', title: 'ZCode', hint: 'v2 config 位置，默认 ~/.zcode' },
  { type: 'gemini', title: 'Gemini CLI', hint: '环境变量探测，无需位置' },
  { type: 'custom', title: '自定义会话目录', hint: '本机会话文件目录，探测文件数' },
]

async function countFiles(root, depth = 0, cap = 2000) {
  if (depth > 3) return 0
  let count = 0
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      count += await countFiles(full, depth + 1, cap - count)
    } else if (entry.isFile()) {
      count += 1
    }
    if (count >= cap) return cap
  }
  return count
}

/**
 * Probe one AI tool type (plus optional location hint). Never returns key
 * plaintext; key details come back as hasKey/keyHint from publicCandidate.
 */
export async function probeAiTool(options = {}) {
  const toolType = String(options.type || '').trim()
  const location = String(options.location || '').trim()
  if (toolType === 'custom') {
    if (!location) throw new Error('自定义类型需要填写位置')
    let info
    try {
      info = statSync(location)
    } catch {
      return { ok: false, type: toolType, location, error: '路径不存在或不可访问' }
    }
    if (!info.isDirectory()) {
      return { ok: false, type: toolType, location, error: '需要的是一个目录' }
    }
    const fileCount = await countFiles(location)
    return {
      ok: true,
      type: toolType,
      location,
      custom: {
        fileCount,
        note:
          fileCount > 0
            ? '可作为自定义会话来源；应用后请把该路径加入 设置→数据与扫描→会话目录（每行一个）'
            : '目录里没有文件，请确认路径',
      },
    }
  }

  const matcher = TYPE_MATCHERS[toolType]
  if (!matcher) throw new Error('未知 AI 工具类型：' + toolType)
  const candidates = detectAiCandidates().filter((candidate) => matcher(candidate.id))
  if (!candidates.length) {
    return { ok: false, type: toolType, location, error: '本机没有探测到该工具的配置' }
  }
  const filtered = location
    ? candidates.filter(
        (candidate) =>
          String(candidate.baseUrl || '').includes(location) ||
          String(candidate.name || '').includes(location) ||
          String(candidate.sourceLabel || '').includes(location),
      )
    : candidates
  const list = filtered.length ? filtered : candidates
  return {
    ok: true,
    type: toolType,
    location,
    hint: filtered.length ? '' : '指定位置没有精确匹配，已返回该类型全部候选',
    candidates: list.map(publicCandidate).map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      sourceLabel: candidate.sourceLabel,
      baseUrl: candidate.baseUrl,
      model: candidate.model,
      apiFormat: candidate.apiFormat,
      modelsCount: (candidate.models || []).length,
      hasKey: candidate.hasKey,
      keyHint: candidate.keyHint,
      note: candidate.note,
    })),
  }
}
