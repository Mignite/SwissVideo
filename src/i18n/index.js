import en from "./en.json";
import es from "./es.json";

export const SUPPORTED = ["en", "es"];
const DICTS = { en, es };
const STORAGE_KEY = "swissvideo_locale";

function normalize(code) {
  if (!code) return "en";
  const lower = String(code).toLowerCase();
  if (lower.startsWith("es")) return "es";
  if (lower.startsWith("en")) return "en";
  return "en";
}

export function detectLocale() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED.includes(stored)) return stored;
  } catch {}
  try {
    const nav = navigator.language || navigator.languages?.[0] || "en";
    return normalize(nav);
  } catch {
    return "en";
  }
}

let current = detectLocale();

export function getLocale() {
  return current;
}

export function setLocale(code) {
  const n = SUPPORTED.includes(code) ? code : normalize(code);
  current = n;
  try {
    localStorage.setItem(STORAGE_KEY, n);
  } catch {}
  document.documentElement.lang = n;
  return n;
}

export function t(key, vars) {
  const dict = DICTS[current] || DICTS.en;
  let str = dict[key];
  if (str === undefined) {
    const fallback = DICTS.en[key];
    if (fallback !== undefined) str = fallback;
    else return key;
  }
  if (vars && typeof vars === "object") {
    for (const [k, v] of Object.entries(vars)) {
      str = str.split(`{${k}}`).join(String(v));
    }
  }
  return str;
}

export function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    const txt = t(key);
    if (el.hasAttribute("data-i18n-html")) {
      el.innerHTML = txt;
    } else {
      el.textContent = txt;
    }
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (!key) return;
    el.placeholder = t(key);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const key = el.getAttribute("data-i18n-title");
    if (!key) return;
    el.title = t(key);
  });
}

// init lang attr immediately
try {
  document.documentElement.lang = current;
} catch {}
