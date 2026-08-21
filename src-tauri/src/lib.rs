use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
fn create_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(program);
    cmd.creation_flags(0x08000000);
    cmd
}

#[cfg(not(windows))]
fn create_command(program: &str) -> Command {
    Command::new(program)
}

// ==================== ESTADOS ====================

struct AppState {
    is_encoding: Mutex<bool>,
    presets: Mutex<HashMap<String, Preset>>,
    presets_file: Mutex<PathBuf>,
    history_file: Mutex<PathBuf>,
    usage_file: Mutex<PathBuf>,
    queue_processing: Mutex<bool>,
    queue_stop_flag: Mutex<bool>,
    stop_requested: AtomicBool,
    enc_pid: AtomicU32,
}

fn default_rate_control() -> String { "cq".into() }

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Preset {
    name: String,
    description: String,
    codec: String,
    quality: u32,
    preset_idx: u32,
    resolution: String,
    fps: String,
    bitrate: u32,
    #[serde(default = "default_rate_control")]
    rate_control: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct VideoInfo {
    filename: String,
    path: String,
    duration_seconds: f64,
    duration_str: String,
    size_mb: f64,
    resolution: String,
    width: u32,
    height: u32,
    fps: String,
    video_codec: String,
    audio_tracks: Vec<AudioTrack>,
    format: String,
    bitrate: f64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct AudioTrack {
    index: u32,
    codec: String,
    channels: u32,
    language: String,
    title: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HistoryEntry {
    timestamp: String,
    input: String,
    output: String,
    original_mb: f64,
    output_mb: f64,
    saved_mb: f64,
    ratio: f64,
    codec: String,
    quality: u32,
    rate_control: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct FfmpegCapabilities {
    gpu: String,
    video_encoders: Vec<String>,
    libx264: bool,
    libx265: bool,
    libsvtav1: bool,
    libvpx_vp9: bool,
    h264_nvenc: bool,
    hevc_nvenc: bool,
    av1_nvenc: bool,
    h264_amf: bool,
    hevc_amf: bool,
    av1_amf: bool,
    h264_qsv: bool,
    hevc_qsv: bool,
    av1_qsv: bool,
    usage: HashMap<String, u32>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct EncodeParams {
    input_path: String,
    output_dir: Option<String>,
    codec: String,
    quality: u32,
    preset_idx: u32,
    resolution: String,
    fps: String,
    bitrate: u32,
    rate_control: String,
    cut_start: Option<String>,
    cut_end: Option<String>,
    name_template: Option<String>,
    audio_tracks: Option<Vec<u32>>,
    custom_mix: Option<bool>,
    output_override: Option<String>,
}

#[derive(Serialize)]
pub struct NombreSalidaInfo {
    existe: bool,
    salida: String,
    alternativo: Option<String>,
}

#[derive(Clone, Deserialize)]
pub struct QueueItem {
    input_path: String,
    output_dir: Option<String>,
    cut_start: Option<String>,
    cut_end: Option<String>,
    audio_tracks: Option<Vec<u32>>,
    output_override: Option<String>,
}

// Parámetros compartidos por todos los ítems de la cola (sin input_path/output_dir/cortes,
// que son propios de cada archivo y viajan en QueueItem).
#[derive(Clone, Deserialize)]
pub struct QueueBaseParams {
    codec: String,
    quality: u32,
    preset_idx: u32,
    resolution: String,
    fps: String,
    bitrate: u32,
    rate_control: String,
    name_template: Option<String>,
    audio_tracks: Option<Vec<u32>>,
    custom_mix: Option<bool>,
}

// ==================== UTILIDADES FFMPEG ====================

fn find_tool(name: &str) -> String {
    // Try bare name first (resolves via PATH — covers chocolatey, conda, scoop, etc.)
    let bare = name.to_string();
    let check = create_command(&bare).arg("--help").stdout(Stdio::null()).stderr(Stdio::null()).status();
    if check.is_ok() && check.unwrap().success() {
        return bare;
    }

    // Fallback: hardcoded paths
    let candidates = vec![
        format!(r"C:\ffmpeg\bin\{}.exe", name),
        format!(r"C:\Program Files\ffmpeg\bin\{}.exe", name),
        format!(r"C:\Program Files (x86)\ffmpeg\bin\{}.exe", name),
    ];

    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return path.clone();
        }
    }

    bare
}

fn detect_gpu_internal() -> String {
    let ffmpeg = find_tool("ffmpeg");
    let output = create_command(&ffmpeg)
        .arg("-encoders")
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let has_nvenc = stdout.contains("nvenc") && stdout.contains("h264_nvenc");
            let has_amf = stdout.contains("amf") && stdout.contains("h264_amf");
            let has_qsv = stdout.contains("qsv") && stdout.contains("h264_qsv");

            if has_amf { "amd".into() }
            else if has_nvenc { "nvidia".into() }
            else if has_qsv { "intel".into() }
            else { "cpu".into() }
        }
        Err(_) => "cpu".into(),
    }
}

fn default_presets() -> HashMap<String, Preset> {
    let mut presets = HashMap::new();
    presets.insert(
        "whatsapp".into(),
        Preset {
            name: "WhatsApp".into(),
            description: "15 min 720p30 ~160MB, H.265 AMF".into(),
            codec: "hevc_amf".into(),
            quality: 30,
            preset_idx: 5,
            resolution: "1280x720".into(),
            fps: "30".into(),
            bitrate: 2,
            rate_control: "cq".into(),
        },
    );
    presets.insert(
        "discord".into(),
        Preset {
            name: "Discord 10MB".into(),
            description: "Optimizado para Discord (límite 10MB, 720p30)".into(),
            codec: "av1_amf".into(),
            quality: 30,
            preset_idx: 5,
            resolution: "1280x720".into(),
            fps: "30".into(),
            bitrate: 1,
            rate_control: "vbr".into(),
        },
    );
    presets.insert(
        "clips".into(),
        Preset {
            name: "Clips Rápidos".into(),
            description: "Para clips cortos en redes sociales".into(),
            codec: "libx265".into(),
            quality: 26,
            preset_idx: 6,
            resolution: "1920x1080".into(),
            fps: "60".into(),
            bitrate: 6,
            rate_control: "cq".into(),
        },
    );
    presets.insert(
        "archive".into(),
        Preset {
            name: "Archivado".into(),
            description: "Máxima calidad para preservar archivos".into(),
            codec: "libx265".into(),
            quality: 18,
            preset_idx: 8,
            resolution: "original".into(),
            fps: "original".into(),
            bitrate: 12,
            rate_control: "cq".into(),
        },
    );
    presets.insert(
        "web".into(),
        Preset {
            name: "Web".into(),
            description: "Balance calidad/tamaño para web".into(),
            codec: "libx265".into(),
            quality: 28,
            preset_idx: 6,
            resolution: "1920x1080".into(),
            fps: "30".into(),
            bitrate: 4,
            rate_control: "cq".into(),
        },
    );
    presets.insert(
        "mobile".into(),
        Preset {
            name: "Móvil".into(),
            description: "Optimizado para dispositivos móviles".into(),
            codec: "libx264".into(),
            quality: 28,
            preset_idx: 5,
            resolution: "1280x720".into(),
            fps: "30".into(),
            bitrate: 2,
            rate_control: "cq".into(),
        },
    );
    presets
}

fn get_presets_dir(app: &AppHandle) -> PathBuf {
    let config = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
    std::fs::create_dir_all(&config).ok();
    config
}

// ==================== UTILIDADES DE PROGRESO ====================

struct ProgressThrottle {
    interval: Duration,
    last_emit: Option<Duration>,
}

impl ProgressThrottle {
    fn new(interval: Duration) -> Self {
        Self { interval, last_emit: None }
    }

    fn should_emit(&mut self, now: Duration) -> bool {
        match self.last_emit {
            None => {
                self.last_emit = Some(now);
                true
            }
            Some(last) => {
                if now.saturating_sub(last) >= self.interval {
                    self.last_emit = Some(now);
                    true
                } else {
                    false
                }
            }
        }
    }
}

// ==================== UTILIDADES DE PERSISTENCIA ====================

fn atomic_write_json<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), String> {
    use std::io::Write;
    let data = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().ok();
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

// ==================== COMANDOS TAURI ====================

#[tauri::command]
fn detect_gpu() -> String {
    detect_gpu_internal()
}

#[tauri::command]
fn check_ffmpeg(app: AppHandle) -> FfmpegCapabilities {
    let ffmpeg = find_tool("ffmpeg");
    let output = create_command(&ffmpeg).arg("-encoders").output();

    let mut usage: HashMap<String, u32> = HashMap::new();
    let config_dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
    let usage_path = config_dir.join("codec_usage.json");
    if usage_path.exists() {
        if let Ok(data) = std::fs::read_to_string(&usage_path) {
            usage = serde_json::from_str(&data).unwrap_or_default();
        }
    }

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let has = |name: &str| stdout.contains(name);

            let gpu = if has("h264_amf") || has("hevc_amf") {
                "amd"
            } else if has("h264_nvenc") || has("hevc_nvenc") {
                "nvidia"
            } else if has("h264_qsv") || has("hevc_qsv") {
                "intel"
            } else {
                "cpu"
            };

            // Formato de `ffmpeg -encoders`: " V....D nombre  descripción".
            // El primer carácter es el tipo (V=video, A=audio, S=subtítulo);
            // el segundo token es el nombre del encoder. Se excluyen las líneas
            // de leyenda ("V..... = Video"), cuyo segundo token es "=".
            let mut video_encoders: Vec<String> = stdout
                .lines()
                .filter_map(|line| {
                    let trimmed = line.trim_start();
                    if !trimmed.starts_with('V') {
                        return None;
                    }
                    let name = trimmed.split_whitespace().nth(1)?;
                    if name.contains('=') {
                        return None;
                    }
                    Some(name.to_string())
                })
                .collect();
            video_encoders.sort_by_key(|s| s.to_lowercase());

            FfmpegCapabilities {
                gpu: gpu.into(),
                video_encoders,
                libx264: has("libx264"),
                libx265: has("libx265"),
                libsvtav1: has("libsvtav1"),
                libvpx_vp9: has("libvpx-vp9"),
                h264_nvenc: has("h264_nvenc"),
                hevc_nvenc: has("hevc_nvenc"),
                av1_nvenc: has("av1_nvenc"),
                h264_amf: has("h264_amf"),
                hevc_amf: has("hevc_amf"),
                av1_amf: has("av1_amf"),
                h264_qsv: has("h264_qsv"),
                hevc_qsv: has("hevc_qsv"),
                av1_qsv: has("av1_qsv"),
                usage,
            }
        }
        Err(_) => FfmpegCapabilities {
            gpu: "cpu".into(),
            video_encoders: Vec::new(),
            libx264: false,
            libx265: false,
            libsvtav1: false,
            libvpx_vp9: false,
            h264_nvenc: false,
            hevc_nvenc: false,
            av1_nvenc: false,
            h264_amf: false,
            hevc_amf: false,
            av1_amf: false,
            h264_qsv: false,
            hevc_qsv: false,
            av1_qsv: false,
            usage: HashMap::new(),
        },
    }
}

