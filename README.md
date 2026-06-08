# FastBank Launcher

A local panel to start all microservices from a single place.

![deps](https://img.shields.io/badge/deps-zero-brightgreen)

## Usage

```sh
node launcher.js     # or: npm start
```

Opens `http://localhost:9999` automatically. From there:

- **Start All** starts everything respecting the dependency order.
- Each service has individual **Start / Restart (↻) / Stop**.
- Per-service **Auto-restart on crash** toggle.
- Live status LED: running, starting, stopped, **crashed**.
- Per-service logs (collapsible), also saved to `logs/<id>.log`.

`Ctrl+C` in the terminal shuts down the launcher and kills all services.

## Setup (per machine)

The first run creates `launcher.local.json` (git-ignored) with default paths. Point it at
your folders from the **⚙ Settings** panel — set the root, each service's folder (via the
folder browser), and your Maven path. Or copy [`launcher.local.example.json`](launcher.local.example.json)
and edit it by hand.

Your paths never get committed, so the repo is safe to share with teammates: everyone clones
it and configures their own `launcher.local.json`.

## Add a service

Edit [`services.json`](services.json) and restart. No code changes needed. Use `${ROOT}` in
`cwd` instead of absolute paths. See [CLAUDE.md](CLAUDE.md) for each field and the architecture.

## Requirements

Node >= 16. Built for Windows. Zero npm dependencies.
