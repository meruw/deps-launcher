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

## Add a service

Edit [`services.json`](services.json) and restart. No code changes needed.
See [CLAUDE.md](CLAUDE.md) for the detail of each field and the architecture.

## Requirements

Node >= 16. Built for Windows. Zero npm dependencies.
