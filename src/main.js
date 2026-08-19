import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

// ========== CONFIGURACIÓN GLOBAL ==========
let CurrentVideoPath = null;
let CurrentVideoInfo = null;
let IsEncoding = false;
let SelectedCodec = "libx265";
let LogExpanded = false;
let FirstFrameReceived = false;
let CurrentPresets = {};
let CurrentActivePresetKey = null;
let FfmpegCaps = null;
let lastSliderQuality = 23;
let lastSliderBitrate = 6;
let VideoInfoRequestSeq = 0;

// Cache lazy de elementos DOM consultados frecuentemente (UpdateProgress corre 30-60 Hz).
// Se inicializa una sola vez en DOMContentLoaded para evitar getElementById por cada progress.
const DomCache = {};

function GetEl(id) {
    if (!DomCache[id]) {
        DomCache[id] = document.getElementById(id);
    }
    return DomCache[id];
}

const CodecMeta = {
    libx264:    { label: "H.264",   family: "cpu",   hwtag: "" },
    libx265:    { label: "H.265",   family: "cpu",   hwtag: "" },
    libsvtav1:  { label: "AV1",     family: "cpu",   hwtag: "" },
    libvpx_vp9: { label: "VP9",     family: "cpu",   hwtag: "" },
    h264_nvenc: { label: "H.264",   family: "nvidia", hwtag: "NV" },
    hevc_nvenc: { label: "H.265",   family: "nvidia", hwtag: "NV" },
    av1_nvenc:  { label: "AV1",     family: "nvidia", hwtag: "NV" },
    h264_amf:   { label: "H.264",   family: "amd",   hwtag: "AMD" },
    hevc_amf:   { label: "H.265",   family: "amd",   hwtag: "AMD" },
    av1_amf:    { label: "AV1",     family: "amd",   hwtag: "AMD" },
    h264_qsv:   { label: "H.264",   family: "intel", hwtag: "INT" },
    hevc_qsv:   { label: "H.265",   family: "intel", hwtag: "INT" },
    av1_qsv:    { label: "AV1",     family: "intel", hwtag: "INT" },
};

const CodecMap = {
    libx264: "h264", libx265: "h265", libsvtav1: "av1", "libvpx-vp9": "vp9",
    h264_nvenc: "h264", hevc_nvenc: "h265", av1_nvenc: "av1",
    h264_amf: "h264", hevc_amf: "h265", av1_amf: "av1",
    h264_qsv: "h264", hevc_qsv: "h265", av1_qsv: "av1",
};

const CodecCrfRange = Object.fromEntries(
    Object.entries(CodecMeta).map(([k, v]) => {
        const isAV1 = v.label === "AV1";
        const isVP9 = v.label === "VP9";
        return [k, isAV1 ? { min: 0, max: 63, default: 35 } :
                     isVP9 ? { min: 0, max: 63, default: 32 } :
                     { min: 0, max: 51, default: 23 }];
    })
);

// ========== ICONOS SVG ==========
const Icons = {
    film: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/></svg>',
    ruler: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="18" height="8" rx="1"/><path d="M7 8v4M11 8v4M15 8v4M19 8v4"/></svg>',
    frames: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h6v14H4zM14 5h6v14h-6z"/><path d="M10 9h4M10 15h4"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    target: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    box: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12"/></svg>',
    rocket: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    stop: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
    stats: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/></svg>',
    save: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>',
    folder: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    dot: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>',
    scissors: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></svg>',
    audio: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>',
    empty: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};

// ========== COMUNICACIÓN CON BACKEND ==========
async function SendMessage(Action, Payload = {}, RequestId = null) {
    const commandMap = {
        get_presets: "get_presets",
        save_preset: "save_preset",
        delete_preset: "delete_preset",
        reset_default_presets: "reset_default_presets",
        get_history: "get_history",
        get_video_info: "get_video_info",
        start_encode: "start_encode",
        stop_encode: "stop_encode",
        detect_gpu: "detect_gpu",
        check_ffmpeg: "check_ffmpeg",
        start_queue: "start_queue",
        stop_queue: "stop_queue",
    };

    const cmd = commandMap[Action];
    if (!cmd) {
        return false;
    }

    try {
        const result = await invoke(cmd, Payload);
        if (cmd === "get_presets") {
            HandleBackendMessage({ action: "presets_list", presets: result });
        } else if (cmd === "save_preset" || cmd === "delete_preset" || cmd === "reset_default_presets") {
            if (cmd === "reset_default_presets") {
                HandleBackendMessage({ action: "presets_list", presets: result });
            } else {
                const presets = await invoke("get_presets");
                HandleBackendMessage({ action: "presets_list", presets });
            }
        } else if (cmd === "get_video_info") {
            HandleBackendMessage({ action: "video_info", success: true, info: result, request_id: RequestId });
        } else if (cmd === "start_encode") {
            HandleBackendMessage({ action: "log", line: "Compresión iniciada", type: "success" });
        } else if (cmd === "stop_encode") {
            HandleBackendMessage({ action: "log", line: "Compresión detenida por el usuario", type: "warning" });
        } else if (cmd === "check_ffmpeg") {
            FfmpegCaps = result;
            HandleBackendMessage({ action: "ffmpeg_caps", caps: result });
        } else if (cmd === "detect_gpu") {
            const names = { nvidia: "NVIDIA NVENC", amd: "AMD AMF", intel: "Intel QuickSync", cpu: "CPU (sin GPU)" };
            HandleBackendMessage({ action: "log", line: `Aceleracion GPU activada (${names[result] || result})`, type: "info" });
        } else if (cmd === "start_queue") {
            HandleBackendMessage({ action: "log", line: "Cola de procesamiento iniciada", type: "success" });
        } else if (cmd === "stop_queue") {
            HandleBackendMessage({ action: "log", line: "Cola detenida por el usuario", type: "warning" });
        }
        return true;
    } catch (e) {
        if (cmd === "get_video_info") {
            HandleBackendMessage({ action: "video_info", success: false, error: e.toString(), request_id: RequestId });
        } else if (cmd === "start_encode" || cmd === "stop_encode" || cmd === "start_queue" || cmd === "stop_queue") {
            HandleBackendMessage({ action: "encode_finished", success: false, error: e.toString() });
        }
        HandleBackendMessage({ action: "log", line: `Error: ${e}`, type: "error" });
        return false;
    }
}

// ==================== GESTIÓN DE PRESETS ====================
function LoadPresetsFromBackend() {
    SendMessage('get_presets');
}

function RenderPresetsBar() {
    const Container = document.getElementById("presetsBar");
    if (!Container) return;
    Container.innerHTML = '';
    const PresetEntries = Object.entries(CurrentPresets).slice(0, 6);
    PresetEntries.forEach(([Key, Preset]) => {
        const Chip = document.createElement('div');
        Chip.className = 'PresetChip';
        Chip.textContent = Preset.name || Key;
        Chip.title = Preset.description || `Aplicar ${Preset.name}`;
        if (CurrentActivePresetKey === Key) {
            Chip.style.background = 'var(--AccentDim)';
            Chip.style.borderColor = 'var(--Accent)';
            Chip.style.color = 'var(--Accent)';
        }
        Chip.addEventListener('click', () => ApplyPreset(Key, Preset));
        Container.appendChild(Chip);
    });
    if (Object.keys(CurrentPresets).length > 6) {
        const MoreChip = document.createElement('div');
        MoreChip.className = 'PresetChip';
        MoreChip.textContent = `+${Object.keys(CurrentPresets).length - 6} más`;
        MoreChip.addEventListener('click', () => OpenPresetManager());
        Container.appendChild(MoreChip);
    }
}

function OpenPresetManager() {
    RenderPresetsList();
    document.getElementById("presetManagerModal").style.display = "flex";
}

function ClosePresetManager() {
    document.getElementById("presetManagerModal").style.display = "none";
}

function RenderPresetsList() {
    const Container = document.getElementById("presetsListContainer");
    if (!Container) return;
    Container.innerHTML = '';
    if (Object.keys(CurrentPresets).length === 0) {
        Container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--Text3);">${Icons.box} No hay presets.<br>Haz click en "Nuevo Preset" para crear uno.</div>`;
        return;
    }
    Object.entries(CurrentPresets).forEach(([Key, Preset]) => {
        const meta = CodecMeta[Preset.codec];
        const CodecName = meta ? (meta.hwtag ? `${meta.label}·${meta.hwtag}` : `${meta.label} CPU`) : Preset.codec;
        const Resolution = Preset.resolution === 'original' ? 'Original' : Preset.resolution;
        const Item = document.createElement('div');
        Item.className = 'QueueItem';
        Item.innerHTML = `
            <div class="preset-item-header">
                <div class="preset-name">${escapeHtml(Preset.name)}</div>
                ${CurrentActivePresetKey === Key ? '<div class="preset-badge">Activo</div>' : ''}
            </div>
            <div class="preset-desc">${escapeHtml(Preset.description || 'Sin descripción')}</div>
            <div class="preset-details">
                <span>${Icons.film} ${CodecName}</span><span>${Icons.ruler} ${Resolution}</span>
                <span>${Icons.frames} ${Preset.fps === 'original' ? 'FPS orig' : Preset.fps + ' fps'}</span>
                <span>${Icons.gear} ${Preset.rate_control === 'vbr' ? 'VBR' : Preset.rate_control === 'cbr' ? 'CBR' : 'CQ'} ${Preset.rate_control === 'cq' ? Preset.quality : Preset.bitrate + 'M'}</span>
            </div>
            <div class="preset-actions">
                <button class="apply-btn" data-key="${Key}">${Icons.target} Aplicar</button>
                <button class="edit-btn" data-key="${Key}">${Icons.edit} Editar</button>
                <button class="delete-btn" data-key="${Key}">${Icons.trash} Eliminar</button>
            </div>`;
        Container.appendChild(Item);
    });
    Container.querySelectorAll('.apply-btn').forEach(Btn => {
        Btn.addEventListener('click', () => { const k = Btn.dataset.key; if (CurrentPresets[k]) { ApplyPreset(k, CurrentPresets[k]); ClosePresetManager(); } });
    });
    Container.querySelectorAll('.edit-btn').forEach(Btn => {
        Btn.addEventListener('click', () => OpenEditPresetModal(Btn.dataset.key));
    });
    Container.querySelectorAll('.delete-btn').forEach(Btn => {
        Btn.addEventListener('click', () => {
            const k = Btn.dataset.key;
            if (confirm(`¿Eliminar el preset "${CurrentPresets[k]?.name}"?`)) {
                SendMessage('delete_preset', { name: k });
                if (CurrentActivePresetKey === k) {
                    CurrentActivePresetKey = null;
                    const ind = document.getElementById("activePresetIndicator");
                    if (ind) ind.style.display = 'none';
                }
            }
        });
    });
}

