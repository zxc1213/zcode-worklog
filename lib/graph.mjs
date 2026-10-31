/**
 * Knowledge graph (REQ-O3), rule-extracted and explainable: entities
 * (project/person/tool/topic/source) with relations derived from the unified
 * entries and todos. Deterministic full rebuild, incremental cost is low
 * (entries cap at 20k). Stored in data/graph.json.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadTodos } from './store.mjs'  // kept for future todo-topic links
import { loadEntries } from './entries.mjs'

const MAX_NODES = 2000
const MAX_EDGES = 5000

function graphFile(config) {
  return join(config.dataDir, 'graph.json')
}

export async function loadGraph(config) {
  try {
    const parsed = JSON.parse(await readFile(graphFile(config), 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.nodes && parsed.edges) return parsed
  } catch {
    /* fresh graph */
  }
  return { nodes: {}, edges: [], builtAt: '' }
}

export async function saveGraph(config, graph) {
  await mkdir(dirname(graphFile(config)), { recursive: true })
  await writeFile(graphFile(config), JSON.stringify(graph, null, 2) + '\n', 'utf8')
  return graph
}

function addNode(graph, id, type, label, weight = 1) {
  const key = type + ':' + String(label || id).slice(0, 60)
  const node = graph.nodes[key]
  if (node) {
    node.weight += weight
    return key
  }
  graph.nodes[key] = { type, label: String(label || id).slice(0, 60), weight }
  return key
}

function addEdge(graph, from, to, kind) {
  const edge = graph.edges.find((item) => item.from === from && item.to === to && item.kind === kind)
  if (edge) edge.count += 1
  else graph.edges.push({ from, to, kind, count: 1 })
}

/**
 * Deterministic rebuild from entries + todos.
 * Sources: person<-git entry tags[0]; tool<-session entry tags[0];
 * topic<-any entry tag / todo tag; source<-connector entry.source.
 */
export async function rebuildGraph(config) {
  const graph = { nodes: {}, edges: [], builtAt: new Date().toISOString() }
  const entries = await loadEntries(config)

  const ensurePerson = (name) => addNode(graph, '', 'person', name)
  const ensureProject = (name) => addNode(graph, '', 'project', name)
  const ensureTool = (name) => addNode(graph, '', 'tool', name)
  const ensureTopic = (name) => addNode(graph, '', 'topic', name)
  const ensureSource = (name) => addNode(graph, '', 'source', name)

  for (const entry of entries) {
    const project = entry.project
    const projectKey = project ? ensureProject(project) : ''
    if (entry.source === 'git') {
      const author = (entry.tags || [])[0]
      if (author) {
        const personKey = ensurePerson(author)
        if (projectKey) addEdge(graph, personKey, projectKey, '提交了')
      }
    }
    if (entry.source === 'sessions') {
      const toolLabel = (entry.tags || [])[0] || 'AI'
      const toolKey = ensureTool(toolLabel)
      if (projectKey) addEdge(graph, toolKey, projectKey, '用于')
      else addNode(graph, '', 'tool', toolLabel)
    }
    if (['zentao', 'feishu', 'generic'].includes(entry.source)) {
      const sourceKey = ensureSource(entry.source)
      if (projectKey) addEdge(graph, sourceKey, projectKey, '提供')
    }    for (const tag of (entry.tags || []).slice(1)) {
      const topicKey = ensureTopic(tag)
      if (projectKey) addEdge(graph, topicKey, projectKey, '出现于')
    }
  }


  // cap and drop isolated nodes
  graph.edges = graph.edges.slice(0, MAX_EDGES)
  const connected = new Set()
  for (const edge of graph.edges) {
    connected.add(edge.from)
    connected.add(edge.to)
  }
  for (const key of Object.keys(graph.nodes)) {
    if (!connected.has(key)) {
      const node = graph.nodes[key]
      const standalone = node.type === 'person' || node.type === 'tool' || node.type === 'source'
      if (!standalone) delete graph.nodes[key]
    }
  }
  const keys = Object.keys(graph.nodes).slice(0, MAX_NODES)
  graph.nodes = Object.fromEntries(keys.map((key) => [key, graph.nodes[key]]))
  await saveGraph(config, graph)
  return { nodes: Object.keys(graph.nodes).length, edges: graph.edges.length }
}

/** Neighbors of one entity (or the whole graph overview when no entity). */
export async function queryGraph(config, entity = '') {
  const graph = await loadGraph(config)
  if (!entity) {
    const types = {}
    for (const [key, node] of Object.entries(graph.nodes)) {
      types[node.type] = (types[node.type] || 0) + 1
    }
    const nodes = Object.entries(graph.nodes)
      .map(([key, node]) => ({ key, type: node.type, label: node.label, weight: node.weight }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 100)
    return { builtAt: graph.builtAt, nodeCount: Object.keys(graph.nodes).length, edgeCount: graph.edges.length, types, nodes }
  }
  const wanted = String(entity).toLowerCase()
  const matchKey = Object.keys(graph.nodes).find((key) => key.toLowerCase().includes(wanted))
  if (!matchKey) return { entity, found: false }
  const node = graph.nodes[matchKey]
  const relations = graph.edges
    .filter((edge) => edge.from === matchKey || edge.to === matchKey)
    .map((edge) => ({
      kind: edge.kind,
      count: edge.count,
      direction: edge.from === matchKey ? 'out' : 'in',
      other: graph.nodes[edge.from === matchKey ? edge.to : edge.from]?.label || edge.to,
      otherType: graph.nodes[edge.from === matchKey ? edge.to : edge.from]?.type || '',
    }))
    .sort((a, b) => b.count - a.count)
  return { entity, found: true, key: matchKey, type: node.type, label: node.label, weight: node.weight, relations }
}

