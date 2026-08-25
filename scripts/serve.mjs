#!/usr/bin/env node
/**
 * Graph Engine — observability server. READ-ONLY: it renders the same state.json the
 * orchestrator writes through engine.mjs; it never mutates anything and never decides
 * anything. Kill it and the execution is unaffected.
 *
 * Usage: node <skill>/scripts/serve.mjs [--port 4949] [--run <name>]
 * Then open http://localhost:4949
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/* Same discovery as engine.mjs (duplicated on purpose — importing the engine would run
 * its CLI arg handling). GRAPH_ROOT overrides; otherwise walk up from cwd to the first
 * .git or package.json. Keep in sync. */
function findRoot() {
  if (process.env.GRAPH_ROOT) {
    const r = resolve(process.env.GRAPH_ROOT)
    if (!existsSync(r)) {
      console.error(`[graph] ERROR: GRAPH_ROOT points to "${r}", which does not exist`)
      process.exit(1)
    }
    return r
  }
  let dir = process.cwd()
  while (true) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) {
      console.error(
        '[graph] ERROR: no project root found (no .git or package.json above cwd) — ' +
          'run from inside a project, or set GRAPH_ROOT',
      )
      process.exit(1)
    }
    dir = parent
  }
}

const ROOT = findRoot()
const GRAPH_DIR = join(ROOT, '.specs', 'graph')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const PORT = Number(flag('port', 4949))
const RUN_FLAG = flag('run', null)

function currentRun() {
  if (RUN_FLAG) return RUN_FLAG
  const p = join(GRAPH_DIR, 'CURRENT')
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null
}

/** Same derivation the engine uses — duplicated on purpose so this stays dependency-free
 *  read-only (importing engine.mjs would run its CLI arg handling). Keep in sync. */
function derive(state) {
  const out = {}
  for (const [id, t] of Object.entries(state.tasks)) {
    let effective = t.state
    let blockedBy = []
    if (t.state === 'pending') {
      blockedBy = t.deps.filter((d) => {
        const dep = state.tasks[d]
        return !dep || (dep.state !== 'done' && dep.state !== 'skipped')
      })
      effective = blockedBy.length === 0 ? 'ready' : 'waiting'
    }
    out[id] = { effective, blockedBy }
  }
  return out
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const run = url.searchParams.get('run') ?? currentRun()

  if (url.pathname === '/api/state') {
    if (!run) return json(res, 404, { error: 'no run' })
    const p = join(GRAPH_DIR, run, 'state.json')
    if (!existsSync(p)) return json(res, 404, { error: `run "${run}" not found` })
    const state = JSON.parse(readFileSync(p, 'utf8'))
    return json(res, 200, { ...state, derived: derive(state) })
  }

  if (url.pathname === '/api/events') {
    if (!run) return json(res, 404, { error: 'no run' })
    const p = join(GRAPH_DIR, run, 'events.ndjson')
    if (!existsSync(p)) return json(res, 200, { events: [] })
    const limit = Number(url.searchParams.get('limit') ?? 300)
    const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
    return json(res, 200, { events: lines.slice(-limit).map((l) => JSON.parse(l)) })
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(readFileSync(join(HERE, 'dashboard.html'), 'utf8'))
  }

  res.writeHead(404)
  res.end('not found')
}).listen(PORT, () => {
  console.log(`[graph] dashboard on http://localhost:${PORT} (run: ${currentRun() ?? '—'})`)
})
