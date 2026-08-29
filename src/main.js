import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { t, applyI18n, setLocale, getLocale, detectLocale } from "./i18n/index.js";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

// ========== I18N INIT ==========
const __initialLocale = detectLocale();
setLocale(__initialLocale);
window.t = t;
window.applyI18n = applyI18n;

function UpdateLocaleToggleUI(locale) {
    const wrap = document.getElementById("localeToggle");
    if (!wrap) return;
    wrap.querySelectorAll("[data-locale]").forEach((Btn) => {
        const isActive = Btn.dataset.locale === locale;
        Btn.classList.toggle("on", isActive);
        Btn.setAttribute("aria-pressed", String(isActive));
    });
}

function SetupLocaleToggle() {
    const wrap = document.getElementById("localeToggle");
    if (!wrap || wrap._localeWired) return;
    wrap._localeWired = true;
    UpdateLocaleToggleUI(getLocale());
    wrap.addEventListener("click", (E) => {
        const Btn = E.target.closest("[data-locale]");
        if (!Btn) return;
        const next = Btn.dataset.locale;
        if (!next || next === getLocale()) return;
        setLocale(next);
        applyI18n(document);
        UpdateLocaleToggleUI(getLocale());
        // Re-render dinámicos que usan t() fuera de data-i18n
        try { RenderPresetsBar(); } catch {}
        try { RenderCodecSelector(); } catch {}
        try { RenderQueueList(); } catch {}
        try { UpdateCrfSlider(SelectedCodec); } catch {}
        try {
            const st = getSelectedAudioState();
            updateAudioPreviewBadge(st.selected, st.vols);
        } catch {}
        try {
            const chevron = document.getElementById("logChevron");
            if (chevron) chevron.textContent = LogExpanded ? t("log.collapse") : t("log.expand");
        } catch {}
        try {
            const ppBtn = document.getElementById("playerPlayBtn");
            const cv = document.getElementById("previewVideo");
            if (ppBtn && cv) ppBtn.innerHTML = cv.paused ? `${Icons.play} ${t("cut.play")}` : `${Icons.pause} ${t("cut.pause")}`;
        } catch {}
    });
}

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