function OpenEditPresetModal(EditKey = null) {
    const Modal = document.getElementById("presetEditModal");
    const Title = document.getElementById("presetEditTitle");
    const NameInput = document.getElementById("editPresetName");
    const DescInput = document.getElementById("editPresetDesc");
    if (EditKey && CurrentPresets[EditKey]) {
        Title.textContent = `Editar: ${CurrentPresets[EditKey].name}`;
        NameInput.value = CurrentPresets[EditKey].name;
        DescInput.value = CurrentPresets[EditKey].description || '';
        Modal.dataset.editKey = EditKey;
    } else {
        Title.textContent = "Crear Nuevo Preset";
        NameInput.value = '';
        DescInput.value = '';
        delete Modal.dataset.editKey;
    }
    UpdatePresetPreview();
    Modal.style.display = "flex";
}

function CloseEditModal() {
    document.getElementById("presetEditModal").style.display = "none";
}

function UpdatePresetPreview() {
    const Preview = document.getElementById("presetPreview");
    if (!Preview) return;
    const s = GetCurrentSettings();
    const meta = CodecMeta[s.codec];
    const CodecName = meta ? (meta.hwtag ? `${meta.label}·${meta.hwtag}` : meta.label) : s.codec;
    const rcLabel = { cq: `CQ ${s.quality}`, vbr: `VBR ${s.bitrate}M`, cbr: `CBR ${s.bitrate}M` }[s.rate_control] || s.rate_control;
    Preview.innerHTML = `Codec: ${CodecName} | ${rcLabel} | ${s.resolution === 'original' ? 'Original' : s.resolution}<br>FPS: ${s.fps === 'original' ? 'Original' : s.fps}`;
}

function GetCurrentSettings() {
    return {
        name: "", description: "",
        codec: SelectedCodec,
        quality: GetQualityValue(),
        preset_idx: parseInt(document.getElementById("presetSlider").value),
        resolution: document.getElementById("resolutionSelect").value,
        fps: document.getElementById("fpsSelect").value,
        bitrate: GetBitrateValue(),
        rate_control: (document.querySelector("#rateCtrl .RateOpt.on")?.dataset.rc) || "cq",
    };
}

function ClearActivePresetIfCustomized() {
    if (CurrentActivePresetKey) {
        CurrentActivePresetKey = null;
        const ind = document.getElementById("activePresetIndicator");
        if (ind) ind.style.display = 'none';
    }
}

function SaveCurrentPresetFromModal() {
    const NameInput = document.getElementById("editPresetName");
    const DescInput = document.getElementById("editPresetDesc");
    const Modal = document.getElementById("presetEditModal");
    const EditKey = Modal.dataset.editKey;
    const PresetName = NameInput.value.trim();
    if (!PresetName) { AddLog("❌ Ingresa un nombre para el preset", "error"); return; }
    const PresetKey = PresetName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (EditKey && EditKey !== PresetKey && CurrentPresets[EditKey]) {
        SendMessage('delete_preset', { name: EditKey });
    }
    const Settings = GetCurrentSettings();
    Settings.name = PresetName;
    Settings.description = DescInput.value.trim() || `${PresetName} - Configuración personalizada`;
    SendMessage('save_preset', { name: PresetKey, preset: Settings });
    CloseEditModal();
    AddLog(`💾 Preset "${PresetName}" guardado`, "success");
}

function ApplyPreset(PresetKey, Preset) {
    if (Preset.codec) {
        const CodecBtn = document.querySelector(`.CodecOpt[data-codec="${Preset.codec}"]`);
        if (CodecBtn) SelectCodec(Preset.codec);
    }
    if (Preset.quality !== undefined) {
        lastSliderQuality = Preset.quality;
        const rc = document.querySelector("#rateCtrl .RateOpt.on")?.dataset.rc;
        if (rc === "cq") {
            document.getElementById("qualitySlider").value = Preset.quality;
            document.getElementById("qualityVal").textContent = Preset.quality;
        }
    }
    if (Preset.preset_idx !== undefined) {
        document.getElementById("presetSlider").value = Preset.preset_idx;
        const PresetNames = ["ultrafast","superfast","veryfast","faster","fast","medium","slow","slower","veryslow"];
        document.getElementById("presetVal").textContent = PresetNames[Preset.preset_idx] || "fast";
    }
    if (Preset.resolution) document.getElementById("resolutionSelect").value = Preset.resolution;
    if (Preset.fps) document.getElementById("fpsSelect").value = Preset.fps;
    if (Preset.bitrate !== undefined && Preset.bitrate > 0) {
        lastSliderBitrate = Preset.bitrate;
    }
    if (Preset.rate_control) {
        document.querySelectorAll("#rateCtrl .RateOpt").forEach(r => r.classList.toggle("on", r.dataset.rc === Preset.rate_control));
        UpdateSliderMode();
    }
    CurrentActivePresetKey = PresetKey;
    const Indicator = document.getElementById("activePresetIndicator");
    if (Indicator) {
        Indicator.style.display = 'block';
        Indicator.innerHTML = `${Icons.dot} Usando preset: ${Preset.name}`;
        setTimeout(() => { Indicator.style.opacity = '0.5'; }, 2000);
    }
    AddLog(`✅ Preset "${Preset.name}" aplicado`, "success");
    UpdateEstimate();
    UpdateNamePreview();
    RenderPresetsBar();
}

function ExportAllPresets() {
    try {
        const DataStr = JSON.stringify(CurrentPresets, null, 2);
        const BlobObj = new Blob([DataStr], { type: 'application/json' });
        const Url = URL.createObjectURL(BlobObj);
        const A = document.createElement('a');
        A.href = Url; A.download = `swissvideo_presets_${new Date().toISOString().slice(0,19)}.json`;
        document.body.appendChild(A); A.click(); document.body.removeChild(A);
        URL.revokeObjectURL(Url);
        AddLog(`📁 Exportados ${Object.keys(CurrentPresets).length} presets`, "success");
    } catch (error) { AddLog(`❌ Error exportando: ${error.message}`, "error"); }
}

function ImportPresets() {
    const Input = document.createElement('input');
    Input.type = 'file'; Input.accept = '.json';
    Input.onchange = (E) => {
        const File = E.target.files[0]; if (!File) return;
        const Reader = new FileReader();
        Reader.onload = (Event) => {
            try {
                const Imported = JSON.parse(Event.target.result);
                let Count = 0;
                Object.entries(Imported).forEach(([Key, Preset]) => {
                    if (Preset.name && Preset.codec) { SendMessage('save_preset', { name: Key, preset: Preset }); Count++; }
                });
                AddLog(`✅ Importados ${Count} presets`, "success");
                ClosePresetManager();
            } catch (Err) { AddLog(`❌ Error importando: ${Err.message}`, "error"); }
        };
        Reader.readAsText(File);
    };
    Input.click();
}

function ResetDefaultPresets() {
    if (confirm("¿Restaurar presets por defecto? Se perderán los personalizados.")) {
        SendMessage('reset_default_presets');
        CurrentActivePresetKey = null;
        const ind = document.getElementById("activePresetIndicator");
        if (ind) ind.style.display = 'none';
        AddLog("🔄 Restaurando presets por defecto...", "info");
    }
}

function RenderCodecSelector() {
    const Row = document.getElementById("codecRow");
    if (!Row || !FfmpegCaps) return;
    Row.innerHTML = "";

    const gpuType = FfmpegCaps.gpu;
    const gpuSuffix = { nvidia: "nvenc", amd: "amf", intel: "qsv" }[gpuType];
    const gpuLabel = { nvidia: "NV", amd: "AMD", intel: "INT" }[gpuType] || "";

    const families = ["H.264", "H.265", "AV1", "VP9"];

    families.forEach(label => {
        const cpuCodec = Object.keys(CodecMeta).find(k =>
            CodecMeta[k].label === label && k.startsWith("lib") && FfmpegCaps[k]);
        const gpuCodec = gpuSuffix ? Object.keys(CodecMeta).find(k =>
            CodecMeta[k].label === label && k.endsWith(gpuSuffix) && FfmpegCaps[k]) : null;

        const items = [];
        if (cpuCodec) items.push({ codec: cpuCodec, text: "CPU" });
        if (gpuCodec) items.push({ codec: gpuCodec, text: "GPU·" + gpuLabel });

        if (items.length === 0) return;

        const familyRow = document.createElement("div");
        familyRow.className = "CodecFamily";

        const name = document.createElement("span");
        name.className = "CodecFamLabel";
        name.textContent = label;
        familyRow.appendChild(name);

        const opts = document.createElement("div");
        opts.className = "CodecFamOpts";

        items.forEach(({ codec, text }) => {
            const btn = document.createElement("span");
            btn.className = "CodecOpt" + (codec === SelectedCodec ? " on" : "");
            btn.dataset.codec = codec;
            btn.textContent = text;
            btn.addEventListener("click", () => SelectCodec(codec));
            opts.appendChild(btn);
        });

        familyRow.appendChild(opts);
        Row.appendChild(familyRow);
    });

    // Select first available if none selected
    const allCodecs = [...Row.querySelectorAll(".CodecOpt")].map(el => el.dataset.codec);
    if (!allCodecs.includes(SelectedCodec) && allCodecs.length > 0) {
        SelectCodec(allCodecs[0]);
    }
}

function ApplyFfmpegCaps() {
    if (!FfmpegCaps) return;

    const gpuNames = { nvidia: "NVIDIA NVENC", amd: "AMD AMF", intel: "Intel QuickSync", cpu: "CPU (sin GPU)" };
    AddLog(`FFmpeg detectado: GPU=${gpuNames[FfmpegCaps.gpu] || FfmpegCaps.gpu}`, "info");

    RenderCodecSelector();
}

function escapeHtml(Text) {
    if (!Text) return '';
    const Div = document.createElement('div');
    Div.textContent = Text;
    return Div.innerHTML;
}

function AddLog(Message, Type = "info") {
    const LogBody = document.getElementById("logBody");
    if (!LogBody) return;
    const Line = document.createElement("div");
    Line.className = `LogLine ${Type}`;
    Line.textContent = `[${new Date().toLocaleTimeString()}] ${Message}`.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}\u{2705}]/gu, '');
    LogBody.appendChild(Line);
    LogBody.scrollTop = LogBody.scrollHeight;
    const logPreview = document.getElementById("logPreview");
    if (logPreview) logPreview.textContent = Message.substring(0, 100);
}

