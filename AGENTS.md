# SwissVideo V2 — Contexto para IA

## Visión General

Compresor de video profesional. V2 migra de Electron+JS a **Tauri v2 + Rust** para
eliminar las limitaciones de Electron (memoria, tamaño binario, rendimiento).

## Arquitectura

```
Frontend (Vanilla JS + Vite)  ← invoke() →  Rust Backend (Tauri v2)
       │                                           │
  index.html, main.js, styles.css              lib.rs (comandos)
       │                                           │
  @tauri-apps/api (invoke)                    spawn FFmpeg/FFprobe
```

## Comandos

| Comando | Descripción |
|---------|-------------|
| `npm run tauri dev` | Dev con hot-reload + backend Rust |
| `npm run tauri build` | Build release (instalador .exe/.msi) |
| `npm run dev` | Solo frontend Vite |
| `cd src-tauri && cargo build` | Solo compilar Rust |
| `cd src-tauri && cargo test` | Tests Rust |

## Estructura de Archivos Clave

- `src-tauri/src/lib.rs` — Todos los comandos Tauri (backend lógica FFmpeg)
- `src-tauri/src/main.rs` — Entry point (`fn main` llama a `run()`)
- `src/main.js` — Frontend, invoca comandos via `invoke("comando", {args})`
- `src/index.html` — UI con paneles: archivo, configuración, progreso
- `src/styles.css` — Tema oscuro, variables CSS, layout flex

## Comandos Tauri Implementados

### detect_gpu
- Ejecuta `ffmpeg -encoders`, busca nvenc/amf/qsv
- Retorna: `"nvidia" | "amd" | "intel" | "cpu"`

### get_video_info(path)
- Ejecuta `ffprobe -v quiet -print_format json -show_streams -show_format`
- Retorna: `VideoInfo` struct con duración, resolución, fps, codec, pistas audio

### start_encode(params)
- Construye comando FFmpeg según params:
  - Codec (libx264/libx265/libsvtav1) con mapeo a GPU (nvenc/amf/qsv)
  - Calidad CRF/CQ/CQP según GPU
  - Preset mapeado según tipo de GPU
  - Resolución via `-vf scale=`
  - FPS via `-r`
  - Corte via `-ss` / `-to`
  - Audio AAC 192k
  - `-movflags +faststart`
- Spawnea proceso, emite evento `encode-started`

### stop_encode
- Mata proceso FFmpeg via `taskkill /T /F` en Windows, SIGTERM en Unix

### Presets CRUD
- `get_presets` / `save_preset` / `delete_preset` / `reset_default_presets`
- Persistencia en JSON en `app_config_dir/`
- Defaults: discord, clips, archive, web, mobile

### get_history
- Lee `history.json`, retorna últimas 50 entradas con total MB ahorrados

## Convenciones de Código

### Rust
- `snake_case` para funciones y variables
- `CamelCase` para structs y enums
- `unwrap()` solo en setup; usar `map_err` + `?` en comandos Tauri
- Mutex para estado compartido (`AppState`)
- Serde para serialización de structs

### JavaScript
- `camelCase` para variables y funciones
- `PascalCase` solo para clases
- Funciones async con try/catch
- `$("id")` helper para `document.getElementById`

### Pipeline de Compresión (FFmpeg)

1. Detectar GPU → mapear codec CPU a GPU
2. Construir args: `-c:v`, calidad, preset, scale, fps, corte, audio
3. `Command::new("ffmpeg").args([...]).spawn()`
4. Pipe stderr para parsear progreso (frame, fps, time, speed, size)
5. Monitor tamaño archivo cada 1s
6. Al close: calcular factor compresión, guardar history

## Notas Técnicas

- FFmpeg buscado en: `C:\ffmpeg\bin\`, `C:\Program Files\ffmpeg\bin\`, PATH
- GPU AMD usa `-rc cqp -qp_i N -qp_p N`
- GPU NVIDIA usa `-cq N`
- GPU Intel usa `-preset` + `-global_quality`
- CPU usa `-crf N -preset name`
- AV1 CPU preset mapea 0-8 → 13-0 (SVT-AV1)
- NVENC preset mapea 0-8 → p1-p7
- AMD AMF preset mapea a speed/balanced/quality

## Mejoras Pendientes para V2 (Roadmap)

- [ ] Eventos de progreso en tiempo real (emit desde hilo separado)
- [ ] Cola de archivos (array + ProcessNextInQueue como en V1)
- [ ] Cálculo de bitrate para tamaño objetivo
- [ ] Drag & drop de archivos
- [ ] Pipeline AV1 con parámetros tuneados
- [ ] Tests unitarios en Rust

## Memoria del usuario
- SwissVideo es un compresor de video basado en Electron/FFmpeg, con cola de procesamiento por lotes (batch queue), presets, corte/recorte (cut/trim) y selección de pista de audio, con memoria de audio por ítem.
- Se está portando de Electron a Tauri, con estilo inspirado en ColorDubber, usando una IA local para el desarrollo.
- Enfoque de trabajo: primero la capa gráfica/visual, luego corrección de bugs.
- Bugs ya resueltos: la vista previa de video no cargaba; el audio no se incluía correctamente al comprimir; el botón cancelar/detener no funcionaba en codificaciones de un solo archivo (causa: faltaba el listener del evento `encode-started` en main.js).
- Estado actual: se realizaron pruebas para encontrar los presets por defecto más óptimos; el usuario considera la app terminada tras el último fix.