// ========== AUDIO PREVIEW (mezcla audible) ==========
let PreviewAudioCtx = null;
let PreviewAudioGain = null;
let PreviewMediaSource = null;
let PreviewExtractedAudios = []; // {track, audioEl, gainNode, srcPath}
let PreviewExtractCacheKey = null;
let PreviewUsingExtraction = false;
let PreviewSyncRaf = null;
let PreviewPendingExtract = 0;

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
    libx264: "h264", libx265: "h265", libsvtav1: "av1", libvpx_vp9: "vp9",
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
    volume: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
    mute: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M16 9 22 15M22 9 16 15"/></svg>',
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
        } else if (cmd === "get_history") {
            const totalSavedMB = result.reduce((acc, h) => acc + (h.saved_mb || 0), 0);
            HandleBackendMessage({ action: "history_list", history: result.slice(0, 50), total_saved_mb: parseFloat(totalSavedMB.toFixed(1)) });
        } else if (cmd === "start_encode") {
            HandleBackendMessage({ action: "log", line: t("log.compressionStarted"), type: "success" });
        } else if (cmd === "stop_encode") {
            HandleBackendMessage({ action: "log", line: t("log.compressionStoppedByUser"), type: "warning" });
        } else if (cmd === "check_ffmpeg") {
            FfmpegCaps = result;
            HandleBackendMessage({ action: "ffmpeg_caps", caps: result });
        } else if (cmd === "detect_gpu") {
            const names = { nvidia: t("gpu.nvidia"), amd: t("gpu.amd"), intel: t("gpu.intel"), cpu: t("gpu.cpu") };
            HandleBackendMessage({ action: "log", line: t("log.gpuEnabled", { gpu: names[result] || result }), type: "info" });
        } else if (cmd === "start_queue") {
            HandleBackendMessage({ action: "log", line: t("log.queueInitiated"), type: "success" });
        } else if (cmd === "stop_queue") {
            HandleBackendMessage({ action: "log", line: t("log.queueStoppedByUser"), type: "warning" });
        }
        return true;
    } catch (e) {
        if (cmd === "get_video_info") {
            HandleBackendMessage({ action: "video_info", success: false, error: e.toString(), request_id: RequestId });
        } else if (cmd === "start_encode" || cmd === "stop_encode" || cmd === "start_queue" || cmd === "stop_queue") {
            HandleBackendMessage({ action: "encode_finished", success: false, error: e.toString() });
        }
        HandleBackendMessage({ action: "log", line: t("log.errorGeneric", { error: e }), type: "error" });
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
        Chip.title = Preset.description || `${t("presets.apply")} ${Preset.name}`;
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
        MoreChip.textContent = t("presets.more", { count: Object.keys(CurrentPresets).length - 6 });
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
        Container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--Text3);">${Icons.box} ${t("presets.empty")}</div>`;
        return;
    }
    Object.entries(CurrentPresets).forEach(([Key, Preset]) => {
        const CodecName = Preset.codec;
        const Resolution = Preset.resolution === 'original' ? t("quality.original") : Preset.resolution;
        const Item = document.createElement('div');
        Item.className = 'QueueItem';
        Item.innerHTML = `
            <div class="preset-item-header">
                <div class="preset-name">${escapeHtml(Preset.name)}</div>
                ${CurrentActivePresetKey === Key ? `<div class="preset-badge">${t("presets.activeBadge")}</div>` : ''}
            </div>
            <div class="preset-desc">${escapeHtml(Preset.description || t("presets.noDesc"))}</div>
            <div class="preset-details">
                <span>${Icons.film} ${CodecName}</span><span>${Icons.ruler} ${Resolution}</span>
                <span>${Icons.frames} ${Preset.fps === 'original' ? t("presets.fpsOrig") : Preset.fps + ' fps'}</span>
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
            if (confirm(t("confirm.deletePreset", { name: CurrentPresets[k]?.name }))) {
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
        Title.textContent = t("modal.presetEdit.editTitle", { name: CurrentPresets[EditKey].name });
        NameInput.value = CurrentPresets[EditKey].name;
        DescInput.value = CurrentPresets[EditKey].description || '';
        Modal.dataset.editKey = EditKey;
    } else {
        Title.textContent = t("modal.presetEdit.createTitle");
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
    const CodecName = s.codec;
    const rcLabel = { cq: `CQ ${s.quality}`, vbr: `VBR ${s.bitrate}M`, cbr: `CBR ${s.bitrate}M` }[s.rate_control] || s.rate_control;
    Preview.innerHTML = `Codec: ${CodecName} | ${rcLabel} | ${s.resolution === 'original' ? t("quality.original") : s.resolution}<br>FPS: ${s.fps === 'original' ? t("quality.original") : s.fps}`;
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
    if (!PresetName) { AddLog(t("log.errorEnterPresetName"), "error"); return; }
    const PresetKey = PresetName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (EditKey && EditKey !== PresetKey && CurrentPresets[EditKey]) {
        SendMessage('delete_preset', { name: EditKey });
    }
    const Settings = GetCurrentSettings();
    Settings.name = PresetName;
    Settings.description = DescInput.value.trim() || `${PresetName} - Configuración personalizada`;
    SendMessage('save_preset', { name: PresetKey, preset: Settings });
    CloseEditModal();
    AddLog(t("log.presetSaved", { name: PresetName }), "success");
}

function ApplyPreset(PresetKey, Preset) {
    if (Preset.codec) {
        if (AvailableCodecs.has(Preset.codec)) SelectCodec(Preset.codec);
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
        Indicator.innerHTML = `${Icons.dot} ${t("presets.activeWithName", { name: Preset.name })}`;
        setTimeout(() => { Indicator.style.opacity = '0.5'; }, 2000);
    }
    AddLog(t("log.presetApplied", { name: Preset.name }), "success");
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
        AddLog(t("log.presetsExported", { count: Object.keys(CurrentPresets).length }), "success");
    } catch (error) { AddLog(t("log.errorExport", { error: error.message }), "error"); }
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
                AddLog(t("log.presetsImported", { count: Count }), "success");
                ClosePresetManager();
            } catch (Err) { AddLog(t("log.errorImport", { error: Err.message }), "error"); }
        };
        Reader.readAsText(File);
    };
    Input.click();
}

function ResetDefaultPresets() {
    if (confirm(t("confirm.resetPresets"))) {
        SendMessage('reset_default_presets');
        CurrentActivePresetKey = null;
        const ind = document.getElementById("activePresetIndicator");
        if (ind) ind.style.display = 'none';
        AddLog(t("log.restoringPresets"), "info");
    }
}

let AvailableCodecs = new Set();

function RenderCodecSelector() {
    const Row = document.getElementById("codecRow");
    if (!Row || !FfmpegCaps) return;
    Row.innerHTML = "";

    const Chevron = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    const gpuSuffix = { nvidia: "nvenc", amd: "amf", intel: "qsv" }[FfmpegCaps.gpu];

    const variantsFor = (label) => {
        const cpu = Object.keys(CodecMeta).find(k =>
            CodecMeta[k].label === label && k.startsWith("lib") && FfmpegCaps[k]);
        const gpu = gpuSuffix ? Object.keys(CodecMeta).find(k =>
            CodecMeta[k].label === label && k.endsWith(gpuSuffix) && FfmpegCaps[k]) : null;
        return { cpu, gpu };
    };

    const isRelevant = (name) => {
        if (name.endsWith("_nvenc") && FfmpegCaps.gpu !== "nvidia") return false;
        if (name.endsWith("_amf") && FfmpegCaps.gpu !== "amd") return false;
        if (name.endsWith("_qsv") && FfmpegCaps.gpu !== "intel") return false;
        if (name.endsWith("_vaapi") || name.endsWith("_v4l2m2m") || name.endsWith("_videotoolbox")) return false;
        return true;
    };
    const relevantEncoders = (FfmpegCaps.video_encoders || []).filter(isRelevant);

    const usage = FfmpegCaps.usage || {};
    const sortedUsage = Object.entries(usage)
        .filter(([name]) => relevantEncoders.includes(name))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name]) => name);
    let outsideEncoders = sortedUsage.slice(0, 3);
    if (outsideEncoders.length < 3) {
        const defaults = ["libx264", "libx265", "libsvtav1"].filter(n => relevantEncoders.includes(n) && !outsideEncoders.includes(n));
        for (const d of defaults) {
            if (outsideEncoders.length >= 3) break;
            outsideEncoders.push(d);
        }
    }
    if (outsideEncoders.length === 0) outsideEncoders = relevantEncoders.slice(0, 3);
    outsideEncoders = [...new Set(outsideEncoders)].slice(0, 3);

    const shown = new Set(outsideEncoders);
    const otherEncoders = relevantEncoders
        .filter(name => !shown.has(name))
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    AvailableCodecs = new Set([...outsideEncoders, ...otherEncoders]);

    const seg = document.createElement("div");
    seg.className = "CodecSeg";

    outsideEncoders.forEach(name => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "CodecSegBtn" + (SelectedCodec === name ? " on" : "");
        btn.textContent = name;
        btn.title = name;
        btn.addEventListener("click", () => {
            if (SelectedCodec !== name) SelectCodec(name);
        });
        seg.appendChild(btn);
    });

    if (otherEncoders.length > 0) {
        const wrap = document.createElement("div");
        wrap.className = "OthersWrap";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "CodecSegBtn" + (otherEncoders.includes(SelectedCodec) ? " on" : "");
        btn.innerHTML = `${t("codec.others")} ${Chevron}`;
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            wrap.classList.toggle("open");
        });
        const menu = document.createElement("div");
        menu.className = "OthersMenu";
        const searchWrap = document.createElement("div");
        searchWrap.className = "OthersSearchWrap";
        const search = document.createElement("input");
        search.type = "text";
        search.className = "OthersSearch";
        search.placeholder = t("codec.searchPlaceholder");
        search.setAttribute("aria-label", t("codec.searchAria"));
        search.addEventListener("click", (e) => e.stopPropagation());
        search.addEventListener("keydown", (e) => {
            if (e.key === "Escape") { e.stopPropagation(); wrap.classList.remove("open"); }
            else e.stopPropagation();
        });
        searchWrap.appendChild(search);
        menu.appendChild(searchWrap);
        const list = document.createElement("div");
        list.className = "OthersList";
        const emptyMsg = document.createElement("div");
        emptyMsg.className = "OthersEmpty";
        emptyMsg.textContent = t("codec.noResults");
        otherEncoders.forEach(name => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "OthersItem";
            if (SelectedCodec === name) item.classList.add("on");
            item.dataset.encoder = name;
            item.innerHTML = `<span>${escapeHtml(name)}</span><span class="OthersDot"></span>`;
            item.addEventListener("click", () => {
                if (SelectedCodec !== name) SelectCodec(name);
                else wrap.classList.remove("open");
            });
            list.appendChild(item);
        });
        menu.appendChild(list);
        menu.appendChild(emptyMsg);
        search.addEventListener("input", () => {
            const q = search.value.toLowerCase().trim();
            let visible = 0;
            list.querySelectorAll(".OthersItem").forEach(item => {
                const match = !q || item.dataset.encoder.toLowerCase().includes(q);
                item.style.display = match ? "" : "none";
                if (match) visible++;
            });
            emptyMsg.style.display = visible === 0 ? "block" : "none";
        });
        btn.addEventListener("click", () => {
            if (wrap.classList.contains("open")) {
                requestAnimationFrame(() => search.focus());
            } else {
                search.value = "";
                search.dispatchEvent(new Event("input"));
            }
        });
        wrap.appendChild(btn);
        wrap.appendChild(menu);
        seg.appendChild(wrap);
    }

    Row.appendChild(seg);

    if (!RenderCodecSelector._bound) {
        RenderCodecSelector._bound = true;
        document.addEventListener("click", (e) => {
            document.querySelectorAll(".OthersWrap.open").forEach(w => {
                if (!w.contains(e.target)) {
                    w.classList.remove("open");
                    const s = w.querySelector(".OthersSearch");
                    if (s) { s.value = ""; s.dispatchEvent(new Event("input")); }
                }
            });
        });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") document.querySelectorAll(".OthersWrap.open").forEach(w => {
                w.classList.remove("open");
                const s = w.querySelector(".OthersSearch");
                if (s) { s.value = ""; s.dispatchEvent(new Event("input")); }
            });
        });
    }

    if (!AvailableCodecs.has(SelectedCodec)) {
        const first = AvailableCodecs.values().next().value;
        if (first) SelectCodec(first);
    }
}

function ApplyFfmpegCaps() {
    if (!FfmpegCaps) return;

    const gpuNames = { nvidia: t("gpu.nvidia"), amd: t("gpu.amd"), intel: t("gpu.intel"), cpu: t("gpu.cpu") };
    AddLog(t("log.ffmpegDetected", { gpu: gpuNames[FfmpegCaps.gpu] || FfmpegCaps.gpu }), "info");

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
    const clean = Message.replace(/[\p{Extended_Pictographic}\u2600-\u27BF\u2300-\u23FF\u2B00-\u2BFF]/gu, '').replace(/[\uFE0F\u200D]/gu, '').replace(/\s{2,}/g, ' ').trim();
    Line.textContent = `[${new Date().toLocaleTimeString()}] ${clean}`;
    LogBody.appendChild(Line);
    LogBody.scrollTop = LogBody.scrollHeight;
    const logPreview = document.getElementById("logPreview");
    if (logPreview) logPreview.textContent = clean.substring(0, 100);
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
            AddLog(t("log.presetsAvailable", { count: Object.keys(CurrentPresets).length }), "info");
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
            AddLog(t("log.queueProcessingStarted", { total: Data.total }), "success");
            break;

        case "queue_progress":
            document.getElementById("queueCurrent").textContent = Data.current;
            document.getElementById("queueTotal").textContent = Data.total;
            window.queueCurrentIndex = Data.current;
            window.queueTotalCount = Data.total;
            AddLog(t("log.queueProgress", { current: Data.current, total: Data.total, filename: Data.filename }), "info");
            break;

        case "queue_finished":
            QueueProcessing = false;
            document.getElementById("queueProgress").style.display = "none";
            if (Data.stopped) {
                AddLog(t("log.queueStopped", { total: Data.total || 0 }), "warning");
            } else {
                AddLog(t("log.queueFinished", { total: Data.total }), "success");
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
                AddLog(t("log.compressionFactorSaved", { factor: Math.round(Data.factor * 100), output: Math.round(Data.outputSize), original: Math.round(Data.originalSize) }), "info");
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
                const ActiveItem = FileQueue.find(f => f.path === CurrentVideoPath);
                UpdateAudioTracks(CurrentVideoInfo, ActiveItem ? ActiveItem.audio_tracks : null, ActiveItem ? ActiveItem.audio_volumes : null);
                UpdateEstimatedTotalFrames();
                AddLog(t("log.fileLoaded", { name: Data.info.filename }), "success");
            } else if (!Data.success) {
                AddLog(t("log.fileAnalyzeError", { error: Data.error }), "error");
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
                statusDiv3.innerHTML = `${Icons.refresh} ${t("encode.starting")}`;
                statusDiv3.style.color = "var(--Warn)";
            }
            AddLog(t("log.compressionInitiating"), "success");
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
                    statusDiv2.innerHTML = `${Icons.check} ${t("encode.completed")}`;
                    statusDiv2.style.color = "var(--Success)";
                } else {
                    statusDiv2.innerHTML = `${Icons.x} ${t("encode.cancelled")}`;
                    statusDiv2.style.color = "var(--Danger)";
                }
                setTimeout(() => { if (statusDiv2) statusDiv2.innerHTML = ""; }, 5000);
            }

            if (Data.success) {
                AddLog(t("log.compressionCompleted", { output: Data.output }), "success");
            } else {
                AddLog(t("log.compressionError", { error: Data.error }), "error");
            }
            break;

        case "file_size_warning":
            if (Data.size_mb > 5000) {
                AddLog(t("log.largeFileWarning", { size: (Data.size_mb/1024).toFixed(1) }), "warning");
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

function UpdateAudioTracks(Info, savedTracks, savedVolumes) {
    const Container = document.getElementById("audioTracksContainer");
    if (!Container) return;
    Container.innerHTML = "";

    if (!Info.audio_tracks || Info.audio_tracks.length === 0) {
        Container.innerHTML = `<div class="AudioEmpty">${t("audio.emptyNoTracks")}</div>`;
        const badge = document.getElementById("audioPreviewStatus");
        if (badge) badge.style.display = "none";
        return;
    }

    // Resolver volúmenes guardados: param explícito o del item de cola actual
    let resolvedVolumes = savedVolumes;
    if (resolvedVolumes === undefined) {
        const curItem = FileQueue.find(f => f.path === CurrentVideoPath);
        resolvedVolumes = curItem?.audio_volumes || {};
    }
    if (resolvedVolumes == null || typeof resolvedVolumes !== 'object' || Array.isArray(resolvedVolumes)) {
        resolvedVolumes = {};
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
        const vol = resolvedVolumes[Track.index] != null ? parseInt(resolvedVolumes[Track.index]) : 100;
        const clampedVol = Math.max(0, Math.min(200, vol));
        const badgeCls = clampedVol === 0 ? 'VolumeBadge muted' : clampedVol !== 100 ? 'VolumeBadge boosted' : 'VolumeBadge';
        const muteLabel = clampedVol === 0 ? Icons.mute : Icons.volume;

        Div.innerHTML = `<label class="AudioCheckWrap"><input type="checkbox" class="audio-track-cb" data-track="${Track.index}"><span class="AudioCheck" aria-hidden="true"><svg viewBox="0 0 12 10"><path d="M1 5 L4.5 8.5 L11 1.5"/></svg></span></label><span title="${escapeHtml(Label)}${escapeHtml(infoStr)}">${escapeHtml(Label)}${escapeHtml(infoStr)}</span><input type="range" class="VolumeSlider" data-track="${Track.index}" min="0" max="200" value="${clampedVol}" title="${t("audio.volume", { value: clampedVol })}"><span class="${badgeCls}" data-track="${Track.index}">${clampedVol}%</span><button type="button" class="VolumeMuteBtn${clampedVol === 0 ? ' on' : ''}" data-track="${Track.index}" title="${clampedVol === 0 ? t("audio.unmuteTitle") : t("audio.muteTitle")}">${muteLabel}</button>`;
        Container.appendChild(Div);
    });

    // Restaurar selección guardada del queue item, o marcar primera pista por defecto
    if (Array.isArray(savedTracks)) {
        savedTracks.forEach(trackIdx => {
            const cb = Container.querySelector(`.audio-track-cb[data-track="${trackIdx}"]`);
            if (cb) cb.checked = true;
        });
    } else {
        const FirstCb = Container.querySelector('.audio-track-cb');
        if (FirstCb) FirstCb.checked = true;
    }

    // Sincronizar estado deshabilitado del slider según checkbox
    Container.querySelectorAll('.TrackRow').forEach(row => {
        const cb = row.querySelector('.audio-track-cb');
        const slider = row.querySelector('.VolumeSlider');
        const muteBtn = row.querySelector('.VolumeMuteBtn');
        if (cb && slider) {
            slider.disabled = !cb.checked;
            if (muteBtn) muteBtn.disabled = !cb.checked;
            row.style.opacity = cb.checked ? '1' : '0.6';
        }
    });

    SaveAudioToCurrentQueueItem();
    // Actualizar preview audible automáticamente (sin recargar video)
    try { UpdatePreviewAudioMix(); } catch {}
}

function SaveVolumeToCurrentQueueItem(trackIdx, vol) {
    const CurrentItem = FileQueue.find(f => f.path === CurrentVideoPath);
    if (!CurrentItem) return;
    if (!CurrentItem.audio_volumes || typeof CurrentItem.audio_volumes !== 'object') CurrentItem.audio_volumes = {};
    const clamped = Math.max(0, Math.min(200, parseInt(vol) || 0));
    CurrentItem.audio_volumes[trackIdx] = clamped;

    // Actualizar badge en DOM sin re-render completo
    const Container = document.getElementById("audioTracksContainer");
    if (Container) {
        const badge = Container.querySelector(`.VolumeBadge[data-track="${trackIdx}"]`);
        if (badge) {
            badge.textContent = `${clamped}%`;
            badge.className = clamped === 0 ? 'VolumeBadge muted' : clamped !== 100 ? 'VolumeBadge boosted' : 'VolumeBadge';
        }
        const muteBtn = Container.querySelector(`.VolumeMuteBtn[data-track="${trackIdx}"]`);
        if (muteBtn) {
            muteBtn.classList.toggle('on', clamped === 0);
            muteBtn.title = clamped === 0 ? t("audio.unmuteTitle") : t("audio.muteTitle");
            muteBtn.innerHTML = clamped === 0 ? Icons.mute : Icons.volume;
        }
        const slider = Container.querySelector(`.VolumeSlider[data-track="${trackIdx}"]`);
        if (slider) slider.value = clamped;
    }
    RenderQueueList();
    // Live gain: si ya estamos en modo extracción, solo tocar ese GainNode.
    // Si estamos en modo global (un solo track), actualizar el GainNode global.
    // Solo disparar UpdatePreviewAudioMix si cambia el modo (p.ej. 1 track @100 -> 1 track @150
    // que antes no necesitaba extracción y ahora sí, o selección de pista distinta al default).
    const stNow = getSelectedAudioState();
    const wasExtraction = PreviewUsingExtraction;
    // Consistencia: cualquier pista seleccionada va por extracción
    const needsExtEffective = stNow.selected.length > 0;

    if (wasExtraction) {
        let touched = false;
        PreviewExtractedAudios.forEach(a => {
            if (a.track === trackIdx) {
                const g = Math.max(0, Math.min(2, clamped / 100));
                try {
                    if (a.gainNode.gain.setTargetAtTime) a.gainNode.gain.setTargetAtTime(g, PreviewAudioCtx ? PreviewAudioCtx.currentTime : 0, 0.02);
                    else a.gainNode.gain.value = g;
                } catch { try { a.gainNode.gain.value = g; } catch {} }
                try { a.audioEl.muted = g === 0; } catch {}
                try { a.audioEl.volume = Math.max(0, Math.min(1, g)); } catch {}
                touched = true;
            }
        });
        updateAudioPreviewBadge(stNow.selected, stNow.vols);
        // Si el modo ya no necesita extracción (volvió a 100 y single default), salir del modo extracción
        if (!needsExtEffective) { try { UpdatePreviewAudioMix(); } catch {} }
        else if (!touched) { try { UpdatePreviewAudioMix(); } catch {} }
        return;
    }
    // Modo global: aplicar gain global inmediato (sin debounce) para que el slider se escuche al instante
    if (!wasExtraction) {
        // Si ahora necesita extracción, dispararla (debounced dentro de UpdatePreviewAudioMix)
        if (needsExtEffective) { try { UpdatePreviewAudioMix(); } catch {} return; }
        // Si sigue en global, actualizar gain: usar GainNode solo para boost >1, si no v.volume directo
        try {
            const v = document.getElementById("previewVideo");
            const avg = stNow.selected.length ? stNow.selected.reduce((a, idx) => a + (stNow.vols[idx] ?? 100), 0) / stNow.selected.length / 100 : 0;
            const g = Math.max(0, Math.min(2, avg));
            if (v) v.muted = g === 0;
            if (g > 1.0 && PreviewAudioGain && PreviewAudioCtx) {
                if (PreviewAudioCtx.state === "suspended") PreviewAudioCtx.resume().catch(()=>{});
                if (PreviewAudioGain.gain.setTargetAtTime) PreviewAudioGain.gain.setTargetAtTime(g, PreviewAudioCtx.currentTime, 0.02);
                else PreviewAudioGain.gain.value = g;
                if (v) v.volume = 1.0;
            } else {
                if (PreviewAudioGain) try { PreviewAudioGain.gain.value = 1.0; } catch {}
                if (PreviewAudioCtx && PreviewAudioCtx.state === "suspended" && PreviewMediaSource && !PreviewUsingExtraction) {
                    try { PreviewMediaSource.disconnect(); PreviewAudioGain.disconnect(); } catch {}
                    PreviewMediaSource = null; PreviewAudioGain = null;
                }
                if (v) v.volume = Math.max(0, Math.min(1, g));
            }
            updateAudioPreviewBadge(stNow.selected, stNow.vols);
        } catch {}
    }
}

// ========== AUDIO PREVIEW: mezcla audible ==========

function ensurePreviewAudioContext() {
    if (PreviewAudioCtx) return PreviewAudioCtx;
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        PreviewAudioCtx = new Ctx();
        return PreviewAudioCtx;
    } catch { return null; }
}

function teardownPreviewAudioMix() {
    // detener sync
    if (PreviewSyncRaf) { cancelAnimationFrame(PreviewSyncRaf); PreviewSyncRaf = null; }
    PreviewExtractedAudios.forEach(a => {
        try { a.audioEl.pause(); } catch {}
        try { a.audioEl.src = ""; a.audioEl.load(); } catch {}
        try { if (a.gainNode) a.gainNode.disconnect(); } catch {}
    });
    PreviewExtractedAudios = [];
    PreviewUsingExtraction = false;
    PreviewExtractCacheKey = null;
    // no cerrar ctx para reusar; solo desconectar source del video
    if (PreviewMediaSource) {
        try { PreviewMediaSource.disconnect(); } catch {}
        PreviewMediaSource = null;
    }
    if (PreviewAudioGain) {
        try { PreviewAudioGain.disconnect(); } catch {}
        PreviewAudioGain = null;
    }
    const v = document.getElementById("previewVideo");
    if (v) v.muted = false;
}

function SetupAudioPreview() {
    const v = document.getElementById("previewVideo");
    if (!v) return;
    // Intentar conectar MediaElementSource -> GainNode una sola vez (global volume)
    // Esto no rompe preview si falla; fallback silencioso.
    try {
        const ctx = ensurePreviewAudioContext();
        if (!ctx) return;
        // Si ya hay source, no recrear (MediaElementSource solo una vez por elemento)
        if (!PreviewMediaSource) {
            try {
                PreviewMediaSource = ctx.createMediaElementSource(v);
                PreviewAudioGain = ctx.createGain();
                PreviewAudioGain.gain.value = 1.0;
                PreviewMediaSource.connect(PreviewAudioGain);
                PreviewAudioGain.connect(ctx.destination);
            } catch (e) {
                // Si ya fue conectado antes, el browser lanza InvalidStateError; ignorar
                if (!String(e).includes("already connected")) console.warn("SetupAudioPreview:", e);
            }
        }
        // Wire sync de play/pause/seek para audios extraídos (idempotente)
        if (!v._previewAudioWired) {
            v._previewAudioWired = true;
            const resumeCtx = () => { try { if (PreviewAudioCtx && PreviewAudioCtx.state === "suspended") PreviewAudioCtx.resume(); } catch {} };
            v.addEventListener("play", () => { resumeCtx(); if (PreviewUsingExtraction) PreviewExtractedAudios.forEach(a => { a.audioEl.play().catch(()=>{}); }); });
            v.addEventListener("pause", () => { if (PreviewUsingExtraction) PreviewExtractedAudios.forEach(a => a.audioEl.pause()); });
            v.addEventListener("seeking", () => { if (PreviewUsingExtraction) PreviewExtractedAudios.forEach(a => { try { a.audioEl.currentTime = v.currentTime; } catch {} }); });
            v.addEventListener("seeked", () => { if (PreviewUsingExtraction) PreviewExtractedAudios.forEach(a => { try { a.audioEl.currentTime = v.currentTime; } catch {} }); });
            v.addEventListener("ratechange", () => { if (PreviewUsingExtraction) PreviewExtractedAudios.forEach(a => { try { a.audioEl.playbackRate = v.playbackRate; } catch {} }); });
            v.addEventListener("volumechange", () => { /* video muted state manejado por UpdatePreviewAudioMix */ });
            // Drift correction suave: solo corregir si el desfase supera 1.2s y han pasado 1.5s desde el último ajuste.
            // Antes era 0.35s/500ms y causaba que el audio se re-enganchara cada medio segundo
            // y pareciera loopeado en 1s cuando el slider movía el gain durante playback.
            let lastSync = 0;
            v.addEventListener("timeupdate", () => {
                if (!PreviewUsingExtraction || PreviewExtractedAudios.length === 0) return;
                if (v.paused || v.seeking) return;
                const now = performance.now();
                if (now - lastSync < 1500) return;
                PreviewExtractedAudios.forEach(a => {
                    try {
                        const drift = Math.abs(a.audioEl.currentTime - v.currentTime);
                        if (drift > 1.2) {
                            a.audioEl.currentTime = v.currentTime;
                            lastSync = now;
                        }
                    } catch {}
                });
            });
        }
    } catch (e) { console.warn("SetupAudioPreview fallo:", e); }
}

function getSelectedAudioState() {
    const cbs = [...document.querySelectorAll(".audio-track-cb")];
    const selected = cbs.filter(cb => cb.checked).map(cb => parseInt(cb.dataset.track));
    const vols = {};
    document.querySelectorAll(".VolumeSlider").forEach(sl => {
        const idx = parseInt(sl.dataset.track);
        vols[idx] = Math.max(0, Math.min(200, parseInt(sl.value) || 100));
    });
    return { selected, vols };
}

function updateAudioPreviewBadge(selected, vols) {
    const el = document.getElementById("audioPreviewStatus");
    if (!el) return;
    if (!CurrentVideoInfo || !CurrentVideoInfo.audio_tracks || CurrentVideoInfo.audio_tracks.length === 0) {
        el.style.display = "none"; el.textContent = ""; return;
    }
    if (selected.length === 0) {
        el.style.display = "inline-flex";
        el.textContent = t("audio.previewMuted");
        el.className = "AudioPreviewBadge muted";
        return;
    }
    const parts = selected.map(idx => {
        const v = vols[idx] ?? 100;
        return v === 100 ? `#${idx}` : `#${idx}@${v}%`;
    });
    const mode = PreviewUsingExtraction ? "mezcla" : "global";
    el.style.display = "inline-flex";
    el.textContent = PreviewUsingExtraction ? t("audio.previewMix", { count: selected.length, parts: parts.join(", ") }) : t("audio.previewGlobal", { count: selected.length, parts: parts.join(", ") });
    el.className = "AudioPreviewBadge " + (PreviewUsingExtraction ? "mix" : "global");
}

