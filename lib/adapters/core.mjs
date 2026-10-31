/** Shared HTTP helper for connectors: timeout + readable errors. */
export async function fetchJson(url, options = {}, timeoutMs = 20000) {
  let response
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error('网络请求失败：' + String(error?.message || error))
  }
  const raw = await response.text()
  let data
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = { raw }
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || data?.raw || ''
    throw new Error('HTTP ' + response.status + (message ? '：' + String(message).slice(0, 200) : ''))
  }
  return data
}

export function firstPage(base, params = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  }
  const text = query.toString()
  return text ? base + (base.includes('?') ? '&' : '?') + text : base
}
