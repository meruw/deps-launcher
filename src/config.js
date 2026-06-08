// Loads and validates services.json.
// The config is declarative: adding/removing a service = editing the JSON,
// without touching the launcher code.

const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, '..', 'services.json')

const VALID_HEALTH_TYPES = ['tcp', 'http', 'process']

function load() {
  let raw
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  } catch (e) {
    throw new Error(`Could not read services.json (${CONFIG_PATH}): ${e.message}`)
  }

  let cfg
  try {
    cfg = JSON.parse(raw)
  } catch (e) {
    throw new Error(`services.json is not valid JSON: ${e.message}`)
  }

  // ${ROOT} is substituted with config.root, or the FASTBANK_ROOT env var.
  const root = cfg.root || process.env.FASTBANK_ROOT || process.cwd()
  const subst = s => (typeof s === 'string' ? s.replace(/\$\{ROOT\}/g, root) : s)

  if (!Array.isArray(cfg.services) || cfg.services.length === 0) {
    throw new Error('services.json must have a "services" array with at least one service')
  }

  const seenIds = new Set()
  const seenPorts = new Map()

  const services = cfg.services.map((s, i) => {
    if (!s.id) throw new Error(`Service #${i}: missing "id"`)
    if (!s.cmd) throw new Error(`Service "${s.id}": missing "cmd"`)
    if (seenIds.has(s.id)) throw new Error(`Service "${s.id}": duplicate id`)
    seenIds.add(s.id)

    const health = s.health || { type: 'tcp' }
    if (!VALID_HEALTH_TYPES.includes(health.type)) {
      throw new Error(`Service "${s.id}": invalid health.type "${health.type}" (use: ${VALID_HEALTH_TYPES.join(', ')})`)
    }
    if (health.type === 'tcp' && !s.port) {
      throw new Error(`Service "${s.id}": health "tcp" requires "port"`)
    }

    if (s.port) {
      if (seenPorts.has(s.port)) {
        throw new Error(`Service "${s.id}": port ${s.port} already used by "${seenPorts.get(s.port)}"`)
      }
      seenPorts.set(s.port, s.id)
    }

    return {
      id: s.id,
      name: s.name || s.id,
      desc: s.desc || '',
      port: s.port || null,
      color: s.color || '#3B82F6',
      cwd: subst(s.cwd) || root,
      cmd: subst(s.cmd),
      args: (s.args || []).map(subst),
      health: { type: health.type, path: health.path || '/', url: health.url ? subst(health.url) : null },
      dependsOn: s.dependsOn || [],
      depTimeout: s.depTimeout || 60000,
      autoRestart: s.autoRestart === true,
      maxRestarts: s.maxRestarts != null ? s.maxRestarts : 3
    }
  })

  // Validate that dependencies exist.
  for (const svc of services) {
    for (const dep of svc.dependsOn) {
      if (!seenIds.has(dep)) {
        throw new Error(`Service "${svc.id}": depends on "${dep}" which does not exist`)
      }
    }
  }

  return {
    uiPort: cfg.uiPort || 9999,
    root,
    openBrowser: cfg.openBrowser !== false,
    services
  }
}

module.exports = { load, CONFIG_PATH }
