// ============================================================
//  date-input.js  —  Fleet Manager
//  Zajednička logika za SVA polja za datum u aplikaciji:
//   • tekstualno polje sa maskom dd.mm.gggg (format je isti za sve
//     korisnike, bez obzira na jezik/region browsera),
//   • jasno istaknuto dugme sa kalendarom na desnoj strani polja
//     (klik otvara kalendar, izabrani dan se upisuje u polje),
//   • provera datuma (npr. 31.09.2026 ne postoji) sa porukom ISPOD
//     polja, crvenim okvirom i fokusom na prvo pogrešno polje.
//
//  Ranije su toDMY / parseDMY / attachDateMask bili kopirani u
//  reports.js, vehicles.js, assignments.js i dashboard.js — sada
//  postoji samo ova jedna verzija.
// ============================================================

import { t, getCurrentLang } from "./i18n.js";

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

// ── FORMATIRANJE / PARSIRANJE ─────────────────────────────────
function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Date | Firestore Timestamp | string → "dd.mm.gggg" ("" ako je prazno/nevažeće) */
export function toDMY(val) {
  if (!val) return "";
  const d = val.toDate ? val.toDate() : new Date(val);
  if (isNaN(d)) return "";
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function todayDMY() {
  return toDMY(new Date());
}

/** Placeholder prati jezik aplikacije (dd/mm je fiksno, menja se samo "godina"). */
export function datePlaceholder() {
  return getCurrentLang() === "en" ? "dd.mm.yyyy" : "dd.mm.gggg";
}

/** Date → "gggg-mm-dd" po LOKALNOM vremenu (bez UTC pomeranja kao toISOString). */
export function toISODate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Detaljna provera teksta datuma.
 * Vraća { empty, ok, date, code, params } — `code` je jedan od:
 * "format" | "year" | "month" | "day_range" | "day" (dan ne postoji u tom mesecu).
 */
export function inspectDMY(str) {
  const s = String(str ?? "").trim();
  if (!s) return { empty: true, ok: false, date: null, code: null, params: {} };

  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})\.?$/);
  if (!m) return { empty: false, ok: false, date: null, code: "format", params: {} };

  const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);

  if (year < MIN_YEAR || year > MAX_YEAR) {
    return { empty: false, ok: false, date: null, code: "year", params: { min: MIN_YEAR, max: MAX_YEAR } };
  }
  if (month < 1 || month > 12) {
    return { empty: false, ok: false, date: null, code: "month", params: {} };
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  if (day < 1) {
    return { empty: false, ok: false, date: null, code: "day_range", params: { days: daysInMonth } };
  }
  if (day > daysInMonth) {
    const locale = getCurrentLang() === "en" ? "en-GB" : "sr-Latn-RS";
    const monthName = new Date(year, month - 1, 1).toLocaleDateString(locale, { month: "long" });
    return { empty: false, ok: false, date: null, code: "day", params: { month: monthName, year, days: daysInMonth } };
  }

  return { empty: false, ok: true, date: new Date(year, month - 1, day), code: null, params: {} };
}

/** Strogo parsiranje: Date ili null (npr. 31.09.2026 → null). */
export function parseDMY(str) {
  const r = inspectDMY(str);
  return r.ok ? r.date : null;
}

function messageFor(result) {
  return t("date_err_" + result.code, result.params);
}

// ── GREŠKE NA POLJU ───────────────────────────────────────────
function resolveEl(target) {
  return typeof target === "string" ? document.getElementById(target) : target;
}

function errorHost(el) {
  return el.closest(".date-field") || el;
}

export function clearDateError(target) {
  const el = resolveEl(target);
  if (!el) return;
  el.classList.remove("input--error");
  el.removeAttribute("aria-invalid");
  const scope = errorHost(el).parentElement;
  scope?.querySelectorAll(`.field-error-msg[data-date-err="${el.id}"]`).forEach(n => n.remove());
}

/** Prikaži poruku ispod polja (crveni okvir). focus=true → fokus + scroll do polja. */
export function setDateError(target, message, { focus = false } = {}) {
  const el = resolveEl(target);
  if (!el) return;
  clearDateError(el);
  el.classList.add("input--error");
  el.setAttribute("aria-invalid", "true");

  const msg = document.createElement("span");
  msg.className = "field-error-msg";
  msg.dataset.dateErr = el.id;
  msg.setAttribute("role", "alert");
  msg.textContent = message;
  errorHost(el).insertAdjacentElement("afterend", msg);

  if (focus) {
    el.focus();
    el.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }
}

/**
 * Pročitaj i proveri jedno polje.
 * Vraća { ok, date, message }. Prazno polje je ok (date = null) osim ako je required.
 * Pri grešci odmah prikazuje poruku ispod polja.
 */
