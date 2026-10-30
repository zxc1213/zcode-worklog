/**
 * Detect AI endpoints that are already configured on this machine.
 *
 * Detection is read-only and never leaves the local process: the panel asks
 * for candidates, then applies one by writing the chosen base URL / model /
 * key into this plugin's own config. Keys are never returned to the panel.
 */
import { readdirSync, readFileSync } from 'node:fs'
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
  const models = [...new Set((Array.isArray(input.models) ? input.models : [input.model])
    .map((model) => String(model || '').trim())
    .filter(Boolean))]
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
    models,
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
    const modelsMap = provider.models && typeof provider.models === 'object' ? provider.models : {}
    const modelKey = Object.keys(modelsMap)[0] || ''
    const model = String(modelsMap[modelKey]?.name || modelKey || '').trim()
    const modelNames = Object.entries(modelsMap).map(([id, entry]) =>
      String(entry?.name || id || '').trim(),
    )
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
        models: modelNames,
        apiKey: encrypted ? '' : rawKey,
        note: notes.join('；'),
        rank: chosen && usableKey ? 0 : provider.enabled === false ? 2 : usableKey ? 1 : 3,
      }),
    )
  }
  return out.sort((a, b) => a.rank - b.rank)
}

// Minimal YAML reader for dsh's settings/credentials files: handles nested
// mappings, sequences of mappings and quoted scalars, which is all `llm-pi-ai`
// and `refs` use. Not a general YAML parser.
export function parseYamlLite(text) {
  const lines = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---') continue
    lines.push({ indent: raw.match(/^\s*/)[0].length, content: trimmed })
  }

  let pos = 0
  const parseScalar = (value) => {
    let textValue = value
    if (
      (textValue.startsWith('"') && textValue.endsWith('"')) ||
      (textValue.startsWith("'") && textValue.endsWith("'"))
    ) {
      return textValue.slice(1, -1)
    }
    const comment = textValue.indexOf(' #')
    if (comment >= 0) textValue = textValue.slice(0, comment).trim()
    if (textValue === 'true') return true
    if (textValue === 'false') return false
    if (textValue === 'null' || textValue === '~') return null
    if (/^-?\d+(?:\.\d+)?$/.test(textValue)) return Number(textValue)
    return textValue
  }

  const parseBlock = (indent) => {
    if (pos >= lines.length) return null
    return lines[pos].content.startsWith('- ') ? parseSeq(indent) : parseMap(indent)
  }

  const parseMap = (indent) => {
    const node = {}
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].content.startsWith('- ')) {
      const content = lines[pos].content
      const colon = content.indexOf(':')
      pos += 1
      if (colon < 0) continue
      const key = content.slice(0, colon).trim()
      const value = content.slice(colon + 1).trim()
      if (!key) continue
      if (value) node[key] = parseScalar(value)
      else if (pos < lines.length && lines[pos].indent > indent) node[key] = parseBlock(lines[pos].indent)
      else node[key] = {}
    }
    return node
  }

  const parseSeq = (indent) => {
    const node = []
    while (pos < lines.length && lines[pos].indent === indent && lines[pos].content.startsWith('- ')) {
      const content = lines[pos].content.slice(2).trim()
      pos += 1
      const colon = content.indexOf(':')
      if (colon > 0) {
        const item = {}
        const key = content.slice(0, colon).trim()
        const value = content.slice(colon + 1).trim()
        item[key] = value ? parseScalar(value) : {}
        if (pos < lines.length && lines[pos].indent > indent) {
          const more = parseBlock(lines[pos].indent)
          if (Array.isArray(more)) item[key] = more
          else if (more && typeof more === 'object') Object.assign(item, more)
        }
        node.push(item)
      } else {
        node.push(parseScalar(content))
        if (pos < lines.length && lines[pos].indent > indent) parseBlock(lines[pos].indent)
      }
    }
    return node
  }

  const root = parseBlock(lines[0]?.indent ?? 0)
  return root && typeof root === 'object' ? root : {}
}

