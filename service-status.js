// ============================================================
//  service-status.js  —  Fleet Manager
//  Zajednička logika za status servisnog zapisa.
//
//  Stariji zapisi u bazi nemaju polje "status" (kreirani su pre
//  ove izmene), pa se status u tom slučaju izvodi iz datuma:
//  budući datum → "planned", danas/prošlost → "done" (već odrađen,
//  logovan direktno kroz "Dodaj servis" kao što je uvek i rađeno).
//
//  Tok statusa za NOVE zapise:
//    planned  --[🚗 Vozilo odvezeno u servis]-->  in_progress
//    in_progress --[✅ Servis završen]-->          done
// ============================================================

import { db } from "./firebase.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t } from "./i18n.js";

export const SERVICE_STATUS = {
  PLANNED:     "planned",
  IN_PROGRESS: "in_progress",
  DONE:        "done",
  CANCELLED:   "cancelled",
};

export function effectiveServiceStatus(s) {
  if (s.status) return s.status;
  const d = s.serviceDate?.toDate ? s.serviceDate.toDate() : new Date(s.serviceDate);
  if (isNaN(d)) return SERVICE_STATUS.DONE;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  // "Danas" se i dalje tretira kao "planned" (nije još gotovo) — dan
  // se ne završava dok ne prođe ponoć, pa servis zakazan za danas mora
  // da ostane vidljiv i sa dugmetom sve dok se ne klikne ili dok dan
  // ne prođe (tek sutra postaje "propušten", ne "done").
  return d.getTime() >= today.getTime() ? SERVICE_STATUS.PLANNED : SERVICE_STATUS.DONE;
}

/** Da li je serviceDate danas (lokalno, ponoć-ponoć). */
export function isServiceToday(s) {
  const d = s.serviceDate?.toDate ? s.serviceDate.toDate() : new Date(s.serviceDate);
  if (isNaN(d)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return d.getTime() === today.getTime();
}

/**
 * "Zakasnio" servis: bio je zakazan (status "planned"), a datum je već
 * prošao, a niko nije potvrdio da je vozilo odvezeno u servis. Dugme
 * "Vozilo odvezeno" ostaje dostupno i dalje — ovo je samo vizuelna
 * oznaka da zapisu treba pažnja.
 */
export function isServiceOverdue(s) {
  if (effectiveServiceStatus(s) !== SERVICE_STATUS.PLANNED) return false;
  const d = s.serviceDate?.toDate ? s.serviceDate.toDate() : new Date(s.serviceDate);
  if (isNaN(d)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return d.getTime() < today.getTime();
}

/** Broj dana od zakazanog datuma do danas (pozitivan broj, samo za overdue zapise). */
export function overdueDays(s) {
  const d = s.serviceDate?.toDate ? s.serviceDate.toDate() : new Date(s.serviceDate);
  if (isNaN(d)) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)));
}


// ============================================================
//  PODSETNIK ZA REDOVNI SERVIS
//  Sledeći redovni servis se NE čuva u bazi — računa se iz poslednjeg
//  završenog redovnog servisa, pa se posle svakog novog završenog
//  redovnog servisa brojači sami "resetuju".
// ============================================================

export const DEFAULT_SERVICE_SETTINGS = {
  intervalKm:     10000, // na svakih X km
  intervalMonths: 12,    // ili na svakih X meseci (šta pre nastupi)
  alarmKm:        100,   // alarm kreće X km pre roka
  alarmDays:      15,    // alarm kreće X dana pre roka
};

function posNum(v, def, allowZero = false) {
  const n = Number(v);
  if (!isFinite(n) || v === null || v === undefined || v === "") return def;
  return (allowZero ? n >= 0 : n > 0) ? n : def;
}

export function normalizeServiceSettings(raw) {
  const r = raw || {};
  const d = DEFAULT_SERVICE_SETTINGS;
  return {
    intervalKm:     posNum(r.intervalKm,     d.intervalKm),
    intervalMonths: Math.round(posNum(r.intervalMonths, d.intervalMonths)),
    alarmKm:        posNum(r.alarmKm,        d.alarmKm,   true),
    alarmDays:      Math.round(posNum(r.alarmDays, d.alarmDays, true)),
  };
}

/**
 * Podešavanja po vozilu (vehicle.serviceSettings). Svako polje je opciono:
 * prazno/nevalidno polje se ignoriše i vozilo nasleđuje vrednost firme.
 * @returns objekat samo sa validno popunjenim poljima ({} ako ih nema)
 */
export function cleanVehicleServiceOverrides(raw) {
  const r = raw || {};
  const out = {};
  const num = (v, allowZero) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!isFinite(n)) return null;
    return (allowZero ? n >= 0 : n > 0) ? n : null;
  };
  const ik = num(r.intervalKm, false);     if (ik !== null) out.intervalKm = ik;
  const im = num(r.intervalMonths, false); if (im !== null) out.intervalMonths = Math.round(im);
  const ak = num(r.alarmKm, true);         if (ak !== null) out.alarmKm = ak;
  const ad = num(r.alarmDays, true);       if (ad !== null) out.alarmDays = Math.round(ad);
  return out;
}

/** Da li vozilo ima bar jedno sopstveno podešavanje servisnog podsetnika. */
export function hasVehicleServiceOverrides(vehicle) {
  return Object.keys(cleanVehicleServiceOverrides(vehicle?.serviceSettings)).length > 0;
}

/** Podešavanja servisnog podsetnika firme (sa podrazumevanim vrednostima). */
export async function getServiceSettings(companyId) {
  try {
    const snap = await getDoc(doc(db, "companies", companyId));
    return normalizeServiceSettings(snap.exists() ? snap.data().serviceSettings : null);
  } catch (e) {
    return normalizeServiceSettings(null);
  }
}

