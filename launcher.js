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

logger.init(cfg.services.map(s => s.id))

const pm = new ProcessManager(cfg.services, logger)

// Heartbeat: every 2s we re-check every service's health (is the port open? is the
// process alive?) and update its status. This is how the UI stays in sync with reality
// even if a service crashes, or if you started one from another terminal.
const refreshTimer = setInterval(() => pm.refresh().catch(() => {}), 2000)

const server = createServer({ pm, config: cfg, logger })

server.listen(cfg.uiPort, () => {
  console.log('\n ┌─────────────────────────────────────┐')
  console.log(' │  FastBank Launcher                  │')
  console.log(` │  http://localhost:${cfg.uiPort}              │`)
  console.log(' └─────────────────────────────────────┘\n')
  console.log(` ${cfg.services.length} services configured. Ctrl+C to exit.\n`)
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