export function readDateField(id, { required = false, requiredMessage = null } = {}) {
  const el = document.getElementById(id);
  if (!el) return { ok: true, date: null, message: null };

  const r = inspectDMY(el.value);
  if (r.empty) {
    if (required) {
      const message = requiredMessage || t("date_err_required");
      setDateError(el, message);
      return { ok: false, date: null, message };
    }
    clearDateError(el);
    return { ok: true, date: null, message: null };
  }
  if (!r.ok) {
    const message = messageFor(r);
    setDateError(el, message);
    return { ok: false, date: null, message };
  }
  clearDateError(el);
  return { ok: true, date: r.date, message: null };
}

/**
 * Proveri više polja odjednom.
 * specs: [{ id, required, requiredMessage? }]
 * Sva pogrešna polja dobijaju poruku, fokus ide na PRVO pogrešno.
 * Vraća { ok, values: { [id]: Date|null }, firstMessage }.
 */
export function collectDates(specs) {
  const values = {};
  let ok = true;
  let firstBadId = null;
  let firstMessage = null;

  for (const spec of specs) {
    const r = readDateField(spec.id, {
      required: !!spec.required,
      requiredMessage: spec.requiredMessage || null,
    });
    values[spec.id] = r.date;
    if (!r.ok) {
      ok = false;
      if (!firstBadId) { firstBadId = spec.id; firstMessage = r.message; }
    }
  }

  if (firstBadId) {
    const el = document.getElementById(firstBadId);
    el?.focus();
    el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }
  return { ok, values, firstMessage };
}

// ── MASKA + KALENDAR ──────────────────────────────────────────
const CALENDAR_SVG = `
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="18" rx="2"></rect>
    <path d="M16 2v4M8 2v4M3 10h18"></path>
  </svg>`;

/**
 * Pretvara obično tekstualno polje (već u DOM-u) u polje za datum:
 *  - maska dd.mm.gggg dok korisnik kuca,
 *  - dugme sa kalendarom na desnoj strani,
 *  - provera pri napuštanju polja (blur).
 * Poziva se po ID-u, posle renderovanja forme (isto kao ranije).
 */
export function attachDateMask(id) {
  const el = document.getElementById(id);
  if (!el || el.dataset.dateField === "1") return;
  el.dataset.dateField = "1";

  el.setAttribute("autocomplete", "off");
  el.setAttribute("inputmode", "numeric");
  el.setAttribute("maxlength", "10");
  if (!el.getAttribute("placeholder")) el.setAttribute("placeholder", datePlaceholder());

  // Omotač: polje + dugme sa kalendarom + skriveni nativni birač datuma
  const wrap = document.createElement("div");
  wrap.className = "date-field";
  el.parentNode.insertBefore(wrap, el);
  wrap.appendChild(el);

  const native = document.createElement("input");
  native.type = "date";
  native.className = "date-field__native";
  native.tabIndex = -1;
  native.setAttribute("aria-hidden", "true");
  native.min = `${MIN_YEAR}-01-01`;
  native.max = `${MAX_YEAR}-12-31`;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "date-field__btn";
  btn.title = t("date_pick");
  btn.setAttribute("aria-label", t("date_pick"));
  btn.innerHTML = CALENDAR_SVG;
  btn.disabled = el.disabled;

  wrap.append(native, btn);

  // Maska dok se kuca
  el.addEventListener("input", () => {
    const digits = el.value.replace(/\D/g, "").slice(0, 8);
    let out = digits;
    if (digits.length > 4) out = `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
    else if (digits.length > 2) out = `${digits.slice(0, 2)}.${digits.slice(2)}`;
    el.value = out;
    clearDateError(el); // dok korisnik ispravlja, stara greška nestaje
  });

  // Nalepljen datum (5.9.2026, 05/09/2026, 2026-09-05) → dd.mm.gggg
  el.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData("text") ?? "";
    const dmy = text.trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})\.?$/);
    const iso = text.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    let out = null;
    if (dmy) out = `${pad2(dmy[1])}.${pad2(dmy[2])}.${dmy[3]}`;
    else if (iso) out = `${pad2(iso[3])}.${pad2(iso[2])}.${iso[1]}`;
    if (!out) return; // ostalo prepusti maski
    e.preventDefault();
    el.value = out;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // Provera kad korisnik napusti polje (ne dok kuca)
  const validateOnLeave = () => {
    const r = inspectDMY(el.value);
    if (r.empty || r.ok) clearDateError(el);
    else setDateError(el, messageFor(r));
  };
  el.addEventListener("blur", validateOnLeave);
  el.addEventListener("change", validateOnLeave);

  // Klik na kalendar
  btn.addEventListener("click", () => {
    const r = inspectDMY(el.value);
    native.value = r.ok ? toISODate(r.date) : "";
    try {
      native.showPicker();
    } catch {
      // Stariji browseri bez showPicker() — probaj običan fokus/klik
      native.focus();
      native.click();
    }
  });

  // Izabran dan u kalendaru → upiši u polje u formatu dd.mm.gggg
  native.addEventListener("change", () => {
    const m = native.value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return;
    el.value = `${m[3]}.${m[2]}.${m[1]}`;
    clearDateError(el);
    // Isti događaji kao da je korisnik ukucao datum — drugi listeneri
    // (npr. automatski prepis isteka registracije u istek osiguranja) rade i dalje.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.focus();
  });
}