function HandleBackendMessage(Data) {
    console.log("Mensaje del backend:", Data);
    switch(Data.action) {
        case "presets_list":
            CurrentPresets = Data.presets || {};
            RenderPresetsBar();
            const modal = document.getElementById("presetManagerModal");
            if (modal && modal.style.display !== 'none') {
                RenderPresetsList();
            }
            AddLog(`📦 ${Object.keys(CurrentPresets).length} presets disponibles`, "info");
            break;

        case "presets_updated":
            SendMessage('get_presets');
            break;

        case "ffmpeg_caps":
            FfmpegCaps = Data.caps;
            ApplyFfmpegCaps();
            break;

        case "queue_started":
            QueueProcessing = true;
            document.getElementById("encodeBtn").style.display = "none";
            document.getElementById("stopBtn").style.display = "block";
            AddLog(`🚀 Iniciando procesamiento de cola (${Data.total} archivos)`, "success");
            break;

        case "queue_progress":
            document.getElementById("queueCurrent").textContent = Data.current;
            document.getElementById("queueTotal").textContent = Data.total;
            window.queueCurrentIndex = Data.current;
            window.queueTotalCount = Data.total;
            AddLog(`📋 Procesando (${Data.current}/${Data.total}): ${Data.filename}`, "info");
            break;

        case "queue_finished":
            QueueProcessing = false;
            document.getElementById("queueProgress").style.display = "none";
            if (Data.stopped) {
                AddLog(`⏹️ Cola detenida (${Data.total || 0} archivos procesados)`, "warning");
            } else {
                AddLog(`✅ Cola completada (${Data.total} archivos procesados)`, "success");
            }
            FileQueue = [];
            ClearCurrentVideo();
            RenderQueueList();
            LoadHistory();
            IsEncoding = false;
            document.getElementById("encodeBtn").style.display = "block";
            document.getElementById("stopBtn").style.display = "none";
            document.getElementById("progressFill").style.width = "0%";
            break;

        case "history_list":
            RenderHistory(Data.history, Data.total_saved_mb);
            break;

        case "history_updated":
            LoadHistory();
            break;

        case "save_compression_factor":
            try {
                let savedFactors = JSON.parse(localStorage.getItem('swissvideo_factors') || '{}');
                savedFactors[Data.key] = Data.factor;
                localStorage.setItem('swissvideo_factors', JSON.stringify(savedFactors));
                AddLog(`📊 Factor de compresión guardado: ${Math.round(Data.factor * 100)}% (${Math.round(Data.outputSize)}MB / ${Math.round(Data.originalSize)}MB)`, "info");
                UpdateEstimate();
            } catch(e) {
                console.error('Error guardando factor:', e);
            }
            break;

        case "log":
            AddLog(Data.line, Data.type || "debug");
            break;

        case "video_info":
            if (!CurrentVideoPath) {
                break;
            }
            if (Data.request_id !== undefined && Data.request_id !== null && Data.request_id !== VideoInfoRequestSeq) {
                break;
            }
            if (Data.success && Data.info) {
                CurrentVideoInfo = Data.info;
                CurrentVideoInfo.path = CurrentVideoPath;
                UpdateVideoInfoDisplay(CurrentVideoInfo);
                UpdateAudioTracks(CurrentVideoInfo);
                UpdateEstimatedTotalFrames();
                AddLog(`Archivo cargado: ${Data.info.filename}`, "success");
            } else if (!Data.success) {
                AddLog(`Error al analizar: ${Data.error}`, "error");
            }
            break;

        case "progress":
            UpdateProgress(Data);
            break;

        case "encode_started":
            IsEncoding = true;
            FirstFrameReceived = false;
            window.lastKnownFrames = 0;
            window.lastKnownSeconds = 0;
            let dur = (Data.duration_seconds && Data.duration_seconds > 0)
                ? Data.duration_seconds
                : (CurrentVideoInfo?.duration_seconds || 0);

            const cutStart = Data.cut_start;
            const cutEnd = Data.cut_end;
            let cutStartSec = 0;
            if (cutStart || cutEnd) {
                cutStartSec = cutStart ? HmsToSeconds(cutStart) : 0;
                const cutEndSec = (cutEnd && cutEnd !== "00:00:00") ? HmsToSeconds(cutEnd) : dur;
                if (cutEndSec > cutStartSec) {
                    dur = cutEndSec - cutStartSec;
                } else if (dur > cutStartSec) {
                    dur = dur - cutStartSec;
                }
            }
            window.currentEncodeDuration = Math.max(0, dur);
            window.currentEncodeCutStartSeconds = cutStartSec;

            const rawFps = Data.fps ? parseFloat(Data.fps) : (CurrentVideoInfo ? parseFloat(CurrentVideoInfo.fps) : 30);
            window.currentEncodeFps = (isNaN(rawFps) || rawFps <= 0) ? 30 : rawFps;

            document.getElementById("encodeBtn").style.display = "none";
            document.getElementById("stopBtn").style.display = "block";

            const stopBtn = document.getElementById("stopBtn");
            if (stopBtn) stopBtn.disabled = false;

            document.getElementById("framesDone").textContent = "0";
            document.getElementById("framesTotal").textContent = "0";
            document.getElementById("progressFill").style.width = "0%";
            document.getElementById("etaVal").textContent = "--:--";

            const statusDiv3 = document.getElementById("encodingStatus");
            if (statusDiv3) {
                statusDiv3.innerHTML = `${Icons.refresh} Iniciando compresión...`;
                statusDiv3.style.color = "var(--Warn)";
            }
            AddLog(`Iniciando compresión`, "success");
            break;

        case "encode_finished":
            IsEncoding = false;
            document.getElementById("encodeBtn").style.display = "block";
            document.getElementById("stopBtn").style.display = "none";
            document.getElementById("progressFill").style.width = "0%";

            const warningContainer = document.getElementById("sizeWarningContainer");
            if (warningContainer) {
                setTimeout(() => { warningContainer.innerHTML = ""; }, 3000);
            }

            const statusDiv2 = document.getElementById("encodingStatus");
            if (statusDiv2) {
                if (Data.success) {
                    statusDiv2.innerHTML = `${Icons.check} Compresión completada`;
                    statusDiv2.style.color = "var(--Success)";
                } else {
                    statusDiv2.innerHTML = `${Icons.x} Compresión cancelada`;
                    statusDiv2.style.color = "var(--Danger)";
                }
                setTimeout(() => { if (statusDiv2) statusDiv2.innerHTML = ""; }, 5000);
            }

            if (Data.success) {
                AddLog(`✅ Compresión completada: ${Data.output}`, "success");
            } else {
                AddLog(`❌ Error: ${Data.error}`, "error");
            }
            break;

        case "file_size_warning":
            if (Data.size_mb > 5000) {
                AddLog(`⚠️ Archivo grande (${(Data.size_mb/1024).toFixed(1)}GB). El análisis inicial puede tardar varios segundos.`, "warning");
            }
            break;
    }
}

function UpdateVideoInfoDisplay(Info) {
    const elements = {
        infoName: Info.filename,
        infoDuration: Info.duration_str,
        infoRes: Info.resolution,
        infoFps: `${Info.fps} fps`,
        infoSize: `${Info.size_mb.toFixed(1)} MB`,
        fullEndTime: Info.duration_str,
    };
    for (const [id, value] of Object.entries(elements)) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }
    const cutEndInput = document.getElementById("cutEnd");
    if (cutEndInput && (!cutEndInput.value || cutEndInput.value === "00:00:00")) {
        cutEndInput.value = Info.duration_str;
    }
    UpdateVideoPreview(Info.path);
    UpdateEstimate();
    UpdateNamePreview();
}

function UpdateAudioTracks(Info) {
    const Container = document.getElementById("audioTracksContainer");
    if (!Container) return;
    Container.innerHTML = "";

    if (!Info.audio_tracks || Info.audio_tracks.length === 0) {
        Container.innerHTML = '<div style="color: var(--Text3); padding: 8px;">No se detectaron pistas de audio</div>';
        return;
    }

    Info.audio_tracks.forEach((Track) => {
        const Div = document.createElement("div");
        Div.className = "TrackRow";

        const trackInfo = [];
        if (Track.codec) trackInfo.push(Track.codec);
        if (Track.channels) trackInfo.push(`${Track.channels}ch`);
        if (Track.language && Track.language !== 'unknown') trackInfo.push(Track.language);
        const infoStr = trackInfo.length ? ` (${trackInfo.join(', ')})` : '';

        const Label = Track.title ? Track.title : `Track ${Track.index}`;
        Div.innerHTML = `<input type="checkbox" class="audio-track-cb" data-track="${Track.index}"><span>${Label}${infoStr}</span>`;
        Container.appendChild(Div);
    });

    // Restaurar selección guardada del queue item, o marcar primera pista por defecto
    if (PendingAudioRestoreTracks && PendingAudioRestoreTracks.length > 0) {
        PendingAudioRestoreTracks.forEach(trackIdx => {
            const cb = Container.querySelector(`.audio-track-cb[data-track="${trackIdx}"]`);
            if (cb) cb.checked = true;
        });
        PendingAudioRestoreTracks = null;
    } else {
        // Marcar la primera pista de audio disponible (no buscar data-track="0"
        // porque stream 0 suele ser video, no audio)
        const FirstCb = Container.querySelector('.audio-track-cb');
        if (FirstCb) FirstCb.checked = true;
    }
}

function UpdateVideoPreview(videoPath) {
    const previewVideo = document.getElementById("previewVideo");
    const previewSource = document.getElementById("previewSource");
    const videoPlaceholder = document.getElementById("videoPlaceholder");

    if (!previewVideo || !previewSource) return;

    if (videoPath && videoPath !== "") {
        CloseCutSelector();
        const fileUrl = convertFileSrc(videoPath);
        previewSource.src = fileUrl;
        previewVideo.load();

        if (videoPlaceholder) videoPlaceholder.style.display = "none";
        previewVideo.style.display = "block";
        previewVideo.preload = "metadata";

        AddLog(`📹 Preview cargado: ${videoPath.split(/[\\/]/).pop()}`, "info");
    } else {
        previewSource.src = "";
        previewVideo.load();
        if (videoPlaceholder) videoPlaceholder.style.display = "flex";
        previewVideo.style.display = "none";
    }
}

