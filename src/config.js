// Carga y valida services.json.
// La config es declarativa: agregar/quitar un servicio = editar el JSON,
// sin tocar el código del launcher.

const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, '..', 'services.json')

const VALID_HEALTH_TYPES = ['tcp', 'http', 'process']

function load() {
  let raw
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  } catch (e) {
    throw new Error(`No se pudo leer services.json (${CONFIG_PATH}): ${e.message}`)
  }

  let cfg
  try {
    cfg = JSON.parse(raw)
  } catch (e) {
    throw new Error(`services.json no es JSON válido: ${e.message}`)
  }

  // ${ROOT} se sustituye por config.root, o por la env var FASTBANK_ROOT.
  const root = cfg.root || process.env.FASTBANK_ROOT || process.cwd()
  const subst = s => (typeof s === 'string' ? s.replace(/\$\{ROOT\}/g, root) : s)

  if (!Array.isArray(cfg.services) || cfg.services.length === 0) {
    throw new Error('services.json debe tener un array "services" con al menos un servicio')
  }

  const seenIds = new Set()
  const seenPorts = new Map()

  const services = cfg.services.map((s, i) => {
    if (!s.id) throw new Error(`Servicio #${i}: falta "id"`)
    if (!s.cmd) throw new Error(`Servicio "${s.id}": falta "cmd"`)
    if (seenIds.has(s.id)) throw new Error(`Servicio "${s.id}": id duplicado`)
    seenIds.add(s.id)

    const health = s.health || { type: 'tcp' }
    if (!VALID_HEALTH_TYPES.includes(health.type)) {
      throw new Error(`Servicio "${s.id}": health.type "${health.type}" inválido (usar: ${VALID_HEALTH_TYPES.join(', ')})`)
    }
    if (health.type === 'tcp' && !s.port) {
      throw new Error(`Servicio "${s.id}": health "tcp" requiere "port"`)
    }

    if (s.port) {
      if (seenPorts.has(s.port)) {
        throw new Error(`Servicio "${s.id}": puerto ${s.port} ya usado por "${seenPorts.get(s.port)}"`)
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

  // Validar que las dependencias existan.
  for (const svc of services) {
    for (const dep of svc.dependsOn) {
      if (!seenIds.has(dep)) {
        throw new Error(`Servicio "${svc.id}": depende de "${dep}" que no existe`)
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
