// Helpers sin estado: orden topológico por dependencias y espera con polling.

// Devuelve los servicios ordenados de forma que cada uno aparezca después
// de sus dependencias. Si hay un ciclo, lo ignora (no cuelga).
function topoSort(services) {
  const byId = Object.fromEntries(services.map(s => [s.id, s]))
  const visited = new Set()
  const visiting = new Set()
  const result = []

  function visit(svc) {
    if (visited.has(svc.id) || visiting.has(svc.id)) return
    visiting.add(svc.id)
    for (const depId of svc.dependsOn || []) {
      if (byId[depId]) visit(byId[depId])
    }
    visiting.delete(svc.id)
    visited.add(svc.id)
    result.push(svc)
  }

  services.forEach(visit)
  return result
}

// Resuelve true cuando predicate() es verdadero, o false al expirar el timeout.
function waitFor(predicate, timeout = 30000, interval = 300) {
  return new Promise(resolve => {
    const start = Date.now()
    ;(function poll() {
      if (predicate()) return resolve(true)
      if (Date.now() - start >= timeout) return resolve(false)
      setTimeout(poll, interval)
    })()
  })
}

module.exports = { topoSort, waitFor }