function UpdateProgress(Data) {
    const framesDone = GetEl("framesDone");
    const speedVal = GetEl("speedVal");
    const framesTotalElem = GetEl("framesTotal");
    const currentSizeElem = GetEl("currentSize");
    const statusDiv = GetEl("encodingStatus");

    if (!FirstFrameReceived && (Data.frames_done > 0 || (Data.current_seconds && Data.current_seconds > 0))) {
        FirstFrameReceived = true;
        if (statusDiv) {
            statusDiv.innerHTML = `${Icons.film} Comprimiendo video...`;
            statusDiv.style.color = "var(--Accent)";
        }
        AddLog("✅ Análisis completado, comenzando compresión", "success");
    }

    if (currentSizeElem && Data.current_size_kb !== undefined) {
        const currentSizeMB = (Data.current_size_kb / 1024).toFixed(1);
        currentSizeElem.textContent = currentSizeMB;
        UpdateLiveEstimate(Data.current_size_kb / 1024, Data.current_seconds);
    }

    if (speedVal) {
        if (Data.encode_fps !== undefined && Data.encode_fps !== null) {
            speedVal.textContent = Data.encode_fps.toFixed(0);
        } else if (Data.speed !== undefined && Data.speed !== null && Data.speed <= 50) {
            const estimatedFps = Data.speed * (window.currentEncodeFps || 30);
            speedVal.textContent = estimatedFps.toFixed(0);
        }
    }

    const activeDuration = window.currentEncodeDuration || GetTrimmedDuration();
    let targetFps;
    const fpsSelect = document.getElementById("fpsSelect")?.value;
    if (fpsSelect && fpsSelect !== "original") {
        targetFps = parseInt(fpsSelect);
    } else {
        targetFps = window.currentEncodeFps || 30;
    }
    const totalFrames = Math.max(1, Math.round(activeDuration * targetFps));

    if (framesTotalElem && totalFrames > 0) {
        framesTotalElem.textContent = totalFrames.toLocaleString();
    }

    let currentFrames = null;

    if (Data.frames_done !== undefined && Data.frames_done !== null && Data.frames_done > 0) {
        currentFrames = Data.frames_done;
        window.lastKnownFrames = currentFrames;
    }
    else if (Data.current_seconds !== undefined && Data.current_seconds > 0) {
        const CutStartSec = window.currentEncodeCutStartSeconds || 0;
        const AdjustedSeconds = CutStartSec > 0
            ? Math.max(0, Data.current_seconds - CutStartSec)
            : Data.current_seconds;
        currentFrames = Math.round(AdjustedSeconds * targetFps);
        if (currentFrames > 0) window.lastKnownFrames = currentFrames;
    }
    else if (window.lastKnownFrames && window.lastKnownFrames > 0) {
        currentFrames = window.lastKnownFrames;
    }

    if (currentFrames !== null && currentFrames >= 0 && framesDone) {
        framesDone.textContent = currentFrames.toLocaleString();
    }

    let percent = 0;
    if (totalFrames > 0 && currentFrames && currentFrames > 0) {
        percent = Math.min(100, Math.max(0, (currentFrames / totalFrames) * 100));
    } else if (Data.current_seconds && activeDuration > 0) {
        percent = Math.min(100, Math.max(0, (Data.current_seconds / activeDuration) * 100));
    }

    const progressFill = document.getElementById("progressFill");
    if (progressFill && percent >= 0) {
        progressFill.style.width = `${percent}%`;
    }

    const etaVal = document.getElementById("etaVal");
    if (Data.encode_fps && Data.encode_fps > 0 && totalFrames > 0 && currentFrames && currentFrames > 0) {
        const remainingFrames = totalFrames - currentFrames;
        const remainingSeconds = remainingFrames / Data.encode_fps;
        if (isFinite(remainingSeconds) && remainingSeconds > 0) {
            const Minutes = Math.floor(remainingSeconds / 60);
            const Seconds = Math.floor(remainingSeconds % 60);
            if (etaVal) etaVal.textContent = `${Minutes}:${Seconds.toString().padStart(2, '0')}`;
        }
    } else if (Data.speed && Data.speed > 0 && Data.speed <= 50 && totalFrames > 0 && currentFrames && currentFrames > 0) {
        const remainingFrames = totalFrames - currentFrames;
        const remainingSeconds = remainingFrames / (Data.speed * targetFps);
        if (isFinite(remainingSeconds) && remainingSeconds > 0) {
            const Minutes = Math.floor(remainingSeconds / 60);
            const Seconds = Math.floor(remainingSeconds % 60);
            if (etaVal) etaVal.textContent = `${Minutes}:${Seconds.toString().padStart(2, '0')}`;
        }
    }
}

function UpdateLiveEstimate(currentSizeMB, currentSeconds) {
    if (!CurrentVideoInfo) return;
    if (!currentSizeMB || currentSizeMB <= 0) return;
    if (!currentSeconds || currentSeconds <= 0) return;

    const trimmedDuration = GetTrimmedDuration();
    if (trimmedDuration <= 0) return;

    let adjustedSeconds = currentSeconds;
    const isCustomCut = document.getElementById("cutCustomBtn")?.classList.contains("on");
    if (isCustomCut) {
        const cutStart = document.getElementById("cutStart")?.value || "00:00:00";
        const startSeconds = HmsToSeconds(cutStart);
        adjustedSeconds = Math.max(0, currentSeconds - startSeconds);
    }

    if (adjustedSeconds <= 0) return;

    const estimatedTotalMB = (currentSizeMB / adjustedSeconds) * trimmedDuration;
    const reduction = ((CurrentVideoInfo.size_mb - estimatedTotalMB) / CurrentVideoInfo.size_mb) * 100;

    const estSize = document.getElementById("estSize");
    const estReduction = document.getElementById("estReduction");

    if (estSize) {
        estSize.textContent = `~${Math.round(estimatedTotalMB)} MB (en vivo)`;
        estSize.style.color = "var(--Accent)";
    }

    if (estReduction) {
        const reductionPercent = Math.max(-100, Math.min(100, reduction));
        estReduction.textContent = `${reductionPercent > 0 ? '-' : '+'}${Math.abs(Math.round(reductionPercent))}%`;
        if (reductionPercent < 0) {
            estReduction.style.color = "var(--Danger)";
        } else {
            estReduction.style.color = "var(--Success)";
        }
    }
}

function UpdateEstimate() {
    if (!CurrentVideoInfo) return;
    if (IsEncoding) return;

    const key = `${SelectedCodec}_${document.getElementById("qualitySlider")?.value || 23}`;
    let savedFactors = {};
    try {
        savedFactors = JSON.parse(localStorage.getItem('swissvideo_factors') || '{}');
    } catch(e) {}
    const savedFactor = savedFactors[key];

    if (savedFactor && savedFactor > 0) {
        const EstimatedMb = CurrentVideoInfo.size_mb * savedFactor;
        const estSize = document.getElementById("estSize");
        const estReduction = document.getElementById("estReduction");
        if (estSize) {
            estSize.textContent = `~${Math.round(EstimatedMb)} MB (historial)`;
            estSize.style.color = "var(--Accent)";
        }
        if (estReduction) {
            estReduction.textContent = `-${Math.round((1 - savedFactor) * 100)}%`;
            estReduction.style.color = "var(--Success)";
        }
        return;
    }

    const Quality = parseInt(document.getElementById("qualitySlider")?.value || 23);
    let Ratio = Quality <= 18 ? 0.7 : (Quality <= 28 ? 0.35 : 0.15);

    const Resolution = document.getElementById("resolutionSelect")?.value;
    if (Resolution === "1280x720") Ratio *= 0.5;
    else if (Resolution === "854x480") Ratio *= 0.25;
    else if (Resolution === "3840x2160") Ratio *= 2.5;
    else if (Resolution === "2560x1440") Ratio *= 1.2;

    const EstimatedMb = CurrentVideoInfo.size_mb * Ratio;
    const estSize = document.getElementById("estSize");
    const estReduction = document.getElementById("estReduction");
    if (estSize) {
        estSize.textContent = `~${Math.round(EstimatedMb)} MB (estimado)`;
        estSize.style.color = "var(--Accent)";
    }
    if (estReduction) {
        estReduction.textContent = `-${Math.round((1 - Ratio) * 100)}%`;
        estReduction.style.color = "var(--Success)";
    }
}

function UpdateNamePreview() {
    if (!CurrentVideoInfo) return;
    const Template = document.getElementById("nameTemplate")?.value || "{nombre}_{codec}_q{qp}";
    let Preview = Template;
    Preview = Preview.replace("{nombre}", CurrentVideoInfo.filename.replace(/\.[^/.]+$/, ""));
    Preview = Preview.replace("{codec}", CodecMap[SelectedCodec] || "h265");
    Preview = Preview.replace("{qp}", document.getElementById("qualitySlider")?.value || "23");
    const Res = document.getElementById("resolutionSelect")?.value;
    Preview = Preview.replace("{res}", Res === "original" ? "orig" : (Res?.split("x")[1] + "p") || "orig");
    const Fps = document.getElementById("fpsSelect")?.value;
    Preview = Preview.replace("{fps}", Fps === "original" ? "orig" : Fps || "30");
    Preview = Preview.replace("{fecha}", new Date().toISOString().slice(0,10).replace(/-/g, ""));
    const namePreview = document.getElementById("namePreview");
    if (namePreview) namePreview.textContent = Preview;
}

function UpdateCrfSlider(codec) {
    const slider = document.getElementById("qualitySlider");
    const valDisplay = document.getElementById("qualityVal");
    if (!slider) return;
    const rc = document.querySelector("#rateCtrl .RateOpt.on")?.dataset.rc;
    if (rc !== "cq") return;
    const range = CodecCrfRange[codec] || CodecCrfRange.libx265;
    const oldMax = parseInt(slider.max);
    slider.min = range.min;
    slider.max = range.max;
    if (oldMax !== range.max) {
        slider.value = range.default;
        if (valDisplay) valDisplay.textContent = range.default;
        UpdateEstimate();
    }
    const label = document.getElementById("qualityLabel");
    if (label) {
        let mode = "CRF";
        if (codec.includes("nvenc")) mode = "CQ";
        else if (codec.includes("amf")) mode = "QP";
        else if (codec.includes("qsv")) mode = "GQuality";
        label.textContent = `Calidad (${mode})`;
    }
}

function UpdateSliderMode() {
    const rc = document.querySelector("#rateCtrl .RateOpt.on")?.dataset.rc || "cq";
    const slider = document.getElementById("qualitySlider");
    const valDisplay = document.getElementById("qualityVal");
    const label = document.getElementById("qualityLabel");
    if (!slider) return;

    if (rc === "cq") {
        lastSliderBitrate = parseInt(slider.value);
        slider.value = lastSliderQuality;
        UpdateCrfSlider(SelectedCodec);
    } else {
        lastSliderQuality = parseInt(slider.value);
        slider.min = 1;
        slider.max = 50;
        slider.value = lastSliderBitrate;
        if (label) label.textContent = "Bitrate";
        if (valDisplay) valDisplay.textContent = `${lastSliderBitrate} Mbps`;
    }
}

function GetQualityValue() {
    const rc = document.querySelector("#rateCtrl .RateOpt.on")?.dataset.rc;
    if (rc === "cq") return parseInt(document.getElementById("qualitySlider")?.value) || 23;
    return lastSliderQuality;
}

function GetBitrateValue() {
    const rc = document.querySelector("#rateCtrl .RateOpt.on")?.dataset.rc;
    if (rc === "cq") return lastSliderBitrate;
    return parseInt(document.getElementById("qualitySlider")?.value) || 0;
}

function SelectCodec(CodecValue) {
    SelectedCodec = CodecValue;
    UpdateCrfSlider(CodecValue);
    UpdateNamePreview();
    UpdateEstimate();
    const meta = CodecMeta[CodecValue];
    const displayName = meta ? (meta.hwtag ? `${meta.label}·${meta.hwtag}` : `${meta.label} CPU`) : CodecValue;
    AddLog(`Codec: ${displayName}`, "info");
    SaveCodecUsage(CodecValue);
    ClearActivePresetIfCustomized();
    RenderCodecSelector();
}

function SaveCodecUsage(codec) {
    if (!FfmpegCaps) return;
    const usage = FfmpegCaps.usage || {};
    usage[codec] = (usage[codec] || 0) + 1;
    invoke("save_codec_usage", { usage }).catch(() => {});
}

function LoadVideoInfo(FilePath) {
    if (!FilePath) return;
    CurrentVideoPath = FilePath;
    VideoInfoRequestSeq += 1;
    SendMessage('get_video_info', { path: FilePath }, VideoInfoRequestSeq);
}

