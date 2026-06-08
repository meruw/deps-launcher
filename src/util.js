// Stateless helpers: topological ordering by dependencies and polling wait.

// Returns the services ordered so that each one appears after its dependencies.
// If there is a cycle, it is ignored (won't hang).
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

// Resolves true when predicate() is truthy, or false when the timeout expires.
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
