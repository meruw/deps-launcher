// HTTP server: serves the UI and exposes the REST API the front-end consumes.

const http = require('http')
const fs = require('fs')
const path = require('path')

const INDEX_HTML = path.join(__dirname, '..', 'index.html')

// Read a JSON request body (small, capped to avoid abuse).
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

// List the folders inside a directory (for the Settings folder browser).
function listDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => a.localeCompare(b))
  const parent = path.dirname(dir)
  return { path: dir, parent: parent === dir ? null : parent, dirs }
}

// List available drive roots on Windows (C:\, D:\, ...) by probing letters.
function listDrives() {
  const drives = []
  for (let c = 67; c <= 90; c++) { // C..Z (skip A/B floppies)
    const root = String.fromCharCode(c) + ':\\'
    try { fs.accessSync(root); drives.push(root) } catch (_) {}
  }
  return { path: '', parent: null, drives, dirs: [] }
}

function createServer({ pm, config, logger, configModule }) {
  // Origins our own UI legitimately sends from.
  const allowedOrigins = new Set([
    `http://localhost:${config.uiPort}`,
    `http://127.0.0.1:${config.uiPort}`
  ])

  // CSRF defense: a malicious page can still make your browser SEND a cross-origin
  // POST (dropping CORS only blocks reading the response, not the request). But the
  // browser always tags such a request with its own Origin, so we reject any Origin
  // that isn't our UI. Requests with no Origin (curl, native clients) aren't a CSRF
  // vector — there are no cookies/credentials to ride on — so we let them through.
  function originAllowed(req) {
    const origin = req.headers.origin
    if (!origin) return true
    return allowedOrigins.has(origin)
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${config.uiPort}`)
    const { pathname } = url

    // No CORS headers on purpose. The UI is served from this same origin and uses
    // relative fetches, so it doesn't need them. Adding `Allow-Origin: *` would let
    // any website you visit drive this API from your browser — exactly what we avoid.

    const json = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    const ok = () => { res.writeHead(200); res.end('ok') }

    // Block state-changing requests coming from a foreign origin.
    if (req.method === 'POST' && !originAllowed(req)) {
      return json(403, { error: 'forbidden: cross-origin request blocked' })
    }

    // ── UI ──
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(INDEX_HTML))
      return
    }

    // ── Status of all services ──
    if (req.method === 'GET' && pathname === '/api/status') {
      return json(200, pm.snapshot())
    }

    // ── Clear a service's in-memory logs (the file history is kept) ──
    const clearMatch = pathname.match(/^\/api\/logs\/(.+)\/clear$/)
    if (req.method === 'POST' && clearMatch) {
      const id = decodeURIComponent(clearMatch[1])
      if (!pm.byId[id]) return json(404, { error: `unknown service "${id}"` })
      logger.clear(id)
      return ok()
    }

    // ── Full in-memory logs for a service ──
    if (req.method === 'GET' && pathname.startsWith('/api/logs/')) {
      const id = decodeURIComponent(pathname.split('/').pop())
      return json(200, { id, logs: logger.tail(id, 200) })
    }

    // ── Individual actions: start / stop / restart ──
    const action = pathname.match(/^\/api\/(start|stop|restart)\/(.+)$/)
    if (req.method === 'POST' && action) {
      const [, verb, rawId] = action
      const id = decodeURIComponent(rawId)
      if (!pm.byId[id]) return json(404, { error: `unknown service "${id}"` })
      if (verb === 'start') pm.start(id).catch(() => {})
      else if (verb === 'stop') pm.stop(id)
      else if (verb === 'restart') pm.restart(id).catch(() => {}) // async, not awaited
      return ok()
    }

    // ── Per-service auto-restart toggle ──
    const toggle = pathname.match(/^\/api\/autorestart\/(.+)$/)
    if (req.method === 'POST' && toggle) {
      const id = decodeURIComponent(toggle[1])
      if (!pm.byId[id]) return json(404, { error: `unknown service "${id}"` })
      const value = pm.setAutoRestart(id) // no argument = toggle
      return json(200, { id, autoRestart: value })
    }

    // ── Global actions ──
    if (req.method === 'POST' && pathname === '/api/start-all') { pm.startAll().catch(() => {}); return ok() }
    if (req.method === 'POST' && pathname === '/api/stop-all')  { pm.stopAll();  return ok() }

    // ── Local config: read current per-machine paths ──
    if (req.method === 'GET' && pathname === '/api/config') {
      const local = configModule.loadLocal() || {}
      return json(200, {
        root: local.root || '',
        vars: local.vars || {},
        paths: local.paths || {},
        closeDockerOnStop: !!local.closeDockerOnStop
      })
    }

    // ── Local config: save paths and re-resolve live (applies on next start) ──
    if (req.method === 'POST' && pathname === '/api/config') {
      let body
      try { body = await readBody(req) } catch (_) { return json(400, { error: 'invalid JSON body' }) }
      const local = {
        root: body.root || '',
        vars: body.vars || {},
        paths: body.paths || {},
        closeDockerOnStop: !!body.closeDockerOnStop
      }
      configModule.saveLocal(local)
      configModule.applyLocal(pm.services, local) // mutates service cwd/cmd/args in place
      pm.flags.closeDockerOnStop = local.closeDockerOnStop // behaviour flag applies immediately
      return json(200, { ok: true })
    }

    // ── Folder browser: list drives (no path) or subfolders of a directory ──
    if (req.method === 'GET' && pathname === '/api/browse') {
      const p = url.searchParams.get('path') || ''
      try {
        return json(200, p ? listDir(p) : listDrives())
      } catch (e) {
        return json(400, { error: e.message })
      }
    }

    res.writeHead(404)
    res.end()
  })
}

module.exports = { createServer }