async function StartEncode() {
    const batchMode = document.getElementById("batchModeCheck")?.checked || false;

    if (batchMode && FileQueue.length > 0) {
        if (IsEncoding || QueueProcessing) {
            AddLog("⚠️ Ya hay una tarea activa", "warning");
            return;
        }
        AddLog(`🚀 Iniciando procesamiento en lote (${FileQueue.length} archivos)`, "info");
        ProcessQueue();
        return;
    }

    if (!CurrentVideoPath) {
        AddLog("❌ Selecciona un video de la cola o carga uno primero", "error");
        return;
    }

    if (IsEncoding) {
        AddLog("⚠️ Ya hay una compresión activa", "warning");
        return;
    }

    if (!CurrentVideoInfo || !CurrentVideoInfo.duration_seconds) {
        AddLog("⏳ Espera a que termine de cargar la información del video", "error");
        return;
    }

    const framesDone = document.getElementById("framesDone");
    const speedVal = document.getElementById("speedVal");
    const framesTotalElem = document.getElementById("framesTotal");
    const progressFill = document.getElementById("progressFill");
    const etaVal = document.getElementById("etaVal");
    const currentSizeElem = document.getElementById("currentSize");

    if (framesDone) framesDone.textContent = "0";
    if (speedVal) speedVal.textContent = "0";
    if (progressFill) progressFill.style.width = "0%";
    if (etaVal) etaVal.textContent = "--:--";
    if (currentSizeElem) currentSizeElem.textContent = "0";

    window.lastKnownFrames = 0;
    window.lastKnownSeconds = 0;
    FirstFrameReceived = false;

    const statusDiv = document.getElementById("encodingStatus");
    if (statusDiv) {
        if (CurrentVideoInfo && CurrentVideoInfo.size_mb > 5000) {
            statusDiv.innerHTML = "<span class='analyzing-spinner'></span> Analizando archivo grande... puede tomar hasta 30 segundos";
            statusDiv.style.color = "var(--Warn)";
        } else {
            statusDiv.innerHTML = "<span class='analyzing-spinner'></span> Analizando archivo...";
            statusDiv.style.color = "var(--Warn)";
        }
    }

    const warningContainer = document.getElementById("sizeWarningContainer");
    if (warningContainer && CurrentVideoInfo && CurrentVideoInfo.size_mb > 5000) {
        warningContainer.innerHTML = `
            <div style="background: rgba(245, 158, 11, 0.15); border-left: 3px solid var(--Warn); padding: 8px 12px; border-radius: 6px; margin-top: 12px; font-size: 11px;">
                ⏳ <strong>Archivo grande (${(CurrentVideoInfo.size_mb/1024).toFixed(1)}GB)</strong><br>
                La compresión puede tardar 10-30 segundos en comenzar mientras FFmpeg analiza el archivo.
            </div>
        `;
    } else if (warningContainer) {
        warningContainer.innerHTML = "";
    }

    AddLog("🔄 Iniciando nueva compresión...", "info");

    let OutputDir = document.getElementById("destPath")?.value || "";
    const sameFolderCheck = document.getElementById("sameFolderCheck");
    if (sameFolderCheck?.checked) {
        const PathParts = CurrentVideoPath.split(/[\\/]/);
        PathParts.pop();
        OutputDir = PathParts.join('\\');
    }

    const audioTracks = [...document.querySelectorAll(".audio-track-cb:checked")].map(Cb => parseInt(Cb.dataset.track));

    const Params = {
        input_path: CurrentVideoPath,
        output_dir: OutputDir,
        name_template: document.getElementById("nameTemplate")?.value || "{nombre}_{codec}_q{qp}",
        codec: SelectedCodec,
        quality: GetQualityValue(),
        preset_idx: parseInt(document.getElementById("presetSlider")?.value || 4),
        resolution: document.getElementById("resolutionSelect")?.value || "original",
        fps: document.getElementById("fpsSelect")?.value || "original",
        bitrate: GetBitrateValue(),
        rate_control: (document.querySelector("#rateCtrl .RateOpt.on")?.dataset.rc) || "cq",
        audio_tracks: audioTracks,
        custom_mix: document.getElementById("customMixCheck")?.checked || false,
        cut_start: document.getElementById("cutCustomBtn")?.classList.contains("on") ? document.getElementById("cutStart")?.value : null,
        cut_end: document.getElementById("cutCustomBtn")?.classList.contains("on") ? document.getElementById("cutEnd")?.value : null,
    };

    try {
        const colision = await invoke("verificar_nombre_salida", { params: Params });
        if (colision && colision.existe) {
            const decision = await preguntarColision(colision);
            if (decision === "cancelar") {
                AddLog("❌ Compresión cancelada: el archivo de salida ya existe", "warning");
                return;
            }
            if (decision === "renombrar" && colision.alternativo) {
                Params.output_override = colision.alternativo;
            }
        }
    } catch (e) {
        console.warn("No se pudo verificar la salida:", e);
    }

    window.currentEncodeDuration = GetTrimmedDuration();
    const fpsVal = document.getElementById("fpsSelect")?.value;
    window.currentEncodeFps = fpsVal && fpsVal !== "original"
        ? parseInt(fpsVal)
        : (CurrentVideoInfo ? parseFloat(CurrentVideoInfo.fps) : 30);
    const cutStartVal = document.getElementById("cutCustomBtn")?.classList.contains("on")
        ? document.getElementById("cutStart")?.value
        : null;
    window.currentEncodeCutStartSeconds = cutStartVal ? HmsToSeconds(cutStartVal) : 0;
    IsEncoding = true;

    SendMessage("start_encode", { params: Params });
}

let PendingCollisionResolver = null;

function preguntarColision(info) {
    return new Promise((resolve) => {
        const Modal = document.getElementById("collisionModal");
        const FileNameEl = document.getElementById("collisionFileName");
        const NewNameEl = document.getElementById("collisionNewName");
        const RenameBtn = document.getElementById("collisionRenameBtn");
        if (FileNameEl && info.salida) FileNameEl.textContent = info.salida.split(/[\\/]/).pop();
        const ext = info.salida ? "." + info.salida.split('.').pop() : "";
        if (RenameBtn) {
            if (info.alternativo) {
                if (NewNameEl) NewNameEl.textContent = info.alternativo + ext;
                RenameBtn.disabled = false;
            } else {
                if (NewNameEl) NewNameEl.textContent = "...";
                RenameBtn.disabled = true;
            }
        }
        PendingCollisionResolver = resolve;
        if (Modal) Modal.style.display = "flex";
    });
}

function resolverColision(decision) {
    const Modal = document.getElementById("collisionModal");
    if (Modal) Modal.style.display = "none";
    if (PendingCollisionResolver) {
        PendingCollisionResolver(decision);
        PendingCollisionResolver = null;
    }
}

function StopEncode() {
    if (QueueProcessing) {
        SendMessage("stop_queue");
    } else {
        SendMessage("stop_encode");
    }

    const statusDiv = document.getElementById("encodingStatus");
    if (statusDiv) {
        statusDiv.innerHTML = `${Icons.stop} Deteniendo...`;
        statusDiv.style.color = "var(--Warn)";
    }

    AddLog("⏹️ Deteniendo proceso... puede tomar unos segundos", "warning");

    const stopBtn = document.getElementById("stopBtn");
    if (stopBtn) stopBtn.disabled = true;

    setTimeout(() => {
        if (stopBtn) stopBtn.disabled = false;
    }, 2000);
}

function ToggleLog() {
    LogExpanded = !LogExpanded;
    const LogBody = document.getElementById("logBody");
    const Chevron = document.getElementById("logChevron");
    if (LogBody && Chevron) {
        if (LogExpanded) {
            LogBody.classList.add("open");
            Chevron.textContent = "▼ colapsar";
        } else {
            LogBody.classList.remove("open");
            Chevron.textContent = "▲ expandir";
        }
    }
}

function UpdateEstimatedTotalFrames() {
    if (!CurrentVideoInfo) return;

    const DurationSeconds = GetTrimmedDuration();
    const FpsSelect = document.getElementById("fpsSelect")?.value;

    let FpsValue;
    if (FpsSelect && FpsSelect !== "original") {
        FpsValue = parseInt(FpsSelect);
    } else {
        FpsValue = parseFloat(CurrentVideoInfo.fps);
    }

    const EstimatedTotalFrames = Math.round(DurationSeconds * FpsValue);
    const framesTotal = document.getElementById("framesTotal");
    if (framesTotal) framesTotal.textContent = EstimatedTotalFrames.toLocaleString();

    window.EstimatedTotalFrames = EstimatedTotalFrames;
    window.CurrentFpsValue = FpsValue;
    window.TrimmedDuration = DurationSeconds;
}

// ========== REPRODUCTOR DE CORTE ==========
let PlayerMarkedStart = null;
let PlayerMarkedEnd = null;
let IsScrubbing = false;

function SecondsToHms(S) {
    const H = Math.floor(S / 3600);
    const M = Math.floor((S % 3600) / 60);
    const Sec = Math.floor(S % 60);
    return `${String(H).padStart(2,'0')}:${String(M).padStart(2,'0')}:${String(Sec).padStart(2,'0')}`;
}

function HmsToSeconds(Hms) {
    if (!Hms) return 0;
    const Parts = String(Hms).split(':').map(Number);
    if (Parts.length === 3) return (Parts[0]||0)*3600 + (Parts[1]||0)*60 + (Parts[2]||0);
    if (Parts.length === 2) return (Parts[0]||0)*60 + (Parts[1]||0);
    if (Parts.length === 1) return Parts[0] || 0;
    return 0;
}

function UpdateTimelineVisuals() {
    const CutVideo = document.getElementById("previewVideo");
    const PlayerFill = document.getElementById("playerFill");
    const PlayerThumb = document.getElementById("playerThumb");
    const PlayerTimeDisp = document.getElementById("playerTimeDisplay");
    if (!CutVideo || !PlayerFill || !PlayerThumb || !PlayerTimeDisp) return;
    const Pct = CutVideo.duration ? (CutVideo.currentTime / CutVideo.duration) * 100 : 0;
    PlayerFill.style.width = `${Pct}%`;
    PlayerThumb.style.left = `${Pct}%`;
    PlayerTimeDisp.textContent = `${SecondsToHms(CutVideo.currentTime)} / ${SecondsToHms(CutVideo.duration || 0)}`;
    UpdateMarkerVisuals();
}

function UpdateMarkerVisuals() {
    const CutVideo = document.getElementById("previewVideo");
    const MarkerStart = document.getElementById("markerStart");
    const MarkerEnd = document.getElementById("markerEnd");
    const MarkStartTime = document.getElementById("markStartTime");
    const MarkEndTime = document.getElementById("markEndTime");
    const PlayerSelection = document.getElementById("playerSelection");
    if (!CutVideo) return;
    const Dur = CutVideo.duration || 1;
    if (PlayerMarkedStart !== null && MarkerStart && MarkStartTime) {
        const Pct = (PlayerMarkedStart / Dur) * 100;
        MarkerStart.style.left = `${Pct}%`;
        MarkerStart.style.display = 'block';
        MarkStartTime.textContent = SecondsToHms(PlayerMarkedStart);
    }
    if (PlayerMarkedEnd !== null && MarkerEnd && MarkEndTime) {
        const Pct = (PlayerMarkedEnd / Dur) * 100;
        MarkerEnd.style.left = `${Pct}%`;
        MarkerEnd.style.display = 'block';
        MarkEndTime.textContent = SecondsToHms(PlayerMarkedEnd);
    }
    if (PlayerMarkedStart !== null && PlayerMarkedEnd !== null && PlayerMarkedEnd > PlayerMarkedStart && PlayerSelection) {
        const L = (PlayerMarkedStart / Dur) * 100;
        const W = ((PlayerMarkedEnd - PlayerMarkedStart) / Dur) * 100;
        PlayerSelection.style.left = `${L}%`;
        PlayerSelection.style.width = `${W}%`;
        PlayerSelection.style.display = 'block';
    } else if (PlayerSelection) {
        PlayerSelection.style.display = 'none';
    }
    const MarkerStartLabel = document.getElementById("markerStartTime");
    const MarkerEndLabel = document.getElementById("markerEndTime");
    if (MarkerStartLabel) MarkerStartLabel.textContent = PlayerMarkedStart !== null ? SecondsToHms(PlayerMarkedStart) : "--:--:--";
    if (MarkerEndLabel) MarkerEndLabel.textContent = PlayerMarkedEnd !== null ? SecondsToHms(PlayerMarkedEnd) : "--:--:--";
}

