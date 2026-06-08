// Healthchecks. Tres estrategias:
//   - tcp:     el puerto acepta conexiones (rápido, sirve para casi todo)
//   - http:    un GET devuelve status < 500 (más preciso para web/APIs)
//   - process: no se puede chequear por red; el caller usa la presencia del proceso
//              (ej. Azurite, que no expone un endpoint trivial)

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
      res.resume() // drenar para liberar el socket
      resolve(res.statusCode < 500)
    })
    req.setTimeout(timeout, () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

// Devuelve true/false según el healthcheck, o null si es de tipo "process"
// (el caller decide en base a si el proceso sigue vivo).
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
