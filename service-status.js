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
