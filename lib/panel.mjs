/**
 * Compose the self-contained panel document.
 *
 * The ZCode plugin sandbox serves only the HTML resource returned by the MCP
 * server; it does not resolve sibling `ui://` subresources. Inlining the
 * script and stylesheet keeps the panel working without any host-specific
 * resource loading or external application.
 */

const STYLE_SLOT = '<!-- ZCODE_WORKLOG_STYLE -->'
const SCRIPT_SLOT = '<!-- ZCODE_WORKLOG_SCRIPT -->'

function escapeStyle(css) {
  return String(css).replace(/<\/style/gi, '<\\/style')
}

function escapeScript(js) {
  return String(js).replace(/<\/script/gi, '<\\/script')
}

export function composePanelHtml(html, css, js) {
  const style = `<style>\n${escapeStyle(css)}\n</style>`
  const script = `<script>\n${escapeScript(js)}\n</script>`
  let out = String(html)

  // Use function replacements: the bundle contains `$&`/`$'`-like sequences
  // that String.replace would otherwise expand.
  if (out.includes(STYLE_SLOT)) out = out.replace(STYLE_SLOT, () => style)
  else if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, () => `${style}\n</head>`)

  if (out.includes(SCRIPT_SLOT)) out = out.replace(SCRIPT_SLOT, () => script)
  else if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, () => `${script}\n</body>`)

  return out
}

export { STYLE_SLOT, SCRIPT_SLOT }
