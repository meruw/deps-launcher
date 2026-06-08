// Per-service logs. Two destinations:
//   - in-memory buffer (ring buffer) → what the UI shows, fast
//   - file at logs/<id>.log           → persists across launcher restarts

const fs = require('fs')
const path = require('path')

const LOG_DIR = path.join(__dirname, '..', 'logs')
const MAX_LINES = 200 // lines kept in memory per service

const buffers = {} // id → string[]
const streams = {} // id → WriteStream

function init(ids) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  ids.forEach(id => {
    buffers[id] = []
    streams[id] = fs.createWriteStream(path.join(LOG_DIR, `${id}.log`), { flags: 'a' })
    streams[id].write(`\n===== session ${new Date().toISOString()} =====\n`)
  })
}

function add(id, text) {
  if (!buffers[id]) buffers[id] = []
  const lines = text.toString().split('\n').filter(l => l.trim())
  lines.forEach(line => {
    const stamped = `[${new Date().toLocaleTimeString()}] ${line}`
    // Memory: ring buffer — keep only the last MAX_LINES so the UI stays light.
    buffers[id].push(stamped)
    if (buffers[id].length > MAX_LINES) buffers[id].shift()
    // Disk: append every line, no trimming — the full history is in logs/<id>.log.
    if (streams[id]) streams[id].write(stamped + '\n')
  })
}

function tail(id, n = 40) {
  return (buffers[id] || []).slice(-n)
}

function clear(id) {
  buffers[id] = []
}

function logFilePath(id) {
  return path.join(LOG_DIR, `${id}.log`)
}

module.exports = { init, add, tail, clear, logFilePath, LOG_DIR }