function tryApplyAudioTracksApi(selected, vols) {
    const v = document.getElementById("previewVideo");
    if (!v || !v.audioTracks || typeof v.audioTracks.length !== "number") return false;
    try {
        // audioTracks es Chrome-only; habilita/deshabilita por índice de track 0..n
        // Mapear: asumimos orden igual a ffprobe audio_tracks (no hay garantía perfecta)
        // Si longitudes no coinciden, no usar.
        if (v.audioTracks.length !== (CurrentVideoInfo?.audio_tracks?.length || 0)) return false;
        const selSet = new Set(selected);
        for (let i = 0; i < v.audioTracks.length; i++) {
            const infoIdx = CurrentVideoInfo.audio_tracks[i]?.index;
            v.audioTracks[i].enabled = selSet.has(infoIdx);
        }
        // Volumen global ponderado: promedio de seleccionados (no hay per-track gain en spec)
        if (selected.length > 0) {
            const avg = selected.reduce((a, idx) => a + (vols[idx] ?? 100), 0) / selected.length / 100;
            v.volume = Math.max(0, Math.min(1, avg));
            v.muted = avg === 0;
        } else {
            v.muted = true;
        }
        // También aplicar GainNode global si existe para no duplicar
        if (PreviewAudioGain) {
            try { PreviewAudioGain.gain.value = 1.0; } catch {}
        }
        return true;
    } catch { return false; }
}

