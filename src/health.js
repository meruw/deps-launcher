// Healthchecks. Three strategies:
//   - tcp:     the port accepts connections (fast, works for almost everything)
//   - http:    a GET returns status < 500 (more precise for web/APIs)
//   - process: can't be checked over the network; the caller uses process presence
//              (e.g. Azurite, which doesn't expose a trivial endpoint)

const net = require('net')
const http = require('http')

function checkTcp(port, host = 'localhost', timeout = 400) {
  return new Promise(resolve => {
    if (!port) return resolve(false)
    const sock = new net.Socket()
    sock.setTimeout(timeout)
    sock.on('connect', () => { sock.destroy(); resolve(true) })
    sock.on('error',   () => resolve(false))
    sock.on('timeout', () => { sock.destroy(); resolve(false) })
    sock.connect(port, host)
  })
}

function checkHttp(url, timeout = 1500) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      res.resume() // drain to free the socket
      resolve(res.statusCode < 500)
    })
    req.setTimeout(timeout, () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

// Returns true/false based on the healthcheck, or null if the type is "process"
// (the caller decides based on whether the process is still alive).
async function check(svc) {
  const h = svc.health || { type: 'tcp' }
  if (h.type === 'process') return null
  if (h.type === 'http') {
    const url = h.url || `http://localhost:${svc.port}${h.path || '/'}`
    return checkHttp(url)
  }
  return svc.port ? checkTcp(svc.port) : null
}

module.exports = { check, checkTcp, checkHttp }