function SeekFromTimelineEvent(E) {
    const PlayerTimeline = document.getElementById("playerTimeline");
    const CutVideo = document.getElementById("previewVideo");
    if (!PlayerTimeline || !CutVideo) return;
    const Rect = PlayerTimeline.getBoundingClientRect();
    const Ratio = Math.max(0, Math.min(1, (E.clientX - Rect.left) / Rect.width));
    if (CutVideo.duration) {
        CutVideo.currentTime = Ratio * CutVideo.duration;
    }
}

function OpenCutSelector() {
    if (!CurrentVideoPath) {
        AddLog("Carga un video primero", "error");
        return;
    }
    const ExistingStart = document.getElementById("cutStart")?.value;
    const ExistingEnd = document.getElementById("cutEnd")?.value;
    PlayerMarkedStart = (ExistingStart && ExistingStart !== "00:00:00") ? HmsToSeconds(ExistingStart) : null;
    PlayerMarkedEnd = (ExistingEnd && ExistingEnd !== "00:00:00") ? HmsToSeconds(ExistingEnd) : null;
    const MarkerStart = document.getElementById("markerStart");
    const MarkerEnd = document.getElementById("markerEnd");
    const PlayerSelection = document.getElementById("playerSelection");
    const MarkStartTime = document.getElementById("markStartTime");
    const MarkEndTime = document.getElementById("markEndTime");
    if (MarkerStart) MarkerStart.style.display = 'none';
    if (MarkerEnd) MarkerEnd.style.display = 'none';
    if (PlayerSelection) PlayerSelection.style.display = 'none';
    if (MarkStartTime) MarkStartTime.textContent = PlayerMarkedStart !== null ? SecondsToHms(PlayerMarkedStart) : "--:--:--";
    if (MarkEndTime) MarkEndTime.textContent = PlayerMarkedEnd !== null ? SecondsToHms(PlayerMarkedEnd) : "--:--:--";
    const PreviewVideo = document.getElementById("previewVideo");
    const CutInlineBox = document.getElementById("cutInlineBox");
    if (!PreviewVideo || !CutInlineBox) return;
    PreviewVideo.pause();
    CutInlineBox.style.display = "flex";
    if (PreviewVideo.readyState < 1) {
        PreviewVideo.onloadedmetadata = () => {
            UpdateTimelineVisuals();
            UpdateMarkerVisuals();
        };
    }
    UpdateTimelineVisuals();
    UpdateMarkerVisuals();
    const PlayerPlayBtn = document.getElementById("playerPlayBtn");
    if (PlayerPlayBtn) PlayerPlayBtn.innerHTML = PreviewVideo.paused ? `${Icons.play} Play` : `${Icons.pause} Pausa`;
}

function CloseCutSelector() {
    const PreviewVideo = document.getElementById("previewVideo");
    const CutInlineBox = document.getElementById("cutInlineBox");
    if (PreviewVideo) PreviewVideo.pause();
    if (CutInlineBox) CutInlineBox.style.display = "none";
}

function validarCutInput(input) {
    const val = (input.value || "").trim();
    if (!val || val === "00:00:00") return true;
    if (!/^\d{1,2}:\d{2}:\d{2}([.,]\d+)?$/.test(val)) {
        AddLog(`❌ Formato inválido "${val}" (usá HH:MM:SS)`, "error");
        input.value = "00:00:00";
        return false;
    }
    return true;
}

function GetTrimmedDuration() {
    if (!CurrentVideoInfo) return CurrentVideoInfo?.duration_seconds || 0;

    const isCustomCut = document.getElementById("cutCustomBtn")?.classList.contains("on");
    if (!isCustomCut) return CurrentVideoInfo.duration_seconds;

    const cutStart = document.getElementById("cutStart")?.value || "00:00:00";
    let cutEnd = document.getElementById("cutEnd")?.value || CurrentVideoInfo.duration_str;

    const startSeconds = HmsToSeconds(cutStart);
    let endSeconds;

    if (cutEnd === "00:00:00" || cutEnd === "" || !cutEnd) {
        endSeconds = CurrentVideoInfo.duration_seconds;
    } else {
        endSeconds = HmsToSeconds(cutEnd);
    }

    if (endSeconds <= startSeconds) {
        return CurrentVideoInfo.duration_seconds - startSeconds;
    }

    return endSeconds - startSeconds;
}

// ========== COLA DE PROCESAMIENTO ==========
let FileQueue = [];
let QueueProcessing = false;
let StopRequested = false;
let CurrentQueueSelectedIndex = -1;
let PendingAudioRestoreTracks = null;

function AddToQueue(filePath) {
    if (!filePath) return;

    if (FileQueue.some(f => f.path === filePath)) {
        AddLog(`⚠️ ${filePath.split(/[\\/]/).pop()} ya está en la cola`, "warning");
        return;
    }

    FileQueue.push({ path: filePath, name: filePath.split(/[\\/]/).pop(), cut_start: null, cut_end: null, audio_tracks: null, audio_track_names: null });

    if (CurrentQueueSelectedIndex === -1) {
        SelectVideoFromQueue(FileQueue.length - 1);
    } else {
        RenderQueueList();
    }
    AddLog(`📋 Añadido a cola: ${FileQueue[FileQueue.length-1].name}`, "info");
}

function RemoveFromQueue(index) {
    const wasSelected = index === CurrentQueueSelectedIndex;
    FileQueue.splice(index, 1);

    if (wasSelected) {
        if (FileQueue.length > 0) {
            const nextIdx = Math.min(index, FileQueue.length - 1);
            SelectVideoFromQueue(nextIdx);
        } else {
            ClearCurrentVideo();
        }
    } else {
        if (CurrentQueueSelectedIndex > index) CurrentQueueSelectedIndex--;
        RenderQueueList();
    }
    AddLog("🗑️ Removido de cola", "info");
}

function ClearCurrentVideo() {
    CurrentVideoPath = null;
    CurrentVideoInfo = null;
    CurrentQueueSelectedIndex = -1;
    CloseCutSelector();
    PlayerMarkedStart = null;
    PlayerMarkedEnd = null;
    UpdateVideoPreview("");

    ["infoName", "infoDuration", "infoRes", "infoFps", "infoSize", "fullEndTime"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = "-";
    });

    const audioContainer = document.getElementById("audioTracksContainer");
    if (audioContainer) audioContainer.innerHTML = "";

    const cutStart = document.getElementById("cutStart");
    const cutEnd = document.getElementById("cutEnd");
    if (cutStart) cutStart.value = "00:00:00";
    if (cutEnd) cutEnd.value = "";

    const cutFullBtn = document.getElementById("cutFullBtn");
    const cutCustomBtn = document.getElementById("cutCustomBtn");
    const fullPane = document.getElementById("cutFullPane");
    const customPane = document.getElementById("cutCustomPane");
    if (cutFullBtn) cutFullBtn.classList.add("on");
    if (cutCustomBtn) cutCustomBtn.classList.remove("on");
    if (fullPane) fullPane.style.display = "block";
    if (customPane) customPane.style.display = "none";
}