function applyGlobalGainFallback(selected, vols) {
    const v = document.getElementById("previewVideo");
    if (!v) return;
    if (selected.length === 0) {
        v.muted = true;
        if (PreviewAudioGain) try { PreviewAudioGain.gain.value = 0; } catch {}
        return;
    }
    const avg = selected.reduce((a, idx) => a + (vols[idx] ?? 100), 0) / selected.length / 100;
    const gain = Math.max(0, Math.min(2, avg));
    v.muted = gain === 0;
    // Si necesitamos boost >1.0, usar GainNode (puede amplificar hasta 2x). Si no, usar v.volume directo
    // para no depender de AudioContext suspendido (que silencia el MediaElementSource).
    if (gain > 1.0 && PreviewAudioGain && PreviewAudioCtx) {
        try {
            if (PreviewAudioCtx.state === "suspended") PreviewAudioCtx.resume().catch(()=>{});
            if (PreviewAudioGain.gain.setTargetAtTime) PreviewAudioGain.gain.setTargetAtTime(gain, PreviewAudioCtx.currentTime, 0.02);
            else PreviewAudioGain.gain.value = gain;
            v.volume = 1.0;
        } catch { v.volume = Math.max(0, Math.min(1, avg)); }
    } else {
        // Ruta directa sin AudioContext: usar v.volume (capped 1.0) y asegurar GainNode en 1.0 si existe
        if (PreviewAudioGain) try { PreviewAudioGain.gain.value = 1.0; } catch {}
        // Si el contexto está suspendido y teníamos MediaElementSource conectado, desconectarlo
        // para que el audio no quede silenciado por el graph suspendido. Solo si no estamos en extracción.
        if (PreviewAudioCtx && PreviewAudioCtx.state === "suspended" && PreviewMediaSource && !PreviewUsingExtraction) {
            try { PreviewMediaSource.disconnect(); PreviewAudioGain.disconnect(); } catch {}
            PreviewMediaSource = null; PreviewAudioGain = null;
        }
        v.volume = Math.max(0, Math.min(1, gain));
    }
}

