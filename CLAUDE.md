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
services.json          ── service DEFINITIONS (committed): name, cmd, port, deps, ${ROOT}/${MVN} tokens
launcher.local.json    ── per-machine PATHS (git-ignored): root, tool paths, per-service overrides
      │
launcher.js     ── wires everything together and starts the server
      ├── src/config.js          merges services.json + launcher.local.json, substitutes tokens
      ├── src/logger.js          per-service logs: ring buffer + file in logs/
      ├── src/health.js          healthchecks tcp / http / process
      ├── src/util.js            topoSort (dependency ordering) + waitFor
      ├── src/process-manager.js spawn/stop/restart, crashes, auto-restart, deps
      └── src/server.js          HTTP server + REST API (incl. config + folder browser)
index.html      ── the UI (vanilla JS, no build, polls /api/status every 2s; Settings panel)
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

## Configuration & sharing

Config is split into two files so the repo can be shared (even made public) without
leaking anyone's machine paths:

- **`services.json`** (committed) — *what* the services are. Machine-agnostic: it uses
  `${ROOT}` and `${MVN}` tokens instead of real paths. Safe to share.
- **`launcher.local.json`** (git-ignored) — *where* they live on **this** machine: `root`,
  tool paths (`vars`), and optional per-service folder overrides (`paths`). Never committed.
  Auto-created on first run with defaults; `launcher.local.example.json` is the documented
  template for teammates.

Token resolution: any `${NAME}` in `services.json` is substituted from the local config
(`vars`), with built-in defaults. Current tokens:

| token            | default              | used for                                  |
|------------------|----------------------|-------------------------------------------|
| `${ROOT}`        | `%USERPROFILE%`      | base folder for every service's `cwd`     |
| `${MVN}`         | `mvn`                | path to Maven (FastBank's `cmd`)          |
| `${PROFILE}`     | `dev-local-postgres` | Spring Boot profile for FastBank          |
| `${DB_CONTAINER}`| `fastbank-postgres`  | Docker container name for the `postgres` service |
| `${DOCKER_DESKTOP}`| `...\Docker Desktop.exe` | launched to start the Docker engine when it's off |
| `${CORS_ORIGIN}` | `http://localhost:4200` | origin passed to the Azure Functions' `--cors` flag |

The launcher's own panel port (`uiPort`, default 9999) can also be overridden per-machine in
`launcher.local.json` (or from Settings) — it takes effect on the next launcher restart.

A `paths[<id>]` entry overrides that service's folder outright (this is what the **Settings**
folder browser writes). Resolution is recomputed live when config is saved, and applies the
next time a service starts.

**Postgres / the DB:** the `postgres` service starts your Docker container with
`docker start -a ${DB_CONTAINER}`, and FastBank `dependsOn` it (health `tcp:5432`). Because
the health check is port-based, it shows `running` whether the launcher started the container
or you did it by hand.

The launcher *can* start the Docker engine itself via the service's `ensure` block (token
`${DOCKER_DESKTOP}` → default `C:\Program Files\Docker\Docker\Docker Desktop.exe`). FastBank's
`depTimeout` is 180s to tolerate a cold Docker start.

### The `ensure` block (prerequisites)

Any service can declare a prerequisite that's checked/launched before it spawns:

```json
"ensure": {
  "label":   "Docker Desktop",                       // shown in logs
  "check":   "docker info",                          // command that exits 0 when ready
  "start":   "${DOCKER_DESKTOP}",                    // launched (detached) if the check fails
  "stop":    "docker desktop stop & wsl --shutdown", // optional teardown (see flag below)
  "timeout": 120000                                   // ms to wait for the check to pass
}
```

Flow: run `check`; if it passes, proceed instantly (no delay). If not, launch `start` and poll
`check` every 3s until it passes or `timeout` elapses — if it times out, the service is marked
`crashed` instead of spawning into a guaranteed failure. It's generic: reuse it for any
"make sure X is up first" need, not just Docker.

`ensure.stop` is the inverse: a command to tear the prerequisite down when the service is
stopped. It only runs when the local-config flag **`closeDockerOnStop`** is `true` (a Settings
toggle, default off) — so by default stopping Postgres stops the container but leaves Docker
Desktop running.

When on, the teardown is `docker desktop stop & wsl --shutdown`: the first stops the Docker
engine, the second tears down the WSL2 VM so its memory (the `Vmmem` process, often 1-3 GB) is
actually reclaimed — stopping the engine alone leaves that VM lingering. **Caveat:**
`wsl --shutdown` shuts down *all* WSL distros, not just Docker's; the `&` runs both
sequentially regardless of the first's exit code (cmd.exe semantics).

