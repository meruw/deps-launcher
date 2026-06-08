# FastBank Launcher

Panel local para levantar todos los microservicios de FastBank desde un solo lugar.

![estado](https://img.shields.io/badge/deps-cero-brightgreen)

## Uso

```sh
node launcher.js     # o: npm start
```

Abre `http://localhost:9999` automáticamente. Desde ahí:

- **Start All** arranca todo respetando el orden de dependencias.
- Cada servicio tiene **Start / Restart (↻) / Stop** individuales.
- LED de estado en vivo: corriendo, iniciando, detenido, **caído**.
- Logs por servicio (colapsables), también guardados en `logs/<id>.log`.

`Ctrl+C` en la terminal apaga el launcher y mata todos los servicios.

## Agregar un servicio

Edita [`services.json`](services.json) y reinicia. No hay que tocar código.
Ver [CLAUDE.md](CLAUDE.md) para el detalle de cada campo y la arquitectura.

## Requisitos

Node >= 16. Pensado para Windows. Cero dependencias npm.