// Debounce extracción: 350ms
let _previewMixDebounce = null;
function UpdatePreviewAudioMix() {
    const v = document.getElementById("previewVideo");
    if (!v || !CurrentVideoPath || !CurrentVideoInfo) {
        updateAudioPreviewBadge([], {});
        return;
    }
    const { selected, vols } = getSelectedAudioState();

    // Consistencia: siempre usar extracción cuando hay pistas seleccionadas (incluso individual @100).
    // Evita depender de audioTracks API / gain global que dejaba mudo el track 1.
    if (selected.length === 0) {
        // Invalidar extracciones pendientes (race si se desactiva mientras se mezclaba)
        PreviewPendingExtract++;
        clearTimeout(_previewMixDebounce);
        teardownPreviewAudioMix();
        // No crear GainNode innecesario para mute
        updateAudioPreviewBadge(selected, vols);
        const v0 = document.getElementById("previewVideo");
        if (v0) v0.muted = true;
        return;
    }

    // Feedback inmediato con gain global mientras se extrae (evita silencio hasta que llegue el wav)
    SetupAudioPreview();
    applyGlobalGainFallback(selected, vols);
    updateAudioPreviewBadge(selected, vols);

    clearTimeout(_previewMixDebounce);
    _previewMixDebounce = setTimeout(() => doExtractedMix(selected, vols), 350);
}