function readDshSettings(dshHome) {
  const empty = { providers: null, defaultProvider: '', defaultModelId: '' }
  const pluginEntries = (parsed) => {
    const roots = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.plugins)
        ? parsed.plugins
        : []
    const out = []
    const walk = (items) => {
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        if (Array.isArray(item.insert)) walk(item.insert)
        if (item.id) out.push(item)
      }
    }
    walk(roots)
    return out
  }

  // dsh >= 0.2 keeps providers in the active profile's cordis config.
  let profiles = []
  try {
    profiles = readdirSync(join(dshHome, 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    profiles = []
  }
  const order = (name) => ['web', 'headless', 'acp'].indexOf(name)
  profiles.sort((a, b) => {
    const rankA = order(a)
    const rankB = order(b)
    if (rankA !== rankB) return (rankA < 0 ? 99 : rankA) - (rankB < 0 ? 99 : rankB)
    return a.localeCompare(b)
  })
  for (const name of profiles) {
    for (const file of ['cordis.patch.yml', 'cordis.yml']) {
      const text = readText(join(dshHome, 'profiles', name, file))
      if (!text) continue
      const entries = pluginEntries(parseYamlLite(text))
      const llm = entries.find((entry) => entry?.id === 'llm-pi-ai' && entry?.config?.providers)
      if (!llm) continue
      const defaults = entries.find((entry) => entry?.id === 'agent-default-model')?.config || {}
      return {
        providers: llm.config.providers,
        defaultProvider: String(defaults.provider || '').trim(),
        defaultModelId: String(defaults.model || '').trim(),
        source: `~/.dsh/profiles/${name}/${file}`,
      }
    }
  }

  // Older dsh stores the same blocks as top-level settings keys.
  const settingsText =
    readText(join(dshHome, 'settings.yaml')) || readText(join(dshHome, 'settings-legacy.yaml'))
  if (!settingsText) return empty
  const settings = parseYamlLite(settingsText)
  const providers = settings['llm-pi-ai']?.providers
  if (!providers || typeof providers !== 'object') return empty
  const defaultModel = settings['agent-default-model'] || {}
  return {
    providers,
    defaultProvider: String(defaultModel.provider || '').trim(),
    defaultModelId: String(defaultModel.model || '').trim(),
    source: '~/.dsh/settings-legacy.yaml',
  }
}

function dshCandidates(home, env) {
  const dshHome = String(env.DSH_HOME || '').trim() || join(home, '.dsh')
  const settings = readDshSettings(dshHome)
  const providers = settings.providers
  if (!providers || typeof providers !== 'object') return []

  const credentials = parseYamlLite(readText(join(dshHome, '.credentials.yaml')) || '')
  const refs = credentials.refs && typeof credentials.refs === 'object' ? credentials.refs : {}
  const defaultProvider = settings.defaultProvider
  const defaultModelId = settings.defaultModelId

  const out = []
  for (const [id, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object') continue
    const baseUrl = String(provider.baseURL || '').trim()
    if (!baseUrl) continue
    const api = String(provider.api || '').trim()
    const apiFormat = api === 'anthropic-messages' ? 'anthropic' : 'openai'
    const apiKeyEnv = String(provider.apiKeyEnv || '').trim()
    const rawKey = String(
      provider.apiKey || (apiKeyEnv ? refs[apiKeyEnv] : '') || (apiKeyEnv ? env[apiKeyEnv] : '') || '',
    ).trim()
    const usable = Boolean(rawKey) && !rawKey.startsWith('{') && !rawKey.startsWith('enc:')
    const models = Array.isArray(provider.models) ? provider.models : []
    const modelIds = models
      .map((model) => String(model?.id || model?.name || '').trim())
      .filter(Boolean)
    const model =
      defaultProvider === id && modelIds.includes(defaultModelId) ? defaultModelId : modelIds[0] || ''
    const notes = []
    if (defaultProvider === id) notes.push('DeepSeek Harness 默认供应商')
    if (apiKeyEnv && !usable) notes.push(`缺少 ${apiKeyEnv}`)
    if (api && api !== 'openai-completions' && api !== 'anthropic-messages') {
      notes.push(`接口类型 ${api}，按 OpenAI 兼容处理`)
    }
    out.push(
      makeCandidate({
        id: `dsh:${id}`,
        source: 'deepseek-harness',
        sourceLabel: 'DeepSeek Harness',
        name: String(provider.displayName || id),
        baseUrl,
        model,
        apiFormat,
        models: modelIds,
        apiKey: usable ? rawKey : '',
        note: notes.join('；'),
        rank: defaultProvider === id && usable ? 1 : usable ? 4 : 6,
      }),
    )
  }

  const deepseekKey = String(refs.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || '').trim()
  if (deepseekKey && !deepseekKey.startsWith('{') && !deepseekKey.startsWith('enc:')) {
    out.push(
      makeCandidate({
        id: 'dsh:deepseek-api',
        source: 'deepseek-harness',
        sourceLabel: 'DeepSeek Harness',
        name: 'DeepSeek API（DEEPSEEK_API_KEY）',
        baseUrl: String(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim(),
        model: 'deepseek-chat',
        apiFormat: 'openai',
        apiKey: deepseekKey,
        note: '来自 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY',
        rank: 5,
      }),
    )
  }
  return out
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
    ...dshCandidates(home, env),
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
