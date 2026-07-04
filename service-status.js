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
};

export function effectiveServiceStatus(s) {
  if (s.status) return s.status;
  const d = s.serviceDate?.toDate ? s.serviceDate.toDate() : new Date(s.serviceDate);
  if (isNaN(d)) return SERVICE_STATUS.DONE;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return d.getTime() > today.getTime() ? SERVICE_STATUS.PLANNED : SERVICE_STATUS.DONE;
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