async function doExtractedMix(selected, vols) {
    const v = document.getElementById("previewVideo");
    if (!v || !CurrentVideoPath) return;
    const cacheKey = `${CurrentVideoPath}::${selected.slice().sort((a,b)=>a-b).join(",")}`;
    if (PreviewExtractCacheKey === cacheKey && PreviewUsingExtraction && PreviewExtractedAudios.length === selected.length) {
        // solo actualizar gains
        PreviewExtractedAudios.forEach(a => {
            const gain = (vols[a.track] ?? 100) / 100;
            try { a.gainNode.gain.value = Math.max(0, Math.min(2, gain)); a.audioEl.muted = gain === 0; } catch {}
        });
        updateAudioPreviewBadge(selected, vols);
        return;
    }
    const mySeq = ++PreviewPendingExtract;
    const statusEl = document.getElementById("audioPreviewStatus");
    if (statusEl) { statusEl.textContent = t("audio.previewLoading"); statusEl.className = "AudioPreviewBadge loading"; }
    try {
        const results = await invoke("extract_audio_preview", { path: CurrentVideoPath, tracks: selected });
        if (mySeq !== PreviewPendingExtract) return; // stale por nueva extracción
        // Race: si se desactivó un audio mientras se extraía, la selección actual ya no coincide
        const { selected: curSel, vols: curVols } = getSelectedAudioState();
        const curKey = `${CurrentVideoPath}::${curSel.slice().sort((a,b)=>a-b).join(",")}`;
        if (curKey !== cacheKey) {
            // Descartar resultado obsoleto y re-programar con la selección vigente
            clearTimeout(_previewMixDebounce);
            if (curSel.length === 0) {
                teardownPreviewAudioMix();
                updateAudioPreviewBadge(curSel, curVols);
                const stEl = document.getElementById("audioPreviewStatus");
                if (stEl) { stEl.textContent = t("audio.previewMuted"); stEl.className = "AudioPreviewBadge muted"; }
            } else {
                _previewMixDebounce = setTimeout(() => doExtractedMix(curSel, curVols), 100);
            }
            return;
        }
        if (!results || results.length === 0) throw new Error("Sin audios extraídos");
        // Limpiar audios previos
        PreviewExtractedAudios.forEach(a => { try { a.audioEl.pause(); a.audioEl.src=""; } catch {} try { a.gainNode.disconnect(); } catch {} });
        PreviewExtractedAudios = [];
        const ctx = ensurePreviewAudioContext();
        if (!ctx) throw new Error("AudioContext no disponible");
        if (ctx.state === "suspended") await ctx.resume().catch(()=>{});
        // Para cada wav, crear <audio> + GainNode
        for (const r of results) {
            const audioEl = new Audio();
            audioEl.preload = "auto";
            audioEl.src = convertFileSrc(r.wav_path);
            audioEl.crossOrigin = "anonymous";
            audioEl.loop = false;
            audioEl.muted = false;
            // sincronizar tiempo inicial
            try { audioEl.currentTime = v.currentTime || 0; } catch {}
            audioEl.playbackRate = v.playbackRate || 1;
            // Crear GainNode por pista
            let gainNode;
            try {
                const src = ctx.createMediaElementSource(audioEl);
                gainNode = ctx.createGain();
                const g = (vols[r.track] ?? 100) / 100;
                gainNode.gain.value = Math.max(0, Math.min(2, g));
                src.connect(gainNode);
                gainNode.connect(ctx.destination);
                // guardar ref source para posible disconnect futuro
                audioEl._mediaSrc = src;
            } catch (e) {
                // Fallback: usar audioEl.volume si createMediaElementSource falla (CORS/autoplay)
                gainNode = { gain: { value: 1, set value(v){ audioEl.volume = Math.max(0, Math.min(1, v)); } } };
                const g = (vols[r.track] ?? 100) / 100;
                audioEl.volume = Math.max(0, Math.min(1, g));
                console.warn("MediaElementSource fallo, usando volume:", e);
            }
            try { audioEl.load(); } catch {}
            // Si ya está en canplay, sincronizar al instante; si no, hacerlo cuando esté listo
            audioEl.addEventListener("canplay", () => { try { if (PreviewUsingExtraction) audioEl.currentTime = v.currentTime || 0; } catch {} }, { once: true });
            PreviewExtractedAudios.push({ track: r.track, audioEl, gainNode, wavPath: r.wav_path });
        }
        // Mutear video original para evitar doblar audio
        v.muted = true;
        if (PreviewAudioGain) try { PreviewAudioGain.gain.value = 0; } catch {}
        PreviewUsingExtraction = true;
        PreviewExtractCacheKey = cacheKey;
        // Sincronizar play/pause inmediato
        if (!v.paused) {
            PreviewExtractedAudios.forEach(a => a.audioEl.play().catch(()=>{}));
        }
        // Sincronización ligera: solo corregir desfase grande.
        // El loop anterior hacía requestAnimationFrame cada frame y corregía a 0.4s,
        // lo que al mover el slider (que toca el gain) dejaba el audioEl atascado
        // en un bucle de 1s. Ahora solo corregimos cada ~1s y con umbral 1.2s.
        let lastRafSync = 0;
        const tick = () => {
            if (!PreviewUsingExtraction) return;
            PreviewSyncRaf = requestAnimationFrame(tick);
            if (v.paused || v.seeking) return;
            const now = performance.now();
            if (now - lastRafSync < 1000) return;
            PreviewExtractedAudios.forEach(a => {
                try {
                    if (Math.abs(a.audioEl.currentTime - v.currentTime) > 1.2) {
                        a.audioEl.currentTime = v.currentTime;
                        lastRafSync = now;
                    }
                } catch {}
            });
        };
        if (PreviewSyncRaf) cancelAnimationFrame(PreviewSyncRaf);
        PreviewSyncRaf = requestAnimationFrame(tick);
        updateAudioPreviewBadge(selected, vols);
        AddLog(t("log.previewMix", { count: selected.length, details: selected.map(i=>`${i}:${vols[i]??100}%`).join(", ") }), "success");
    } catch (e) {
        console.warn("extract_audio_preview fallo:", e);
        // Fallback a gain global sin romper preview
        PreviewUsingExtraction = false;
        applyGlobalGainFallback(selected, vols);
        updateAudioPreviewBadge(selected, vols);
        AddLog(t("log.previewFallback", { error: String(e).slice(0,80) }), "warning");
        // TODO: picks futuras — cachear slice corto en lugar de full wav para acelerar
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

        AddLog(t("log.previewLoaded", { name: videoPath.split(/[\\/]/).pop() }), "info");
        // Reset extracción previa al cambiar de archivo
        teardownPreviewAudioMix();
        SetupAudioPreview();
        previewVideo.onloadedmetadata = () => { UpdatePreviewAudioMix(); };
        // si metadata ya está cacheada, igual disparar
        setTimeout(() => UpdatePreviewAudioMix(), 400);
    } else {
        teardownPreviewAudioMix();
        previewSource.src = "";
        previewVideo.load();
        if (videoPlaceholder) videoPlaceholder.style.display = "flex";
        previewVideo.style.display = "none";
        const badge = document.getElementById("audioPreviewStatus");
        if (badge) { badge.style.display = "none"; }
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
            statusDiv.innerHTML = `${Icons.film} ${t("encode.compressing")}`;
            statusDiv.style.color = "var(--Accent)";
        }
        AddLog(t("log.analysisDone"), "success");
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
        estSize.textContent = t("estimate.live", { value: Math.round(estimatedTotalMB) });
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
            estSize.textContent = t("estimate.history", { value: Math.round(EstimatedMb) });
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
        estSize.textContent = t("estimate.guess", { value: Math.round(EstimatedMb) });
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
    Preview = Preview.replace("{codec}", SelectedCodec);
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
        if (codec.includes("nvenc")) label.textContent = t("quality.labelCq");
        else if (codec.includes("amf")) label.textContent = t("quality.labelQp");
        else if (codec.includes("qsv")) label.textContent = t("quality.labelGQuality");
        else label.textContent = t("quality.labelCrf");
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
        if (label) label.textContent = t("quality.labelBitrate");
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
    const displayName = meta ? (meta.hwtag ? `${meta.label} · ${t("codec.gpu")}` : `${meta.label} · ${t("codec.cpu")}`) : CodecValue;
    AddLog(t("log.codecSelected", { name: displayName }), "info");
    SaveCodecUsage(CodecValue);
    ClearActivePresetIfCustomized();
    RenderCodecSelector();
}

function SaveCodecUsage(codec, inc = 1) {
    if (!FfmpegCaps) return;
    const usage = FfmpegCaps.usage || {};
    usage[codec] = (usage[codec] || 0) + inc;
    FfmpegCaps.usage = usage;
    invoke("save_codec_usage", { usage }).catch(() => {});
}

function LoadVideoInfo(FilePath) {
    if (!FilePath) return;
    CurrentVideoPath = FilePath;
    VideoInfoRequestSeq += 1;
    SendMessage('get_video_info', { path: FilePath }, VideoInfoRequestSeq);
}

