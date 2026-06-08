// Servidor HTTP: sirve la UI y expone la API REST que el front consume.

const http = require('http')
const fs = require('fs')
const path = require('path')

const INDEX_HTML = path.join(__dirname, '..', 'index.html')

function createServer({ pm, config, logger }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${config.uiPort}`)
    const { pathname } = url

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST')

    const json = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    const ok = () => { res.writeHead(200); res.end('ok') }

    // ── UI ──
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(INDEX_HTML))
      return
    }

    // ── Estado de todos los servicios ──
    if (req.method === 'GET' && pathname === '/api/status') {
      return json(200, pm.snapshot())
    }

    // ── Logs completos en memoria de un servicio ──
    if (req.method === 'GET' && pathname.startsWith('/api/logs/')) {
      const id = decodeURIComponent(pathname.split('/').pop())
      return json(200, { id, logs: logger.tail(id, 200) })
    }

    // ── Acciones individuales: start / stop / restart ──
    const action = pathname.match(/^\/api\/(start|stop|restart)\/(.+)$/)
    if (req.method === 'POST' && action) {
      const [, verb, rawId] = action
      const id = decodeURIComponent(rawId)
      if (!pm.byId[id]) return json(404, { error: `servicio "${id}" desconocido` })
      if (verb === 'start') pm.start(id)
      else if (verb === 'stop') pm.stop(id)
      else if (verb === 'restart') pm.restart(id) // async, no esperamos
      return ok()
    }

    // ── Toggle de auto-restart por servicio ──
    const toggle = pathname.match(/^\/api\/autorestart\/(.+)$/)
    if (req.method === 'POST' && toggle) {
      const id = decodeURIComponent(toggle[1])
      if (!pm.byId[id]) return json(404, { error: `servicio "${id}" desconocido` })
      const value = pm.setAutoRestart(id) // sin argumento = toggle
      return json(200, { id, autoRestart: value })
    }

    // ── Acciones globales ──
    if (req.method === 'POST' && pathname === '/api/start-all') { pm.startAll(); return ok() }
    if (req.method === 'POST' && pathname === '/api/stop-all')  { pm.stopAll();  return ok() }

    res.writeHead(404)
    res.end()
  })
}

module.exports = { createServer }
