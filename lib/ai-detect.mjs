/**
 * Detect AI endpoints that are already configured on this machine.
 *
 * Detection is read-only and never leaves the local process: the panel asks
 * for candidates, then applies one by writing the chosen base URL / model /
 * key into this plugin's own config. Keys are never returned to the panel.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function maskKey(value) {
  const key = String(value || '').trim()
  if (!key) return ''
  if (key.length <= 10) return `${key.slice(0, 2)}…`
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

function makeCandidate(input) {
  const apiKey = String(input.apiKey || '').trim()
  return {
    id: String(input.id),
    source: String(input.source || 'local'),
    sourceLabel: String(input.sourceLabel || input.source || '本地配置'),
    name: String(input.name || input.sourceLabel || ''),
    baseUrl: String(input.baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(input.model || '').trim(),
    apiFormat: input.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
    note: String(input.note || ''),
    rank: Number(input.rank || 0),
    apiKey,
  }
}

export function publicCandidate(candidate) {
  if (!candidate) return null
  const { apiKey, rank, ...rest } = candidate
  return {
    ...rest,
    hasKey: Boolean(apiKey),
    keyHint: maskKey(apiKey),
  }
}

// Minimal TOML reader for the few Codex keys we need; not a general parser.
export function parseTomlLite(text) {
  const root = {}
  let current = root
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const section = /^\[([^\]]+)\]$/.exec(line)
    if (section) {
      current = root
      for (const rawPart of section[1].split('.')) {
        const part = rawPart.trim().replace(/^["']|["']$/g, '')
        if (!part) continue
        if (typeof current[part] !== 'object' || current[part] === null) current[part] = {}
        current = current[part]
      }
      continue
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line)
    if (!kv) continue
    let value = kv[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (value.startsWith('[')) continue
    current[kv[1]] = value
  }
  return root
}

function zcodeCandidates(home) {
  const config = readJson(join(home, '.zcode', 'v2', 'config.json'))
  const providers = config?.provider
  if (!providers || typeof providers !== 'object') return []
  const settings = readJson(join(home, '.zcode', 'v2', 'setting.json')) || {}
  const selected = Object.values(settings.modelProviderFamilySelectedKeys || {}).map(String)
  const isSelected = (key) => selected.some((value) => value === key || value.endsWith(`:${key}`))

  const out = []
  for (const [key, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object') continue
    const options = provider.options || {}
    const baseUrl = String(options.baseURL || options.baseUrl || '').trim()
    if (!baseUrl) continue
    const apiFormat =
      provider.kind === 'anthropic' ? 'anthropic' : provider.kind === 'openai' ? 'openai' : ''
    if (!apiFormat) continue
    const models = provider.models && typeof provider.models === 'object' ? provider.models : {}
    const modelKey = Object.keys(models)[0] || ''
    const model = String(models[modelKey]?.name || modelKey || '').trim()
    const chosen = isSelected(key)
    const rawKey = String(options.apiKey || '').trim()
    const encrypted = rawKey.startsWith('enc:v1:')
    const usableKey = Boolean(rawKey) && !encrypted
    const notes = []
    if (chosen) notes.push('ZCode 当前选择的供应商')
    if (provider.enabled === false) notes.push('在 ZCode 中未启用')
    if (encrypted) notes.push('OAuth 凭据已加密，无法复用 Key，请手动填写')
    else if (!rawKey) notes.push('没有可复用的 API Key')
    out.push(
      makeCandidate({
        id: `zcode:${key}`,
        source: 'zcode',
        sourceLabel: 'ZCode',
        name: provider.name || key,
        baseUrl,
        model,
        apiFormat,
        apiKey: encrypted ? '' : rawKey,
        note: notes.join('；'),
        rank: chosen && usableKey ? 0 : provider.enabled === false ? 2 : usableKey ? 1 : 3,
      }),
    )
  }
  return out.sort((a, b) => a.rank - b.rank)
}

function claudeCandidates(home) {
  const settings = readJson(join(home, '.claude', 'settings.json'))
  const env = settings?.env
  if (!env || typeof env !== 'object') return []
  const baseUrl = String(env.ANTHROPIC_BASE_URL || '').trim()
  const apiKey = String(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '').trim()
  const model = String(
    env.ANTHROPIC_MODEL ||
      env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
      env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
      '',
  ).trim()
  if (!baseUrl && !apiKey) return []
  return [
    makeCandidate({
      id: 'claude-code',
      source: 'claude-code',
      sourceLabel: 'Claude Code',
      name: 'Claude Code settings.json',
      baseUrl: baseUrl || 'https://api.anthropic.com',
      model,
      apiFormat: 'anthropic',
      apiKey,
      note: '来自 ~/.claude/settings.json 的 ANTHROPIC_* 环境变量',
      rank: 3,
    }),
  ]
}

function codexCandidates(home, env) {
  const text = readText(join(home, '.codex', 'config.toml'))
  if (!text) return []
  const toml = parseTomlLite(text)
  const auth = readJson(join(home, '.codex', 'auth.json')) || {}
  const providerId = String(toml.model_provider || '').trim()
  const providers = toml.model_providers && typeof toml.model_providers === 'object' ? toml.model_providers : {}
  const provider = (providerId && providers[providerId]) || providers.openai || {}
  const envKey = String(provider.env_key || '').trim()
  const apiKey = String(auth.OPENAI_API_KEY || (envKey ? env[envKey] : '') || env.OPENAI_API_KEY || '').trim()
  if (!apiKey) return []
  const baseUrl = String(provider.base_url || env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim()
  const wire = String(provider.wire_api || '').trim()
  return [
    makeCandidate({
      id: 'codex',
      source: 'codex',
      sourceLabel: 'Codex CLI',
      name: providerId ? `Codex · ${providerId}` : 'Codex CLI',
      baseUrl,
      model: String(toml.model || '').trim(),
      apiFormat: 'openai',
      apiKey,
      note:
        wire === 'responses'
          ? 'Codex 使用 Responses API；若该端点不支持 chat/completions，润色会失败'
          : '来自 ~/.codex/config.toml 与 auth.json',
      rank: 4,
    }),
  ]
}

function geminiCandidates(home, env) {
  const dotenv = readText(join(home, '.gemini', '.env')) || ''
  const dotenvKey = /^\s*GEMINI_API_KEY\s*=\s*(.+)$/m.exec(dotenv)?.[1]?.trim().replace(/^["']|["']$/g, '')
  const apiKey = String(env.GEMINI_API_KEY || dotenvKey || '').trim()
  if (!apiKey) return []
  const settings = readJson(join(home, '.gemini', 'settings.json')) || {}
  return [
    makeCandidate({
      id: 'gemini-cli',
      source: 'gemini-cli',
      sourceLabel: 'Gemini CLI',
      name: 'Gemini CLI',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: String(settings.model || 'gemini-2.5-flash').trim(),
      apiFormat: 'openai',
      apiKey,
      note: '来自 GEMINI_API_KEY（OpenAI 兼容端点）',
      rank: 5,
    }),
  ]
}

function envCandidates(env) {
  const out = []
  if (env.OPENAI_API_KEY) {
    out.push(
      makeCandidate({
        id: 'env:openai',
        source: 'env',
        sourceLabel: '环境变量',
        name: 'OPENAI_API_KEY',
        baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        model: env.OPENAI_MODEL || 'gpt-4o-mini',
        apiFormat: 'openai',
        apiKey: env.OPENAI_API_KEY,
        note: '来自当前进程环境变量',
        rank: 6,
      }),
    )
  }
  if (env.ANTHROPIC_API_KEY) {
    out.push(
      makeCandidate({
        id: 'env:anthropic',
        source: 'env',
        sourceLabel: '环境变量',
        name: 'ANTHROPIC_API_KEY',
        baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
        apiFormat: 'anthropic',
        apiKey: env.ANTHROPIC_API_KEY,
        note: '来自当前进程环境变量',
        rank: 6,
      }),
    )
  }
  return out
}

export function detectAiCandidates(options = {}) {
  const home = options.home || homedir()
  const env = options.env || process.env
  const all = [
    ...zcodeCandidates(home),
    ...claudeCandidates(home),
    ...codexCandidates(home, env),
    ...geminiCandidates(home, env),
    ...envCandidates(env),
  ]
  const seen = new Set()
  const unique = []
  for (const item of all) {
    const fingerprint = [item.baseUrl, item.apiFormat, item.model, item.apiKey].join('|')
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    unique.push(item)
  }
  return unique.sort((a, b) => a.rank - b.rank)
}

export function findAiCandidate(id, options = {}) {
  const wanted = String(id || '').trim()
  if (!wanted) return null
  return detectAiCandidates(options).find((item) => item.id === wanted) || null
}
