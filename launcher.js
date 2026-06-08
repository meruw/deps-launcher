// FastBank Local Launcher — entry point.
// Corre con: node launcher.js   (o: npm start)
//
// Este archivo solo "cablea" los módulos. La lógica vive en src/.

const { exec } = require('child_process')
const config = require('./src/config')
const logger = require('./src/logger')
const { ProcessManager } = require('./src/process-manager')
const { createServer } = require('./src/server')

let cfg
try {
  cfg = config.load()
} catch (e) {
  console.error(`\n✖ Error de configuración:\n  ${e.message}\n`)
  process.exit(1)
}

logger.init(cfg.services.map(s => s.id))

const pm = new ProcessManager(cfg.services, logger)

// Sondeo de salud cada 2s.
const refreshTimer = setInterval(() => pm.refresh().catch(() => {}), 2000)

const server = createServer({ pm, config: cfg, logger })

server.listen(cfg.uiPort, () => {
  console.log('\n ┌─────────────────────────────────────┐')
  console.log(' │  FastBank Launcher                  │')
  console.log(` │  http://localhost:${cfg.uiPort}              │`)
  console.log(' └─────────────────────────────────────┘\n')
  console.log(` ${cfg.services.length} servicios configurados. Ctrl+C para salir.\n`)
  if (cfg.openBrowser) exec(`start http://localhost:${cfg.uiPort}`)
})

// Apagado limpio: matar todos los procesos hijos antes de salir.
let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\n Apagando servicios...')
  clearInterval(refreshTimer)
  pm.stopAll()
  setTimeout(() => process.exit(0), 1500)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
