# SwissVideo

![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?style=flat-square&logo=tauri)
![Rust](https://img.shields.io/badge/Rust-1.70%2B-DEA584?style=flat-square&logo=rust)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)

Professional desktop video compressor. Lightweight, no-nonsense alternative to Handbrake, focused on fast hardware-accelerated transcoding and fine-grained control over codecs, trimming and audio. Built with **Tauri v2 + Rust + FFmpeg** — small binary, low RAM, no Electron overhead (V2 is a port of the Electron-based V1).

> **Status:** works on Windows 10/11. Requires external FFmpeg (see [Prerequisites](#prerequisites)).

> **⚠️ Transparency — heavy AI assistance:** this project was built with **heavy LLM assistance** for architecture, Rust/JS implementation and debugging. The author (1st-semester Systems Engineering student) understands the high-level purpose of each module, but **large parts of the codebase are not yet fully understood line-by-line by the author**. It is published honestly as a learning project. **Current plan:** deeply study each part (FFmpeg pipeline, Tauri IPC, state handling) and **progressively rewrite/refactor all code with full personal understanding**. Issues and PRs pointing out confusing or improvable code are welcome — they help that learning.

## Screenshots

> Placeholders — design mockups are in [`design/`](design/):
> - `design/app-redesign.html` — general app layout
> - `design/codec-selector.html` — codec selector variants (design A chosen)
> - `design/swiss-squared.html` — visual explorations
>
> For a real screenshot, run `npm run tauri dev` and capture 1400×900. Recommended location `design/screenshots/` (not tracked by default).

## Features

- **Automatic GPU detection** — parses `ffmpeg -encoders` and enables:
  - NVIDIA NVENC (`h264_nvenc`, `hevc_nvenc`, `av1_nvenc`)
  - AMD AMF (`h264_amf`, `hevc_amf`, `av1_amf`)
  - Intel QuickSync (`h264_qsv`, `hevc_qsv`, `av1_qsv`)
  - CPU fallback (`libx264`, `libx265`, `libsvtav1`, `libvpx-vp9`)
- **Batch queue** — add multiple files, each item keeps its own trim and audio selection. Batch mode (`start_queue`) processes the queue sequentially with `queue-progress` / `queue-finished` events. Drag & drop + background audio probing per item.
- **Presets** — CRUD persisted in `app_config_dir/presets.json`. 6 defaults: WhatsApp, Discord 10MB, Fast Clips, Archive, Web and Mobile. Import/export JSON, restore defaults. `preset_idx` 0–8 maps to each backend (NVENC p1–p7, AMF speed/balanced/quality, QSV veryfast–veryslow, SVT-AV1 13–0).
- **Trim / Cut** — range selection with interactive timeline (`CutInlineBox`, markers `markerStart/End`, `playerTimeline`). Uses `-ss` / `-to` / `-t` and live preview via `<video>` with `convertFileSrc` (asset protocol).
- **Audio track selection** — enumerated via `ffprobe` (`audio_tracks: Vec<AudioTrack>` with `index`, `codec`, `channels`, `language`, `title`). Multi-select with custom checkboxes (`AudioCheck`), per-track volume 0–200% (`VolumeSlider` + `VolumeMuteBtn`) and audible preview via `extract_audio_preview` (temp WAV + Web Audio API with `amix` or `volume` filter_complex). Per-item state (`audio_tracks: Option<Vec<u32>>`, `audio_volumes: HashMap<u32,f32>`) and crash-safe `-map 0:N?`.
- **Codec selector** — families H.264/H.265/AV1/VP9 + engine CPU/GPU. Top segment shows 3 most-used encoders (`codec_usage.json` + fallback `libx264/libx265/libsvtav1`) and **Others** dropdown with search + scroll for the full catalog (`video_encoders: Vec<String>` from `ffmpeg -encoders`). Availability guard via `AvailableCodecs` with automatic fallback.
- **History** — last 50 encodes in `history.json` (input/output, original/output MB, saved, ratio, codec, quality). Accordion view with total saved.
- **Full FFmpeg pipeline** — quality CQ/CQP/VBR/CBR with correct vendor mappings (AMD `-rc cqp -qp_i/-qp_p`, NVIDIA `-cq`, Intel `-global_quality`, CPU `-crf`), presets, scale `-vf scale=`, fps `-r`, trim, audio AAC 192k / Opus 96k for VP9, `-movflags +faststart`. Real-time progress by parsing `stderr` (`frame=`, `fps=`, `time=`, `speed=`, `size=`) with `ProgressThrottle` 100 ms.

## Stack

| Layer | Technology | Version |
|-------|------------|---------|
| Frontend | Vanilla JS + Vite | Vite 6 |
| Backend | Rust + Tauri v2 | Tauri 2.0, Rust 2024 edition |
| Dialog / FS | `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs` | 2.x |
| Transcoding | FFmpeg + FFprobe (external) | any recent build |
| Packaging | NSIS (Windows) | `bundle.targets: ["nsis"]` |

## Prerequisites

- **Node.js** 18+ and **Rust** stable (cargo)
- **FFmpeg + FFprobe** reachable via one of these (search order in `src-tauri/src/lib.rs:find_tool`):
  1. On `PATH` (`ffmpeg --help` should work)
  2. `C:\ffmpeg\bin\ffmpeg.exe` / `ffprobe.exe`
  3. `C:\Program Files\ffmpeg\bin\`
  4. `C:\Program Files (x86)\ffmpeg\bin\`

> Verify with `ffmpeg -encoders | findstr nvenc` and `ffprobe -version`. If not on PATH, install from [ffmpeg.org](https://ffmpeg.org/download.html) or via `choco install ffmpeg` / `scoop install ffmpeg`.

## Installation & Usage

```bash
# 1. Clone
git clone https://github.com/<user>/SwissVideo.git
cd SwissVideo

# 2. Frontend deps
npm install

# 3. Dev (Vite + Tauri with hot-reload)
npm run tauri dev

# 4. Frontend only (no Rust backend)
npm run dev

# 5. Production build — NSIS installer in src-tauri/target/release/bundle/
npm run tauri build

# 6. Rust only (build / tests)
cd src-tauri
cargo build
cargo test
```

Expected `cargo test` (17 tests): `atomic_write_json`, `ProgressThrottle`, FFmpeg progress parsing, per-track volume and flexible `audio_volumes` deserialization (map or array).

## File Structure

```
SwissVideo/
├── index.html                 # UI — 3 columns + bottom bar + modals
├── src/
│   ├── main.js                # Frontend: invoke() ↔ backend, queue, preview, audio mix
│   └── styles.css             # Dark theme (Signal Tape), vars --Accent/--Panel/--Text
├── src-tauri/
│   ├── Cargo.toml             # Rust deps (tauri 2, serde, tokio, windows-sys)
│   ├── tauri.conf.json        # Tauri config (1400×900 window, CSP, NSIS bundle)
│   ├── icons/icon.ico         # Installer icon
│   └── src/
│       ├── main.rs            # Entry → lib::run()
│       └── lib.rs             # Tauri commands + FFmpeg pipeline + tests
├── design/
│   ├── app-redesign.html      # Layout mockup
│   ├── codec-selector.html    # Codec selector mockup
│   └── swiss-squared.html     # Visual exploration
├── vite.config.js             # Dev server port 1420, HMR
└── package.json               # npm scripts (dev/build/tauri)
```

### Exposed Tauri commands (`src-tauri/src/lib.rs`)

| Command | Description |
|---------|-------------|
| `detect_gpu` | Parses `ffmpeg -encoders` → `nvidia`/`amd`/`intel`/`cpu` |
| `check_ffmpeg` | Returns `FfmpegCapabilities` (gpu, full `video_encoders` list, per-codec flags, `usage`) |
| `get_video_info(path)` | `ffprobe -print_format json` → `VideoInfo` |
| `start_encode(params)` | Builds and spawns FFmpeg, emits `encode-started`/`encode-progress`/`encode-finished` |
| `stop_encode` | `TerminateProcess` / `taskkill` the PID in `enc_pid` |
| `start_queue` / `stop_queue` | Sequential batch with `queue-progress` per item |
| `get_presets` / `save_preset` / `delete_preset` / `reset_default_presets` | Persisted in `presets.json` (atomic write) |
| `get_history` | Reads `history.json` (last 50) |
| `save_codec_usage` | Updates `codec_usage.json` for selector ranking |
| `verificar_nombre_salida` | Collision check and suggests ` (2)`… |
| `extract_audio_preview` / `cleanup_audio_preview` | Temp WAVs in `%TEMP%/swissvideo_preview/` for audible preview |

## Technical Notes

### Codec & quality mapping

- **CQ (Constant Quality)** — default (`rate_control: "cq"`):
  - AMD AMF: `-rc cqp -qp_i N -qp_p N` (AV1 `N = quality*4`, else `min(quality,51)`)
  - NVIDIA: `-cq N`
  - Intel QSV: `-global_quality N`
  - CPU: `-crf N`
- **VBR / CBR** — use `-b:v` + vendor flags (`-rc vbr_peak` / `cbr` on AMF, `-cbr 1` on NVENC, `-minrate/-maxrate/-bufsize` on CPU).
- **Presets** — index 0–8 → names in `lib.rs:1093`:
  - AMF AV1: `0=100` (fastest) … `8=0` (best quality); AMF HEVC: `10`…`0`; AMF H264: `1=speed,0=balanced,2=quality`
  - NVENC: `[1,1,2,3,4,5,6,7,7]` → `-preset pN`
  - QSV: clamp to `veryfast`–`veryslow` (7 levels)
  - SVT-AV1: `13 - idx` (0=slow/best) + `-svtav1-params tune=0` (VQ)
  - VP9: `-cpu-used = 5 - min(idx,5)`
- **Resolution/FPS** — `-vf scale=W:H` and `-r N` only if not `"original"`.
- **Trim** — `-ss` before `-i` (fast seek) and `-t`/`-to` depending on start+end or end-only.

### Filename templates

`name_template` supports tokens `{nombre}`, `{codec}`, `{qp}`, `{res}`, `{fps}`, `{fecha}` (see `process_name_template` in `lib.rs:719`). Sanitized with `sanitize_filename` and extension `webm` for VP9, `mp4` otherwise.

### Persistence

`atomic_write_json` writes to `.tmp` + `rename` to avoid corrupt JSON if the process dies mid-write. Dedicated tests in `lib.rs` verify it.

## License

MIT © 2026 Migue Echeverri. See [`LICENSE`](LICENSE).
