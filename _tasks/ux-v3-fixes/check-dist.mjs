import { readFileSync } from 'node:fs'
const decode = (text) => text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
const server = decode(readFileSync('E:/AI_Project/research/zcode-worklog/dist/server.mjs', 'utf8'))
console.log('server 摘录尚未同步(应 true):', server.includes('摘录尚未同步'))
console.log('server 请先同步会话(应 true):', server.includes('请先同步会话'))
const hook = decode(readFileSync('E:/AI_Project/research/zcode-worklog/dist/session-start.mjs', 'utf8'))
let idx = hook.indexOf('归档今天')
while (idx >= 0) {
  console.log('hook 归档今天 context:', JSON.stringify(hook.slice(idx - 30, idx + 30)))
  idx = hook.indexOf('归档今天', idx + 1)
}