function RenderQueueList() {
    const container = document.getElementById("queueList");
    if (!container) return;

    if (FileQueue.length === 0) {
        container.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--Text3);">
                ${Icons.box} Sin archivos en cola<br>
                Haz click en "Seleccionar Videos" para agregar videos
            </div>
        `;
        return;
    }

    container.innerHTML = FileQueue.map((item, idx) => {
        const CutBadge = (item.cut_start || item.cut_end)
            ? `<span style="font-size:9px;color:var(--Accent);display:block;margin-top:2px;font-family:monospace">${Icons.scissors} ${item.cut_start || '00:00:00'} → ${item.cut_end || 'fin'}</span>`
            : '';
        const AudioBadge = (item.audio_tracks && item.audio_tracks.length > 0)
            ? `<span style="font-size:9px;color:var(--Warn);display:block;margin-top:2px;font-family:monospace">${Icons.audio} ${(item.audio_track_names || item.audio_tracks.map(i => `Track ${i + 1}`)).join(', ')}</span>`
            : '';
        return `
            <div class="QueueItem ${idx === CurrentQueueSelectedIndex ? 'active' : ''}" data-queue-index="${idx}">
                <div style="flex:1;min-width:0;overflow:hidden">
                    <span class="QueueItemName" title="${item.path}">${item.name}</span>
                    ${CutBadge}
                    ${AudioBadge}
                </div>
                <button class="QueueItemRemove" data-index="${idx}" title="Quitar de la cola">${Icons.close}</button>
            </div>
        `;
    }).join('');
}

function SelectVideoFromQueue(index) {
    const item = FileQueue[index];
    if (!item) return;

    CurrentQueueSelectedIndex = index;
    AddLog(`🎬 Seleccionado: ${item.name}`, "info");

    PendingAudioRestoreTracks = (item.audio_tracks && item.audio_tracks.length > 0) ? item.audio_tracks : null;

    LoadVideoInfo(item.path);
    RestoreCutStateFromItem(item);
    RenderQueueList();
}

function SaveCutToCurrentQueueItem() {
    const CurrentItem = FileQueue.find(f => f.path === CurrentVideoPath);
    if (!CurrentItem) return;
    const IsCustomCut = document.getElementById("cutCustomBtn")?.classList.contains("on");
    if (IsCustomCut) {
        const StartVal = document.getElementById("cutStart")?.value || null;
        const EndVal   = document.getElementById("cutEnd")?.value   || null;
        CurrentItem.cut_start = (StartVal && StartVal !== "00:00:00") ? StartVal : null;
        CurrentItem.cut_end   = (EndVal   && EndVal   !== "00:00:00") ? EndVal   : null;
    } else {
        CurrentItem.cut_start = null;
        CurrentItem.cut_end   = null;
    }
    RenderQueueList();
}

function SaveAudioToCurrentQueueItem() {
    const CurrentItem = FileQueue.find(f => f.path === CurrentVideoPath);
    if (!CurrentItem) return;
    const SelectedCbs = [...document.querySelectorAll('.audio-track-cb:checked')];
    const SelectedTracks = SelectedCbs.map(Cb => parseInt(Cb.dataset.track));
    CurrentItem.audio_tracks = SelectedTracks.length > 0 ? SelectedTracks : null;
    if (CurrentVideoInfo && CurrentVideoInfo.audio_tracks) {
        CurrentItem.audio_track_names = SelectedCbs.map(Cb => {
            const idx = parseInt(Cb.dataset.track);
            const info = CurrentVideoInfo.audio_tracks.find(t => t.index === idx);
            return info && info.title ? info.title : `Track ${idx + 1}`;
        });
    } else {
        CurrentItem.audio_track_names = null;
    }
    RenderQueueList();
}

function RestoreCutStateFromItem(Item) {
    const CutStartEl  = document.getElementById("cutStart");
    const CutEndEl    = document.getElementById("cutEnd");
    const CutCustomBtn = document.getElementById("cutCustomBtn");
    const CutFullBtn   = document.getElementById("cutFullBtn");
    const FullPane     = document.getElementById("cutFullPane");
    const CustomPane   = document.getElementById("cutCustomPane");

    if (Item.cut_start || Item.cut_end) {
        if (CutCustomBtn) CutCustomBtn.classList.add("on");
        if (CutFullBtn)   CutFullBtn.classList.remove("on");
        if (FullPane)   FullPane.style.display   = "none";
        if (CustomPane) CustomPane.style.display = "block";
        if (CutStartEl) CutStartEl.value = Item.cut_start || "00:00:00";
        if (CutEndEl)   CutEndEl.value   = Item.cut_end   || "";
    } else {
        if (CutFullBtn)   CutFullBtn.classList.add("on");
        if (CutCustomBtn) CutCustomBtn.classList.remove("on");
        if (FullPane)   FullPane.style.display   = "block";
        if (CustomPane) CustomPane.style.display = "none";
        if (CutStartEl) CutStartEl.value = "00:00:00";
        if (CutEndEl)   CutEndEl.value   = "";
    }
    UpdateEstimatedTotalFrames();
}

async function ProcessQueue() {
    if (FileQueue.length === 0) {
        AddLog("❌ No hay archivos en la cola", "error");
        return;
    }

    if (QueueProcessing) {
        AddLog("⚠️ Ya hay una cola en proceso", "warning");
        return;
    }

    let OutputDir = document.getElementById("destPath")?.value || "";
    const sameFolderCheck = document.getElementById("sameFolderCheck");
    if (sameFolderCheck?.checked) {
        OutputDir = "";
    }

    const audioTracks = [...document.querySelectorAll(".audio-track-cb:checked")].map(Cb => parseInt(Cb.dataset.track));

    const baseParams = {
        name_template: document.getElementById("nameTemplate")?.value || "{nombre}_{codec}_q{qp}",
        codec: SelectedCodec,
        quality: GetQualityValue(),
        preset_idx: parseInt(document.getElementById("presetSlider")?.value || 4),
        resolution: document.getElementById("resolutionSelect")?.value || "original",
        fps: document.getElementById("fpsSelect")?.value || "original",
        bitrate: GetBitrateValue(),
        rate_control: (document.querySelector("#rateCtrl .RateOpt.on")?.dataset.rc) || "cq",
        audio_tracks: audioTracks,
        custom_mix: document.getElementById("customMixCheck")?.checked || false,
    };

    const overrides = new Map();
    for (const file of FileQueue) {
        const paramsChequeo = {
            ...baseParams,
            input_path: file.path,
            output_dir: sameFolderCheck?.checked ? null : OutputDir,
            cut_start: file.cut_start || null,
            cut_end: file.cut_end || null,
        };
        try {
            const col = await invoke("verificar_nombre_salida", { params: paramsChequeo });
            if (col && col.existe) {
                AddLog(`⚠️ "${col.salida.split(/[\\/]/).pop()}" ya existe`, "warning");
                const decision = await preguntarColision(col);
                if (decision === "cancelar") {
                    AddLog("❌ Cola cancelada: se detectaron archivos duplicados", "warning");
                    return;
                }
                if (decision === "renombrar" && col.alternativo) {
                    overrides.set(file.path, col.alternativo);
                }
            }
        } catch (e) {
            console.warn("No se pudo verificar la salida:", e);
        }
    }

    const queueItems = FileQueue.map(file => {
        const Item = {
            input_path: file.path,
            output_dir: sameFolderCheck?.checked ? null : OutputDir,
            cut_start: file.cut_start || null,
            cut_end:   file.cut_end   || null,
            output_override: overrides.get(file.path) || null,
        };
        if (file.audio_tracks && file.audio_tracks.length > 0) {
            Item.audio_tracks = file.audio_tracks;
        }
        return Item;
    });

    const queueStarted = await SendMessage("start_queue", {
        items: queueItems,
        base_params: baseParams
    });
    if (!queueStarted) {
        AddLog("❌ No se pudo iniciar la cola", "error");
        return;
    }

    QueueProcessing = true;
    document.getElementById("queueProgress").style.display = "block";
    document.getElementById("queueTotal").textContent = FileQueue.length;
}

// ========== HISTORIAL ==========
let HistoryExpanded = false;

function LoadHistory() {
    SendMessage("get_history");
}

function RenderHistory(history, totalSavedMB) {
    const container = document.getElementById("historyList");
    const stats = document.getElementById("historyStats");

    if (stats) {
        stats.textContent = `Ahorro: ${totalSavedMB.toFixed(1)} MB`;
    }

    if (!container) return;

    if (!history || history.length === 0) {
        container.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--Text3);">
                ${Icons.clock} Sin historial aún<br>
                Comprime un video para ver estadísticas
            </div>
        `;
        return;
    }

    const isLeftPanel = container.closest('.left-panel') !== null;
    container.innerHTML = history.slice(0, isLeftPanel ? 10 : 50).map(item => `
        <div class="history-item">
            <div class="history-item-name">${item.input} → ${item.output}</div>
            <div class="history-item-details">
                <span>${Icons.box} ${parseFloat(item.original_mb).toFixed(1)} MB → ${parseFloat(item.output_mb).toFixed(1)} MB</span>
                <span class="history-saved">${Icons.save} Ahorro: ${parseFloat(item.saved_mb).toFixed(1)} MB (${Math.round((1-item.ratio)*100)}%)</span>
                <span>${Icons.film} ${item.codec}</span>
            </div>
        </div>
    `).join('');
}

function ToggleHistory() {
    HistoryExpanded = !HistoryExpanded;
    const historyList = document.getElementById("historyList");
    if (historyList) {
        historyList.style.display = HistoryExpanded ? "block" : "none";
        if (HistoryExpanded) {
            historyList.classList.add("open");
        } else {
            historyList.classList.remove("open");
        }
    }
}

// ========== SELECTOR DE ARCHIVOS ==========
async function SelectMultipleFiles() {
    try {
        AddLog("📂 Abriendo selector de archivos...", "info");
        const filePath = await open({
            multiple: true,
            filters: [{ name: "Videos", extensions: ["mp4", "mkv", "mov", "avi", "webm", "m4v"] }],
        });
        if (filePath && filePath.length > 0) {
            for (const fp of filePath) {
                if (fp) AddToQueue(fp);
            }
        } else {
            AddLog("❌ No se seleccionó ningún archivo", "info");
        }
    } catch (error) {
        AddLog(`❌ Error: ${error.message}`, "error");
    }
}

