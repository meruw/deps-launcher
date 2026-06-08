// Loads the service definitions and merges them with the per-user local config.
//
// Two-file model so the repo can be shared without leaking machine paths:
//   services.json        (committed)  → WHAT the services are: name, cmd, port, deps...
//                                        uses ${ROOT}/${MVN} tokens instead of real paths
//   launcher.local.json  (gitignored) → WHERE they live on THIS machine: root, tool paths,
//                                        and optional per-service folder overrides
//
// Tokens like ${ROOT} and ${MVN} in services.json are substituted from the local config.
// A per-service entry in local "paths" overrides that service's folder outright (this is
// what the UI folder browser writes).

const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, '..', 'services.json')
const LOCAL_PATH = path.join(__dirname, '..', 'launcher.local.json')

const VALID_HEALTH_TYPES = ['tcp', 'http', 'process']

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// ── Local (per-user) config ───────────────────────────────────────────────────
function loadLocal() {
  if (!fs.existsSync(LOCAL_PATH)) return null
  try {
    return readJson(LOCAL_PATH)
  } catch (e) {
    throw new Error(`launcher.local.json is not valid JSON: ${e.message}`)
  }
}

function saveLocal(local) {
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(local, null, 2) + '\n')
}

// Create launcher.local.json on first run with sensible guesses, so a fresh clone
// works (or at least starts) without hand-editing. Returns true if it created it.
function ensureLocal() {
  if (fs.existsSync(LOCAL_PATH)) return false
  saveLocal({
    root: process.env.FASTBANK_ROOT || process.env.USERPROFILE || process.cwd(),
    vars: { MVN: 'mvn' }, // assume Maven is on PATH unless the user points to mvn.cmd
    paths: {}             // per-service folder overrides (set from the Settings UI)
  })
  return true
}

// ── Token substitution ─────────────────────────────────────────────────────────
function buildTokens(local) {
  const tokens = {
    ROOT: process.env.FASTBANK_ROOT || process.env.USERPROFILE || process.cwd(),
    MVN: 'mvn'
  }
  if (local) {
    if (local.root) tokens.ROOT = local.root
    Object.assign(tokens, local.vars || {})
  }
  return tokens
}

function subst(value, tokens) {
  if (typeof value !== 'string') return value
  return value.replace(/\$\{(\w+)\}/g, (m, name) => (tokens[name] != null ? tokens[name] : m))
}

// Recompute cwd/cmd/args for every service from its raw template + current tokens +
// per-service path overrides. Mutates the service objects IN PLACE so references held
// elsewhere (e.g. the ProcessManager) keep pointing at the live, updated values.
function applyLocal(services, local) {
  const tokens = buildTokens(local)
  const overrides = (local && local.paths) || {}
  for (const s of services) {
    const override = overrides[s.id]
    s.cwd = override ? subst(override, tokens) : (subst(s._rawCwd, tokens) || tokens.ROOT)
    s.cmd = subst(s._rawCmd, tokens)
    s.args = s._rawArgs.map(a => subst(a, tokens))
    s.health.url = s.health._rawUrl ? subst(s.health._rawUrl, tokens) : null
  }
  return services
}

// ── Main load ───────────────────────────────────────────────────────────────────
function load() {
  let cfg
  try {
    cfg = readJson(CONFIG_PATH)
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`Could not read services.json (${CONFIG_PATH})`)
    throw new Error(`services.json is not valid JSON: ${e.message}`)
  }

  if (!Array.isArray(cfg.services) || cfg.services.length === 0) {
    throw new Error('services.json must have a "services" array with at least one service')
  }

  const createdLocal = ensureLocal()
  const local = loadLocal()

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
      dependsOn: s.dependsOn || [],
      depTimeout: s.depTimeout || 60000,
      autoRestart: s.autoRestart === true,
      maxRestarts: s.maxRestarts != null ? s.maxRestarts : 3,
      health: { type: health.type, path: health.path || '/', url: null, _rawUrl: health.url || null },
      // Raw (unsubstituted) templates, kept so paths can be re-resolved at runtime.
      _rawCwd: s.cwd || '${ROOT}',
      _rawCmd: s.cmd,
      _rawArgs: s.args || [],
      // Resolved values, filled by applyLocal() below.
      cwd: null, cmd: null, args: null
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

  applyLocal(services, local)

  return {
    uiPort: cfg.uiPort || 9999,
    openBrowser: cfg.openBrowser !== false,
    services,
    createdLocal
  }
}

module.exports = { load, loadLocal, saveLocal, applyLocal, CONFIG_PATH, LOCAL_PATH }
