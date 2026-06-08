# CLAUDE.md

Guide for working in this repo. Read it before making changes.

## Repository

- GitHub: https://github.com/meruw/deps-launcher
- Remote: `origin` → `main`
- Day-to-day flow: `git add -A` → `git commit -m "..."` → `git push`

## What it is

A local web panel to start and monitor all FastBank microservices from one place,
instead of opening a terminal per service. Runs at `http://localhost:9999`.

**Key principle: zero dependencies.** Everything uses Node built-in modules
(`http`, `child_process`, `net`, `fs`, `path`). Don't add npm packages without a
strong reason — the whole point of this tool is that you clone it and run `node launcher.js`.

## How to run it

```sh
node launcher.js      # or: npm start
```

Opens the browser automatically. `Ctrl+C` shuts down the launcher and kills all child services.

Requires Node >= 16. Built for **Windows** (uses `taskkill` and `start`).

## Architecture

Thin entry point + single-responsibility modules. The flow:

```
services.json   ── declarative configuration of the services
      │
launcher.js     ── wires everything together and starts the server
      ├── src/config.js          loads + validates services.json, substitutes ${ROOT}
      ├── src/logger.js          per-service logs: ring buffer + file in logs/
      ├── src/health.js          healthchecks tcp / http / process
      ├── src/util.js            topoSort (dependency ordering) + waitFor
      ├── src/process-manager.js spawn/stop/restart, crashes, auto-restart, deps
      └── src/server.js          HTTP server + REST API
index.html      ── the UI (vanilla JS, no build, polls /api/status every 2s)
```

### Responsibilities

- **config.js** — single source of truth about which services exist. Validates duplicate
  ids/ports, non-existent dependencies, health types. If something is wrong, the launcher
  refuses to start and explains why.
- **process-manager.js** — the brain. Keeps `procs`, `statuses` and `intent` per service.
- **server.js** — only routes HTTP → calls into the process-manager. No business logic.
- **logger.js / health.js / util.js** — stateless domain utilities.

## State model (process-manager)

Each service has a `status` and an `intent` (what the user wants) kept separate.
That separation is what lets us tell a **crash** apart from a normal **stop**.

| status     | meaning                                              |
|------------|------------------------------------------------------|
| `stopped`  | not running, nobody asked for it                     |
| `starting` | we started it, healthcheck not passing yet           |
| `running`  | healthcheck OK (or process alive if `health=process`)|
| `stopping` | we asked to stop it, waiting for it to die           |
| `crashed`  | it died on its own with `intent=up` (unexpected)     |

Process events (`close`) are the source of truth for `stopped`/`crashed`.
`refresh()` (every 2s) only promotes `starting → running` and detects external services.

## How to add / change a service

**No code changes.** Edit `services.json` and restart the launcher. Fields:

| field         | req. | description                                                        |
|---------------|------|--------------------------------------------------------------------|
| `id`          | yes  | unique identifier (used in the API and log file names)             |
| `cmd`         | yes  | executable to run                                                  |
| `name`/`desc` | no   | text for the UI                                                    |
| `port`        | no*  | service port (required if `health.type` = `tcp`)                   |
| `color`       | no   | accent color on the card                                           |
| `cwd`         | no   | working directory; supports `${ROOT}`                              |
| `args`        | no   | array of arguments; each one supports `${ROOT}`                    |
| `health`      | no   | `{ "type": "tcp" \| "http" \| "process", "path": "/", "url": "" }` |
| `dependsOn`   | no   | array of ids that must be `running` before this one starts         |
| `depTimeout`  | no   | ms to wait for dependencies (default 60000)                        |
| `autoRestart` | no   | **initial** value of the toggle; retries on crash (backoff, up to `maxRestarts`). Can be turned on/off live from the UI; the runtime change is not persisted to the JSON |
| `maxRestarts` | no   | cap on auto-restarts (default 3)                                   |

`${ROOT}` is substituted with the `root` field in `services.json` (or the `FASTBANK_ROOT` env var).

### Healthcheck types

- **`tcp`** (default): the port accepts connections. Fast, works for most cases.
- **`http`**: a GET to `url` (or `http://localhost:{port}{path}`) returns status < 500.
  Useful when the port opens before the service is actually ready
  (e.g. a Spring Boot `/actuator/health`).
- **`process`**: not checked over the network; considered `running` while the process is alive.
  For services without a trivial endpoint (e.g. Azurite).

## HTTP API

| method | route                  | action                                   |
|--------|------------------------|------------------------------------------|
| GET    | `/`                    | serves the UI                            |
| GET    | `/api/status`          | snapshot of all services + logs          |
| GET    | `/api/logs/:id`        | last 200 in-memory lines for an id       |
| POST   | `/api/start/:id`       | start a service                          |
| POST   | `/api/stop/:id`        | stop a service                           |
| POST   | `/api/restart/:id`     | restart a service                        |
| POST   | `/api/autorestart/:id` | toggle auto-restart (returns new value)  |
| POST   | `/api/start-all`       | start everything respecting dependencies |
| POST   | `/api/stop-all`        | stop everything in reverse order         |

## Conventions

- Comments and UI text in English.
- 2-space indentation, no trailing semicolons (matches the existing code style).
- Log messages with prefixes: `→` starting, `←` stopping, `✖` crash, `↻` restart, `⚠` warning.
- Windows-specific: `taskkill /T /F` kills the process tree (the `shell: true` creates an
  intermediate cmd/powershell, so killing only the direct pid would leave orphans).

## Gotchas

- `spawn(..., { shell: true })` is needed to resolve `.cmd`/`.bat` and PATH commands on
  Windows, but it creates an intermediate shell process — that's why stop uses `taskkill /T`.
- In-memory logs are capped at 200 lines per service; the full history lives in
  `logs/<id>.log` (appended across sessions).
- The `tcp` healthcheck reports `running` even if another terminal brought the service up
  (not our process). That's intentional: it reflects the reality of the port.