#[tauri::command]
async fn get_video_info(path: String) -> Result<VideoInfo, String> {
    get_video_info_internal(&path)
}

fn get_video_info_internal(path: &str) -> Result<VideoInfo, String> {
    let ffprobe = find_tool("ffprobe");
    let output = create_command(&ffprobe)
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-show_format",
            path,
        ])
        .output()
        .map_err(|e| format!("FFprobe falló: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| format!("Error parseando JSON: {}", e))?;

    let streams = json["streams"].as_array().ok_or("No streams found")?;
    let video_stream = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .ok_or("No video stream")?;
    let format = &json["format"];

    let duration: f64 = format["duration"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(
            video_stream["duration"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0),
        );

    let hours = (duration / 3600.0) as u32;
    let minutes = ((duration % 3600.0) / 60.0) as u32;
    let seconds = (duration % 60.0) as u32;
    let duration_str = format!("{:02}:{:02}:{:02}", hours, minutes, seconds);

    let size_bytes: f64 = format["size"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let size_mb = size_bytes / (1024.0 * 1024.0);

    let width = video_stream["width"].as_u64().unwrap_or(0) as u32;
    let height = video_stream["height"].as_u64().unwrap_or(0) as u32;
    let resolution = format!("{}x{}", width, height);

    let fps = video_stream["r_frame_rate"]
        .as_str()
        .unwrap_or("0/1");
    let fps_parts: Vec<&str> = fps.split('/').collect();
    let fps_num: f64 = fps_parts.first().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let fps_den: f64 = fps_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let fps_val = if fps_den > 0.0 { fps_num / fps_den } else { 0.0 };
    let fps_str = format!("{:.2}", fps_val);

    let audio_tracks: Vec<AudioTrack> = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .map(|s| AudioTrack {
            index: s["index"].as_u64().unwrap_or(0) as u32,
            codec: s["codec_name"].as_str().unwrap_or("unknown").to_string(),
            channels: s["channels"].as_u64().unwrap_or(0) as u32,
            language: s["tags"]["language"]
                .as_str()
                .unwrap_or("unknown")
                .to_string(),
            title: s["tags"]["name"]
                .as_str()
                .or_else(|| s["tags"]["title"].as_str())
                .and_then(|v| {
                    let t = v.trim();
                    if t.is_empty() || t.eq_ignore_ascii_case("SoundHandler") || t.eq_ignore_ascii_case("Stereo") { None } else { Some(t.to_string()) }
                })
                .unwrap_or_default(),
        })
        .collect();

    let bitrate: f64 = format["bit_rate"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);

    Ok(VideoInfo {
        filename: std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: path.to_string(),
        duration_seconds: duration,
        duration_str,
        size_mb,
        resolution,
        width,
        height,
        fps: fps_str,
        video_codec: video_stream["codec_name"]
            .as_str()
            .unwrap_or("unknown")
            .to_string(),
        audio_tracks,
        format: format["format_name"].as_str().unwrap_or("unknown").to_string(),
        bitrate: bitrate / 1000.0,
    })
}

fn today_ymd() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64 / 86400;

    let mut n = d;
    let mut y = 1970i64;
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
        let days = if leap { 366 } else { 365 };
        if n < days {
            break;
        }
        n -= days;
        y += 1;
    }

    let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
    let month_days: [i64; 12] = if leap {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut m = 0i64;
    for (_, &md) in month_days.iter().enumerate() {
        if n < md {
            break;
        }
        n -= md;
        m += 1;
    }

    format!("{:04}{:02}{:02}", y, m + 1, n + 1)
}

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect()
}

fn process_name_template(
    template: &str,
    input_stem: &str,
    codec: &str,
    quality: u32,
    resolution: &str,
    fps: &str,
) -> String {
    let codec_short = if codec.contains("264") {
        "h264"
    } else if codec.contains("265") || codec.contains("hevc") {
        "h265"
    } else if codec.contains("av1") {
        "av1"
    } else if codec.contains("vp9") {
        "vp9"
    } else {
        "h265"
    };

    let res_short = if resolution == "original" || resolution.is_empty() {
        "orig".to_string()
    } else {
        resolution
            .split('x')
            .nth(1)
            .map(|h| format!("{}p", h))
            .unwrap_or_else(|| resolution.to_string())
    };

    let fps_short = if fps == "original" || fps.is_empty() {
        "orig".to_string()
    } else {
        fps.to_string()
    };

    let result = template
        .replace("{nombre}", input_stem)
        .replace("{codec}", codec_short)
        .replace("{qp}", &quality.to_string())
        .replace("{res}", &res_short)
        .replace("{fps}", &fps_short)
        .replace("{fecha}", &today_ymd());

    sanitize_filename(&result)
}

fn parse_ffmpeg_time(time_str: &str) -> f64 {
    let clean_str = time_str.replace(',', ".");
    let parts: Vec<&str> = clean_str.split(':').collect();
    if parts.len() == 3 {
        let h: f64 = parts[0].parse().unwrap_or(0.0);
        let m: f64 = parts[1].parse().unwrap_or(0.0);
        let s: f64 = parts[2].parse().unwrap_or(0.0);
        h * 3600.0 + m * 60.0 + s
    } else if parts.len() == 2 {
        let m: f64 = parts[0].parse().unwrap_or(0.0);
        let s: f64 = parts[1].parse().unwrap_or(0.0);
        m * 60.0 + s
    } else if parts.len() == 1 {
        parts[0].parse().unwrap_or(0.0)
    } else {
        0.0
    }
}

fn parse_ffmpeg_progress(line: &str) -> Option<serde_json::Value> {
    let trimmed = line.trim();
    if !trimmed.starts_with("frame=") {
        return None;
    }

    let mut map = serde_json::Map::new();
    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    let mut i = 0;

    while i < tokens.len() {
        let token = tokens[i];
        if let Some(pos) = token.find('=') {
            let key = &token[..pos];
            let mut raw_val = &token[pos + 1..];

            if raw_val.is_empty() && i + 1 < tokens.len() && !tokens[i + 1].contains('=') {
                i += 1;
                raw_val = tokens[i];
            }

            match key {
                "frame" => {
                    if let Ok(n) = raw_val.trim().parse::<u64>() {
                        map.insert("frames_done".into(), serde_json::json!(n));
                    }
                }
                "fps" => {
                    if let Ok(n) = raw_val.parse::<f64>() {
                        map.insert("encode_fps".into(), serde_json::json!(n));
                    }
                }
                "speed" => {
                    let stripped = raw_val.trim_end_matches('x');
                    if let Ok(n) = stripped.parse::<f64>() {
                        map.insert("speed".into(), serde_json::json!(n));
                    }
                }
                "size" => {
                    let raw = raw_val.trim();
                    let lower = raw.to_lowercase();
                    if lower == "n/a" { i += 1; continue; }
                    let (num_str, multiplier) = if lower.ends_with("kbits/s") {
                        (&raw[..raw.len() - 7], 1.0)
                    } else if lower.ends_with("kb") {
                        (&raw[..raw.len() - 2], 1.0)
                    } else if lower.ends_with("mb") {
                        (&raw[..raw.len() - 2], 1024.0)
                    } else if lower.ends_with("mbytes") {
                        (&raw[..raw.len() - 6], 1024.0)
                    } else {
                        (raw, 1.0)
                    };
                    if let Ok(n) = num_str.trim().parse::<f64>() {
                        map.insert("current_size_kb".into(), serde_json::json!(n * multiplier));
                    }
                }
                "time" => {
                    let seconds = parse_ffmpeg_time(raw_val.trim());
                    if seconds > 0.0 {
                        map.insert("current_seconds".into(), serde_json::json!(seconds));
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }

    if map.is_empty() { None } else { Some(serde_json::Value::Object(map)) }
}

fn calcular_output_path(params: &EncodeParams) -> Result<String, String> {
    let input_path = &params.input_path;

    if !std::path::Path::new(input_path).exists() {
        return Err("El archivo de entrada no existe".into());
    }

    let output_dir = params
        .output_dir
        .clone()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| {
            std::path::Path::new(input_path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| ".".into())
        });

    std::fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;

    let input_stem = std::path::Path::new(input_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".into());

    let name_template = params
        .name_template
        .clone()
        .unwrap_or_else(|| "{nombre}_{codec}_q{qp}".into());

    let output_name = match &params.output_override {
        Some(ov) if !ov.trim().is_empty() => sanitize_filename(ov),
        _ => process_name_template(
            &name_template,
            &input_stem,
            &params.codec,
            params.quality,
            &params.resolution,
            &params.fps,
        ),
    };

    let is_vp9 = params.codec == "libvpx-vp9" || params.codec == "libvpx_vp9";
    let ext = if is_vp9 { "webm" } else { "mp4" };
    Ok(std::path::Path::new(&output_dir)
        .join(format!("{}.{}", output_name, ext))
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn verificar_nombre_salida(params: EncodeParams) -> Result<NombreSalidaInfo, String> {
    let salida = calcular_output_path(&params)?;
    if !std::path::Path::new(&salida).exists() {
        return Ok(NombreSalidaInfo {
            existe: false,
            salida,
            alternativo: None,
        });
    }

    let path = std::path::Path::new(&salida);
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "video".into());
    let dir = path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let mut alternativo = None;
    for n in 2..10000u32 {
        let candidate = dir.join(format!("{} ({}).{}", stem, n, ext));
        if !candidate.exists() {
            alternativo = Some(format!("{} ({})", stem, n));
            break;
        }
    }

    Ok(NombreSalidaInfo {
        existe: true,
        salida,
        alternativo,
    })
}

fn build_and_spawn(params: &EncodeParams, ffmpeg: &str) -> Result<(std::process::Child, String), String> {
    let input_path = &params.input_path;

    if !std::path::Path::new(input_path).exists() {
        return Err("El archivo de entrada no existe".into());
    }

    let output_path = calcular_output_path(params)?;

    let mut cmd = create_command(ffmpeg);
    if let Some(ref cut) = params.cut_start {
        if cut != "00:00:00" && !cut.is_empty() {
            cmd.args(["-ss", cut]);
        }
    }
    cmd.args(["-i", input_path, "-y"])
        .arg("-map")
        .arg("0:v:0");

    // Pistas de audio seleccionadas (índice 0-based, coincide con "0:a:N" de ffmpeg)
    let mix_down = params.custom_mix.unwrap_or(false);
    let mut audio_filter_label: Option<&str> = None;

    if let Some(ref selected_tracks) = params.audio_tracks {
        if selected_tracks.len() > 1 && mix_down {
            // Varias pistas + "normalizar volumen al mezclar" -> mezclarlas en una sola
            // selected_tracks contiene índices globales de stream (ffprobe "index"),
            // por lo que usamos 0:N (global) en lugar de 0:a:N (audio-relativo).
            let inputs: String = selected_tracks
                .iter()
                .map(|t| format!("[0:{}]", t))
                .collect();
            let filter = format!(
                "{}amix=inputs={}:duration=longest:normalize=1[aout]",
                inputs,
                selected_tracks.len()
            );
            cmd.args(["-filter_complex", &filter]);
            audio_filter_label = Some("[aout]");
        } else if !selected_tracks.is_empty() {
            // Una pista, o varias sin mezclar -> cada una como stream de audio separado.
            // Usamos el índice global del stream (0:N) porque Track.index de ffprobe
            // es el índice absoluto, no el relativo entre pistas de audio.
            // El sufijo '?' hace el mapeo opcional: si la pista no existe en el archivo
            // (p. ej. archivo reemplazado tras el sondeo), ffmpeg la ignora en vez de abortar.
            for track in selected_tracks {
                cmd.arg("-map").arg(format!("0:{}?", track));
            }
        }
        // Si audio_tracks es Some(vec![]) (vacío), el usuario desmarcó todo intencionalmente -> mudo
    } else {
        // Si audio_tracks es None -> por defecto mapear audio por defecto/todas las pistas de audio
        cmd.arg("-map").arg("0:a?");
    }

    if let Some(label) = audio_filter_label {
        cmd.arg("-map").arg(label);
    }

    let actual_codec = &params.codec;
    cmd.args(["-c:v", actual_codec]);

    let is_amd = actual_codec.contains("amf");
    let is_nvidia = actual_codec.contains("nvenc");
    let is_qsv = actual_codec.contains("qsv");
    let is_av1 = actual_codec == "libsvtav1" || actual_codec.contains("av1_");

    match params.rate_control.as_str() {
        "vbr" => {
            let bps = (params.bitrate as u64).max(1) * 1_000_000;
            if is_amd {
                cmd.args(["-rc", "vbr_peak", "-b:v", &bps.to_string()]);
            } else if is_nvidia {
                cmd.args(["-b:v", &bps.to_string(), "-maxrate", &(bps * 2).to_string()]);
            } else {
                cmd.args(["-b:v", &bps.to_string()]);
            }
        },
        "cbr" => {
            let bps = (params.bitrate as u64).max(1) * 1_000_000;
            if is_amd {
                cmd.args(["-rc", "cbr", "-b:v", &bps.to_string()]);
            } else if is_nvidia {
                cmd.args(["-b:v", &bps.to_string(), "-cbr", "1"]);
            } else {
                cmd.args(["-b:v", &bps.to_string(), "-minrate", &bps.to_string(), "-maxrate", &bps.to_string(), "-bufsize", &(bps * 2).to_string()]);
            }
        },
        _ => {
            // CQ (Constant Quality)
            if is_amd {
                if is_av1 {
                    let qp_val = (params.quality * 4).min(255);
                    cmd.args(["-rc", "cqp", "-qp_i", &qp_val.to_string(), "-qp_p", &qp_val.to_string()]);
                } else {
                    let qp_val = params.quality.min(51);
                    cmd.args(["-rc", "cqp", "-qp_i", &qp_val.to_string(), "-qp_p", &qp_val.to_string()]);
                }
            } else if is_nvidia {
                cmd.args(["-cq", &params.quality.to_string()]);
            } else if is_qsv {
                cmd.args(["-global_quality", &params.quality.to_string()]);
            } else {
                cmd.args(["-crf", &params.quality.to_string()]);
            }
        }
    }

    let preset_names = [
        "ultrafast", "superfast", "veryfast", "faster", "fast",
        "medium", "slow", "slower", "veryslow",
    ];
    let idx = (params.preset_idx as usize).min(8);

    if is_amd {
        let q = if actual_codec.contains("av1") {
            // av1_amf: 0=best quality, 100=fastest
            (100u32 - idx as u32 * 100 / 8).min(100).to_string()
        } else if actual_codec.contains("hevc") {
            // hevc_amf: 0=best, 10=fastest
            let v = (10u32 - idx as u32 * 10 / 8).min(10);
            v.to_string()
        } else {
            // h264_amf: 0=balanced, 1=speed, 2=quality
            let v = if idx >= 6 { 2 } else if idx >= 3 { 0 } else { 1 };
            v.to_string()
        };
        cmd.args(["-quality", &q]);
    } else if is_nvidia {
        let nv_map = [1, 1, 2, 3, 4, 5, 6, 7, 7];
        cmd.args(["-preset", &nv_map[idx].to_string()]);
    } else if is_qsv {
        // QSV only accepts 7 presets: veryfast..veryslow
        let qsv_idx = if idx <= 2 { 2 } else { idx.min(8) };
        cmd.args(["-preset", preset_names[qsv_idx]]);
    } else if actual_codec == "libsvtav1" {
        // SVT-AV1 uses numeric presets 0–13 (0=slowest/best, 13=fastest)
        let svt_preset = (13 - idx).max(0).min(13);
        cmd.args(["-preset", &svt_preset.to_string()]);
        // Default tune=1 (PSNR) wastes bits; tune=0 (VQ) prioritizes visual quality
        cmd.args(["-svtav1-params", "tune=0"]);
    } else if actual_codec == "libvpx-vp9" {
        // libvpx-vp9: pass quality/speed via -cpu-used (0=best, 5=fast, 16=realtime)
        let vp9_cpu = idx.min(5) as u32;
        cmd.args(["-cpu-used", &vp9_cpu.to_string()]);
    } else {
        cmd.args(["-preset", preset_names[idx]]);
    }

    if params.resolution != "original" {
        let scaled = params.resolution.replace('x', ":");
        cmd.args(["-vf", &format!("scale={}", scaled)]);
    }

    if params.fps != "original" {
        cmd.args(["-r", &params.fps]);
    }

    if let Some(ref cut) = params.cut_end {
        if cut != "00:00:00" && !cut.is_empty() {
            if let Some(ref start) = params.cut_start {
                if start != "00:00:00" && !start.is_empty() {
                    let s = parse_ffmpeg_time(start);
                    let e = parse_ffmpeg_time(cut);
                    if e > s {
                        let dur = e - s;
                        cmd.args(["-t", &dur.to_string()]);
                    }
                } else {
                    cmd.args(["-to", cut]);
                }
            } else {
                cmd.args(["-to", cut]);
            }
        }
    }

let is_vp9 = params.codec == "libvpx-vp9";
    if is_vp9 {
        cmd.args(["-c:a", "libopus", "-b:a", "96k"]);
    } else {
        cmd.args(["-c:a", "aac", "-b:a", "192k"]);
        cmd.args(["-movflags", "+faststart"]);
    }
    cmd.arg(&output_path);

    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());

    let child = cmd.spawn().map_err(|e| format!("Error al iniciar FFmpeg: {}", e))?;
    Ok((child, output_path))
}

#[cfg(windows)]
fn kill_process_windows(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

#[cfg(windows)]
fn send_ctrl_c(pid: u32) {
    use windows_sys::Win32::System::Console::{AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler, ATTACH_PARENT_PROCESS, CTRL_C_EVENT};
    unsafe {
        FreeConsole();
        if AttachConsole(pid) != 0 {
            SetConsoleCtrlHandler(None, 1);
            GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0);
            std::thread::sleep(Duration::from_millis(500));
            FreeConsole();
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

fn kill_process(pid: u32) {
    #[cfg(windows)] { send_ctrl_c(pid); kill_process_windows(pid); }
    #[cfg(not(windows))] { let _ = Command::new("kill").arg("-9").arg(&pid.to_string()).output(); }
}

#[tauri::command]
async fn start_encode(
    app: AppHandle,
    state: State<'_, AppState>,
    params: EncodeParams,
) -> Result<(), String> {
    let mut is_enc = state.is_encoding.lock().map_err(|e| e.to_string())?;
    if *is_enc {
        return Err("Ya hay una compresión activa".into());
    }

    let ffmpeg = find_tool("ffmpeg");

    let (mut child, output_path) = build_and_spawn(&params, &ffmpeg)?;
    let pid = child.id();
    let stderr = child
        .stderr
        .take()
        .ok_or("No se pudo capturar stderr".to_string())?;

    *is_enc = true;
    state.enc_pid.store(pid, Ordering::Relaxed);
    state.stop_requested.store(false, Ordering::Relaxed);
    drop(is_enc);

    let video_info = get_video_info_internal(&params.input_path).ok();
    let duration_seconds = video_info.as_ref().map(|v| v.duration_seconds).unwrap_or(0.0);
    let fps = video_info.as_ref().map(|v| v.fps.clone()).unwrap_or_else(|| "30".into());

    let _ = app.emit("encode-started", serde_json::json!({
        "output": &output_path,
        "duration_seconds": duration_seconds,
        "fps": fps,
        "cut_start": params.cut_start,
        "cut_end": params.cut_end,
    }));

    let app2 = app.clone();
    let output_path2 = output_path.clone();
    let history_input = params.input_path.clone();
    let history_codec = params.codec.clone();
    let history_quality = params.quality;
    let history_rate_control = params.rate_control.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        let mut was_stopped = false;
        let mut progress_throttle = ProgressThrottle::new(Duration::from_millis(100));
        let start_instant = std::time::Instant::now();
        loop {
            let n = reader.read_until(b'\r', &mut buf).unwrap_or(0);
            if n == 0 { break; }
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            let raw = String::from_utf8_lossy(&buf);
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                if let Some(mut progress) = parse_ffmpeg_progress(trimmed) {
                    if progress_throttle.should_emit(start_instant.elapsed()) {
                        if let Ok(meta) = std::fs::metadata(&output_path2) {
                            let real_kb = meta.len() as f64 / 1024.0;
                            if let Some(obj) = progress.as_object_mut() {
                                obj.insert("current_size_kb".into(), serde_json::json!(real_kb));
                            }
                        }
                        let _ = app2.emit("encode-progress", progress);
                    }
                }
            }
            buf.clear();

            let state = app2.state::<AppState>();
            if state.stop_requested.load(Ordering::Relaxed) {
                child.kill().ok();
                child.wait().ok();
                was_stopped = true;
                break;
            }
        }

        let state = app2.state::<AppState>();
        let mut is_enc = state.is_encoding.lock().unwrap();
        *is_enc = false;
        drop(is_enc);
        state.enc_pid.store(0, Ordering::Relaxed);

        if was_stopped {
            let _ = app2.emit("encode-finished", serde_json::json!({
                "success": false,
                "output": output_path2,
                "error": serde_json::Value::String("Detenido por el usuario".into())
            }));
            return;
        }

        let success = std::path::Path::new(&output_path2).exists();
        if success {
            let original_mb = std::fs::metadata(&history_input)
                .map(|m| m.len() as f64 / (1024.0 * 1024.0))
                .unwrap_or(0.0);
            let output_mb_val = std::fs::metadata(&output_path2)
                .map(|m| m.len() as f64 / (1024.0 * 1024.0))
                .unwrap_or(0.0);
            let saved_mb = (original_mb - output_mb_val).max(0.0);
            let ratio = if original_mb > 0.0 { output_mb_val / original_mb } else { 0.0 };

            let entry = HistoryEntry {
                timestamp: today_ymd(),
                input: std::path::Path::new(&history_input)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                output: std::path::Path::new(&output_path2)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                original_mb,
                output_mb: output_mb_val,
                saved_mb,
                ratio,
                codec: history_codec.clone(),
                quality: history_quality,
                rate_control: history_rate_control.clone(),
            };
            let state = app2.state::<AppState>();
            record_history(&state, entry);

            let _ = app2.emit("history-updated", serde_json::json!({}));
            let _ = app2.emit("save-compression-factor", serde_json::json!({
                "key": format!("{}_{}", history_codec, history_quality),
                "factor": ratio,
                "originalSize": original_mb,
                "outputSize": output_mb_val,
            }));
        }

        let _ = app2.emit(
            "encode-finished",
            serde_json::json!({
                "success": success,
                "output": output_path2,
                "error": if success { serde_json::Value::Null } else { serde_json::Value::String("FFmpeg no generó archivo de salida".into()) }
            }),
        );
    });

    Ok(())
}

#[tauri::command]
fn stop_encode(state: State<'_, AppState>) -> Result<(), String> {
    state.stop_requested.store(true, Ordering::Relaxed);
    let pid = state.enc_pid.load(Ordering::Relaxed);
    if pid != 0 {
        kill_process(pid);
    }
    let mut is_enc = state.is_encoding.lock().map_err(|e| e.to_string())?;
    *is_enc = false;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
async fn start_queue(
    app: AppHandle,
    state: State<'_, AppState>,
    items: Vec<QueueItem>,
    base_params: QueueBaseParams,
) -> Result<(), String> {
    {
        let mut is_enc = state.is_encoding.lock().map_err(|e| e.to_string())?;
        let mut qp = state.queue_processing.lock().map_err(|e| e.to_string())?;
        if *is_enc || *qp {
            return Err("Ya hay una compresión activa".into());
        }
        *is_enc = true;
        *qp = true;
    }
    *state.queue_stop_flag.lock().map_err(|e| e.to_string())? = false;

    let total = items.len();
    let _ = app.emit("queue-started", serde_json::json!({ "total": total }));

    let app2 = app.clone();
    std::thread::spawn(move || {
        let ffmpeg = find_tool("ffmpeg");
        let mut processed: u32 = 0;
        let mut stopped = false;

        for (idx, item) in items.iter().enumerate() {
            {
                let state = app2.state::<AppState>();
                let stop = state.queue_stop_flag.lock().unwrap();
                if *stop {
                    stopped = true;
                    break;
                }
            }

            let filename = std::path::Path::new(&item.input_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| item.input_path.clone());

            let _ = app2.emit(
                "queue-progress",
                serde_json::json!({
                    "current": idx + 1,
                    "total": total,
                    "filename": filename,
                }),
            );

            let params = EncodeParams {
                input_path: item.input_path.clone(),
                output_dir: item.output_dir.clone(),
                codec: base_params.codec.clone(),
                quality: base_params.quality,
                preset_idx: base_params.preset_idx,
                resolution: base_params.resolution.clone(),
                fps: base_params.fps.clone(),
                bitrate: base_params.bitrate,
                rate_control: base_params.rate_control.clone(),
                cut_start: item.cut_start.clone(),
                cut_end: item.cut_end.clone(),
                name_template: base_params.name_template.clone(),
                audio_tracks: item
                    .audio_tracks
                    .clone()
                    .or_else(|| base_params.audio_tracks.clone()),
                custom_mix: base_params.custom_mix,
                output_override: item.output_override.clone(),
            };

            let (mut child, output_path) = match build_and_spawn(&params, &ffmpeg) {
                Ok(v) => v,
                Err(e) => {
                    let _ = app2.emit(
                        "log-message",
                        serde_json::json!({
                            "line": format!("Error con {}: {}", filename, e),
                            "type": "error"
                        }),
                    );
                    continue;
                }
            };

            let video_info = get_video_info_internal(&item.input_path).ok();
            let duration_seconds = video_info.as_ref().map(|v| v.duration_seconds).unwrap_or(0.0);
            let fps = video_info.as_ref().map(|v| v.fps.clone()).unwrap_or_else(|| "30".into());

            let _ = app2.emit("encode-started", serde_json::json!({
                "output": &output_path,
                "duration_seconds": duration_seconds,
                "fps": fps,
                "cut_start": item.cut_start,
                "cut_end": item.cut_end,
            }));

            let pid2 = child.id();
            app2.state::<AppState>().enc_pid.store(pid2, Ordering::Relaxed);
            app2.state::<AppState>().stop_requested.store(false, Ordering::Relaxed);

            let stderr = child.stderr.take();
            let mut was_stopped = false;

            if let Some(stderr) = stderr {
                let mut reader = BufReader::new(stderr);
                let mut line_buf = Vec::new();
                let mut progress_throttle = ProgressThrottle::new(Duration::from_millis(100));
                let start_instant = std::time::Instant::now();
                loop {
                    let n = reader.read_until(b'\r', &mut line_buf).unwrap_or(0);
                    if n == 0 { break; }
                    if line_buf.last() == Some(&b'\r') {
                        line_buf.pop();
                    }
                    let raw = String::from_utf8_lossy(&line_buf);
                    let trimmed = raw.trim();
                    if !trimmed.is_empty() {
                        if let Some(mut progress) = parse_ffmpeg_progress(trimmed) {
                            if progress_throttle.should_emit(start_instant.elapsed()) {
                                if let Ok(meta) = std::fs::metadata(&output_path) {
                                    let real_kb = meta.len() as f64 / 1024.0;
                                    if let Some(obj) = progress.as_object_mut() {
                                        obj.insert("current_size_kb".into(), serde_json::json!(real_kb));
                                    }
                                }
                                let _ = app2.emit("encode-progress", progress);
                            }
                        }
                    }
                    line_buf.clear();

                    if app2.state::<AppState>().stop_requested.load(Ordering::Relaxed) {
                        child.kill().ok();
                        child.wait().ok();
                        was_stopped = true;
                        break;
                    }
                }
            }

            let success = if was_stopped {
                false
            } else {
                child.wait().map(|s| s.success()).unwrap_or(false)
            };

            let _ = app2.emit("encode-finished", serde_json::json!({
                "success": success,
                "output": &output_path,
                "error": if success { serde_json::Value::Null } else { serde_json::Value::String("FFmpeg no generó archivo de salida".into()) }
            }));

            if success && std::path::Path::new(&output_path).exists() {
                let original_mb = std::fs::metadata(&item.input_path)
                    .map(|m| m.len() as f64 / (1024.0 * 1024.0))
                    .unwrap_or(0.0);
                let output_mb = std::fs::metadata(&output_path)
                    .map(|m| m.len() as f64 / (1024.0 * 1024.0))
                    .unwrap_or(0.0);
                let saved_mb = (original_mb - output_mb).max(0.0);
                let ratio = if original_mb > 0.0 { output_mb / original_mb } else { 0.0 };

                let entry = HistoryEntry {
                    timestamp: today_ymd(),
                    input: filename.clone(),
                    output: std::path::Path::new(&output_path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    original_mb,
                    output_mb,
                    saved_mb,
                    ratio,
                    codec: params.codec.clone(),
                    quality: params.quality,
                    rate_control: params.rate_control.clone(),
                };
                let state = app2.state::<AppState>();
                record_history(&state, entry);
                processed += 1;
            } else {
                let _ = app2.emit(
                    "log-message",
                    serde_json::json!({
                        "line": format!("Fallo al comprimir {}", filename),
                        "type": "error"
                    }),
                );
                // Si se detuvo por stop_queue, salimos del bucle en la próxima vuelta
                let state = app2.state::<AppState>();
                let stop = state.queue_stop_flag.lock().unwrap();
                if *stop {
                    stopped = true;
                    break;
                }
            }
        }

        {
            let state = app2.state::<AppState>();
            *state.is_encoding.lock().unwrap() = false;
            *state.queue_processing.lock().unwrap() = false;
        }

        let _ = app2.emit(
            "queue-finished",
            serde_json::json!({
                "total": processed,
                "stopped": stopped,
            }),
        );
    });

    Ok(())
}

#[tauri::command]
fn stop_queue(state: State<'_, AppState>) -> Result<(), String> {
    *state.queue_stop_flag.lock().map_err(|e| e.to_string())? = true;
    state.stop_requested.store(true, Ordering::Relaxed);
    let pid = state.enc_pid.load(Ordering::Relaxed);
    if pid != 0 {
        kill_process(pid);
    }
    Ok(())
}

#[tauri::command]
fn get_presets(state: State<'_, AppState>) -> Result<HashMap<String, Preset>, String> {
    let presets = state.presets.lock().map_err(|e| e.to_string())?;
    Ok(presets.clone())
}

#[tauri::command]
fn save_preset(
    state: State<'_, AppState>,
    name: String,
    preset: Preset,
) -> Result<(), String> {
    let mut presets = state.presets.lock().map_err(|e| e.to_string())?;
    presets.insert(name, preset);
    let path = state.presets_file.lock().map_err(|e| e.to_string())?;
    let snapshot = presets.clone();
    drop(path);
    drop(presets);
    let path = state.presets_file.lock().map_err(|e| e.to_string())?;
    atomic_write_json(&*path, &snapshot)?;
    Ok(())
}

#[tauri::command]
fn delete_preset(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let mut presets = state.presets.lock().map_err(|e| e.to_string())?;
    presets.remove(&name);
    let snapshot = presets.clone();
    drop(presets);
    let path = state.presets_file.lock().map_err(|e| e.to_string())?;
    atomic_write_json(&*path, &snapshot)?;
    Ok(())
}

#[tauri::command]
fn reset_default_presets(state: State<'_, AppState>) -> Result<HashMap<String, Preset>, String> {
    let defaults = default_presets();
    {
        let mut presets = state.presets.lock().map_err(|e| e.to_string())?;
        *presets = defaults.clone();
    }
    let path = state.presets_file.lock().map_err(|e| e.to_string())?;
    atomic_write_json(&*path, &defaults)?;
    Ok(defaults)
}

#[tauri::command]
fn get_history(state: State<'_, AppState>) -> Result<Vec<HistoryEntry>, String> {
    let path = state.history_file.lock().map_err(|e| e.to_string())?;
    if path.exists() {
        let data = std::fs::read_to_string(&*path).map_err(|e| e.to_string())?;
        let history: Vec<HistoryEntry> = serde_json::from_str(&data).unwrap_or_default();
        Ok(history)
    } else {
        Ok(vec![])
    }
}

fn record_history(state: &AppState, entry: HistoryEntry) {
    let path = match state.history_file.lock() {
        Ok(p) => p.clone(),
        Err(_) => return,
    };
    let mut history: Vec<HistoryEntry> = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|d| serde_json::from_str(&d).ok())
            .unwrap_or_default()
    } else {
        vec![]
    };
    history.insert(0, entry);
    history.truncate(50);
    let _ = atomic_write_json(&path, &history);
}

#[tauri::command]
fn save_codec_usage(state: State<'_, AppState>, usage: HashMap<String, u32>) -> Result<(), String> {
    let path = state.usage_file.lock().map_err(|e| e.to_string())?;
    atomic_write_json(&*path, &usage)?;
    Ok(())
}

// ==================== TESTS ====================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_path(suffix: &str) -> std::path::PathBuf {
        let n = TEST_COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
        let pid = std::process::id();
        std::env::temp_dir().join(format!("swissvideo_test_{}_{}_{}", pid, n, suffix))
    }

    #[test]
    fn atomic_write_json_creates_file_when_missing() {
        let path = temp_path("atomic_create.json");
        let _ = std::fs::remove_file(&path);
        let mut map = BTreeMap::new();
        map.insert("k1".to_string(), "v1".to_string());
        atomic_write_json(&path, &map).expect("write should succeed");
        let read = std::fs::read_to_string(&path).expect("file must exist");
        assert!(read.contains("k1"));
    }

    #[test]
    fn atomic_write_json_overwrites_existing_file() {
        let path = temp_path("atomic_overwrite.json");
        std::fs::write(&path, r#"{"old":"content"}"#).unwrap();
        let mut map = BTreeMap::new();
        map.insert("new".to_string(), "value".to_string());
        atomic_write_json(&path, &map).expect("overwrite should succeed");
        let read = std::fs::read_to_string(&path).expect("file must exist");
        assert!(read.contains("new"));
        assert!(!read.contains("old"));
    }

    #[test]
    fn atomic_write_json_does_not_leave_tmp_file_on_success() {
        let path = temp_path("atomic_cleanup.json");
        let _ = std::fs::remove_file(&path);
        let map: BTreeMap<String, String> = BTreeMap::new();
        atomic_write_json(&path, &map).expect("write should succeed");
        let tmp = path.with_extension("tmp");
        assert!(!tmp.exists(), "tmp file must be cleaned up after rename");
    }

    #[test]
    fn progress_throttle_allows_first_call() {
        let mut t = ProgressThrottle::new(Duration::from_millis(100));
        assert!(t.should_emit(Duration::from_millis(0)));
    }

    #[test]
    fn progress_throttle_blocks_calls_within_interval() {
        let mut t = ProgressThrottle::new(Duration::from_millis(100));
        t.should_emit(Duration::from_millis(0));
        assert!(!t.should_emit(Duration::from_millis(50)));
        assert!(!t.should_emit(Duration::from_millis(99)));
    }

    #[test]
    fn progress_throttle_allows_after_interval_elapses() {
        let mut t = ProgressThrottle::new(Duration::from_millis(100));
        t.should_emit(Duration::from_millis(0));
        assert!(t.should_emit(Duration::from_millis(100)));
        assert!(!t.should_emit(Duration::from_millis(150)));
        assert!(t.should_emit(Duration::from_millis(200)));
    }

    #[test]
    fn parse_ffmpeg_progress_parses_typical_line() {
        let line = "frame=  120 fps=58 q=28.0 size=    2048kB time=00:00:04.00 bitrate=4194.3kbits/s speed=1.95x";
        let parsed = parse_ffmpeg_progress(line).expect("must parse");
        let obj = parsed.as_object().expect("must be object");
        assert_eq!(obj.get("frames_done").and_then(|v| v.as_u64()), Some(120));
        assert!(obj.get("encode_fps").and_then(|v| v.as_f64()).unwrap() > 50.0);
        assert!(obj.get("speed").and_then(|v| v.as_f64()).unwrap() > 1.0);
        assert!(obj.get("current_seconds").and_then(|v| v.as_f64()).unwrap() > 3.9);
    }

    #[test]
    fn parse_ffmpeg_progress_ignores_non_progress_lines() {
        let line = "Stream mapping: Stream #0:0 -> #0:0";
        assert!(parse_ffmpeg_progress(line).is_none());
    }

    #[test]
    fn parse_ffmpeg_progress_returns_none_for_empty() {
        assert!(parse_ffmpeg_progress("").is_none());
    }
}

// ==================== RUN ====================

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let config_dir = get_presets_dir(app.handle());
            let presets_file = config_dir.join("presets.json");
            let history_file = config_dir.join("history.json");
            let usage_file = config_dir.join("codec_usage.json");

            let presets = if presets_file.exists() {
                let data = std::fs::read_to_string(&presets_file).unwrap_or_default();
                serde_json::from_str(&data).unwrap_or_else(|_| default_presets())
            } else {
                let defaults = default_presets();
                atomic_write_json(&presets_file, &defaults).ok();
                defaults
            };

            app.manage(AppState {
                is_encoding: Mutex::new(false),
                presets: Mutex::new(presets),
                presets_file: Mutex::new(presets_file),
                history_file: Mutex::new(history_file),
                usage_file: Mutex::new(usage_file),
                queue_processing: Mutex::new(false),
                queue_stop_flag: Mutex::new(false),
                stop_requested: AtomicBool::new(false),
                enc_pid: AtomicU32::new(0),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_gpu,
            check_ffmpeg,
            get_video_info,
            start_encode,
            stop_encode,
            start_queue,
            stop_queue,
            get_presets,
            save_preset,
            delete_preset,
            reset_default_presets,
            get_history,
            save_codec_usage,
            verificar_nombre_salida,
        ])
        .run(tauri::generate_context!())
        .expect("error al ejecutar SwissVideo V2");
}
