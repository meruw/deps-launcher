// FastBank Local Launcher — entry point.
// Run with: node launcher.js   (or: npm start)
//
// This file just wires the modules together. The logic lives in src/.

const { exec } = require('child_process')
const config = require('./src/config')
const logger = require('./src/logger')
const { ProcessManager } = require('./src/process-manager')
const { createServer } = require('./src/server')

let cfg
try {
  cfg = config.load()
} catch (e) {
  console.error(`\n✖ Configuration error:\n  ${e.message}\n`)
  process.exit(1)
}

if (cfg.createdLocal) {
  console.log('\n ℹ First run: created launcher.local.json with default paths.')
  console.log('   Adjust your folders in the Settings panel (⚙) or edit that file.\n')
}

logger.init(cfg.services.map(s => s.id))

const pm = new ProcessManager(cfg.services, logger)
pm.flags = cfg.flags

// Heartbeat: every 2s we re-check every service's health (is the port open? is the
// process alive?) and update its status. This is how the UI stays in sync with reality
// even if a service crashes, or if you started one from another terminal.
const refreshTimer = setInterval(() => pm.refresh().catch(() => {}), 2000)

const server = createServer({ pm, config: cfg, logger, configModule: config })

// Bind to 127.0.0.1 (loopback) ONLY, never 0.0.0.0. This API has no auth and can
// start/stop processes on this machine, so it must not be reachable from the network.
// Omitting the host would make Node listen on all interfaces — don't.
server.listen(cfg.uiPort, '127.0.0.1', () => {
  console.log('\n ┌─────────────────────────────────────┐')
  console.log(' │  FastBank Launcher                  │')
  console.log(` │  http://localhost:${cfg.uiPort}              │`)
  console.log(' └─────────────────────────────────────┘\n')
  console.log(` ${cfg.services.length} services configured. Ctrl+C to exit.\n`)
  // Opens the panel in your default browser on startup. Set "openBrowser": false
  // in services.json if you'd rather it didn't (e.g. you restart the launcher a lot).
  if (cfg.openBrowser) exec(`start http://localhost:${cfg.uiPort}`)
})

// Clean shutdown: kill all child processes before exiting.
let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\n Shutting down services...')
  clearInterval(refreshTimer)
  pm.stopAll()
  setTimeout(() => process.exit(0), 1500)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
