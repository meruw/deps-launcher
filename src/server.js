// HTTP server: serves the UI and exposes the REST API the front-end consumes.

const http = require('http')
const fs = require('fs')
const path = require('path')

const INDEX_HTML = path.join(__dirname, '..', 'index.html')

function createServer({ pm, config, logger }) {
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
      if (verb === 'start') pm.start(id)
      else if (verb === 'stop') pm.stop(id)
      else if (verb === 'restart') pm.restart(id) // async, not awaited
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
    if (req.method === 'POST' && pathname === '/api/start-all') { pm.startAll(); return ok() }
    if (req.method === 'POST' && pathname === '/api/stop-all')  { pm.stopAll();  return ok() }

    res.writeHead(404)
    res.end()
  })
}

module.exports = { createServer }