// ========== INICIALIZACIÓN ==========
document.addEventListener('DOMContentLoaded', () => {
    console.log("Inicializando SwissVideo...");

    // Eventos de progreso desde Rust
    listen("encode-progress", (event) => {
        UpdateProgress(event.payload);
    });
    listen("encode-finished", (event) => {
        HandleBackendMessage({ action: "encode_finished", ...event.payload });
    });
    listen("encode-started", (event) => {
        HandleBackendMessage({ action: "encode_started", ...event.payload });
    });

    // Eventos de la cola de procesamiento por lote
    listen("queue-started", (event) => {
        HandleBackendMessage({ action: "queue_started", ...event.payload });
    });
    listen("queue-progress", (event) => {
        HandleBackendMessage({ action: "queue_progress", ...event.payload });
    });
    listen("queue-finished", (event) => {
        HandleBackendMessage({ action: "queue_finished", ...event.payload });
    });
    listen("log-message", (event) => {
        AddLog(event.payload.line, event.payload.type || "info");
    });
    listen("history-updated", () => {
        LoadHistory();
    });
    listen("save-compression-factor", (event) => {
        HandleBackendMessage({ action: "save_compression_factor", ...event.payload });
    });

    const processQueueBtn = document.getElementById("processQueueBtn");
    const historyHeader = document.getElementById("historyHeader");

    if (processQueueBtn) processQueueBtn.addEventListener("click", ProcessQueue);
    if (historyHeader) historyHeader.addEventListener("click", ToggleHistory);

    LoadHistory();
    setTimeout(() => LoadPresetsFromBackend(), 100);

    const openManagerBtn = document.getElementById("openPresetManagerBtn");
    const closeManagerBtn = document.getElementById("closeManagerModal");
    const createNewBtn = document.getElementById("createNewPresetBtn");
    const importBtn = document.getElementById("importPresetsManagerBtn");
    const exportBtn = document.getElementById("exportAllPresetsManagerBtn");
    const resetBtn = document.getElementById("resetDefaultPresetsBtn");
    const confirmSaveBtn = document.getElementById("confirmSavePresetBtn");
    const cancelEditBtn = document.getElementById("cancelEditPresetBtn");
    const closeEditBtn = document.getElementById("closeEditModal");
    if (openManagerBtn) openManagerBtn.addEventListener('click', () => OpenPresetManager());
    if (closeManagerBtn) closeManagerBtn.addEventListener('click', () => ClosePresetManager());
    if (createNewBtn) createNewBtn.addEventListener('click', () => OpenEditPresetModal());
    if (importBtn) importBtn.addEventListener('click', () => ImportPresets());
    if (exportBtn) exportBtn.addEventListener('click', () => ExportAllPresets());
    if (resetBtn) resetBtn.addEventListener('click', () => ResetDefaultPresets());
    if (confirmSaveBtn) confirmSaveBtn.addEventListener('click', () => SaveCurrentPresetFromModal());
    if (cancelEditBtn) cancelEditBtn.addEventListener('click', () => CloseEditModal());
    if (closeEditBtn) closeEditBtn.addEventListener('click', () => CloseEditModal());

    ['qualitySlider','presetSlider','resolutionSelect','fpsSelect'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => UpdatePresetPreview());
    });

    const qualitySlider = document.getElementById("qualitySlider");
    if (qualitySlider) {
        qualitySlider.addEventListener("input", E => {
            const rc = document.querySelector("#rateCtrl .RateOpt.on")?.dataset.rc;
            const valDisplay = document.getElementById("qualityVal");
            if (rc === "cq") {
                lastSliderQuality = parseInt(E.target.value);
                valDisplay.textContent = E.target.value;
                UpdateEstimate();
                UpdateNamePreview();
            } else {
                lastSliderBitrate = parseInt(E.target.value);
                valDisplay.textContent = `${E.target.value} Mbps`;
                UpdateEstimate();
            }
            ClearActivePresetIfCustomized();
        });
    }

    const presetSlider = document.getElementById("presetSlider");
    if (presetSlider) {
        presetSlider.addEventListener("input", E => {
            const PresetNames = ["ultrafast","superfast","veryfast","faster","fast","medium","slow","slower","veryslow"];
            document.getElementById("presetVal").textContent = PresetNames[E.target.value];
            ClearActivePresetIfCustomized();
        });
    }

    document.querySelectorAll("#rateCtrl .RateOpt").forEach(opt => {
        opt.addEventListener("click", () => {
            document.querySelectorAll("#rateCtrl .RateOpt").forEach(r => r.classList.remove("on"));
            opt.classList.add("on");
            UpdateSliderMode();
            UpdateEstimate();
            UpdatePresetPreview();
            ClearActivePresetIfCustomized();
        });
    });
    UpdateSliderMode();

    const resolutionSelect = document.getElementById("resolutionSelect");
    if (resolutionSelect) {
        resolutionSelect.addEventListener("change", () => { UpdateEstimate(); UpdateNamePreview(); UpdateEstimatedTotalFrames(); ClearActivePresetIfCustomized(); });
    }

    const fpsSelect = document.getElementById("fpsSelect");
    if (fpsSelect) {
        fpsSelect.addEventListener("change", () => { UpdateEstimate(); UpdateNamePreview(); UpdateEstimatedTotalFrames(); ClearActivePresetIfCustomized(); });
    }

    const nameTemplate = document.getElementById("nameTemplate");
    if (nameTemplate) nameTemplate.addEventListener("input", UpdateNamePreview);

    const cutFullBtn = document.getElementById("cutFullBtn");
    const cutCustomBtn = document.getElementById("cutCustomBtn");
    if (cutFullBtn && cutCustomBtn) {
        cutFullBtn.addEventListener("click", () => {
            cutFullBtn.classList.add("on");
            cutCustomBtn.classList.remove("on");
            const fullPane = document.getElementById("cutFullPane");
            const customPane = document.getElementById("cutCustomPane");
            if (fullPane) fullPane.style.display = "block";
            if (customPane) customPane.style.display = "none";
        });
        cutCustomBtn.addEventListener("click", () => {
            cutCustomBtn.classList.add("on");
            cutFullBtn.classList.remove("on");
            const fullPane = document.getElementById("cutFullPane");
            const customPane = document.getElementById("cutCustomPane");
            if (fullPane) fullPane.style.display = "none";
            if (customPane) customPane.style.display = "block";
            SaveCutToCurrentQueueItem();
            OpenCutSelector();
        });
    }

    const sameFolderCheck = document.getElementById("sameFolderCheck");
    const destPath = document.getElementById("destPath");
    if (sameFolderCheck && destPath) {
        sameFolderCheck.addEventListener("change", E => { destPath.disabled = E.target.checked; });
    }

    document.querySelectorAll(".Tpl").forEach(Tpl => {
        Tpl.addEventListener("click", () => {
            const nameTemplateInput = document.getElementById("nameTemplate");
            if (nameTemplateInput) {
                nameTemplateInput.value += Tpl.dataset.token;
                UpdateNamePreview();
            }
        });
    });

    const encodeBtn = document.getElementById("encodeBtn");
    const stopBtn = document.getElementById("stopBtn");
    if (encodeBtn) encodeBtn.addEventListener("click", StartEncode);
    if (stopBtn) stopBtn.addEventListener("click", StopEncode);

    const logHeader = document.getElementById("logHeader");
    if (logHeader) logHeader.addEventListener("click", ToggleLog);

    const dropOverlay = document.getElementById("dropOverlay");
    getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type === "over") {
            dropOverlay?.classList.add("visible");
        } else if (event.payload.type === "leave") {
            dropOverlay?.classList.remove("visible");
        } else if (event.payload.type === "drop") {
            dropOverlay?.classList.remove("visible");
            const paths = event.payload.paths;
            if (paths && paths.length > 0) {
                const videoExts = ["mp4", "mkv", "mov", "avi", "webm", "m4v"];
                const videos = paths.filter(p => {
                    const ext = p.split('.').pop()?.toLowerCase();
                    return ext && videoExts.includes(ext);
                });
                if (videos.length === 0) {
                    AddLog("❌ No se detectaron archivos de video válidos", "error");
                    return;
                }
                for (const vp of videos) AddToQueue(vp);
                AddLog(`📂 ${videos.length} video(s) recibidos por arrastrar y soltar`, "success");
            }
        }
    });

    const selectFilesBtn = document.getElementById("selectFilesBtn");
    if (selectFilesBtn) {
        const newBtn = selectFilesBtn.cloneNode(true);
        selectFilesBtn.parentNode.replaceChild(newBtn, selectFilesBtn);
        newBtn.addEventListener("click", () => SelectMultipleFiles());
    }

    const queueListEl = document.getElementById("queueList");
    if (queueListEl) {
        queueListEl.addEventListener("click", (e) => {
            const delBtn = e.target.closest(".QueueItemRemove");
            if (delBtn) {
                e.stopPropagation();
                RemoveFromQueue(parseInt(delBtn.dataset.index));
                return;
            }
            const item = e.target.closest(".QueueItem");
            if (item) SelectVideoFromQueue(parseInt(item.dataset.queueIndex));
        });
    }

    const browseDestBtn = document.getElementById("browseDestBtn");
    if (browseDestBtn) {
        browseDestBtn.addEventListener("click", async () => {
            const FolderPath = await open({ directory: true });
            if (FolderPath && destPath) {
                destPath.value = FolderPath;
                AddLog(`Destino: ${FolderPath}`, "success");
            }
        });
    }

    const CutVideo = document.getElementById("previewVideo");
    const PlayerTimeline = document.getElementById("playerTimeline");
    const PlayerPlayBtn = document.getElementById("playerPlayBtn");
    const markStartBtn = document.getElementById("markStartBtn");
    const markEndBtn = document.getElementById("markEndBtn");
    const playerConfirmBtn = document.getElementById("playerConfirmBtn");
    const playerCloseBtn = document.getElementById("playerCloseBtn");

    if (CutVideo) {
        CutVideo.addEventListener("timeupdate", () => { if (!IsScrubbing) UpdateTimelineVisuals(); });
        CutVideo.addEventListener("play", () => { if (PlayerPlayBtn) PlayerPlayBtn.innerHTML = `${Icons.pause} Pausa`; });
        CutVideo.addEventListener("pause", () => { if (PlayerPlayBtn) PlayerPlayBtn.innerHTML = `${Icons.play} Play`; });
    }

    if (PlayerPlayBtn) {
        PlayerPlayBtn.addEventListener("click", () => {
            const cv = document.getElementById("previewVideo");
            if (cv) cv.paused ? cv.play() : cv.pause();
        });
    }

    if (PlayerTimeline) {
        PlayerTimeline.addEventListener("mousedown", E => { IsScrubbing = true; SeekFromTimelineEvent(E); });
    }

    document.addEventListener("mousemove", E => { if (IsScrubbing) SeekFromTimelineEvent(E); });
    document.addEventListener("mouseup", () => { IsScrubbing = false; });

    if (markStartBtn) {
        markStartBtn.addEventListener("click", () => {
            const cv = document.getElementById("previewVideo");
            if (cv) {
                PlayerMarkedStart = cv.currentTime;
                if (PlayerMarkedEnd !== null && PlayerMarkedStart >= PlayerMarkedEnd) PlayerMarkedEnd = null;
                UpdateMarkerVisuals();
                AddLog(`Inicio marcado: ${SecondsToHms(PlayerMarkedStart)}`, "info");
            }
        });
    }

    if (markEndBtn) {
        markEndBtn.addEventListener("click", () => {
            const cv = document.getElementById("previewVideo");
            if (cv) {
                if (PlayerMarkedStart !== null && cv.currentTime <= PlayerMarkedStart) {
                    AddLog("El fin debe ser posterior al inicio", "error");
                    return;
                }
                PlayerMarkedEnd = cv.currentTime;
                UpdateMarkerVisuals();
                AddLog(`Fin marcado: ${SecondsToHms(PlayerMarkedEnd)}`, "info");
            }
        });
    }

    if (playerConfirmBtn) {
        playerConfirmBtn.addEventListener("click", () => {
            const cutStart = document.getElementById("cutStart");
            const cutEnd = document.getElementById("cutEnd");
            if (PlayerMarkedStart !== null && cutStart) cutStart.value = SecondsToHms(PlayerMarkedStart);
            if (PlayerMarkedEnd !== null && cutEnd) cutEnd.value = SecondsToHms(PlayerMarkedEnd);
            SaveCutToCurrentQueueItem();
            CloseCutSelector();
            UpdateEstimatedTotalFrames();
            AddLog(`Corte aplicado: ${SecondsToHms(PlayerMarkedStart ?? 0)} → ${SecondsToHms(PlayerMarkedEnd ?? 0)}`, "success");
        });
    }

    const cutStartInput = document.getElementById("cutStart");
    const cutEndInput = document.getElementById("cutEnd");
    if (cutStartInput) cutStartInput.addEventListener("change", () => {
        if (!validarCutInput(cutStartInput)) return;
        UpdateEstimatedTotalFrames(); SaveCutToCurrentQueueItem();
    });
    if (cutEndInput)   cutEndInput.addEventListener("change", () => {
        if (!validarCutInput(cutEndInput)) return;
        UpdateEstimatedTotalFrames(); SaveCutToCurrentQueueItem();
    });

    const AudioTracksContainer = document.getElementById("audioTracksContainer");
    if (AudioTracksContainer) {
        AudioTracksContainer.addEventListener("change", (E) => {
            if (E.target.classList.contains("audio-track-cb")) {
                SaveAudioToCurrentQueueItem();
            }
        });
    }

    if (playerCloseBtn) playerCloseBtn.addEventListener("click", CloseCutSelector);

    const collisionRenameBtn = document.getElementById("collisionRenameBtn");
    const collisionOverwriteBtn = document.getElementById("collisionOverwriteBtn");
    const collisionCancelBtn = document.getElementById("collisionCancelBtn");
    const collisionCloseBtn = document.getElementById("collisionCloseBtn");
    if (collisionRenameBtn) collisionRenameBtn.addEventListener("click", () => resolverColision("renombrar"));
    if (collisionOverwriteBtn) collisionOverwriteBtn.addEventListener("click", () => resolverColision("reescribir"));
    if (collisionCancelBtn) collisionCancelBtn.addEventListener("click", () => resolverColision("cancelar"));
    if (collisionCloseBtn) collisionCloseBtn.addEventListener("click", () => resolverColision("cancelar"));

    document.addEventListener("keydown", E => {
        if (E.key === "Escape" && document.getElementById("cutInlineBox") && document.getElementById("cutInlineBox").style.display === "flex") CloseCutSelector();
        if (E.key === "Escape") {
            const cm = document.getElementById("collisionModal");
            if (cm && cm.style.display === "flex") resolverColision("cancelar");
        }
        if (E.key === "Escape") {
            const pm = document.getElementById("presetManagerModal");
            const pe = document.getElementById("presetEditModal");
            if (pm && pm.style.display === "flex") pm.style.display = "none";
            if (pe && pe.style.display === "flex") pe.style.display = "none";
        }
    });

    if (destPath && !destPath.value) destPath.value = "C:\\Users\\migue\\Videos\\SwissVideo";
    const logDot = document.getElementById("logDot");
    if (logDot) logDot.classList.remove("idle");
    SendMessage("check_ffmpeg");
    AddLog("SwissVideo listo", "info");
});