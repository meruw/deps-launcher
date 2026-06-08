// El corazón del launcher: arranca, para y reinicia procesos, detecta crashes,
// hace auto-restart opcional y respeta el orden de dependencias.
//
// Modelo de estado por servicio:
//   stopped   → no corre, nadie lo pidió
//   starting  → lo arrancamos, todavía no pasa el healthcheck
//   running   → healthcheck OK (o proceso vivo si health=process)
//   stopping  → pedimos pararlo, esperando que muera
//   crashed   → murió solo sin que lo pidiéramos
//
// "intent" guarda lo que el usuario quiere (up/down), separado del estado real.
// Eso permite distinguir un crash (intent=up, proceso muerto) de un stop normal.

const { spawn, exec } = require('child_process')
const health = require('./health')
const { topoSort, waitFor } = require('./util')

class ProcessManager {
  constructor(services, logger) {
    this.services = services
    this.logger = logger
    this.byId = Object.fromEntries(services.map(s => [s.id, s]))

    this.procs = {}        // id → ChildProcess
    this.statuses = {}     // id → estado (ver arriba)
    this.intent = {}       // id → 'up' | 'down'
    this.restartCounts = {}
    this.autoRestart = {}  // id → bool (mutable en runtime vía toggle de la UI)

    services.forEach(s => {
      this.statuses[s.id] = 'stopped'
      this.intent[s.id] = 'down'
      this.restartCounts[s.id] = 0
      this.autoRestart[s.id] = s.autoRestart // valor inicial desde services.json
    })
  }

  // Prende/apaga el auto-restart de un servicio en caliente. Devuelve el nuevo valor.
  setAutoRestart(id, value) {
    if (!this.byId[id]) return null
    this.autoRestart[id] = value != null ? !!value : !this.autoRestart[id]
    this.restartCounts[id] = 0 // resetear el contador al cambiar la preferencia
    this.logger.add(id, `↻ Auto-restart ${this.autoRestart[id] ? 'activado' : 'desactivado'}`)
    return this.autoRestart[id]
  }

  start(id) {
    const svc = this.byId[id]
    if (!svc) return
    if (this.procs[id]) return // ya corre

    this.intent[id] = 'up'
    this.statuses[id] = 'starting'
    this.logger.add(id, `→ Iniciando ${svc.name}...`)

    let proc
    try {
      proc = spawn(svc.cmd, svc.args, { cwd: svc.cwd, shell: true, windowsHide: true })
    } catch (e) {
      this.statuses[id] = 'crashed'
      this.logger.add(id, `✖ No se pudo iniciar: ${e.message}`)
      return
    }

    this.procs[id] = proc
    proc.stdout.on('data', d => this.logger.add(id, d))
    proc.stderr.on('data', d => this.logger.add(id, d))
    proc.on('error', err => this.logger.add(id, `⚠ ${err.message}`))
    proc.on('close', code => {
      delete this.procs[id]
      if (this.intent[id] === 'down') {
        this.statuses[id] = 'stopped'
        this.logger.add(id, `← Detenido (código ${code})`)
      } else {
        this.statuses[id] = 'crashed'
        this.logger.add(id, `✖ Crash inesperado (código ${code})`)
        this._maybeAutoRestart(svc)
      }
    })
  }

  stop(id) {
    this.intent[id] = 'down'
    const proc = this.procs[id]
    if (!proc) {
      if (this.statuses[id] !== 'crashed') this.statuses[id] = 'stopped'
      return
    }
    this.statuses[id] = 'stopping'
    this.logger.add(id, '← Deteniendo...')
    // taskkill /T mata el árbol completo (shell + hijos), necesario en Windows.
    try { exec(`taskkill /pid ${proc.pid} /T /F`) } catch (_) {}
  }

  async restart(id) {
    this.stop(id)
    await waitFor(() => !this.procs[id], 8000)
    this.start(id)
  }

  _maybeAutoRestart(svc) {
    if (!this.autoRestart[svc.id]) return
    if (this.restartCounts[svc.id] >= svc.maxRestarts) {
      this.logger.add(svc.id, `⚠ Auto-restart detenido (alcanzó ${svc.maxRestarts} intentos)`)
      return
    }
    this.restartCounts[svc.id]++
    const delay = Math.min(30000, 2000 * this.restartCounts[svc.id]) // backoff lineal con tope
    this.logger.add(svc.id, `↻ Auto-restart en ${delay / 1000}s (intento ${this.restartCounts[svc.id]}/${svc.maxRestarts})`)
    setTimeout(() => {
      if (this.intent[svc.id] === 'up' && !this.procs[svc.id]) this.start(svc.id)
    }, delay)
  }

  // Arranca todo en orden topológico, esperando que cada dependencia esté
  // "running" antes de seguir.
  async startAll() {
    const order = topoSort(this.services)
    for (const svc of order) {
      for (const depId of svc.dependsOn) {
        const ok = await waitFor(() => this.statuses[depId] === 'running', svc.depTimeout)
        if (!ok) this.logger.add(svc.id, `⚠ Dependencia "${depId}" no llegó a running; arranco igual`)
      }
      this.start(svc.id)
    }
  }

  // Para todo en orden inverso (los dependientes primero).
  stopAll() {
    topoSort(this.services).reverse().forEach(svc => this.stop(svc.id))
  }

  // Sondea los healthchecks y promueve/degrada estados.
  // Los eventos de proceso (close) son la fuente de verdad para crashed/stopped;
  // esto se encarga de starting→running y de detectar servicios externos.
  async refresh() {
    await Promise.all(this.services.map(async svc => {
      const id = svc.id
      if (this.statuses[id] === 'stopping') return // esperamos el evento close

      const result = await health.check(svc)
      const ours = !!this.procs[id]

      if (result === null) {
        // health por proceso: confiamos en si el proceso vive
        if (ours && this.statuses[id] !== 'running') {
          this.statuses[id] = 'running'
          this.restartCounts[id] = 0
        }
        return
      }

      if (result === true) {
        this.statuses[id] = 'running'
        if (ours) this.restartCounts[id] = 0
        return
      }

      // healthcheck fallando
      if (ours) {
        this.statuses[id] = 'starting' // proceso vivo pero todavía no responde
      } else if (this.statuses[id] === 'running') {
        // estaba running y el puerto se cayó sin proceso nuestro
        this.statuses[id] = this.intent[id] === 'up' ? 'crashed' : 'stopped'
      } else if (this.statuses[id] !== 'crashed') {
        this.statuses[id] = 'stopped'
      }
    }))
  }

  snapshot() {
    return this.services.map(s => ({
      id: s.id,
      name: s.name,
      desc: s.desc,
      port: s.port,
      color: s.color,
      deps: s.dependsOn,
      autoRestart: this.autoRestart[s.id],
      status: this.statuses[s.id],
      logs: this.logger.tail(s.id, 40)
    }))
  }
}

module.exports = { ProcessManager }