function toDateObj(v) {
  if (!v) return null;
  const d = v.toDate ? v.toDate() : new Date(v);
  return isNaN(d) ? null : d;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Kalendarsko dodavanje meseci; ako dan ne postoji u ciljnom mesecu → poslednji dan tog meseca. */
export function addMonthsClamped(date, months) {
  const d = startOfDay(date);
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

/**
 * Servis se ne zakazuje vikendom: subota → petak, nedelja → ponedeljak.
 * Ako je zadat notBefore (npr. danas) a pomeranje unazad bi završilo pre
 * njega, datum se umesto toga pomera unapred (na ponedeljak).
 */
export function shiftToWorkday(date, notBefore = null) {
  const d = startOfDay(date);
  const wd = d.getDay(); // 0 = nedelja, 6 = subota
  if (wd === 6) {
    const back = new Date(d); back.setDate(d.getDate() - 1);
    if (notBefore && back < startOfDay(notBefore)) {
      const fwd = new Date(d); fwd.setDate(d.getDate() + 2);
      return fwd;
    }
    return back;
  }
  if (wd === 0) {
    const fwd = new Date(d); fwd.setDate(d.getDate() + 1);
    return fwd;
  }
  return d;
}

export function isWeekend(date) {
  const wd = startOfDay(date).getDay();
  return wd === 0 || wd === 6;
}

/**
 * Izračunava stanje redovnog servisa za jedno vozilo.
 * @param vehicle   dokument vozila (currentKm, serviceReminderSnoozedUntil...)
 * @param services  servisi tog vozila (bar oni tipa "regular")
 * @returns null ako vozilo nema završen redovni servis; inače objekat sa
 *          podacima o prethodnom/sledećem servisu i flagovima alarma.
 */
export function getRegularServiceInfo(vehicle, services, settings, now = new Date()) {
  // Firmska podešavanja, preko njih sopstvena podešavanja vozila (ako postoje)
  const vehicleOverrides = cleanVehicleServiceOverrides(vehicle?.serviceSettings);
  const cfg = normalizeServiceSettings({ ...(settings || {}), ...vehicleOverrides });
  const regular = (services || []).filter(s => s.serviceType === "regular");

  const done = regular
    .filter(s => effectiveServiceStatus(s) === SERVICE_STATUS.DONE)
    .map(s => ({
      date: toDateObj(s.endDate) || toDateObj(s.serviceDate),
      km:   (s.endKm ?? s.km ?? null),
    }))
    .filter(x => x.date);
  if (done.length === 0) return null;

  done.sort((a, b) => b.date - a.date);
  const last = done[0];

  const hasOpen = regular.some(s => {
    const st = effectiveServiceStatus(s);
    return st === SERVICE_STATUS.PLANNED || st === SERVICE_STATUS.IN_PROGRESS;
  });

  const today = startOfDay(now);
  const nextDate = shiftToWorkday(addMonthsClamped(last.date, cfg.intervalMonths));
  const nextKm = last.km != null && last.km !== "" ? Number(last.km) + cfg.intervalKm : null;
  const curKm = vehicle.currentKm != null && vehicle.currentKm !== "" ? Number(vehicle.currentKm) : null;

  const daysLeft = Math.round((nextDate - today) / 86400000);
  const kmLeft = nextKm != null && curKm != null ? nextKm - curKm : null;

  const dateAlarm = daysLeft <= cfg.alarmDays;
  const kmAlarm = kmLeft != null && kmLeft <= cfg.alarmKm;

  const snoozedUntil = toDateObj(vehicle.serviceReminderSnoozedUntil);
  const snoozed = !!(snoozedUntil && snoozedUntil > now);

  return {
    vehicleId: vehicle.id,
    lastDate: last.date,
    lastKm: last.km != null && last.km !== "" ? Number(last.km) : null,
    kmSinceLast: last.km != null && curKm != null ? curKm - Number(last.km) : null,
    nextDate, nextKm, daysLeft, kmLeft,
    dateAlarm, kmAlarm,
    alarm: dateAlarm || kmAlarm,
    hasOpen, snoozed,
    customSettings: Object.keys(vehicleOverrides).length > 0,
    // manji broj = hitnije (za sortiranje); km se pretvara u "dane" grubo
    // da bi se oba kriterijuma poredila (1000 km ≈ 30 dana).
    urgency: Math.min(daysLeft, kmLeft != null ? kmLeft / 1000 * 30 : Infinity),
  };
}

function formatNum(n) {
  return Number(n).toLocaleString();
}

/** Tekst "za X dana / oko X meseci" ili "kasni X dana". */
export function timeLeftText(daysLeft) {
  if (daysLeft < 0)  return t("svc_rem_late_days", { n: Math.abs(daysLeft) });
  if (daysLeft === 0) return t("svc_rem_today");
  if (daysLeft <= 60) return t("svc_rem_in_days", { n: daysLeft });
  return t("svc_rem_in_months", { n: Math.round(daysLeft / 30) });
}

/** Tekst "za X km" ili "prekoračeno za X km". */
export function kmLeftText(kmLeft) {
  return kmLeft < 0
    ? t("svc_rem_km_over", { n: formatNum(Math.abs(kmLeft)) })
    : t("svc_rem_in_km", { n: formatNum(kmLeft) });
}

/** Obe komponente (vreme i km) u jednoj liniji. */
export function nextServiceSummary(info) {
  const parts = [timeLeftText(info.daysLeft)];
  if (info.kmLeft != null) parts.push(kmLeftText(info.kmLeft));
  return parts.join(" · ");
}