**Settings UI:** the ⚙ panel lets you set `root`, each service's folder (via a server-backed
folder browser — the Node backend lists real directories, since browsers can't expose native
folder paths), and the Maven path. It saves to `launcher.local.json`.

## How to add / change a service

**No code changes.** Edit `services.json` and restart the launcher. Use `${ROOT}` in `cwd`
(never absolute machine paths — those go in `launcher.local.json`). Fields:

| field         | req. | description                                                        |
|---------------|------|--------------------------------------------------------------------|
| `id`          | yes  | unique identifier (used in the API and log file names)             |
| `cmd`         | yes  | executable to run                                                  |
| `name`/`desc` | no   | text for the UI                                                    |
| `group`       | no   | layer section in the UI: `infra` / `backend` / `frontend` (default `other`) |
| `port`        | no*  | service port (required if `health.type` = `tcp`)                   |
| `color`       | no   | accent color on the card                                           |
| `cwd`         | no   | working directory; supports `${ROOT}`                              |
| `args`        | no   | array of arguments; each one supports `${ROOT}`                    |
| `health`      | no   | `{ "type": "tcp" \| "http" \| "process", "path": "/", "url": "" }` |
| `dependsOn`   | no   | array of ids that must be `running` before this one starts         |
| `depTimeout`  | no   | ms to wait for dependencies (default 60000)                        |
| `stop`        | no   | custom stop command (token-substituted). Used instead of `taskkill` for services we don't own as a process — e.g. `docker stop ${DB_CONTAINER}` |
| `ensure`      | no   | prerequisite to check/launch before spawning (see the `ensure` block below) |
| `autoRestart` | no   | **initial** value of the toggle; retries on crash (backoff, up to `maxRestarts`). Can be toggled live from the UI; the change is persisted **per-machine** to `launcher.local.json` (`autoRestart` map), never to the shared `services.json` |
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
| POST   | `/api/logs/:id/clear`  | clear a service's in-memory logs (file kept) |
| GET    | `/api/logs/:id/download` | download the full `logs/<id>.log` file       |
| POST   | `/api/start/:id`       | start a service                          |
| POST   | `/api/stop/:id`        | stop a service                           |
| POST   | `/api/restart/:id`     | restart a service                        |
| POST   | `/api/autorestart/:id` | toggle auto-restart (returns new value)  |
| POST   | `/api/start-all`       | start everything respecting dependencies |
| POST   | `/api/stop-all`        | stop everything in reverse order         |
| GET    | `/api/config`          | read local config (root, vars, paths)    |
| POST   | `/api/config`          | save local config + re-resolve paths live|
| GET    | `/api/browse?path=`    | list drives / subfolders (folder browser)|

## Conventions

- Comments and UI text in English.
- 2-space indentation, no trailing semicolons (matches the existing code style).
- Log messages with prefixes: `→` starting, `←` stopping, `✖` crash, `↻` restart, `⚠` warning.
- Windows-specific: `taskkill /T /F` kills the process tree (the `shell: true` creates an
  intermediate cmd/powershell, so killing only the direct pid would leave orphans).

## Security

This is a **local dev tool**, not a networked service. The API has **no authentication**
and can start/stop processes on the host, so it must stay reachable only from this machine:

- The HTTP server binds to **`127.0.0.1`** (loopback), never `0.0.0.0`. Don't change the
  `server.listen(...)` host or remove it — omitting it makes Node listen on all interfaces,
  exposing the API to anyone on the same network.
- **No CORS headers** are sent. The UI is same-origin, so it doesn't need them; adding
  `Access-Control-Allow-Origin: *` would let any website you visit drive the API from your
  browser (a drive-by attack on the local service).
- **CSRF: POST requests are Origin-checked.** Dropping CORS doesn't stop a browser from
  *sending* a cross-origin POST (it only blocks reading the response), so `server.js`
  rejects any POST whose `Origin` header isn't our own UI (403). Requests with no Origin
  (curl, native clients) pass — there are no cookies to forge against.
- `services.json` contains absolute machine paths — keep the repo **private**.

If you ever need real remote access, put it behind a reverse proxy with auth — don't loosen
the bind/CORS/Origin checks here.

## Gotchas

- `spawn(..., { shell: true })` is needed to resolve `.cmd`/`.bat` and PATH commands on
  Windows, but it creates an intermediate shell process — that's why stop uses `taskkill /T`.
- In-memory logs are capped at 200 lines per service; the full history lives in
  `logs/<id>.log` (appended across sessions). The UI's **Clear** button only wipes the
  in-memory buffer (`logger.clear`), not the file. The log toolbar's level filter and
  search are purely client-side over those in-memory lines.
- The `tcp` healthcheck reports `running` even if another terminal brought the service up
  (not our process). That's intentional: it reflects the reality of the port.
