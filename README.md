# SwissVideo

![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?style=flat-square&logo=tauri)
![Rust](https://img.shields.io/badge/Rust-1.70%2B-DEA584?style=flat-square&logo=rust)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)

Compresor de video profesional para escritorio. Alternativa ligera y directa a Handbrake, enfocada en transcodificación rápida con aceleración por hardware y control fino sobre codecs, cortes y audio. Construido con **Tauri v2 + Rust + FFmpeg** — binario pequeño, bajo consumo de RAM y sin la sobrecarga de Electron (V2 migra desde la V1 en Electron).

> **Estado:** funcional en Windows 10/11. Requiere FFmpeg externo (ver [Prerrequisitos](#prerrequisitos)).

> **⚠️ Transparencia — asistencia de IA:** este proyecto fue desarrollado con **asistencia pesada de LLM** (Muse Spark / OpenCode) para arquitectura, implementación en Rust/JS y depuración. El autor (estudiante de 1er semestre, Ing. de Sistemas — UNAL Medellín) entiende a alto nivel qué hace cada módulo, pero **gran parte del código aún no es de autoría plenamente comprendida línea por línea**. Se publica con honestidad como proyecto de aprendizaje. **Plan actual:** estudiar a fondo cada parte (pipeline FFmpeg, Tauri IPC, manejo de estado) y **reescribir/refactorizar progresivamente todo el código con comprensión propia**. Issues y PRs que señalen código confuso o mejorable son bienvenidos — ayudan a ese aprendizaje.

## Capturas

> Placeholders — los mockups de diseño están en [`design/`](design/):
> - `design/app-redesign.html` — layout general de la app
> - `design/codec-selector.html` — variantes del selector de codec (diseño A elegido)
> - `design/swiss-squared.html` — exploraciones de estilo visual
>
> Para captura real, ejecutar `npm run tauri dev` y tomar screenshot de 1400×900. Recomendado guardar en `design/screenshots/` (no incluido en el repo por defecto).

## Características

- **Detección automática de GPU** — parsea `ffmpeg -encoders` y habilita:
  - NVIDIA NVENC (`h264_nvenc`, `hevc_nvenc`, `av1_nvenc`)
  - AMD AMF (`h264_amf`, `hevc_amf`, `av1_amf`)
  - Intel QuickSync (`h264_qsv`, `hevc_qsv`, `av1_qsv`)
  - Fallback CPU (`libx264`, `libx265`, `libsvtav1`, `libvpx-vp9`)
- **Cola batch** — añade múltiples archivos, cada ítem guarda corte y pistas de audio seleccionadas. Modo lote (`start_queue`) procesa la cola secuencialmente con progreso `queue-progress` / `queue-finished`. Soporta drag & drop y sonda de audio en background por ítem.
- **Presets** — CRUD persistido en `app_config_dir/presets.json`. Incluye 6 por defecto: WhatsApp, Discord 10MB, Clips Rápidos, Archivado, Web y Móvil. Import/export JSON, restauración a defaults. Mapeo de `preset_idx` 0–8 a cada backend (NVENC p1–p7, AMF speed/balanced/quality, QSV veryfast–veryslow, SVT-AV1 13–0).
- **Corte / Trim** — selección de rango con timeline interactivo (`CutInlineBox`, marcadores `markerStart/End`, `playerTimeline`). Parámetros `-ss` / `-to` / `-t` con preview en `<video>` vía `convertFileSrc` (asset protocol).
- **Selección de pistas de audio** — lista basada en `ffprobe` (`audio_tracks: Vec<AudioTrack>` con `index`, `codec`, `channels`, `language`, `title`). Selección múltiple con checkboxes custom (`AudioCheck`), control de volumen por pista 0–200% (`VolumeSlider` + `VolumeMuteBtn`) y mezcla audible en preview vía `extract_audio_preview` (WAV temporal + Web Audio API con `amix` o `volume` filter_complex). Estado por ítem (`audio_tracks: Option<Vec<u32>>`, `audio_volumes: HashMap<u32,f32>`) y anti-crash con `-map 0:N?`.
- **Selector de codec** — familias H.264/H.265/AV1/VP9 + motor CPU/GPU. Segmento superior con 3 encoders más usados (`codec_usage.json` + fallback `libx264/libx265/libsvtav1`) y dropdown **Otros** con búsqueda y scroll para el catálogo completo (`video_encoders: Vec<String>` extraído de `ffmpeg -encoders`). Guard de disponibilidad vía `AvailableCodecs` y fallback automático.
- **Historial** — últimas 50 compresiones en `history.json` (entrada/salida, MB original/salida/ahorrados, ratio, codec, calidad). Vista acordeón con ahorro total.
- **Pipeline FFmpeg completo** — calidad CQ/CQP/VBR/CBR con mapeos correctos por vendor (AMD `-rc cqp -qp_i/-qp_p`, NVIDIA `-cq`, Intel `-global_quality`, CPU `-crf`), presets, escalado `-vf scale=`, fps `-r`, corte, audio AAC 192k / Opus 96k para VP9, `-movflags +faststart`. Progreso en tiempo real parseando `stderr` (`frame=`, `fps=`, `time=`, `speed=`, `size=`) con `ProgressThrottle` 100 ms.

## Stack

| Capa | Tecnología | Versión |
|------|------------|---------|
| Frontend | Vanilla JS + Vite | Vite 6 |
| Backend | Rust + Tauri v2 | Tauri 2.0, Rust 2024 edition |
| Diálogo / FS | `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs` | 2.x |
| Transcodificación | FFmpeg + FFprobe (externo) | cualquier build reciente |
| Empaquetado | NSIS (Windows) | `bundle.targets: ["nsis"]` |

## Prerrequisitos

- **Node.js** 18+ y **Rust** estable (cargo)
- **FFmpeg + FFprobe** accesibles por uno de estos medios (en orden de búsqueda en `src-tauri/src/lib.rs:find_tool`):
  1. En `PATH` (`ffmpeg --help` debe funcionar)
  2. `C:\ffmpeg\bin\ffmpeg.exe` / `ffprobe.exe`
  3. `C:\Program Files\ffmpeg\bin\`
  4. `C:\Program Files (x86)\ffmpeg\bin\`

> Verificá con `ffmpeg -encoders | findstr nvenc` y `ffprobe -version`. Si no están en PATH, instalá desde [ffmpeg.org](https://ffmpeg.org/download.html) o vía `choco install ffmpeg` / `scoop install ffmpeg`.

## Instalación y uso

```bash
# 1. Clonar
git clone https://github.com/<usuario>/SwissVideo.git
cd SwissVideo

# 2. Dependencias frontend
npm install

# 3. Desarrollo (Vite + Tauri con hot-reload)
npm run tauri dev

# 4. Solo frontend (sin backend Rust)
npm run dev

# 5. Build de producción — genera instalador NSIS en src-tauri/target/release/bundle/
npm run tauri build

# 6. Solo Rust (compilación / tests)
cd src-tauri
cargo build
cargo test
```

Salida de `cargo test` esperada (17 tests): `atomic_write_json`, `ProgressThrottle`, parsing de progreso FFmpeg, volumetría por pista y deserialización flexible de `audio_volumes` (mapa o array).

## Estructura de archivos

```
SwissVideo/
├── index.html                 # UI — 3 columnas + bottom bar + modales
├── src/
│   ├── main.js                # Frontend: invoke() ↔ backend, cola, preview, audio mix
│   └── styles.css             # Tema oscuro (Signal Tape), variables --Accent/--Panel/--Text
├── src-tauri/
│   ├── Cargo.toml             # Dependencias Rust (tauri 2, serde, tokio, windows-sys)
│   ├── tauri.conf.json        # Config Tauri (ventana 1400×900, CSP, bundle NSIS)
│   ├── icons/icon.ico         # Icono del instalador
│   └── src/
│       ├── main.rs            # Entry point → lib::run()
│       └── lib.rs             # Comandos Tauri + pipeline FFmpeg + tests
├── design/
│   ├── app-redesign.html      # Mockup layout
│   ├── codec-selector.html    # Mockup selector de codec
│   └── swiss-squared.html     # Exploración visual
├── vite.config.js             # Dev server puerto 1420, HMR
└── package.json               # Scripts npm (dev/build/tauri)
```

### Comandos Tauri expuestos (`src-tauri/src/lib.rs`)

| Comando | Descripción |
|---------|-------------|
| `detect_gpu` | Parsea `ffmpeg -encoders` → `nvidia`/`amd`/`intel`/`cpu` |
| `check_ffmpeg` | Retorna `FfmpegCapabilities` (gpu, lista completa `video_encoders`, flags por codec, `usage`) |
| `get_video_info(path)` | `ffprobe -print_format json` → `VideoInfo` |
| `start_encode(params)` | Construye y spawnea FFmpeg, emite `encode-started`/`encode-progress`/`encode-finished` |
| `stop_encode` | `TerminateProcess` / `taskkill` del PID en `enc_pid` |
| `start_queue` / `stop_queue` | Batch secuencial con `queue-progress` por ítem |
| `get_presets` / `save_preset` / `delete_preset` / `reset_default_presets` | Persistencia en `presets.json` (atomic write) |
| `get_history` | Lee `history.json` (últimas 50) |
| `save_codec_usage` | Actualiza `codec_usage.json` para ranking del selector |
| `verificar_nombre_salida` | Detecta colisión y propone ` (2)`… |
| `extract_audio_preview` / `cleanup_audio_preview` | WAV temporales en `%TEMP%/swissvideo_preview/` para preview audible |

## Notas técnicas

### Mapeo de codecs y calidad

- **CQ (Constant Quality)** — modo por defecto (`rate_control: "cq"`):
  - AMD AMF: `-rc cqp -qp_i N -qp_p N` (AV1 `N = quality*4`, resto `min(quality,51)`)
  - NVIDIA: `-cq N`
  - Intel QSV: `-global_quality N`
  - CPU: `-crf N`
- **VBR / CBR** — usan `-b:v` + flags por vendor (`-rc vbr_peak` / `cbr` en AMF, `-cbr 1` en NVENC, `-minrate/-maxrate/-bufsize` en CPU).
- **Presets** — índice 0–8 → nombres en `lib.rs:1093`:
  - AMF AV1: `0=100` (más rápido) … `8=0` (mejor calidad); AMF HEVC: `10`…`0`; AMF H264: `1=speed,0=balanced,2=quality`
  - NVENC: `[1,1,2,3,4,5,6,7,7]` → `-preset pN`
  - QSV: clamp a `veryfast`–`veryslow` (7 niveles)
  - SVT-AV1: `13 - idx` (0=lento/mejor) + `-svtav1-params tune=0` (VQ)
  - VP9: `-cpu-used = 5 - min(idx,5)`
- **Resolución/FPS** — `-vf scale=W:H` y `-r N` solo si no es `"original"`.
- **Corte** — `-ss` antes de `-i` (seek rápido) y `-t`/`-to` según si hay inicio+fin o solo fin.

### Plantillas de nombre

`name_template` soporta tokens `{nombre}`, `{codec}`, `{qp}`, `{res}`, `{fps}`, `{fecha}` (ver `process_name_template` en `lib.rs:719`). Se sanitiza con `sanitize_filename` y extensión `webm` para VP9, `mp4` para el resto.

### Persistencia

`atomic_write_json` escribe a `.tmp` + `rename` para evitar JSON corrupto si el proceso muere a mitad de escritura. Tests dedicados en `lib.rs` lo verifican.

## Licencia

MIT © 2026 Migue Echeverri. Ver [`LICENSE`](LICENSE).