async function StartEncode() {
    CloseCutSelector();
    const batchMode = document.getElementById("batchModeCheck")?.checked || false;

    if (batchMode && FileQueue.length > 0) {
        if (IsEncoding || QueueProcessing) {
            AddLog(t("log.warnTaskActive"), "warning");
            return;
        }
        AddLog(t("log.queueInitiatedBatch", { count: FileQueue.length }), "info");
        ProcessQueue();
        return;
    }

    if (!CurrentVideoPath) {
        AddLog(t("log.errorSelectVideo"), "error");
        return;
    }

    if (IsEncoding) {
        AddLog(t("log.warnEncodingActive"), "warning");
        return;
    }

    if (!CurrentVideoInfo || !CurrentVideoInfo.duration_seconds) {
        AddLog(t("log.errorWaitInfo"), "error");
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
            statusDiv.innerHTML = "<span class='analyzing-spinner'></span> " + t("encode.analyzingLarge");
            statusDiv.style.color = "var(--Warn)";
        } else {
            statusDiv.innerHTML = "<span class='analyzing-spinner'></span> " + t("encode.analyzing");
            statusDiv.style.color = "var(--Warn)";
        }
    }

    const warningContainer = document.getElementById("sizeWarningContainer");
    if (warningContainer && CurrentVideoInfo && CurrentVideoInfo.size_mb > 5000) {
        warningContainer.innerHTML = `
            <div style="background: rgba(245, 158, 11, 0.15); border-left: 3px solid var(--Warn); padding: 8px 12px; border-radius: 6px; margin-top: 12px; font-size: 11px;">
                ⏳ <strong>${t("encode.largeWarningTitle", { size: (CurrentVideoInfo.size_mb/1024).toFixed(1) })}</strong><br>
                ${t("encode.largeWarningBody")}
            </div>
        `;
    } else if (warningContainer) {
        warningContainer.innerHTML = "";
    }

    AddLog(t("log.startingNewCompression"), "info");

    let OutputDir = document.getElementById("destPath")?.value || "";
    const sameFolderCheck = document.getElementById("sameFolderCheck");
    if (sameFolderCheck?.checked) {
        const PathParts = CurrentVideoPath.split(/[\\/]/);
        PathParts.pop();
        OutputDir = PathParts.join('\\');
    }

    const audioTracks = [...document.querySelectorAll(".audio-track-cb:checked")].map(Cb => parseInt(Cb.dataset.track));
    const audioVolumes = {};
    document.querySelectorAll(".VolumeSlider").forEach(sl => {
        const idx = parseInt(sl.dataset.track);
        if (audioTracks.includes(idx)) {
            const v = Math.max(0, Math.min(200, parseInt(sl.value) || 100));
            audioVolumes[idx] = v;
        }
    });

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
        audio_volumes: audioVolumes,
        custom_mix: false,
        cut_start: document.getElementById("cutCustomBtn")?.classList.contains("on") ? document.getElementById("cutStart")?.value : null,
        cut_end: document.getElementById("cutCustomBtn")?.classList.contains("on") ? document.getElementById("cutEnd")?.value : null,
    };

    try {
        const colision = await invoke("verificar_nombre_salida", { params: Params });
        if (colision && colision.existe) {
            const decision = await preguntarColision(colision);
            if (decision === "cancelar") {
                AddLog(t("log.compressionCancelledExists"), "warning");
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

    SaveCodecUsage(SelectedCodec);
    RenderCodecSelector();
    SendMessage("start_encode", { params: Params });
}

let PendingCollisionResolver = null;

function preguntarColision(info) {
    return new Promise((resolve) => {
        const Modal = document.getElementById("collisionModal");
        const FileNameEl = document.getElementById("collisionFileName");
        const CollisionMsg = document.getElementById("collisionMsg");
        const NewNameEl = document.getElementById("collisionNewName");
        const RenameBtn = document.getElementById("collisionRenameBtn");
        const fileName = info.salida ? info.salida.split(/[\\/]/).pop() : "";
        if (FileNameEl && info.salida) FileNameEl.textContent = fileName;
        if (CollisionMsg) {
            const nameEsc = escapeHtml(fileName);
            CollisionMsg.innerHTML = t("modal.collision.exists", { name: nameEsc });
        }
        const ext = info.salida ? "." + info.salida.split('.').pop() : "";
        if (RenameBtn) {
            if (info.alternativo) {
                const newFull = info.alternativo + ext;
                if (NewNameEl) NewNameEl.textContent = newFull;
                // also update saveAs span via t if needed
                const saveAsSpan = RenameBtn.querySelector('[data-i18n="modal.collision.saveAs"]');
                if (saveAsSpan) saveAsSpan.textContent = t("modal.collision.saveAs", { name: newFull });
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
        statusDiv.innerHTML = `${Icons.stop} ${t("encode.stopping")}`;
        statusDiv.style.color = "var(--Warn)";
    }

    AddLog(t("log.stoppingProcess"), "warning");

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
            Chevron.textContent = t("log.collapse");
        } else {
            LogBody.classList.remove("open");
            Chevron.textContent = t("log.expand");
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
        AddLog(t("log.errorLoadVideoFirst"), "error");
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
    if (PlayerPlayBtn) PlayerPlayBtn.innerHTML = PreviewVideo.paused ? `${Icons.play} ${t("cut.play")}` : `${Icons.pause} ${t("cut.pause")}`;
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
        AddLog(t("log.errorInvalidFormat", { value: val }), "error");
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

function AddToQueue(filePath) {
    if (!filePath) return;

    if (FileQueue.some(f => f.path === filePath)) {
        AddLog(t("log.alreadyInQueue", { name: filePath.split(/[\\/]/).pop() }), "warning");
        return;
    }

    FileQueue.push({ path: filePath, name: filePath.split(/[\\/]/).pop(), cut_start: null, cut_end: null, audio_tracks: null, audio_track_names: null, audio_volumes: {} });

    if (CurrentQueueSelectedIndex === -1) {
        SelectVideoFromQueue(FileQueue.length - 1);
    } else {
        ProbeQueueItemAudio(FileQueue[FileQueue.length - 1]);
        RenderQueueList();
    }
    AddLog(t("log.addedToQueue", { name: FileQueue[FileQueue.length-1].name }), "info");
}

function ProbeQueueItemAudio(item) {
    if (!item || item.audio_tracks !== null) return;
    invoke("get_video_info", { path: item.path })
        .then((info) => {
            if (!FileQueue.includes(item)) return;
            if (item.audio_tracks !== null) return;
            const audio = info && info.audio_tracks;
            if (audio && audio.length > 0) {
                const first = audio[0];
                item.audio_tracks = [first.index];
                item.audio_track_names = [first.title || `Track ${first.index}`];
                item.audio_volumes = { [first.index]: 100 };
                // Inicializar resto de pistas a 100 para que el payload futuro sea completo si el usuario las activa
                audio.forEach(t => { if (item.audio_volumes[t.index] == null) item.audio_volumes[t.index] = 100; });
            } else {
                item.audio_tracks = [];
                item.audio_track_names = [];
                item.audio_volumes = {};
            }
            RenderQueueList();
        })
        .catch(() => {});
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
    AddLog(t("log.removedFromQueue"), "info");
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
    if (audioContainer) audioContainer.innerHTML = `<div class="AudioEmpty">${t("audio.emptyNoSelection")}</div>`;
    const audioBadge = document.getElementById("audioPreviewStatus");
    if (audioBadge) audioBadge.style.display = "none";

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

    RenderQueueList();
}

function RenderQueueList() {
    const container = document.getElementById("queueList");
    if (!container) return;

    if (FileQueue.length === 0) {
        container.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--Text3);">
                ${Icons.box} ${t("queue.emptyLong")}
            </div>
        `;
        return;
    }

    container.innerHTML = FileQueue.map((item, idx) => {
        const CutBadge = `<span style="font-size:9px;color:var(--Accent);display:inline-flex;align-items:center;gap:4px;font-family:monospace">${Icons.scissors} ${item.cut_start || '00:00:00'} → ${item.cut_end || t("cut.endFallback")}</span>`;
        let AudioBadge;
        if (Array.isArray(item.audio_tracks)) {
            if (item.audio_tracks.length > 0) {
                const vols = item.audio_volumes || {};
                const names = (item.audio_track_names || item.audio_tracks.map(i => `Track ${i + 1}`));
                const parts = item.audio_tracks.map((trackIdx, i) => {
                    const name = names[i] || `Track ${trackIdx + 1}`;
                    const v = vols[trackIdx];
                    const volStr = (v != null && v !== 100) ? ` @${v}%` : '';
                    return `${name}${volStr}`;
                });
                AudioBadge = `<span style="font-size:9px;color:var(--Warn);display:inline-flex;align-items:center;gap:4px;font-family:monospace">${Icons.audio} ${parts.join(', ')}</span>`;
            } else {
                AudioBadge = `<span style="font-size:9px;color:var(--Text3);display:inline-flex;align-items:center;gap:4px;font-family:monospace">${Icons.audio} ${t("audio.noAudioBadge")}</span>`;
            }
        } else {
            AudioBadge = `<span style="font-size:9px;color:var(--Text3);display:inline-flex;align-items:center;gap:4px;font-family:monospace">${Icons.audio}</span>`;
        }
        return `
            <div class="QueueItem ${idx === CurrentQueueSelectedIndex ? 'active' : ''}" data-queue-index="${idx}">
                <div style="flex:1;min-width:0;overflow:hidden">
                    <span class="QueueItemName" title="${item.path}">${item.name}</span>
                    <div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:2px">
                        ${CutBadge}
                        ${AudioBadge}
                    </div>
                </div>
                <button class="QueueItemRemove" data-index="${idx}" title="${t("queue.removeTitle")}">${Icons.close}</button>
            </div>
        `;
    }).join('');
}

function SelectVideoFromQueue(index) {
    const item = FileQueue[index];
    if (!item) return;

    CurrentQueueSelectedIndex = index;
    AddLog(t("log.selected", { name: item.name }), "info");

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
    CurrentItem.audio_tracks = SelectedTracks;
    if (CurrentVideoInfo && CurrentVideoInfo.audio_tracks) {
        CurrentItem.audio_track_names = SelectedCbs.map(Cb => {
            const idx = parseInt(Cb.dataset.track);
            const info = CurrentVideoInfo.audio_tracks.find(t => t.index === idx);
            return info && info.title ? info.title : `Track ${idx + 1}`;
        });
    } else {
        CurrentItem.audio_track_names = null;
    }
    // Persistir volúmenes de todas las pistas visibles (para restaurar al re-marcar)
    if (!CurrentItem.audio_volumes || typeof CurrentItem.audio_volumes !== 'object') CurrentItem.audio_volumes = {};
    document.querySelectorAll('.VolumeSlider').forEach(sl => {
        const idx = parseInt(sl.dataset.track);
        const v = Math.max(0, Math.min(200, parseInt(sl.value) || 100));
        CurrentItem.audio_volumes[idx] = v;
    });
    // Asegurar que pistas seleccionadas tengan volumen (default 100 si falta)
    SelectedTracks.forEach(idx => {
        if (CurrentItem.audio_volumes[idx] == null) CurrentItem.audio_volumes[idx] = 100;
    });
    RenderQueueList();
    try { UpdatePreviewAudioMix(); } catch {}
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
    CloseCutSelector();
    if (FileQueue.length === 0) {
        AddLog(t("log.errorNoFilesInQueue"), "error");
        return;
    }

    if (QueueProcessing) {
        AddLog(t("log.warnQueueProcessing"), "warning");
        return;
    }

    let OutputDir = document.getElementById("destPath")?.value || "";
    const sameFolderCheck = document.getElementById("sameFolderCheck");
    if (sameFolderCheck?.checked) {
        OutputDir = "";
    }

    const audioTracks = [...document.querySelectorAll(".audio-track-cb:checked")].map(Cb => parseInt(Cb.dataset.track));
    const baseVolumes = {};
    document.querySelectorAll(".VolumeSlider").forEach(sl => {
        const idx = parseInt(sl.dataset.track);
        if (audioTracks.includes(idx)) baseVolumes[idx] = Math.max(0, Math.min(200, parseInt(sl.value) || 100));
    });

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
        audio_volumes: baseVolumes,
        custom_mix: false,
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
                AddLog(t("log.warnFileExists", { name: col.salida.split(/[\\/]/).pop() }), "warning");
                const decision = await preguntarColision(col);
                if (decision === "cancelar") {
                    AddLog(t("log.queueCancelledDuplicate"), "warning");
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
        } else if (Array.isArray(file.audio_tracks)) {
            Item.audio_tracks = [];
        }
        if (file.audio_volumes && typeof file.audio_volumes === 'object' && Object.keys(file.audio_volumes).length > 0) {
            const filtered = {};
            const tracks = file.audio_tracks || audioTracks;
            (tracks || []).forEach(idx => {
                if (file.audio_volumes[idx] != null) filtered[idx] = file.audio_volumes[idx];
            });
            // Si el item no tiene tracks definidas aún, enviar todo lo que tenga
            if (Object.keys(filtered).length === 0) Object.assign(filtered, file.audio_volumes);
            if (Object.keys(filtered).length > 0) Item.audio_volumes = filtered;
        }
        return Item;
    });

    const queueStarted = await SendMessage("start_queue", {
        items: queueItems,
        base_params: baseParams
    });
    if (!queueStarted) {
        AddLog(t("log.errorStartingQueue"), "error");
        return;
    }

    SaveCodecUsage(baseParams.codec, queueItems.length);
    RenderCodecSelector();
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
        stats.textContent = t("history.savings", { value: totalSavedMB.toFixed(1) });
    }

    if (!container) return;

    if (!history || history.length === 0) {
        container.innerHTML = `
            <div style="padding: 20px; text-align: center; color: var(--Text3);">
                ${Icons.clock} ${t("history.emptyDetail")}
            </div>
        `;
        return;
    }

    const isLeftPanel = container.closest('.left-panel') !== null;
    container.innerHTML = history.slice(0, isLeftPanel ? 10 : 50).map(item => `
        <div class="HistoryItem">
            <div class="HistoryItemName">${item.input} → ${item.output}</div>
            <div class="HistoryItemDetails">
                <span>${Icons.box} ${parseFloat(item.original_mb).toFixed(1)} MB → ${parseFloat(item.output_mb).toFixed(1)} MB</span>
                <span class="HistorySaved">${Icons.save} ${t("history.savings", { value: parseFloat(item.saved_mb).toFixed(1) })} (${Math.round((1-item.ratio)*100)}%)</span>
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
        AddLog(t("log.selectingFiles"), "info");
        const filePath = await open({
            multiple: true,
            filters: [{ name: "Videos", extensions: ["mp4", "mkv", "mov", "avi", "webm", "m4v"] }],
        });
        if (filePath && filePath.length > 0) {
            for (const fp of filePath) {
                if (fp) AddToQueue(fp);
            }
        } else {
            AddLog(t("log.noFileSelected"), "info");
        }
    } catch (error) {
        AddLog(t("log.errorGeneric", { error: error.message }), "error");
    }
}

// ========== INICIALIZACIÓN ==========
document.addEventListener('DOMContentLoaded', () => {
    applyI18n(document);
    SetupLocaleToggle();
    const _ppBtn = document.getElementById("playerPlayBtn");
    if (_ppBtn) _ppBtn.innerHTML = `${Icons.play} ${t("cut.play")}`;
    const _histStats = document.getElementById("historyStats");
    if (_histStats && !_histStats.textContent.trim()) _histStats.textContent = t("history.savings", { value: "0" });
    const _qLabel = document.getElementById("qualityLabel");
    if (_qLabel && !_qLabel.textContent.trim()) UpdateCrfSlider(SelectedCodec);
    const _logChevron = document.getElementById("logChevron");
    if (_logChevron) _logChevron.textContent = t("log.expand");
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
                    AddLog(t("log.noValidVideos"), "error");
                    return;
                }
                for (const vp of videos) AddToQueue(vp);
                AddLog(t("log.videosReceived", { count: videos.length }), "success");
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
                AddLog(t("log.destSet", { path: FolderPath }), "success");
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
        CutVideo.addEventListener("play", () => { if (PlayerPlayBtn) PlayerPlayBtn.innerHTML = `${Icons.pause} ${t("cut.pause")}`; });
        CutVideo.addEventListener("pause", () => { if (PlayerPlayBtn) PlayerPlayBtn.innerHTML = `${Icons.play} ${t("cut.play")}`; });
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
                AddLog(t("log.startMarked", { time: SecondsToHms(PlayerMarkedStart) }), "info");
            }
        });
    }

    if (markEndBtn) {
        markEndBtn.addEventListener("click", () => {
            const cv = document.getElementById("previewVideo");
            if (cv) {
                if (PlayerMarkedStart !== null && cv.currentTime <= PlayerMarkedStart) {
                    AddLog(t("log.errorEndAfterStart"), "error");
                    return;
                }
                PlayerMarkedEnd = cv.currentTime;
                UpdateMarkerVisuals();
                AddLog(t("log.endMarked", { time: SecondsToHms(PlayerMarkedEnd) }), "info");
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
            AddLog(t("log.cutApplied", { start: SecondsToHms(PlayerMarkedStart ?? 0), end: SecondsToHms(PlayerMarkedEnd ?? 0) }), "success");
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
                const row = E.target.closest('.TrackRow');
                if (row) {
                    const slider = row.querySelector('.VolumeSlider');
                    const muteBtn = row.querySelector('.VolumeMuteBtn');
                    const checked = E.target.checked;
                    if (slider) slider.disabled = !checked;
                    if (muteBtn) muteBtn.disabled = !checked;
                    row.style.opacity = checked ? '1' : '0.6';
                }
                SaveAudioToCurrentQueueItem();
            }
        });
        AudioTracksContainer.addEventListener("input", (E) => {
            if (E.target.classList.contains("VolumeSlider")) {
                const idx = parseInt(E.target.dataset.track);
                const val = Math.max(0, Math.min(200, parseInt(E.target.value) || 0));
                const badge = AudioTracksContainer.querySelector(`.VolumeBadge[data-track="${idx}"]`);
                if (badge) {
                    badge.textContent = `${val}%`;
                    badge.className = val === 0 ? 'VolumeBadge muted' : val !== 100 ? 'VolumeBadge boosted' : 'VolumeBadge';
                }
                const muteBtn = AudioTracksContainer.querySelector(`.VolumeMuteBtn[data-track="${idx}"]`);
                if (muteBtn) {
                    muteBtn.classList.toggle('on', val === 0);
                    muteBtn.innerHTML = val === 0 ? Icons.mute : Icons.volume;
                    muteBtn.title = val === 0 ? t("audio.unmuteTitle") : t("audio.muteTitle");
                }
                SaveVolumeToCurrentQueueItem(idx, val);
            }
        });
        AudioTracksContainer.addEventListener("click", (E) => {
            const muteBtn = E.target.closest('.VolumeMuteBtn');
            if (muteBtn) {
                const idx = parseInt(muteBtn.dataset.track);
                const slider = AudioTracksContainer.querySelector(`.VolumeSlider[data-track="${idx}"]`);
                if (!slider || slider.disabled) return;
                const cur = parseInt(slider.value) || 100;
                const next = cur === 0 ? 100 : 0;
                slider.value = next;
                slider.dispatchEvent(new Event('input', { bubbles: true }));
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
    AddLog(t("log.ready"), "info");
});