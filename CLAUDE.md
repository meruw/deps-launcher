# CLAUDE.md

Guía para trabajar en este repo. Léela antes de hacer cambios.

## Qué es

Un panel local (web) para levantar y monitorear todos los microservicios de FastBank
desde un solo lugar, en vez de abrir una terminal por servicio. Corre en
`http://localhost:9999`.

**Principio clave: cero dependencias.** Todo usa módulos built-in de Node
(`http`, `child_process`, `net`, `fs`, `path`). No agregues paquetes npm sin una
razón fuerte — la gracia de esta herramienta es que se clona y corre con `node launcher.js`.

## Cómo correrlo

```sh
node launcher.js      # o: npm start
```

Abre el navegador solo. `Ctrl+C` apaga el launcher y mata todos los servicios hijos.

Requiere Node >= 16. Pensado para **Windows** (usa `taskkill` y `start`).

## Arquitectura

Entry point delgado + módulos con una sola responsabilidad. El flujo:

```
services.json   ── configuración declarativa de los servicios
      │
launcher.js     ── cablea todo y arranca el servidor
      ├── src/config.js          carga + valida services.json, sustituye ${ROOT}
      ├── src/logger.js          logs por servicio: ring buffer + archivo en logs/
      ├── src/health.js          healthchecks tcp / http / process
      ├── src/util.js            topoSort (orden por dependencias) + waitFor
      ├── src/process-manager.js spawn/stop/restart, crashes, auto-restart, deps
      └── src/server.js          servidor HTTP + API REST
index.html      ── la UI (vanilla JS, sin build, hace polling a /api/status cada 2s)
```

### Responsabilidades

- **config.js** — única fuente de verdad sobre qué servicios existen. Valida ids/puertos
  duplicados, dependencias inexistentes, tipos de health. Si algo está mal, el launcher
  no arranca y explica por qué.
- **process-manager.js** — el cerebro. Mantiene `procs`, `statuses` e `intent` por servicio.
- **server.js** — solo enruta HTTP → llamadas al process-manager. Sin lógica de negocio.
- **logger.js / health.js / util.js** — utilidades sin estado de dominio.

## Modelo de estado (process-manager)

Cada servicio tiene un `status` y un `intent` (lo que el usuario quiere) por separado.
Esa separación es lo que permite distinguir un **crash** de un **stop normal**.

| status     | significado                                          |
|------------|------------------------------------------------------|
| `stopped`  | no corre, nadie lo pidió                             |
| `starting` | lo arrancamos, todavía no pasa el healthcheck        |
| `running`  | healthcheck OK (o proceso vivo si `health=process`)  |
| `stopping` | pedimos pararlo, esperando que muera                 |
| `crashed`  | murió solo con `intent=up` (crash inesperado)        |

Los eventos del proceso (`close`) son la fuente de verdad para `stopped`/`crashed`.
`refresh()` (cada 2s) solo promueve `starting → running` y detecta servicios externos.

## Cómo agregar / cambiar un servicio

**No se toca código.** Editá `services.json` y reiniciá el launcher. Campos:

| campo         | req. | descripción                                                        |
|---------------|------|--------------------------------------------------------------------|
| `id`          | sí   | identificador único (usado en la API y los archivos de log)        |
| `cmd`         | sí   | ejecutable a correr                                                |
| `name`/`desc` | no   | texto para la UI                                                   |
| `port`        | no*  | puerto del servicio (requerido si `health.type` = `tcp`)           |
| `color`       | no   | color del acento en la card                                        |
| `cwd`         | no   | directorio de trabajo; admite `${ROOT}`                            |
| `args`        | no   | array de argumentos; cada uno admite `${ROOT}`                     |
| `health`      | no   | `{ "type": "tcp" \| "http" \| "process", "path": "/", "url": "" }` |
| `dependsOn`   | no   | array de ids que deben estar `running` antes de arrancar este      |
| `depTimeout`  | no   | ms a esperar por las dependencias (default 60000)                  |
| `autoRestart` | no   | valor **inicial** del toggle; reintenta al crashear (backoff, hasta `maxRestarts`). Se puede prender/apagar en vivo desde la UI; el cambio en runtime no se persiste al JSON |
| `maxRestarts` | no   | tope de auto-restarts (default 3)                                  |

`${ROOT}` se sustituye por el campo `root` de `services.json` (o la env var `FASTBANK_ROOT`).

### Tipos de healthcheck

- **`tcp`** (default): el puerto acepta conexiones. Rápido, sirve para la mayoría.
- **`http`**: un GET a `url` (o `http://localhost:{port}{path}`) devuelve status < 500.
  Útil cuando el puerto abre antes de que el servicio esté realmente listo
  (ej. un `/actuator/health` de Spring Boot).
- **`process`**: no se chequea por red; se considera `running` mientras el proceso viva.
  Para servicios sin endpoint trivial (ej. Azurite).

## API HTTP

| método | ruta                  | acción                                  |
|--------|-----------------------|-----------------------------------------|
| GET    | `/`                   | sirve la UI                             |
| GET    | `/api/status`         | snapshot de todos los servicios + logs  |
| GET    | `/api/logs/:id`       | últimas 200 líneas en memoria de un id  |
| POST   | `/api/start/:id`      | arranca un servicio                     |
| POST   | `/api/stop/:id`       | para un servicio                        |
| POST   | `/api/restart/:id`    | reinicia un servicio                    |
| POST   | `/api/autorestart/:id`| togglea el auto-restart (devuelve el nuevo valor) |
| POST   | `/api/start-all`      | arranca todo respetando dependencias    |
| POST   | `/api/stop-all`       | para todo en orden inverso              |

## Convenciones

- Comentarios y textos de UI en español, como el resto del repo.
- Indentación de 2 espacios, sin punto y coma al final (estilo del código existente).
- Mensajes de log con prefijos: `→` iniciando, `←` deteniendo, `✖` crash, `↻` restart, `⚠` warning.
- Específico de Windows: `taskkill /T /F` mata el árbol de procesos (el `shell: true` crea
  un cmd/powershell intermedio, así que matar solo el pid directo dejaría huérfanos).

## Gotchas

- `spawn(..., { shell: true })` es necesario para resolver `.cmd`/`.bat` y comandos del PATH
  en Windows, pero crea un proceso shell intermedio — por eso el stop usa `taskkill /T`.
- Los logs en memoria se limitan a 200 líneas por servicio; el historial completo queda en
  `logs/<id>.log` (se appendea entre sesiones).
- El healthcheck `tcp` da `running` aunque el servicio lo haya levantado otra terminal
  (no nuestro proceso). Es a propósito: refleja la realidad del puerto.
