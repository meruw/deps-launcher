// The heart of the launcher: starts, stops and restarts processes, detects crashes,
// does optional auto-restart and respects dependency ordering.
//
// Per-service state model:
//   stopped   → not running, nobody asked for it
//   starting  → we started it, healthcheck not passing yet
//   running   → healthcheck OK (or process alive if health=process)
//   stopping  → we asked to stop it, waiting for it to die
//   crashed   → it died on its own without us asking
//
// "intent" holds what the user wants (up/down), separate from the real state.
// That lets us distinguish a crash (intent=up, process dead) from a normal stop.

const { spawn, exec } = require('child_process')
const health = require('./health')
const { topoSort, waitFor } = require('./util')

// With shell:true, Node joins cmd + args into one string for cmd.exe, but it does NOT
// quote anything. So a path with spaces (e.g. "C:\Program Files\...\mvn.cmd") gets split
// at the space and cmd.exe tries to run "C:\Program". Quote any token with whitespace
// that isn't already quoted — same as typing & "C:\Program Files\..." in PowerShell.
function shellQuote(s) {
  if (typeof s !== 'string') return s
  return /\s/.test(s) && !s.startsWith('"') ? `"${s}"` : s
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Run a command and resolve true if it exits 0 (used for readiness checks like `docker info`).
function runCheck(cmd) {
  return new Promise(resolve => exec(cmd, { windowsHide: true }, err => resolve(!err)))
}

// Launch a GUI app (e.g. Docker Desktop) detached, so it keeps running and doesn't block us.
function launchDetached(cmd) {
  const p = spawn(shellQuote(cmd), { shell: true, detached: true, stdio: 'ignore', windowsHide: true })
  p.unref()
}

class ProcessManager {
  constructor(services, logger) {
    this.services = services
    this.logger = logger
    this.byId = Object.fromEntries(services.map(s => [s.id, s]))

    this.procs = {}        // id → ChildProcess
    this.statuses = {}     // id → state (see above)
    this.intent = {}       // id → 'up' | 'down'
    this.restartCounts = {}
    this.autoRestart = {}  // id → bool (mutable at runtime via the UI toggle)
    this.flags = { closeDockerOnStop: false } // global behaviour flags (set from config)

    services.forEach(s => {
      this.statuses[s.id] = 'stopped'
      this.intent[s.id] = 'down'
      this.restartCounts[s.id] = 0
      this.autoRestart[s.id] = s.autoRestart // initial value from services.json
    })
  }

  // Turns a service's auto-restart on/off at runtime. Returns the new value.
  setAutoRestart(id, value) {
    if (!this.byId[id]) return null
    this.autoRestart[id] = value != null ? !!value : !this.autoRestart[id]
    this.restartCounts[id] = 0 // reset the counter when the preference changes
    this.logger.add(id, `↻ Auto-restart ${this.autoRestart[id] ? 'enabled' : 'disabled'}`)
    return this.autoRestart[id]
  }

  async start(id) {
    const svc = this.byId[id]
    if (!svc) return
    if (this.procs[id]) return // already running

    this.intent[id] = 'up'
    this.statuses[id] = 'starting'
    this.logger.add(id, `→ Starting ${svc.name}...`)

    // Optional prerequisite (e.g. the Docker engine): make sure it's ready before we
    // spawn, launching it if needed. If it never comes up, abort rather than spawn into
    // a guaranteed failure.
    if (svc.ensure) {
      const ready = await this._ensure(svc)
      if (this.intent[id] !== 'up') return        // user stopped it while we waited
      if (!ready) {
        this.statuses[id] = 'crashed'
        this.logger.add(id, `✖ ${svc.ensure.label} not ready — aborting start`)
        return
      }
    }
    if (this.procs[id] || this.intent[id] !== 'up') return

    // This is where the launcher actually talks to your machine: spawn() launches
    // a real OS process running `cmd args` inside the service's `cwd` directory —
    // exactly what you'd type by hand in a terminal opened at that folder.
    //   shell: true        → run through cmd.exe so PATH lookups and .cmd/.bat
    //                         wrappers (mvn.cmd, npm, func...) resolve like in a shell.
    //   windowsHide: true  → don't pop up a console window for each child.
    // The child keeps running independently; we only hold a handle to it.
    let proc
    try {
      proc = spawn(shellQuote(svc.cmd), svc.args.map(shellQuote), { cwd: svc.cwd, shell: true, windowsHide: true })
    } catch (e) {
      this.statuses[id] = 'crashed'
      this.logger.add(id, `✖ Could not start: ${e.message}`)
      return
    }

    this.procs[id] = proc
    // Pipe the child's stdout/stderr into our logger (memory buffer + file).
    proc.stdout.on('data', d => this.logger.add(id, d))
    proc.stderr.on('data', d => this.logger.add(id, d))
    proc.on('error', err => this.logger.add(id, `⚠ ${err.message}`))
    // 'close' fires when the process exits for any reason. We use `intent` to tell
    // whether we asked for it (stop) or it died on its own (crash).
    proc.on('close', code => {
      delete this.procs[id]
      if (this.intent[id] === 'down') {
        this.statuses[id] = 'stopped'
        this.logger.add(id, `← Stopped (code ${code})`)
      } else {
        this.statuses[id] = 'crashed'
        this.logger.add(id, `✖ Unexpected crash (code ${code})`)
        this._maybeAutoRestart(svc)
      }
    })
  }

  // Make sure a prerequisite is ready: run its check; if it fails, launch it and poll
  // until ready or timeout. Returns true once ready. Used for the Docker engine.
  async _ensure(svc) {
    const { label, check, start, timeout } = svc.ensure
    if (await runCheck(check)) return true // already up — no delay

    this.logger.add(svc.id, `⏳ ${label} not running — launching it...`)
    launchDetached(start)

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await sleep(3000)
      if (this.intent[svc.id] !== 'up') return false // cancelled
      if (await runCheck(check)) {
        this.logger.add(svc.id, `✓ ${label} ready`)
        return true
      }
      this.logger.add(svc.id, `⏳ waiting for ${label}...`)
    }
    return false
  }

  stop(id) {
    this.intent[id] = 'down'
    const svc = this.byId[id]
    const proc = this.procs[id]

    // Custom stop command (e.g. `docker stop <container>`). Needed for services we don't
    // truly "own" as a process: `docker start -a` only ATTACHES to the container, so
    // killing our attached client leaves the container running. `docker stop` is what
    // actually stops it; the attached client then exits on its own (firing 'close').
    if (svc && svc.stop) {
      this.statuses[id] = 'stopping'
      this.logger.add(id, '← Stopping...')
      exec(svc.stop, { windowsHide: true }, err => {
        if (err) this.logger.add(id, `⚠ stop command failed: ${err.message}`)
        // If there was no attached process to fire 'close', settle the status here.
        if (!this.procs[id] && this.intent[id] === 'down') {
          this.statuses[id] = 'stopped'
          this.logger.add(id, '← Stopped')
        }
      })
      this._maybeTeardownEnsure(svc)
      return
    }

    if (!proc) {
      if (this.statuses[id] !== 'crashed') this.statuses[id] = 'stopped'
      this._maybeTeardownEnsure(svc)
      return
    }
    this.statuses[id] = 'stopping'
    this.logger.add(id, '← Stopping...')
    // Because we spawned with shell:true, proc.pid is the intermediate cmd.exe, and
    // the real server (java, node, func...) is its CHILD. Killing only proc.pid would
    // orphan that child and leave the port held. taskkill /T kills the whole tree;
    // /F forces it. This is Windows-specific (no SIGTERM equivalent here).
    try { exec(`taskkill /pid ${proc.pid} /T /F`) } catch (_) {}
    this._maybeTeardownEnsure(svc)
  }

  // Optionally tear down a service's prerequisite when stopping it (e.g. close Docker
  // Desktop after stopping Postgres). Off unless the closeDockerOnStop flag is set.
  _maybeTeardownEnsure(svc) {
    if (!svc || !svc.ensure || !svc.ensure.stop) return
    if (!this.flags.closeDockerOnStop) return
    this.logger.add(svc.id, `← Closing ${svc.ensure.label}...`)
    exec(svc.ensure.stop, { windowsHide: true }, err => {
      if (err) this.logger.add(svc.id, `⚠ couldn't close ${svc.ensure.label}: ${err.message}`)
    })
  }

  async restart(id) {
    this.stop(id)
    await waitFor(() => !this.procs[id], 8000)
    await this.start(id)
  }

  _maybeAutoRestart(svc) {
    if (!this.autoRestart[svc.id]) return
    if (this.restartCounts[svc.id] >= svc.maxRestarts) {
      this.logger.add(svc.id, `⚠ Auto-restart stopped (reached ${svc.maxRestarts} attempts)`)
      return
    }
    this.restartCounts[svc.id]++
    const delay = Math.min(30000, 2000 * this.restartCounts[svc.id]) // linear backoff with cap
    this.logger.add(svc.id, `↻ Auto-restart in ${delay / 1000}s (attempt ${this.restartCounts[svc.id]}/${svc.maxRestarts})`)
    setTimeout(() => {
      if (this.intent[svc.id] === 'up' && !this.procs[svc.id]) this.start(svc.id).catch(() => {})
    }, delay)
  }

  // Starts everything in topological order, waiting for each dependency to be
  // "running" before moving on.
  async startAll() {
    const order = topoSort(this.services)
    for (const svc of order) {
      for (const depId of svc.dependsOn) {
        const ok = await waitFor(() => this.statuses[depId] === 'running', svc.depTimeout)
        if (!ok) this.logger.add(svc.id, `⚠ Dependency "${depId}" never reached running; starting anyway`)
      }
      this.start(svc.id).catch(() => {})
    }
  }

  // Stops everything in reverse order (dependents first).
  stopAll() {
    topoSort(this.services).reverse().forEach(svc => this.stop(svc.id))
  }

  // Polls the healthchecks and promotes/demotes states.
  // Process events (close) are the source of truth for crashed/stopped;
  // this handles starting→running and detecting externally-running services.
  async refresh() {
    await Promise.all(this.services.map(async svc => {
      const id = svc.id
      if (this.statuses[id] === 'stopping') return // wait for the close event

      const result = await health.check(svc)
      const ours = !!this.procs[id]

      if (result === null) {
        // process-based health: trust whether the process is alive
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

      // healthcheck failing
      if (ours) {
        this.statuses[id] = 'starting' // process alive but not responding yet
      } else if (this.statuses[id] === 'running') {
        // was running and the port dropped without our process
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
