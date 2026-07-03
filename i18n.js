// ============================================================
//  i18n.js  —  Fleet Manager
//  Višejezični sistem
// ============================================================

const SUPPORTED_LANGS = ["sr", "en"];
const DEFAULT_LANG = "sr";

let currentLang = localStorage.getItem("fm_lang") || DEFAULT_LANG;
let translations = {};

/** Učitaj jezik iz JSON fajla */
export async function loadLanguage(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) lang = DEFAULT_LANG;
  try {
    const res = await fetch(`./locales/${lang}.json`);
    translations = await res.json();
    currentLang = lang;
    localStorage.setItem("fm_lang", lang);
    document.documentElement.lang = lang;
    applyTranslations();
  } catch (e) {
    console.error("i18n load error:", e);
  }
}

/** Prevedi ključ, sa opcionalnim placeholder zamjenama */
export function t(key, vars = {}) {
  let text = translations[key] || key;
  Object.entries(vars).forEach(([k, v]) => {
    text = text.replace(new RegExp(`{{${k}}}`, "g"), v);
  });
  return text;
}

/** Primeni prevode na sve elemente sa data-i18n atributom */
export function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    el.textContent = t(key);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.getAttribute("data-i18n-title"));
  });
}

export function getCurrentLang() {
  return currentLang;
}

export { SUPPORTED_LANGS };
