// ============================================================
//  dashboard.js  —  Fleet Manager
//  Tab: Pregled / Dashboard
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, where, getDocs, orderBy,
  doc, addDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t, getCurrentLang, formatDateDMY, formatDateTimeDMY } from "./i18n.js";
import { todayDMY, datePlaceholder, attachDateMask, collectDates } from "./date-input.js";
import { S, setActiveCompany, navigateTo, showToast, openModal } from "./app.js";
import { getCompanies } from "./firebase.js";
import { isVehicleRegistered, needsTachograph, openVehicleDetail, openServiceForm, fuelLevelScaleHTML, bindFuelLevelScale, fuelLevelLabel } from "./vehicles.js";
import { mountPendingBanner } from "./pending-requests.js";
import { getServiceProviders } from "./servicers.js";
import {
  effectiveServiceStatus, isServiceToday, isServiceOverdue, overdueDays, SERVICE_STATUS,
  getServiceSettings, getRegularServiceInfo, timeLeftText, kmLeftText, getTireSeasonReminder
} from "./service-status.js";
import { openIncidentForm } from "./incidents.js";
import { tripEntryCard } from "./trips.js";
import { scanQRCode, parseFiscalQR, fetchReceiptDetails, receiptWorkerConfigured } from "./receipt-scan.js";
import { findReceiptDuplicate, saveTripEntry, DuplicateReceiptError, normalizeReceiptNo } from "./receipt-guard.js";

// ── STANJE MODULA: aktivno zaduženje trenutnog vozača ─────────
// Vozač može imati VIŠE aktivnih zaduženja istovremeno (npr. dva
// vozila u isto vreme) — assignmentsState čuva podatke za svako od
// njih. activeAssignment/activeVehicle/activeTrip/tripEntries su
// "trenutno selektovani" pokazivači — postave se na konkretno
// zaduženje neposredno pre bilo koje akcije (dugme, km potvrda...)
// preko selectAssignment(), tako da sav postojeći kod ispod (forme,
// čuvanje unosa, razduženje) ostaje nepromenjen i radi nad ispravnim
// zaduženjem.
let dashboardVehicles = []; // vozila sa poslednjeg učitavanja (za "Zakaži sada")
let assignmentsState = new Map(); // assignmentId -> { assignment, vehicle, trip, entries }
let activeAssignment = null;
let activeVehicle    = null;
let activeTrip        = null;
let tripEntries       = [];

function selectAssignment(assignmentId) {
  const st = assignmentsState.get(assignmentId);
  if (!st) return;
  activeAssignment = st.assignment;
  activeVehicle    = st.vehicle;
  activeTrip       = st.trip;
  tripEntries       = st.entries;
}

export async function renderDashboard(container) {
  const isMasterAdmin = S.profile?.role === "master_admin";

  // Master admin company switcher
  let companySwitcherHTML = "";
  if (isMasterAdmin) {
    try {
      S.companies = await getCompanies();
      companySwitcherHTML = `
        <div class="company-switcher">
          <label class="form-label" data-i18n="company_select">${t("company_select")}</label>
          <select id="company-select" class="form-select">
            <option value="" ${!S.companyId ? "selected" : ""}>${t("company_all")}</option>
            ${S.companies.map(c => `
              <option value="${c.id}" ${S.companyId === c.id ? "selected" : ""}>${c.name}</option>
            `).join("")}
          </select>
        </div>
      `;
    } catch (e) {
      console.error("Error loading companies:", e);
    }
  }

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title" data-i18n="tab_dashboard">${t("tab_dashboard")}</h2>
      ${companySwitcherHTML}
    </div>
    ${isMasterAdmin ? `<div id="pending-banner-section"></div>` : ""}
    <div id="dashboard-content">
      <div class="loading">${t("loading")}</div>
    </div>
  `;

  // Company switcher event
  if (isMasterAdmin) {
    document.getElementById("company-select")?.addEventListener("change", (e) => {
      setActiveCompany(e.target.value || null);
    });
    // Baner "Zahtevi za pristup" — nezavisan od izabrane firme,
    // pending zahtevi mogu biti za bilo koju firmu.
    mountPendingBanner(document.getElementById("pending-banner-section"), { compact: true });
  }

  if (!S.companyId) {
    if (isMasterAdmin && S.companies.length > 0) {
      document.getElementById("dashboard-content").innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">🏢</div>
          <p>${t("company_select")}</p>
        </div>
      `;
    } else {
      document.getElementById("dashboard-content").innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">⚠️</div>
          <p>${t("no_data")}</p>
        </div>
      `;
    }
    return;
  }

  await loadDashboardData();
}

async function loadDashboardData() {
  const cid = S.companyId;
  const role = S.profile?.role;
  const content = document.getElementById("dashboard-content");
  if (!content) return;

  try {
    // Dohvati vozila
    const vehiclesSnap = await getDocs(collection(db, "companies", cid, "vehicles"));
    const vehicles = vehiclesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Arhivirana vozila se ne računaju u statistiku aktivne flote —
    // imaju sopstvenu karticu i filter u tabu "Vozila".
    const activeVehicles = vehicles.filter(v => v.archived !== true);
    const archivedCount = vehicles.length - activeVehicles.length;

    // Statistika
    const total = activeVehicles.length;
    const active = activeVehicles.filter(v => v.status === "active").length;
    const inService = activeVehicles.filter(v => v.status === "service").length;
    const unregistered = activeVehicles.filter(v => isVehicleRegistered(v) === false).length;
    const broken = activeVehicles.filter(v => v.status === "broken").length;
    const inactive = activeVehicles.filter(v => v.status === "inactive").length;

    // Nadolazeće registracije i tahografi (u sledećih 30 dana) — spajamo oba
    // roka u istu listu/karticu, svaka stavka nosi oznaku o kom se roku radi.
    const today = new Date();
    const in30 = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
    const upcomingReg = [];
    activeVehicles.forEach(v => {
      if (v.regExpiry) {
        const d = v.regExpiry.toDate ? v.regExpiry.toDate() : new Date(v.regExpiry);
        if (d >= today && d <= in30) upcomingReg.push({ vehicle: v, date: d, kind: "reg" });
      }
      if (needsTachograph(v) && v.tachographExpiry) {
        const d = v.tachographExpiry.toDate ? v.tachographExpiry.toDate() : new Date(v.tachographExpiry);
        if (d >= today && d <= in30) upcomingReg.push({ vehicle: v, date: d, kind: "tachograph" });
      }
    });
    upcomingReg.sort((a, b) => a.date - b.date);

    // Danas — početak dana u lokalnom vremenu (ponoć)
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    // Aktivna zaduženja
    let assignmentsSnap;
    if (role === "driver") {
      assignmentsSnap = await getDocs(
        query(
          collection(db, "companies", cid, "assignments"),
          where("driverUid", "==", S.user.uid),
          where("status", "==", "active")
        )
      ).catch(() => ({ docs: [] }));
    } else {
      assignmentsSnap = await getDocs(
        query(
          collection(db, "companies", cid, "assignments"),
          where("status", "==", "active")
        )
      ).catch(() => ({ docs: [] }));
    }
    const assignedCount = assignmentsSnap?.docs?.length || 0;

    // Vozač: SVA njegova zaduženja (za istoriju) + SVI njegovi unosi
    // (gorivo/troškovi/prijave) — jedan upit za sve, grupiše se lokalno
    // po zaduženju umesto da se pita baza posebno za svaku vožnju.
    //
    // Zaduženja: driverUid je primarni ključ (uvek pouzdan — direktan Auth
    // UID), sa driverId fallback-om (isti obrazac kao u trips.js) za
    // slučaj da driverUid na starijim zapisima nije popunjen (npr. Google
    // login vozači kod kojih se driverUid ne postavlja automatski).
    //
    // tripEntries: ovde je driverUid UVEK pouzdano popunjen (postavlja se
    // direktno iz trenutno ulogovanog korisnika pri svakom unosu, ne
    // zavisi od profila), pa driverId fallback ovde uopšte nije potreban.
    let allAssignmentsSnap = { docs: [] };
    let allEntriesSnap     = { docs: [] };
    if (role === "driver") {
      allAssignmentsSnap = await getDocs(
        query(
          collection(db, "companies", cid, "assignments"),
          where("driverUid", "==", S.user.uid),
          orderBy("startDate", "desc")
        )
      ).catch(() => ({ docs: [] }));

      if (allAssignmentsSnap.docs.length === 0 && S.profile?.driverId) {
        allAssignmentsSnap = await getDocs(
          query(
            collection(db, "companies", cid, "assignments"),
            where("driverId", "==", S.profile.driverId),
            orderBy("startDate", "desc")
          )
        ).catch(() => ({ docs: [] }));
      }

      allEntriesSnap = await getDocs(
        query(
          collection(db, "companies", cid, "tripEntries"),
          where("driverUid", "==", S.user.uid),
          orderBy("createdAt", "asc")
        )
      ).catch(() => ({ docs: [] }));
    }

    // Zakazani servisi = unosi u "Servisna istorija" koji još nisu rešeni
    // (planned/in_progress). Dohvatamo u dva dela:
    //  1) propušteni (serviceDate < danas) — moraju da ostanu vidljivi dok
    //     ih neko ne potvrdi ili otkaže, bez obzira koliko kasne;
    //  2) nadolazeći u narednih 30 dana (uključujući danas).
    // Oba upita sortirana rastuće po datumu, pa spojena zadržavaju ispravan
    // redosled: najzakasneliji prvi, pa dalje ka budućnosti.
    const overdueServicesSnap = await getDocs(
      query(
        collection(db, "companies", cid, "services"),
        where("serviceDate", "<", todayStart),
        where("status", "in", [SERVICE_STATUS.PLANNED, SERVICE_STATUS.IN_PROGRESS]),
        orderBy("serviceDate", "asc")
      )
    ).catch(() => ({ docs: [] }));

    const servicesSnap = await getDocs(
      query(
        collection(db, "companies", cid, "services"),
        where("serviceDate", ">=", todayStart),
        where("serviceDate", "<=", in30),
        orderBy("serviceDate", "asc")
      )
    ).catch(() => ({ docs: [] }));

    // Adresa servisa za starije zapise (bez snimljene adrese) — iz kartice servisera
    let providerAddr = new Map();
    try {
      const provs = await getServiceProviders();
      providerAddr = new Map(provs.map(p => [p.id, p.address || ""]));
    } catch { /* adresa je dodatni podatak — dashboard radi i bez nje */ }

    const mapService = (d) => {
      const s = { id: d.id, ...d.data() };
      const veh = vehicles.find(v => v.id === s.vehicleId);
      return {
        ...s,
        vehicleBrand: veh?.brand || "",
        vehicleModel: veh?.model || "",
        workshopAddress: s.workshopAddress || (s.servicerId ? providerAddr.get(s.servicerId) : "") || "",
      };
    };

    const upcomingScheduled = [
      ...overdueServicesSnap.docs.map(mapService),
      ...servicesSnap.docs.map(mapService),
    ]
      // Servisi koji su u međuvremenu završeni ili otkazani ne treba
      // više da se prikazuju kao "nadolazeći"/"propušteni". Servisi vozila
      // koja su u međuvremenu arhivirana takođe se ne prikazuju — arhivirano
      // vozilo je van aktivne flote i ne zahteva dalju pažnju na dashboardu.
      .filter(s => {
        const st = effectiveServiceStatus(s);
        if (st === SERVICE_STATUS.DONE || st === SERVICE_STATUS.CANCELLED) return false;
        const veh = vehicles.find(v => v.id === s.vehicleId);
        return veh?.archived !== true;
      });

    // Podsetnici za redovni servis (samo administracija parka). Sledeći
    // servis se računa iz poslednjeg završenog redovnog servisa svakog vozila.
    dashboardVehicles = vehicles;
    let serviceReminders = [];
    if (role !== "driver") {
      try {
        const settings = await getServiceSettings(cid);
        const regSnap = await getDocs(
          query(collection(db, "companies", cid, "services"), where("serviceType", "==", "regular"))
        );
        const byVehicle = new Map();
        regSnap.docs.forEach(d => {
          const sv = { id: d.id, ...d.data() };
          if (!byVehicle.has(sv.vehicleId)) byVehicle.set(sv.vehicleId, []);
          byVehicle.get(sv.vehicleId).push(sv);
        });
        activeVehicles.forEach(v => {
          const info = getRegularServiceInfo(v, byVehicle.get(v.id) || [], settings);
          if (info && info.alarm && !info.hasOpen && !info.snoozed) {
            serviceReminders.push({ ...info, vehicle: v });
          }
        });
        // Najhitniji (najviše prekoračen / najbliži rok) prvi
        serviceReminders.sort((a, b) => a.urgency - b.urgency);
      } catch (e) {
        console.error("Service reminders error:", e);
      }
    }

    // Podsetnici za zamenu sezonskih guma (samo administracija parka),
    // mesec dana pre zakonskog roka — vidi getTireSeasonReminder().
    // Podsetnik se ne prikazuje ako je zamena već zakazana / u toku,
    // ako je u tekućem periodu već odrađen servis tipa "Gume", ili
    // ako ga je admin odložio ("Podseti me kasnije").
    const tireReminders = [];
    if (role !== "driver") {
      const toD = (x) => x?.toDate ? x.toDate() : (x ? new Date(x) : null);
      const tireSvcByVehicle = new Map();
      try {
        const tireSnap = await getDocs(
          query(collection(db, "companies", cid, "services"), where("serviceType", "==", "tires"))
        );
        tireSnap.docs.forEach(d => {
          const sv = { id: d.id, ...d.data() };
          if (!tireSvcByVehicle.has(sv.vehicleId)) tireSvcByVehicle.set(sv.vehicleId, []);
          tireSvcByVehicle.get(sv.vehicleId).push(sv);
        });
      } catch (e) {
        console.error("Tire services error:", e);
      }
      activeVehicles.forEach(v => {
        const r = computeTireReminder(v, tireSvcByVehicle.get(v.id) || []);
        if (r) tireReminders.push(r);
      });
      // Najhitnije (najviše zakasnelo / najbliži rok) prvo
      tireReminders.sort((a, b) => a.daysLeft - b.daysLeft);
    }

    const isDriver = role === "driver";

    // Vozač: pronađi/otvori aktivnu vožnju za SVAKO aktivno zaduženje
    // (vozač može imati više vozila zaduženih istovremeno — svako od
    // njih mora dobiti svoju aktivnu vožnju, ne samo prvo u nizu).
    let resolvedActiveTrips = new Map(); // assignmentId -> trip
    if (isDriver) {
      const candidates = assignmentsSnap?.docs?.map(d => ({ id: d.id, ...d.data() })) || [];
      for (const candidate of candidates) {
        resolvedActiveTrips.set(candidate.id, await loadActiveTrip(candidate));
      }
    }

    // Vozač: obaveštenja za svako vozilo koje mu je na zaduženju (isto što vidi admin)
    const vehicleNotices = new Map(); // vehicleId -> obaveštenja
    if (isDriver) {
      try {
        const settings = await getServiceSettings(cid);
        const assignedIds = [...new Set((assignmentsSnap?.docs || []).map(d => d.data().vehicleId).filter(Boolean))];
        for (const vid of assignedIds) {
          const veh = vehicles.find(x => x.id === vid);
          if (!veh) continue;
          let vehSvcs = [];
          try {
            const snap = await getDocs(query(collection(db, "companies", cid, "services"), where("vehicleId", "==", vid)));
            vehSvcs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          } catch (e) { console.error("Driver vehicle services error:", e); }
          vehicleNotices.set(vid, buildVehicleNotices(veh, vehSvcs, settings, providerAddr));
        }
      } catch (e) {
        console.error("Driver vehicle notices error:", e);
      }
    }

    content.innerHTML = `
      ${isDriver ? renderDriverDashboard(assignmentsSnap, allAssignmentsSnap, allEntriesSnap, vehicles, resolvedActiveTrips, vehicleNotices) : renderAdminDashboard({
        total, active, inService, unregistered, broken, inactive, upcomingReg, vehicles, assignedCount, upcomingScheduled, archivedCount, serviceReminders, tireReminders
      })}
    `;

    // Event listeneri (kartice admina, klikabilne stat-kartice vozača,
    // i akcije na aktivnoj vožnji — potvrda km, dodavanje unosa, razduženje)
    attachDashboardEvents();
    if (isDriver) attachDriverActiveAssignmentEvents();

  } catch (e) {
    console.error("Dashboard load error:", e);
    content.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

// ── POMOĆNE FUNKCIJE ZA OBAVEŠTENJA O VOZILU ───────────────────
// Podsetnik za sezonske gume jednog vozila (isti uslovi za admina i vozača):
// null ako nije potreban, isključen je, odložen ili je zamena već zakazana/odrađena.
function computeTireReminder(v, tireServices, now = new Date()) {
  const toD = (x) => x?.toDate ? x.toDate() : (x ? new Date(x) : null);
  const r = getTireSeasonReminder(v, now);
  if (!r) return null;
  if (v.tireReminderDisabled === true) return null; // trajno isključeno (npr. vozilo koristi samo jednu sezonu)
  const snoozedUntil = toD(v.tireReminderSnoozedUntil);
  if (snoozedUntil && snoozedUntil > now) return null;
  // početak perioda podsetnika = mesec dana pre roka
  const windowStart = new Date(r.deadline.getFullYear(), r.deadline.getMonth() - 1, 1);
  const handled = (tireServices || []).some(sv => {
    const st = effectiveServiceStatus(sv);
    if (st === SERVICE_STATUS.PLANNED || st === SERVICE_STATUS.IN_PROGRESS) return true;
    if (st === SERVICE_STATUS.DONE) { const d = toD(sv.serviceDate); return d && d >= windowStart; }
    return false;
  });
  if (handled) return null;
  return { ...r, vehicle: v };
}

function noticeEsc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Sve što admin vidi za jedno vozilo, spakovano za vozača:
// istek registracije/tahografa, status vozila, zakazani servisi,
// podsetnik za redovni servis i za sezonske gume.
function buildVehicleNotices(v, services, settings, providerAddr = new Map()) {
  const toD = (x) => x?.toDate ? x.toDate() : (x ? new Date(x) : null);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const in30 = new Date(today.getTime() + 30 * 86400000);
  const dayMs = 86400000;

  // Registracija / tahograf — rok u narednih 30 dana ili već istekao
  const deadlines = [];
  const addDeadline = (kind, raw) => {
    const d = toD(raw);
    if (!d || isNaN(d)) return;
    const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (dd > in30) return;
    deadlines.push({ kind, date: dd, daysLeft: Math.round((dd - today) / dayMs) });
  };
  addDeadline("reg", v.regExpiry);
  if (needsTachograph(v)) addDeadline("tachograph", v.tachographExpiry);

  // Zakazani / aktivni servisi: propušteni + narednih 30 dana
  const scheduled = (services || [])
    .filter(sv => {
      const st = effectiveServiceStatus(sv);
      if (st === SERVICE_STATUS.DONE || st === SERVICE_STATUS.CANCELLED) return false;
      const d = toD(sv.serviceDate);
      return d && !isNaN(d) && d <= in30;
    })
    .map(sv => ({
      ...sv,
      workshopAddress: sv.workshopAddress || (sv.servicerId ? providerAddr.get(sv.servicerId) : "") || "",
    }))
    .sort((a, b) => (toD(a.serviceDate) - toD(b.serviceDate)) || String(a.serviceTime || "").localeCompare(String(b.serviceTime || "")));

  // Redovni servis (po vremenu/km) — isti uslovi kao kod admina
  let regular = null;
  try {
    const info = getRegularServiceInfo(v, services || [], settings);
    if (info && info.alarm && !info.hasOpen && !info.snoozed) regular = info;
  } catch (e) { console.error("Driver regular service info error:", e); }

  const tire = computeTireReminder(v, (services || []).filter(sv => sv.serviceType === "tires"));

  const badStatus = (v.status === "broken" || v.status === "service") ? v.status : null;
  return { vehicle: v, deadlines, scheduled, regular, tire, badStatus };
}

function renderVehicleNotices(n, a = null) {
  if (!n) return "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const toD = (x) => x?.toDate ? x.toDate() : (x ? new Date(x) : null);
  const items = [];

  n.deadlines.forEach(d => {
    const expired = d.daysLeft < 0;
    const urgency = expired || d.daysLeft <= 7 ? "urgent" : d.daysLeft <= 14 ? "warning" : "ok";
    const kindLabel = d.kind === "tachograph" ? t("dashboard_kind_tachograph") : t("dashboard_kind_reg");
    items.push(`
      <div class="upcoming-item upcoming-item--${urgency}">
        <div class="upcoming-item__main">
          <span class="upcoming-item__name">${expired ? "⛔" : "📄"} ${noticeEsc(kindLabel)}</span>
        </div>
        <div class="upcoming-item__right">
          <span class="upcoming-item__date">${formatDate(d.date)}</span>
          <span class="upcoming-item__days">${expired
            ? t("driver_notice_expired_days", { n: Math.abs(d.daysLeft) })
            : d.daysLeft + " " + t("dashboard_days_left")}</span>
        </div>
      </div>`);
  });

  if (n.badStatus) {
    items.push(`
      <div class="upcoming-item upcoming-item--${n.badStatus === "broken" ? "urgent" : "warning"}">
        <div class="upcoming-item__main">
          <span class="upcoming-item__name">🚧 ${t("driver_notice_vehicle_status")}</span>
        </div>
        <div class="upcoming-item__right">
          <span class="upcoming-item__days">${t("vehicle_status_" + n.badStatus)}</span>
        </div>
      </div>`);
  }

  n.scheduled.forEach(s => {
    const d = toD(s.serviceDate);
    const daysLeft = Math.ceil((d - today) / 86400000);
    const status = effectiveServiceStatus(s);
    const overdue = isServiceOverdue(s);
    const todayFlag = isServiceToday(s);
    const urgency = overdue ? "urgent" : todayFlag ? "today" : daysLeft <= 2 ? "urgent" : daysLeft <= 7 ? "warning" : "ok";
    const badges = [
      todayFlag ? `<span class="today-badge">${t("dashboard_today")}</span>` : "",
      overdue ? `<span class="today-badge" style="background:var(--color-danger)">⚠️ ${t("service_status_overdue")} — ${t("service_overdue_days", { n: overdueDays(s) })}</span>` : "",
      status === SERVICE_STATUS.IN_PROGRESS ? `<span class="today-badge" style="background:var(--color-warning)">${t("service_status_in_progress")}</span>` : "",
    ].join("");
    items.push(`
      <div class="upcoming-item upcoming-item--${urgency}">
        <div class="upcoming-item__main">
          <span class="upcoming-item__name">🔧 ${noticeEsc(t("service_type_" + s.serviceType) || s.serviceType || "")}</span>
          ${s.workshop || s.workshopAddress ? `
            <div class="upcoming-item__place">
              ${s.workshop ? `<span class="upcoming-item__plate">🏭 ${noticeEsc(s.workshop)}</span>` : ""}
              ${s.workshopAddress ? `<span class="upcoming-item__addr">📍 ${noticeEsc(s.workshopAddress)}</span>` : ""}
            </div>` : ""}
          ${s.description ? `<span class="upcoming-item__addr">${noticeEsc(s.description)}</span>` : ""}
        </div>
        <div class="upcoming-item__right">
          <span class="upcoming-item__date">
            <span class="upcoming-item__time${s.serviceTime ? "" : " upcoming-item__time--missing"}" ${s.serviceTime ? "" : `title="${t("service_time_missing")}"`}>🕒 ${noticeEsc(s.serviceTime || "—:—")}</span>
            ${formatDate(d)}
            ${badges}
          </span>
          <span class="upcoming-item__days">${daysLeft <= 0 ? "" : daysLeft + " " + t("dashboard_days_left")}</span>
        </div>
      </div>`);
  });

  if (n.regular) {
    const r = n.regular;
    const late = r.daysLeft < 0 || (r.kmLeft != null && r.kmLeft < 0);
    const reasons = [];
    if (r.dateAlarm) reasons.push(`📅 ${timeLeftText(r.daysLeft)}`);
    if (r.kmAlarm)   reasons.push(`🛣️ ${kmLeftText(r.kmLeft)}`);
    const dueKm = r.nextKm != null ? ` / ${r.nextKm.toLocaleString()} km` : "";
    items.push(`
      <div class="upcoming-item upcoming-item--${late ? "urgent" : "warning"} service-reminder">
        <div class="service-reminder__body">
          <div class="upcoming-item__main">
            <span class="upcoming-item__name">⚠️ ${t("svc_rem_title")}</span>
          </div>
          <div class="service-reminder__info">
            ${t("svc_rem_next_due", { date: formatDate(r.nextDate), km: dueKm })}<br>
            <strong>${reasons.join(" · ")}</strong>
          </div>
        </div>
      </div>`);
  }

  if (n.tire) {
    const r = n.tire;
    const urgent = r.overdue || r.daysLeft <= 7;
    const curType = n.vehicle.tires?.type ? t("tire_" + n.vehicle.tires.type) : "";
    const dims = n.vehicle.tires?.dimensions ? ` (${n.vehicle.tires.dimensions})` : "";
    items.push(`
      <div class="upcoming-item upcoming-item--${urgent ? "urgent" : "warning"} service-reminder tire-reminder">
        <div class="service-reminder__body">
          <div class="upcoming-item__main">
            <span class="upcoming-item__name">🛞 ${t("tire_rem_title_" + r.needed)}</span>
          </div>
          <div class="service-reminder__info">
            ${t("tire_rem_current", { type: curType, dims })}<br>
            ${t("tire_rem_deadline", { date: formatDate(r.deadline) })}<br>
            <strong>📅 ${timeLeftText(r.daysLeft)}</strong>
          </div>
        </div>
      </div>`);
  }

  return `
    <div class="dashboard-panel driver-notices">
      <h3 class="panel-title">🔔 ${t("driver_notices_title")}${a ? ` — ${noticeEsc(a.vehicleBrand || "")} ${noticeEsc(a.vehicleModel || "")} <span class="upcoming-item__plate">${noticeEsc(a.vehiclePlate || "")}</span>` : ""}</h3>
      ${items.length ? items.join("") : `<p class="empty-text">✅ ${t("driver_notices_none")}</p>`}
    </div>`;
}

function renderAdminDashboard({ total, active, inService, unregistered, broken, inactive, upcomingReg, vehicles, assignedCount, upcomingScheduled, archivedCount, serviceReminders = [], tireReminders = [] }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0); // lokalna ponoć

  return `
    <div class="stats-grid">
      <div class="stat-card stat-card--total" data-nav="vehicles">
        <div class="stat-card__value">${total}</div>
        <div class="stat-card__label" data-i18n="dashboard_total_vehicles">${t("dashboard_total_vehicles")}</div>
      </div>
      <div class="stat-card stat-card--active" data-nav="vehicles" data-filter="active">
        <div class="stat-card__value">${active}</div>
        <div class="stat-card__label" data-i18n="dashboard_active">${t("dashboard_active")}</div>
      </div>
      <div class="stat-card stat-card--service" data-nav="vehicles" data-filter="service">
        <div class="stat-card__value">${inService}</div>
        <div class="stat-card__label" data-i18n="dashboard_in_service">${t("dashboard_in_service")}</div>
      </div>
      <div class="stat-card stat-card--unreg" data-nav="vehicles" data-filter="unregistered">
        <div class="stat-card__value">${unregistered}</div>
        <div class="stat-card__label" data-i18n="dashboard_unregistered">${t("dashboard_unregistered")}</div>
      </div>
      ${broken > 0 ? `
      <div class="stat-card stat-card--broken" data-nav="vehicles" data-filter="broken">
        <div class="stat-card__value">${broken}</div>
        <div class="stat-card__label">${t("vehicle_status_broken")}</div>
      </div>
      ` : ""}
      ${inactive > 0 ? `
      <div class="stat-card stat-card--inactive" data-nav="vehicles" data-filter="inactive">
        <div class="stat-card__value">${inactive}</div>
        <div class="stat-card__label">${t("vehicle_status_inactive")}</div>
      </div>
      ` : ""}
      ${archivedCount > 0 ? `
      <div class="stat-card stat-card--archived" data-nav="vehicles" data-filter="archived">
        <div class="stat-card__value">${archivedCount}</div>
        <div class="stat-card__label">${t("dashboard_archived")}</div>
      </div>
      ` : ""}
      <div class="stat-card stat-card--assigned" data-nav="assignments">
        <div class="stat-card__value">${assignedCount}</div>
        <div class="stat-card__label" data-i18n="dashboard_assigned">${t("dashboard_assigned")}</div>
      </div>
    </div>

    <div class="dashboard-grid">
      <div class="dashboard-panel">
        <h3 class="panel-title" data-i18n="dashboard_upcoming_reg">${t("dashboard_upcoming_reg")}</h3>
        ${upcomingReg.length === 0
          ? `<p class="empty-text" data-i18n="dashboard_no_upcoming">${t("dashboard_no_upcoming")}</p>`
          : upcomingReg.map(item => {
              const v = item.vehicle;
              const d = item.date;
              const daysLeft = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
              const urgency = daysLeft <= 7 ? "urgent" : daysLeft <= 14 ? "warning" : "ok";
              const kindLabel = item.kind === "tachograph" ? t("dashboard_kind_tachograph") : t("dashboard_kind_reg");
              return `
                <div class="upcoming-item upcoming-item--${urgency}">
                  <div class="upcoming-item__main">
                    <span class="upcoming-item__name">${v.brand} ${v.model}</span>
                    <span class="upcoming-item__plate">${v.plate}</span>
                    <span class="upcoming-item__kind">${kindLabel}</span>
                  </div>
                  <div class="upcoming-item__right">
                    <span class="upcoming-item__date">${formatDate(d)}</span>
                    <span class="upcoming-item__days">${daysLeft} ${t("dashboard_days_left")}</span>
                  </div>
                </div>
              `;
            }).join("")
        }
      </div>

      <div class="dashboard-panel">
        <h3 class="panel-title" data-i18n="schedule_panel_title">📅 ${t("schedule_panel_title")}</h3>
        ${serviceReminders.map(r => {
          const v = r.vehicle;
          const late = r.daysLeft < 0 || (r.kmLeft != null && r.kmLeft < 0);
          const reasons = [];
          if (r.dateAlarm) reasons.push(`📅 ${timeLeftText(r.daysLeft)}`);
          if (r.kmAlarm)   reasons.push(`🛣️ ${kmLeftText(r.kmLeft)}`);
          const lastKm = r.kmSinceLast != null && r.kmSinceLast >= 0
            ? ` (${t("svc_rem_last_km", { n: r.kmSinceLast.toLocaleString() })})` : "";
          const dueKm = r.nextKm != null ? ` / ${r.nextKm.toLocaleString()} km` : "";
          return `
            <div class="upcoming-item upcoming-item--${late ? "urgent" : "warning"} service-reminder" data-reminder-vehicle="${v.id}">
              <div class="service-reminder__body">
                <div class="upcoming-item__main">
                  <span class="upcoming-item__name">⚠️ ${v.brand || ""} ${v.model || ""}</span>
                  <span class="upcoming-item__plate">${v.plate || ""}</span>
                  <span class="upcoming-item__kind">${t("svc_rem_title")}</span>
                  ${r.customSettings ? `<span class="service-reminder__custom" title="${t("svc_custom_badge")}">⚙️ ${t("svc_custom_badge_short")}</span>` : ""}
                </div>
                <div class="service-reminder__info">
                  ${t("svc_rem_last", { date: formatDate(r.lastDate) })}${lastKm}<br>
                  ${t("svc_rem_next_due", { date: formatDate(r.nextDate), km: dueKm })}<br>
                  <strong>${reasons.join(" · ")}</strong>
                </div>
                <div class="service-reminder__question">${t("svc_rem_question")}</div>
                <div class="service-reminder__actions">
                  <button class="btn btn--primary btn--sm btn-reminder-schedule" data-vehicle="${v.id}">${t("svc_rem_schedule_now")}</button>
                  <button class="btn btn--secondary btn--sm btn-reminder-snooze" data-vehicle="${v.id}">${t("svc_rem_snooze")}</button>
                </div>
              </div>
            </div>`;
        }).join("")}
        ${tireReminders.map(r => {
          const v = r.vehicle;
          const urgent = r.overdue || r.daysLeft <= 7;
          const curType = v.tires?.type ? t("tire_" + v.tires.type) : "";
          const dims = v.tires?.dimensions ? ` (${v.tires.dimensions})` : "";
          return `
            <div class="upcoming-item upcoming-item--${urgent ? "urgent" : "warning"} service-reminder tire-reminder" data-tire-vehicle="${v.id}">
              <div class="service-reminder__body">
                <div class="upcoming-item__main">
                  <span class="upcoming-item__name">🛞 ${v.brand || ""} ${v.model || ""}</span>
                  <span class="upcoming-item__plate">${v.plate || ""}</span>
                  <span class="upcoming-item__kind">${t("tire_rem_title_" + r.needed)}</span>
                </div>
                <div class="service-reminder__info">
                  ${t("tire_rem_current", { type: curType, dims })}<br>
                  ${t("tire_rem_deadline", { date: formatDate(r.deadline) })}<br>
                  <strong>📅 ${timeLeftText(r.daysLeft)}</strong>
                </div>
                <div class="service-reminder__question">${t("svc_rem_question")}</div>
                <div class="service-reminder__actions">
                  <button class="btn btn--primary btn--sm btn-tire-schedule" data-vehicle="${v.id}">${t("svc_rem_schedule_now")}</button>
                  <button class="btn btn--secondary btn--sm btn-tire-snooze" data-vehicle="${v.id}">${t("svc_rem_snooze")}</button>
                </div>
              </div>
            </div>`;
        }).join("")}
        ${(!upcomingScheduled || upcomingScheduled.length === 0) && (serviceReminders.length > 0 || tireReminders.length > 0) ? "" : !upcomingScheduled || upcomingScheduled.length === 0
          ? `<p class="empty-text">${t("schedule_no_data")}</p>`
          : upcomingScheduled.map(s => {
              const d = s.serviceDate?.toDate ? s.serviceDate.toDate() : new Date(s.serviceDate);
              const daysLeft = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
              const today_ = isServiceToday(s);
              const overdue = isServiceOverdue(s);
              const urgency = overdue ? "urgent" : today_ ? "today" : daysLeft <= 2 ? "urgent" : daysLeft <= 7 ? "warning" : "ok";
              const dateStr = formatDate(d);
              const status = effectiveServiceStatus(s);
              const inProgressBadge = status === SERVICE_STATUS.IN_PROGRESS
                ? `<span class="today-badge" style="background:var(--color-warning)">${t("service_status_in_progress")}</span>` : "";
              const overdueBadge = overdue
                ? `<span class="today-badge" style="background:var(--color-danger)">⚠️ ${t("service_status_overdue")} — ${t("service_overdue_days", { n: overdueDays(s) })}</span>`
                : "";
              return `
                <div class="upcoming-item upcoming-item--${urgency}" data-vehicle-id="${s.vehicleId}" style="cursor:pointer">
                  <div class="upcoming-item__main">
                    <span class="upcoming-item__name">${s.vehicleBrand} ${s.vehicleModel}</span>
                    <span class="upcoming-item__plate">${s.vehiclePlate}</span>
                    ${s.workshop || s.workshopAddress ? `
                      <div class="upcoming-item__place">
                        ${s.workshop ? `<span class="upcoming-item__plate">🔧 ${s.workshop}</span>` : ""}
                        ${s.workshopAddress ? `<span class="upcoming-item__addr">📍 ${s.workshopAddress}</span>` : ""}
                      </div>` : ""}
                  </div>
                  <div class="upcoming-item__right">
                    <span class="upcoming-item__date">
                      <span class="upcoming-item__time${s.serviceTime ? "" : " upcoming-item__time--missing"}" ${s.serviceTime ? "" : `title="${t("service_time_missing")}"`}>🕒 ${s.serviceTime || "—:—"}</span>
                      ${dateStr}
                      ${today_ ? `<span class="today-badge">${t("dashboard_today")}</span>` : ""}
                      ${overdueBadge}
                      ${inProgressBadge}
                    </span>
                    <span class="upcoming-item__days">${daysLeft <= 0 ? "" : daysLeft + " " + t("dashboard_days_left")}</span>
                  </div>
                </div>
              `;
            }).join("")
        }
      </div>
    </div>
  `;
}

// ── AKTIVNA VOŽNJA UNUTAR ZADUŽENJA ────────────────────────────
// Pronalazi trenutno aktivnu vožnju za dato zaduženje. Ako je nema
// (npr. zaduženje kreirano pre uvođenja koncepta "vožnji"), otvara je
// na licu mesta na osnovu podataka sa samog zaduženja, da bi sve
// dalje (unosi, zatvaranje) imalo na šta da se veže.
async function loadActiveTrip(assignment) {
  if (!assignment) return null;
  try {
    const snap = await getDocs(query(
      collection(db, "companies", S.companyId, "trips"),
      where("assignmentId", "==", assignment.id),
      where("status", "==", "active")
    ));
    if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };

    const tripData = {
      assignmentId: assignment.id,
      vehicleId:    assignment.vehicleId,
      vehicleBrand: assignment.vehicleBrand,
      vehicleModel: assignment.vehicleModel,
      vehiclePlate: assignment.vehiclePlate,
      vehicleVin:   assignment.vehicleVin || null,
      driverId:     assignment.driverId,
      driverName:   assignment.driverName,
      driverUid:    assignment.driverUid || S.user.uid,
      startDate:    assignment.startDate,
      endDate:      null,
      startKm:      assignment.startKm ?? null,
      endKm:        null,
      tripType:     assignment.tripType || "local",
      destination:  assignment.destination || null,
      route:        assignment.route || null,
      reason:       assignment.reason || null,
      status:       "active",
      notes:        null,
      createdAt:    serverTimestamp(),
      createdBy:    S.user.uid,
    };
    const ref = await addDoc(collection(db, "companies", S.companyId, "trips"), tripData);
    return { id: ref.id, ...tripData };
  } catch (e) {
    console.error("loadActiveTrip error:", e);
    return null;
  }
}

function renderDriverDashboard(assignmentsSnap, allAssignmentsSnap, allEntriesSnap, vehicles, resolvedActiveTrips, vehicleNotices = new Map()) {
  const activeAssignments = assignmentsSnap?.docs?.map(d => ({ id: d.id, ...d.data() })) || [];
  const allEntries        = allEntriesSnap?.docs?.map(d => ({ id: d.id, ...d.data() })) || [];

  assignmentsState = new Map();

  if (activeAssignments.length === 0) {
    activeAssignment = null;
    activeVehicle    = null;
    activeTrip       = null;
    tripEntries       = [];
    return `
      <div class="empty-state">
        <div class="empty-state__icon">🚗</div>
        <h3>${t("trip_no_assignment")}</h3>
        <p>${t("trip_no_assignment_sub")}</p>
      </div>
    `;
  }

  // Vozač može imati VIŠE aktivnih zaduženja istovremeno (npr. dva
  // zadužena vozila) — svako dobija svoju karticu vozila, km potvrdu,
  // akcije i listu unosa. Podaci za svako zaduženje čuvaju se u
  // assignmentsState, a klik na dugme unutar konkretne kartice (vidi
  // attachDriverActiveAssignmentEvents) selektuje to zaduženje pre
  // pokretanja akcije.
  const blocksHTML = activeAssignments.map(a => {
    const vehicle = vehicles?.find(v => v.id === a.vehicleId) || null;
    const trip    = resolvedActiveTrips?.get(a.id) || null;

    // Unosi tokom TRENUTNE vožnje (po tripId). Stariji unosi bez tripId
    // (nastali pre uvođenja vožnji) i dalje se prikazuju uz trenutnu
    // vožnju, da se ne bi "izgubili" iz prikaza.
    const entries = trip
      ? allEntries.filter(e => e.assignmentId === a.id && (e.tripId === trip.id || !e.tripId))
      : allEntries.filter(e => e.assignmentId === a.id);

    assignmentsState.set(a.id, { assignment: a, vehicle, trip, entries });

    return `
      <div class="trip-assignment-block" data-assignment-id="${a.id}">
        ${renderActiveAssignmentBlock(a, trip, entries, vehicle)}
      </div>
    `;
  }).join("");

  // Podrazumevano selektovano zaduženje — koristi se samo ako neka akcija
  // krene pre bilo kog klika na konkretnu karticu; svaki klik na dugme
  // unutar kartice ionako re-selektuje ispravno zaduženje.
  selectAssignment(activeAssignments[0].id);

  // Obaveštenja (istek registracije, servisi, gume...) idu na sam VRH
  // dashboarda, iznad kartica zaduženja — po jedan blok za svako zaduženo vozilo.
  const seenVehicles = new Set();
  const noticesTop = activeAssignments.map(a => {
    if (!a.vehicleId || seenVehicles.has(a.vehicleId)) return "";
    seenVehicles.add(a.vehicleId);
    return renderVehicleNotices(vehicleNotices.get(a.vehicleId), a);
  }).join("");

  return noticesTop + blocksHTML;
}

// ── AKTIVNO ZADUŽENJE: kartica vozila, km potvrda, statistike,
//    akcije i lista unosa tokom vožnje ──────────────────────────
function renderActiveAssignmentBlock(a, trip, entries, v) {
  const totalFuel     = entries.filter(e => e.type === "fuel").reduce((s, e) => s + (e.fuelAmount || 0), 0);
  const totalFuelCost = entries.filter(e => e.type === "fuel").reduce((s, e) => s + (e.fuelCost || 0), 0);
  const totalTolls    = entries.filter(e => e.type === "toll").reduce((s, e) => s + (e.amount || 0), 0);
  const totalOther    = entries.filter(e => e.type === "other_cost").reduce((s, e) => s + (e.amount || 0), 0);
  const incidents     = entries.filter(e => ["fault", "damage", "accident"].includes(e.type));

  const tripType     = trip?.tripType ?? a.tripType;
  const destination  = trip?.destination ?? a.destination;
  const reason       = trip?.reason ?? a.reason;
  const startKm      = trip?.startKm ?? a.startKm;

  return `
    <!-- HEADER VOZILA -->
    <div class="trip-vehicle-card">
      <div class="trip-vehicle-card__header">
        <div class="trip-vehicle-card__title">
          <span class="trip-vehicle-card__icon">🚗</span>
          <div>
            <div class="trip-vehicle-card__name">${a.vehicleBrand} ${a.vehicleModel}</div>
            <div class="trip-vehicle-card__plate">${a.vehiclePlate}</div>
          </div>
        </div>
        <span class="badge badge--active">${t("trip_active_badge")}</span>
      </div>
      <div class="trip-vehicle-card__details">
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">${t("trip_assigned_label")}</span>
          <span>${formatDate(a.startDate)}</span>
        </div>
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">${t("trip_current_trip_since_label")}</span>
          <span>${trip ? formatDate(trip.startDate) : "—"}</span>
        </div>
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">${t("trip_start_km_label")}</span>
          <span><strong>${startKm?.toLocaleString() || "—"} km</strong></span>
        </div>
        ${tripType === "intercity" ? `
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">${t("trip_destination_label")}</span>
          <span>📍 ${destination || "—"}</span>
        </div>
        ` : ""}
        ${reason ? `
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">${t("trip_reason_label")}</span>
          <span>${reason}</span>
        </div>
        ` : ""}
      </div>

      <!-- KM POTVRDA -->
      <div class="km-confirm-box" id="km-confirm-box-${a.id}" data-assignment-id="${a.id}">
        ${kmConfirmBoxContent(a, v)}
      </div>
    </div>

    <!-- STATISTIKE (za TRENUTNU vožnju) -->
    <div class="trip-stats" data-assignment-id="${a.id}">
      <div class="trip-stat-box">
        <div class="trip-stat-box__value">${totalFuel.toFixed(1)} L</div>
        <div class="trip-stat-box__label">${t("trip_stats_fuel")}</div>
      </div>
      <div class="trip-stat-box">
        <div class="trip-stat-box__value">${(totalFuelCost + totalTolls + totalOther).toLocaleString()} RSD</div>
        <div class="trip-stat-box__label">${t("trip_stats_cost")}</div>
      </div>
      <div class="trip-stat-box ${incidents.length > 0 ? "trip-stat-box--warn" : ""}">
        <div class="trip-stat-box__value">${incidents.length}</div>
        <div class="trip-stat-box__label">${t("trip_stats_incidents")}</div>
      </div>
      <div class="trip-stat-box">
        <div class="trip-stat-box__value">${entries.length}</div>
        <div class="trip-stat-box__label">${t("trip_stats_entries")}</div>
      </div>
    </div>

    <!-- AKCIJE -->
    <div class="trip-actions">
      <button class="btn btn--primary" data-action="add-fuel" data-assignment-id="${a.id}">⛽ ${t("trip_fuel_btn")}</button>
      <button class="btn btn--secondary" data-action="add-toll" data-assignment-id="${a.id}">🛣️ ${t("trip_cost_btn")}</button>
      <button class="btn btn--warning" data-action="add-incident" data-assignment-id="${a.id}">⚠️ ${t("trip_incident_btn")}</button>
      <button class="btn btn--secondary" data-action="close-trip" data-assignment-id="${a.id}">🔁 ${t("trip_close_trip_btn")}</button>
      <button class="btn btn--danger" data-action="close-assignment" data-assignment-id="${a.id}">🔓 ${t("trip_close_assignment_btn")}</button>
    </div>

    <!-- LISTA UNOSA (tokom trenutne vožnje) -->
    <div class="trip-entries-header">
      <h3>${t("trip_entries_header")}</h3>
    </div>
    <div id="trip-entries-list-${a.id}">
      ${entries.length === 0
        ? `<div class="empty-state"><div class="empty-state__icon">📋</div><p>${t("trip_no_entries")}</p></div>`
        : entries.map(e => tripEntryCard(e, { clickable: true })).join("")
      }
    </div>
  `;
}

// Bind-uje akcije SVAKOG aktivnog zaduženja (km potvrda, dugmad za unos,
// zatvaranje vožnje/zaduženja) — poziva se posle upisa u DOM. Svaki blok
// zaduženja (data-assignment-id) dobija svoje listenere; klik unutar bloka
// prvo selektuje to zaduženje (selectAssignment) pre pokretanja akcije, da
// bi forme i čuvanje radili nad ispravnim vozilom/vožnjom.
function attachDriverActiveAssignmentEvents() {
  if (assignmentsState.size === 0) return;

  document.querySelectorAll(".trip-assignment-block[data-assignment-id]").forEach(block => {
    const aid = block.dataset.assignmentId;
    bindKmConfirm(aid);

    block.querySelector('[data-action="add-fuel"]')
      ?.addEventListener("click", () => { selectAssignment(aid); openFuelForm(); });
    block.querySelector('[data-action="add-toll"]')
      ?.addEventListener("click", () => { selectAssignment(aid); openCostForm(); });
    block.querySelector('[data-action="add-incident"]')
      ?.addEventListener("click", () => { selectAssignment(aid); openIncidentForm(null, refreshEntries, aid); });
    block.querySelector('[data-action="close-trip"]')
      ?.addEventListener("click", () => { selectAssignment(aid); openCloseTripForm(); });
    block.querySelector('[data-action="close-assignment"]')
      ?.addEventListener("click", () => { selectAssignment(aid); openDriverUnassignForm(); });
  });
}

// ── KM POTVRDA — sadržaj boksa (potvrđeno vs. forma) ───────────
function kmConfirmBoxContent(a, v) {
  const suffix = a.id;
  const systemKm = v?.currentKm ?? a.startKm;

  if (a.kmConfirmed) {
    const val = a.kmConfirmedValue ?? systemKm;
    const fuelVal = a.fuelLevelConfirmedValue ?? v?.fuelLevel;
    return `
      <div class="km-confirmed">
        ✅ ${t("trip_km_confirmed")}: <strong>${val?.toLocaleString()} km</strong>
        ${a.kmMismatch ? `<span class="km-mismatch-note">${t("trip_km_mismatch_reported")}</span>` : ""}
      </div>
      ${fuelVal ? `<div class="km-confirmed">⛽ ${t("vehicle_fuel_level")}: <strong>${fuelLevelLabel(fuelVal)}</strong>${a.fuelLevelMismatch ? `<span class="km-mismatch-note">${t("trip_fuel_mismatch_reported")}</span>` : ""}</div>` : ""}
    `;
  }

  return `
    <div class="km-confirm-box__label">${t("trip_km_system")}</div>
    <div class="km-confirm-box__value">${systemKm?.toLocaleString() || "—"} km</div>
    <div class="km-confirm-box__hint">${t("trip_km_confirm_hint")}</div>

    <div class="form-group" style="margin-top:10px">
      <label class="form-label">${t("vehicle_fuel_level")}</label>
      ${fuelLevelScaleHTML(`km-confirm-fuelLevel-${suffix}`, `km-confirm-fuelLevel-scale-${suffix}`, v?.fuelLevel)}
    </div>

    <div class="km-confirm-box__actions">
      <button class="btn btn--primary btn--sm" data-action="confirm-km" data-assignment-id="${suffix}">✓ ${t("trip_km_confirm")}</button>
      <button class="btn btn--secondary btn--sm" data-action="correct-km" data-assignment-id="${suffix}">✏️ ${t("trip_km_enter_actual")}</button>
    </div>
    <div id="km-correct-form-${suffix}" class="hidden" style="margin-top:10px">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${t("trip_km_actual_ph")}</label>
          <input id="input-actual-km-${suffix}" class="form-input" type="number"
            placeholder="${systemKm || ""}" />
        </div>
        <div style="display:flex;align-items:flex-end">
          <button class="btn btn--primary btn--sm" data-action="submit-km" data-assignment-id="${suffix}">${t("trip_km_confirm")}</button>
        </div>
      </div>
    </div>
  `;
}

// ── POSLEDNJA VAŽEĆA KILOMETRAŽA (referenca za validaciju) ─────
// Sve od ovog trenutka nadalje (gorivo, troškovi, prijave, razduženje)
// mora biti >= od ove vrednosti. Ažurira se na vehicle.currentKm
// posle svakog unosa koji sadrži km.
function getLastKnownKm() {
  return activeVehicle?.currentKm ?? activeAssignment?.startKm ?? 0;
}

// Validira uneti km string: obavezan je i mora biti >= poslednje važeće.
// Vraća broj ili null (i ispisuje grešku) ako validacija ne prođe.
function validateKmInput(rawValue, errorElId) {
  const km = parseFloat(rawValue);
  if (!rawValue || isNaN(km) || km <= 0) {
    showEntryError(errorElId, t("required_field") + ": " + t("trip_current_km"));
    return null;
  }
  const lastKm = getLastKnownKm();
  if (km < lastKm) {
    showEntryError(errorElId, `${t("trip_km_too_low")}: ${lastKm.toLocaleString()} km`);
    return null;
  }
  return km;
}

// Upisuje novu km (i, opciono, nivo goriva) na vozilo (Firestore) i
// ažurira lokalno stanje. fuelLevel je opcioni — ako vozač nije izabrao
// vrednost pri zatvaranju vožnje/zaduženja, postojeći nivo se ne menja.
async function bumpVehicleKm(newKm, fuelLevel = null) {
  const update = {
    currentKm: newKm,
    currentKmUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (fuelLevel) update.fuelLevel = fuelLevel;

  await updateDoc(doc(db, "companies", S.companyId, "vehicles", activeAssignment.vehicleId), update);

  if (activeVehicle) {
    activeVehicle.currentKm = newKm;
    if (fuelLevel) activeVehicle.fuelLevel = fuelLevel;
  } else {
    activeVehicle = { id: activeAssignment.vehicleId, currentKm: newKm, fuelLevel: fuelLevel || null };
  }
}

// ── KM POTVRDA ────────────────────────────────────────────────
function bindKmConfirm(aid) {
  const suffix = aid;
  const st = assignmentsState.get(aid);
  if (!st) return;
  const systemKm = st.vehicle?.currentKm ?? st.assignment?.startKm;

  bindFuelLevelScale(`km-confirm-fuelLevel-${suffix}`, `km-confirm-fuelLevel-scale-${suffix}`);

  document.querySelector(`[data-action="confirm-km"][data-assignment-id="${suffix}"]`)?.addEventListener("click", async () => {
    selectAssignment(aid);
    const fuelLevel = document.getElementById(`km-confirm-fuelLevel-${suffix}`)?.value || null;
    const fuelMismatch = !!(fuelLevel && activeVehicle?.fuelLevel && fuelLevel !== activeVehicle.fuelLevel);

    try {
      const updateData = {
        kmConfirmed:      true,
        kmConfirmedValue: systemKm,
        kmConfirmedAt:    serverTimestamp(),
        updatedAt:        serverTimestamp(),
      };
      if (fuelLevel) updateData.fuelLevelConfirmedValue = fuelLevel;

      if (fuelMismatch) {
        updateData.fuelLevelMismatch = true;
        updateData.systemFuelLevel   = activeVehicle?.fuelLevel || null;
      }

      await updateDoc(doc(db, "companies", S.companyId, "assignments", activeAssignment.id), updateData);
      activeAssignment.kmConfirmed      = true;
      activeAssignment.kmConfirmedValue = systemKm;
      if (fuelLevel) activeAssignment.fuelLevelConfirmedValue = fuelLevel;

      // Ako se vozač izjasnio o nivou goriva a razlikuje se od onog
      // upisanog na vozilu, ažuriraj vozilo da odražava stvarno stanje
      // i pošalji notifikaciju fleet adminu (isto kao km neslaganje).
      if (fuelLevel && fuelLevel !== activeVehicle?.fuelLevel) {
        await updateDoc(doc(db, "companies", S.companyId, "vehicles", activeAssignment.vehicleId), {
          fuelLevel, updatedAt: serverTimestamp(),
        });
        const priorFuelLevel = activeVehicle?.fuelLevel || null;
        if (activeVehicle) activeVehicle.fuelLevel = fuelLevel;

        if (fuelMismatch) {
          await addDoc(collection(db, "companies", S.companyId, "notifications"), {
            type:             "fuel_mismatch",
            assignmentId:     activeAssignment.id,
            vehicleId:        activeAssignment.vehicleId,
            vehiclePlate:     activeAssignment.vehiclePlate,
            driverId:         S.profile.driverId,
            driverName:       activeAssignment.driverName,
            systemFuelLevel:  priorFuelLevel,
            driverFuelLevel:  fuelLevel,
            status:           "unread",
            createdAt:        serverTimestamp(),
          });
        }
      }
      if (fuelMismatch) showToast(t("trip_fuel_mismatch_reported"), "warning");
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
      return;
    }

    document.getElementById(`km-confirm-box-${suffix}`).innerHTML = `
      <div class="km-confirmed">✅ ${t("trip_km_confirmed")}: <strong>${systemKm?.toLocaleString()} km</strong></div>
      ${fuelLevel ? `<div class="km-confirmed">⛽ ${t("vehicle_fuel_level")}: <strong>${fuelLevelLabel(fuelLevel)}</strong>${fuelMismatch ? `<span class="km-mismatch-note">${t("trip_fuel_mismatch_reported")}</span>` : ""}</div>` : ""}
    `;
  });

  document.querySelector(`[data-action="correct-km"][data-assignment-id="${suffix}"]`)?.addEventListener("click", () => {
    document.getElementById(`km-correct-form-${suffix}`).classList.remove("hidden");
  });

  document.querySelector(`[data-action="submit-km"][data-assignment-id="${suffix}"]`)?.addEventListener("click", async () => {
    selectAssignment(aid);
    const actualKm = Number(document.getElementById(`input-actual-km-${suffix}`)?.value);
    if (!actualKm || actualKm <= 0) return;
    const fuelLevel = document.getElementById(`km-confirm-fuelLevel-${suffix}`)?.value || null;

    const mismatch = actualKm !== systemKm;
    const fuelMismatch = !!(fuelLevel && activeVehicle?.fuelLevel && fuelLevel !== activeVehicle.fuelLevel);
    const priorFuelLevel = activeVehicle?.fuelLevel || null;

    try {
      const updateData = {
        kmConfirmed:      true,
        kmConfirmedValue: actualKm,
        kmConfirmedAt:    serverTimestamp(),
        updatedAt:        serverTimestamp(),
      };
      if (fuelLevel) updateData.fuelLevelConfirmedValue = fuelLevel;
      if (fuelMismatch) {
        updateData.fuelLevelMismatch = true;
        updateData.systemFuelLevel   = priorFuelLevel;
      }

      if (mismatch) {
        updateData.kmMismatch    = true;
        updateData.driverStartKm = actualKm;

        // Snimi neslaganje i pošalji notifikaciju fleet adminu
        await addDoc(collection(db, "companies", S.companyId, "notifications"), {
          type:         "km_mismatch",
          assignmentId: activeAssignment.id,
          vehicleId:    activeAssignment.vehicleId,
          vehiclePlate: activeAssignment.vehiclePlate,
          driverId:     S.profile.driverId,
          driverName:   activeAssignment.driverName,
          systemKm,
          driverKm:     actualKm,
          status:       "unread",
          createdAt:    serverTimestamp(),
        });
      }

      if (fuelMismatch) {
        // Isti obrazac kao km_mismatch, samo za nivo goriva.
        await addDoc(collection(db, "companies", S.companyId, "notifications"), {
          type:            "fuel_mismatch",
          assignmentId:    activeAssignment.id,
          vehicleId:       activeAssignment.vehicleId,
          vehiclePlate:    activeAssignment.vehiclePlate,
          driverId:        S.profile.driverId,
          driverName:      activeAssignment.driverName,
          systemFuelLevel: priorFuelLevel,
          driverFuelLevel: fuelLevel,
          status:          "unread",
          createdAt:       serverTimestamp(),
        });
      }

      await updateDoc(doc(db, "companies", S.companyId, "assignments", activeAssignment.id), updateData);

      activeAssignment.kmConfirmed      = true;
      activeAssignment.kmConfirmedValue = actualKm;
      if (mismatch) activeAssignment.kmMismatch = true;
      if (fuelLevel) activeAssignment.fuelLevelConfirmedValue = fuelLevel;
      if (fuelMismatch) activeAssignment.fuelLevelMismatch = true;

      if (fuelLevel && fuelLevel !== activeVehicle?.fuelLevel) {
        await updateDoc(doc(db, "companies", S.companyId, "vehicles", activeAssignment.vehicleId), {
          fuelLevel, updatedAt: serverTimestamp(),
        });
        if (activeVehicle) activeVehicle.fuelLevel = fuelLevel;
      }

      if (mismatch) showToast(t("trip_km_mismatch_reported"), "warning");
      if (fuelMismatch) showToast(t("trip_fuel_mismatch_reported"), "warning");
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
      return;
    }

    // Ažuriraj prikaz
    document.getElementById(`km-confirm-box-${suffix}`).innerHTML = `
      <div class="km-confirmed">
        ✅ Unesena km: <strong>${actualKm.toLocaleString()} km</strong>
        ${mismatch ? `<span class="km-mismatch-note">(razlika: ${(actualKm - systemKm).toLocaleString()} km)</span>` : ""}
      </div>
      ${fuelLevel ? `<div class="km-confirmed">⛽ ${t("vehicle_fuel_level")}: <strong>${fuelLevelLabel(fuelLevel)}</strong>${fuelMismatch ? `<span class="km-mismatch-note">${t("trip_fuel_mismatch_reported")}</span>` : ""}</div>` : ""}
    `;
  });
}

// ── ZATVARANJE VOŽNJE (bez zatvaranja celog zaduženja) ─────────
function openCloseTripForm() {
  const bodyHTML = `
    <div class="unassign-info">
      <div>🚗 <strong>${activeAssignment.vehicleBrand} ${activeAssignment.vehicleModel}</strong> — ${activeAssignment.vehiclePlate}</div>
      ${activeTrip?.destination ? `<div>📍 ${activeTrip.destination}</div>` : ""}
      <div>🛣️ ${t("assignment_start_km")}: ${(activeTrip?.startKm ?? activeAssignment.startKm)?.toLocaleString() || "—"}</div>
    </div>

    <div class="form-section-title" style="margin-top:12px">${t("trip_close_trip_title")}</div>
    <div class="form-group">
      <label class="form-label">${t("assignment_end_km")} *</label>
      <input id="ct-endKm" class="form-input" type="number"
        value="${activeVehicle?.currentKm || ""}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("vehicle_fuel_level")}</label>
      ${fuelLevelScaleHTML("ct-fuelLevel", "ct-fuelLevel-scale", activeVehicle?.fuelLevel)}
    </div>
    <div class="form-group">
      <label class="form-label">${t("notes")}</label>
      <textarea id="ct-notes" class="form-textarea" rows="2"></textarea>
    </div>
    <p id="close-trip-error" class="login-error hidden"></p>
  `;

  openModal(t("trip_close_trip_btn"), bodyHTML, () => closeCurrentTrip());
  bindFuelLevelScale("ct-fuelLevel", "ct-fuelLevel-scale");
}

async function closeCurrentTrip() {
  if (!activeTrip) return false;

  const endKm = validateKmInput(document.getElementById("ct-endKm")?.value, "close-trip-error");
  if (endKm === null) return false;
  const notes = document.getElementById("ct-notes")?.value.trim() || null;
  const fuelLevel = document.getElementById("ct-fuelLevel")?.value || null;

  try {
    await updateDoc(doc(db, "companies", S.companyId, "trips", activeTrip.id), {
      status:    "closed",
      endDate:   serverTimestamp(),
      endKm,
      fuelLevel,
      notes,
      updatedAt: serverTimestamp(),
    });
    await bumpVehicleKm(endKm, fuelLevel);

    showToast(t("trip_closed_success"), "success");

    // Odmah ponudi otvaranje sledeće vožnje — startKm se preuzima sa
    // kraja upravo zatvorene vožnje.
    openNewTripForm(endKm);
    return true;
  } catch (e) {
    showEntryError("close-trip-error", `${t("error")}: ${e.message}`);
    return false;
  }
}

// ── NOVA VOŽNJA (u okviru istog zaduženja) ─────────────────────
function openNewTripForm(prefillStartKm) {
  const bodyHTML = `
    <div class="form-section-title">${t("trip_new_trip_title")}</div>
    <div class="form-group">
      <label class="form-label">${t("assignment_start_km")} *</label>
      <input id="nt-startKm" class="form-input" type="number" value="${prefillStartKm || ""}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("assignment_type")} *</label>
      <div class="radio-group">
        <label class="radio-label">
          <input type="radio" name="nt-tripType" value="local" checked />
          🏙️ ${t("assignment_local")}
        </label>
        <label class="radio-label">
          <input type="radio" name="nt-tripType" value="intercity" />
          ✈️ ${t("assignment_intercity")}
        </label>
      </div>
    </div>
    <div id="nt-intercity-fields" class="hidden">
      <div class="form-group">
        <label class="form-label">${t("assignment_destination")}</label>
        <input id="nt-destination" class="form-input" type="text" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("assignment_route")}</label>
        <input id="nt-route" class="form-input" type="text" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("assignment_reason")}</label>
      <textarea id="nt-reason" class="form-textarea"></textarea>
    </div>
    <p id="new-trip-error" class="login-error hidden"></p>
  `;

  // Malo kašnjenje — pusti prethodni modal (zatvaranje vožnje) da se
  // skloni pre nego što se otvori sledeći, da ne dođe do preklapanja.
  setTimeout(() => {
    openModal(t("trip_new_trip_title"), bodyHTML, () => saveNewTrip());

    document.querySelectorAll("input[name='nt-tripType']").forEach(radio => {
      radio.addEventListener("change", () => {
        document.getElementById("nt-intercity-fields")?.classList.toggle("hidden", radio.value !== "intercity");
      });
    });
  }, 200);
}

async function saveNewTrip() {
  const startKm = parseFloat(document.getElementById("nt-startKm")?.value);
  if (!startKm || startKm <= 0) {
    showEntryError("new-trip-error", t("required_field"));
    return false;
  }

  const tripType    = document.querySelector("input[name='nt-tripType']:checked")?.value || "local";
  const destination = document.getElementById("nt-destination")?.value.trim() || null;
  const route       = document.getElementById("nt-route")?.value.trim() || null;
  const reason      = document.getElementById("nt-reason")?.value.trim() || null;

  if (tripType === "intercity" && !destination) {
    showEntryError("new-trip-error", t("assignment_no_destination"));
    return false;
  }

  try {
    const tripData = {
      assignmentId: activeAssignment.id,
      vehicleId:    activeAssignment.vehicleId,
      vehicleBrand: activeAssignment.vehicleBrand,
      vehicleModel: activeAssignment.vehicleModel,
      vehiclePlate: activeAssignment.vehiclePlate,
      vehicleVin:   activeAssignment.vehicleVin || null,
      driverId:     activeAssignment.driverId,
      driverName:   activeAssignment.driverName,
      driverUid:    S.user.uid,
      startDate:    serverTimestamp(),
      endDate:      null,
      startKm,
      endKm:        null,
      tripType,
      destination:  tripType === "intercity" ? destination : null,
      route:        tripType === "intercity" ? route : null,
      reason,
      status:       "active",
      notes:        null,
      createdAt:    serverTimestamp(),
      createdBy:    S.user.uid,
    };
    const ref = await addDoc(collection(db, "companies", S.companyId, "trips"), tripData);
    activeTrip = { id: ref.id, ...tripData, startDate: new Date() };

    showToast(t("trip_new_trip_started"), "success");

    const container = document.getElementById("content");
    if (container) renderDashboard(container);
    return true;
  } catch (e) {
    showEntryError("new-trip-error", `${t("error")}: ${e.message}`);
    return false;
  }
}

// ── FORMA ZA TOČENJE GORIVA ───────────────────────────────────
function openFuelForm() {
  const bodyHTML = `
    <div class="form-section-title">${t("trip_fuel_header")}</div>
    <button type="button" id="tf-scan-btn" class="btn btn--secondary btn--full">${t("receipt_scan_btn")}</button>
    <p id="tf-scan-status" class="scan-status hidden"></p>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_type")} *</label>
        <select id="tf-fuelType" class="form-select">
          <option value="diesel">${t("fuel_diesel")}</option>
          <option value="petrol">${t("fuel_petrol")}</option>
          <option value="lpg">${t("fuel_lpg")}</option>
          <option value="cng">${t("fuel_cng")}</option>
          <option value="electric">${t("fuel_electric")}</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_amount")} (L) *</label>
        <input id="tf-fuelAmount" class="form-input" type="number" step="0.01" min="0" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_price")} (RSD) *</label>
        <input id="tf-fuelCost" class="form-input" type="number" min="0" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_price_per_l")}</label>
        <input id="tf-pricePerL" class="form-input" type="number" step="0.01" min="0"
          placeholder="${t("trip_fuel_price_per_l_ph")}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_station")} *</label>
        <input id="tf-fuelStation" class="form-input" type="text" placeholder="npr. NIS Petrol" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_receipt")}</label>
        <input id="tf-receiptNo" class="form-input" type="text" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_address")}</label>
        <input id="tf-fuelStationAddress" class="form-input" type="text" placeholder="npr. Bulevar Heroja sa Košara 10, Beograd" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_receipt_time")}</label>
        <input id="tf-receiptTime" class="form-input" type="datetime-local" step="1" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("trip_current_km")} *</label>
      <input id="tf-currentKm" class="form-input" type="number"
        value="${activeVehicle?.currentKm || ""}"
        placeholder="${t('trip_current_km')}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("notes")}</label>
      <textarea id="tf-notes" class="form-textarea" rows="2"></textarea>
    </div>
    <p id="fuel-form-error" class="login-error hidden"></p>
  `;

  fuelScan = { url: null, source: "manual", pib: null, object: null };
  openModal(t("trip_with_fueling"), bodyHTML, () => saveFuelEntry());

  // Auto-izračun cene po litru (osim ako je cenu vozač upisao ručno)
  const calcPrice = () => {
    const pEl = document.getElementById("tf-pricePerL");
    if (!pEl || pEl.dataset.manual === "1") return;
    const amount = parseFloat(document.getElementById("tf-fuelAmount")?.value);
    const cost   = parseFloat(document.getElementById("tf-fuelCost")?.value);
    if (amount > 0 && cost > 0) pEl.value = (cost / amount).toFixed(2);
  };
  setTimeout(() => {
    document.getElementById("tf-fuelAmount")?.addEventListener("input", calcPrice);
    document.getElementById("tf-fuelCost")?.addEventListener("input", calcPrice);
    document.getElementById("tf-pricePerL")?.addEventListener("input", (e) => {
      e.target.dataset.manual = e.target.value ? "1" : "";
    });
    document.getElementById("tf-scan-btn")?.addEventListener("click", onScanReceipt);
  }, 100);
}

// ── SKENIRANJE FISKALNOG RAČUNA ───────────────────────────────
// Stanje poslednjeg skeniranja (čuva se uz unos goriva)
let fuelScan = { url: null, source: "manual", pib: null, object: null };

// Poruka "Račun X je već unet (datum, vozač, vozilo)"
function duplicateReceiptMessage(pfr, existing) {
  const when = existing?.createdAt ? formatDateDMY(existing.createdAt) : "—";
  const who  = [existing?.driverName, existing?.vehiclePlate].filter(Boolean).join(", ") || "—";
  return t("receipt_duplicate_detail", { pfr, date: when, who });
}

// Proverava da li je račun već unet (gorivo ILI trošak). Vraća
//   { duplicate: unos } | { duplicate: null } | { error: poruka }
// Ako provera ne uspe, snimanje se NE dozvoljava (ranije je tiho prolazilo).
async function checkReceiptDuplicate(pfr) {
  if (!normalizeReceiptNo(pfr)) return { duplicate: null };
  try {
    return { duplicate: await findReceiptDuplicate(S.companyId, pfr) };
  } catch (e) {
    console.warn("Provera duplikata računa nije uspela:", e);
    return { error: t("receipt_check_failed") };
  }
}

function fuelFormSet(id, value) {
  const el = document.getElementById(id);
  if (!el || value === null || value === undefined || value === "") return;
  if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === String(value))) return;
  el.value = value;
}

async function onScanReceipt() {
  const statusEl = document.getElementById("tf-scan-status");
  const btn = document.getElementById("tf-scan-btn");
  const setStatus = (msg, kind = "info") => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = `scan-status scan-status--${kind}`;
  };

  let text;
  try {
    text = await scanQRCode();
  } catch (e) {
    setStatus(t(e.code === "denied" ? "receipt_scan_camera_denied" : "receipt_scan_camera_unavailable"), "error");
    return;
  }
  if (text === null) return; // korisnik je zatvorio skener

  const qr = parseFiscalQR(text);
  if (!qr) { setStatus(t("receipt_scan_not_fiscal"), "error"); return; }
  const dup = await checkReceiptDuplicate(qr.pfr);
  if (dup.error) { setStatus(dup.error, "error"); return; }
  if (dup.duplicate) {
    setStatus(duplicateReceiptMessage(qr.pfr, dup.duplicate), "error");
    return;
  }

  // Podaci koji stoje u samom QR kodu
  fuelScan.url = text.trim();
  fuelScan.source = "qr";
  fuelFormSet("tf-receiptNo", qr.pfr);
  fuelFormSet("tf-fuelCost", qr.amount);
  fuelFormSet("tf-receiptTime", qr.dateTime);
  document.getElementById("tf-fuelCost")?.dispatchEvent(new Event("input"));

  if (!receiptWorkerConfigured()) { setStatus(t("receipt_scan_qr_only"), "warn"); return; }

  // Pumpa, adresa, gorivo, litri i cena — sa računa preko Worker-a
  setStatus(t("receipt_scan_loading"), "info");
  if (btn) btn.disabled = true;
  try {
    const r = await fetchReceiptDetails(fuelScan.url);
    applyReceiptDetails(r, qr, setStatus);
  } catch (e) {
    console.warn("Učitavanje računa nije uspelo:", e.message, e.diag || "");
    setStatus(`${t("receipt_scan_qr_only")} (${e.message})`, "warn");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function applyReceiptDetails(r, qr, setStatus) {
  const items = r.items || [];
  const fuelItem = items.find((i) => i.fuelType) || (items.length === 1 ? items[0] : null);

  fuelFormSet("tf-fuelStation", r.chain);
  fuelFormSet("tf-fuelStationAddress", [r.address, r.city].filter(Boolean).join(", "));
  fuelFormSet("tf-receiptTime", r.time);
  fuelScan.pib = r.pib || null;
  fuelScan.object = r.object || null;

  if (fuelItem) {
    fuelFormSet("tf-fuelType", fuelItem.fuelType);
    fuelFormSet("tf-fuelAmount", fuelItem.quantity);
    if (fuelItem.total > 0) fuelFormSet("tf-fuelCost", fuelItem.total);
    const pEl = document.getElementById("tf-pricePerL");
    if (pEl && fuelItem.unitPrice > 0) { pEl.value = fuelItem.unitPrice.toFixed(2); pEl.dataset.manual = ""; }
  }

  const notes = [];
  if (r.total > 0 && Math.abs(r.total - qr.amount) > 0.01) {
    notes.push(t("receipt_scan_total_mismatch", { a: r.total.toFixed(2), b: qr.amount.toFixed(2) }));
  }
  if (!fuelItem) notes.push(t("receipt_scan_no_fuel_item"));
  else if (items.length > 1) notes.push(t("receipt_scan_extra_items", { total: (r.total || qr.amount).toFixed(2) }));
  setStatus(notes.length ? notes.join(" ") : t("receipt_scan_ok"), notes.length ? "warn" : "ok");
}

async function saveFuelEntry() {
  const fuelAmount  = parseFloat(document.getElementById("tf-fuelAmount")?.value);
  const fuelCost    = parseFloat(document.getElementById("tf-fuelCost")?.value);
  const fuelStation = document.getElementById("tf-fuelStation")?.value.trim();

  if (!fuelAmount || !fuelCost || !fuelStation) {
    showEntryError("fuel-form-error", t("required_field"));
    return false;
  }

  const currentKm = validateKmInput(document.getElementById("tf-currentKm")?.value, "fuel-form-error");
  if (currentKm === null) return false;

  const receiptNo = normalizeReceiptNo(document.getElementById("tf-receiptNo")?.value);
  if (receiptNo) {
    const dup = await checkReceiptDuplicate(receiptNo);
    if (dup.error || dup.duplicate) {
      showEntryError("fuel-form-error", dup.error || duplicateReceiptMessage(receiptNo, dup.duplicate));
      return false;
    }
  }
  const priceField = parseFloat(document.getElementById("tf-pricePerL")?.value);

  try {
    await saveTripEntry(S.companyId, {
      type:         "fuel",
      assignmentId: activeAssignment.id,
      tripId:       activeTrip?.id || null,
      vehicleId:    activeAssignment.vehicleId,
      vehiclePlate: activeAssignment.vehiclePlate,
      driverId:     S.profile?.driverId || null,
      driverUid:    S.user.uid,
      driverName:   activeAssignment.driverName,
      fuelType:     document.getElementById("tf-fuelType")?.value,
      fuelAmount,
      fuelCost,
      pricePerL:    priceField > 0 ? priceField : (fuelAmount > 0 ? fuelCost / fuelAmount : null),
      fuelStation,
      fuelStationAddress: document.getElementById("tf-fuelStationAddress")?.value.trim() || null,
      stationObject: fuelScan.object || null,
      stationPib:   fuelScan.pib || null,
      receiptNo,
      receiptTime:  document.getElementById("tf-receiptTime")?.value || null,
      receiptUrl:   fuelScan.url || null,
      receiptSource: fuelScan.source,
      currentKm,
      notes:        document.getElementById("tf-notes")?.value.trim() || null,
      createdAt:    serverTimestamp(),
    });

    await bumpVehicleKm(currentKm);

    showToast(t("success"), "success");
    await refreshEntries();
  } catch (e) {
    showEntryError("fuel-form-error", e instanceof DuplicateReceiptError
      ? duplicateReceiptMessage(e.receiptNo, e.existing)
      : `${t("error")}: ${e.message}`);
    return false;
  }
}

// ── FORMA ZA PUTARINU / TROŠAK ────────────────────────────────
function openCostForm() {
  const bodyHTML = `
    <div class="form-section-title">${t("trip_cost_header")}</div>
    <div class="form-group">
      <label class="form-label">${t("trip_cost_type")}</label>
      <select id="tc-type" class="form-select">
        <option value="toll">🛣️ ${t("trip_cost_toll")}</option>
        <option value="parking">🅿️ ${t("trip_cost_parking")}</option>
        <option value="washing">🚿 ${t("trip_cost_washing")}</option>
        <option value="other_cost">📋 ${t("trip_cost_other")}</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_cost_amount")}</label>
        <input id="tc-amount" class="form-input" type="number" min="0" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_cost_receipt")}</label>
        <input id="tc-receiptNo" class="form-input" type="text" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("trip_cost_location")}</label>
      <input id="tc-location" class="form-input" type="text" placeholder="${t("trip_cost_location_ph")}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("trip_current_km")} *</label>
      <input id="tc-currentKm" class="form-input" type="number"
        value="${activeVehicle?.currentKm || ""}"
        placeholder="${t('trip_current_km')}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("notes")}</label>
      <textarea id="tc-notes" class="form-textarea" rows="2"></textarea>
    </div>
    <p id="cost-form-error" class="login-error hidden"></p>
  `;

  openModal(t("trip_cost_add"), bodyHTML, () => saveCostEntry());
}

async function saveCostEntry() {
  const amount = parseFloat(document.getElementById("tc-amount")?.value);
  if (!amount || amount <= 0) {
    showEntryError("cost-form-error", t("required_field"));
    return;
  }

  const currentKm = validateKmInput(document.getElementById("tc-currentKm")?.value, "cost-form-error");
  if (currentKm === null) return;

  const costReceiptNo = normalizeReceiptNo(document.getElementById("tc-receiptNo")?.value);
  if (costReceiptNo) {
    const dup = await checkReceiptDuplicate(costReceiptNo);
    if (dup.error || dup.duplicate) {
      showEntryError("cost-form-error", dup.error || duplicateReceiptMessage(costReceiptNo, dup.duplicate));
      return false;
    }
  }

  try {
    await saveTripEntry(S.companyId, {
      type:         document.getElementById("tc-type")?.value || "other_cost",
      assignmentId: activeAssignment.id,
      tripId:       activeTrip?.id || null,
      vehicleId:    activeAssignment.vehicleId,
      vehiclePlate: activeAssignment.vehiclePlate,
      driverId:     S.profile?.driverId || null,
      driverUid:    S.user.uid,
      driverName:   activeAssignment.driverName,
      amount,
      receiptNo:    costReceiptNo,
      location:     document.getElementById("tc-location")?.value.trim() || null,
      currentKm,
      notes:        document.getElementById("tc-notes")?.value.trim() || null,
      createdAt:    serverTimestamp(),
    });

    await bumpVehicleKm(currentKm);

    showToast(t("success"), "success");
    await refreshEntries();
  } catch (e) {
    showEntryError("cost-form-error", e instanceof DuplicateReceiptError
      ? duplicateReceiptMessage(e.receiptNo, e.existing)
      : `${t("error")}: ${e.message}`);
    return false;
  }
}

// ── FORMA ZA RAZDUŽENJE (VOZAČ) ───────────────────────────────
function openDriverUnassignForm() {
  const bodyHTML = `
    <div class="unassign-info">
      <div>🚗 <strong>${activeAssignment.vehicleBrand} ${activeAssignment.vehicleModel}</strong> — ${activeAssignment.vehiclePlate}</div>
      <div>📅 ${t("trip_assigned_label")}: ${formatDate(activeAssignment.startDate)}</div>
      ${activeAssignment.startKm ? `<div>🛣️ ${t("assignment_start_km")}: ${activeAssignment.startKm.toLocaleString()}</div>` : ""}
    </div>

    <div class="form-section-title" style="margin-top:12px">${t("assignment_unassign_title")}</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("assignment_unassign_date_label")}</label>
        <input id="du-endDate" class="form-input" type="text" inputmode="numeric" maxlength="10"
          placeholder="${datePlaceholder()}" value="${todayDMY()}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("assignment_end_km")}</label>
        <input id="du-endKm" class="form-input" type="number"
          value="${activeVehicle?.currentKm || ""}" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("vehicle_fuel_level")}</label>
      ${fuelLevelScaleHTML("du-fuelLevel", "du-fuelLevel-scale", activeVehicle?.fuelLevel)}
    </div>
    <div class="form-group">
      <label class="form-label">${t("notes")}</label>
      <textarea id="du-notes" class="form-textarea" rows="2"></textarea>
    </div>
    <p id="unassign-form-error" class="login-error hidden"></p>
  `;

  openModal(t("assignment_unassign") + " " + t("assignment_vehicle").toLowerCase(), bodyHTML, () => processDriverUnassign());
  attachDateMask("du-endDate");
  bindFuelLevelScale("du-fuelLevel", "du-fuelLevel-scale");
}

async function processDriverUnassign() {
  const endKm     = parseFloat(document.getElementById("du-endKm")?.value);
  const notes     = document.getElementById("du-notes")?.value.trim();
  const fuelLevel = document.getElementById("du-fuelLevel")?.value || null;

  // Datum: poruka ispod polja + fokus. `return false` drži dijalog otvorenim
  // (običan `return` ga je zatvarao i korisnik je gubio unos).
  const unassignDates = collectDates([
    { id: "du-endDate", required: true, requiredMessage: t("assignment_unassign_date_required") },
  ]);
  if (!unassignDates.ok) return false;
  const endDateObj = unassignDates.values["du-endDate"];

  if (!endKm || endKm <= 0) {
    showEntryError("unassign-form-error", t("assignment_unassign_endkm_required"));
    return false;
  }

  const lastKm = getLastKnownKm();
  if (endKm < lastKm) {
    showEntryError("unassign-form-error", `${t("trip_km_too_low")}: ${lastKm.toLocaleString()} km`);
    return false;
  }

  try {
    await updateDoc(
      doc(db, "companies", S.companyId, "assignments", activeAssignment.id),
      {
        status:        "closed",
        endDate:       endDateObj,
        endKm,
        fuelLevel,
        unassignNotes: notes || null,
        closedByDriver: true,
        updatedAt:     serverTimestamp(),
      }
    );

    const vehicleUpdate = {
      currentKm:          endKm,
      currentKmUpdatedAt: serverTimestamp(),
      assignedDriverName: null,
      updatedAt:          serverTimestamp(),
    };
    if (fuelLevel) vehicleUpdate.fuelLevel = fuelLevel;

    await updateDoc(
      doc(db, "companies", S.companyId, "vehicles", activeAssignment.vehicleId),
      vehicleUpdate
    );

    // Zatvori i trenutno aktivnu vožnju — zaduženje se gasi u celini
    if (activeTrip) {
      await updateDoc(
        doc(db, "companies", S.companyId, "trips", activeTrip.id),
        {
          status:    "closed",
          endDate:   endDateObj,
          endKm,
          fuelLevel,
          notes:     notes || null,
          updatedAt: serverTimestamp(),
        }
      );
    }

    showToast(t("unassign_success"), "success");
    activeAssignment = null;
    activeVehicle    = null;
    activeTrip       = null;
    tripEntries       = [];

    const container = document.getElementById("content");
    if (container) renderDashboard(container);
  } catch (e) {
    showEntryError("unassign-form-error", `${t("error")}: ${e.message}`);
  }
}

// ── REFRESH ENTRIES (posle dodavanja unosa) ────────────────────
async function refreshEntries() {
  if (!activeAssignment) return;
  const snap = await getDocs(query(
    collection(db, "companies", S.companyId, "tripEntries"),
    where("assignmentId", "==", activeAssignment.id),
    orderBy("createdAt", "desc")
  ));
  const allForAssignment = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  tripEntries = activeTrip
    ? allForAssignment.filter(e => e.tripId === activeTrip.id || !e.tripId)
    : allForAssignment;

  // Sinhronizuj keširano stanje za ovo zaduženje, da ostane tačno i bez
  // punog ponovnog učitavanja dashboarda.
  const st = assignmentsState.get(activeAssignment.id);
  if (st) st.entries = tripEntries;

  const listEl = document.getElementById(`trip-entries-list-${activeAssignment.id}`);
  if (listEl) {
    listEl.innerHTML = tripEntries.length === 0
      ? `<div class="empty-state"><div class="empty-state__icon">📋</div><p>${t("trip_no_entries")}</p></div>`
      : tripEntries.map(e => tripEntryCard(e, { clickable: true })).join("");
  }

  // Ažuriraj statistike (samo za blok ovog zaduženja)
  const totalFuel     = tripEntries.filter(e => e.type === "fuel").reduce((s, e) => s + (e.fuelAmount || 0), 0);
  const totalCost     = tripEntries.reduce((s, e) => s + (e.fuelCost || 0) + (e.amount || 0), 0);
  const incidentCount = tripEntries.filter(e => ["fault","damage","accident"].includes(e.type)).length;

  document.querySelector(`.trip-stats[data-assignment-id="${activeAssignment.id}"]`)?.replaceWith((() => {
    const div = document.createElement("div");
    div.className = "trip-stats";
    div.dataset.assignmentId = activeAssignment.id;
    div.innerHTML = `
      <div class="trip-stat-box"><div class="trip-stat-box__value">${totalFuel.toFixed(1)} L</div><div class="trip-stat-box__label">${t("trip_stats_fuel")}</div></div>
      <div class="trip-stat-box"><div class="trip-stat-box__value">${totalCost.toLocaleString()} RSD</div><div class="trip-stat-box__label">${t("trip_stats_cost")}</div></div>
      <div class="trip-stat-box ${incidentCount > 0 ? "trip-stat-box--warn" : ""}"><div class="trip-stat-box__value">${incidentCount}</div><div class="trip-stat-box__label">${t("trip_stats_incidents")}</div></div>
      <div class="trip-stat-box"><div class="trip-stat-box__value">${tripEntries.length}</div><div class="trip-stat-box__label">${t("trip_stats_entries")}</div></div>
    `;
    return div;
  })());
}

// ── FORMA GREŠKE ─────────────────────────────────────────────
function showEntryError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
}

function attachDashboardEvents() {
  document.querySelectorAll(".stat-card[data-nav]").forEach(card => {
    card.style.cursor = "pointer";
    card.addEventListener("click", () => {
      const filter = card.dataset.filter || null;
      if (filter) {
        // Navigiraj na tab i primeni filter
        import("./vehicles.js").then(({ renderVehicles }) => {
          S.activeTab = "vehicles";
          document.querySelectorAll(".nav-btn").forEach(btn => {
            btn.classList.toggle("nav-btn--active", btn.dataset.tab === "vehicles");
          });
          const content = document.getElementById("content");
          if (content) renderVehicles(content, filter);
        });
      } else {
        navigateTo(card.dataset.nav);
      }
    });
  });

  // Podsetnik za redovni servis: "Zakaži sada" → forma za dodavanje servisa
  document.querySelectorAll(".btn-reminder-schedule").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const vehicle = dashboardVehicles.find(v => v.id === btn.dataset.vehicle);
      if (!vehicle) return;
      await openServiceForm(vehicle, null, { serviceType: "regular" }, {
        onSaved: () => loadDashboardData(),
      });
    });
  });

  // Podsetnik za redovni servis: "Podseti me kasnije" → pitanje za koliko dana odložiti
  document.querySelectorAll(".btn-reminder-snooze").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const vehicleId = btn.dataset.vehicle;
      openSnoozeModal({
        permanent: false,
        onPick: async (days) => {
          const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
          await updateDoc(doc(db, "companies", S.companyId, "vehicles", vehicleId), {
            serviceReminderSnoozedUntil: until,
          });
          const v = dashboardVehicles.find(x => x.id === vehicleId);
          if (v) v.serviceReminderSnoozedUntil = until;
          showToast(t("svc_rem_snoozed_toast", { n: days }), "success");
        },
      });
    });
  });

  // Podsetnik za gume: "Zakaži sada" → forma za servis tipa "Gume"
  document.querySelectorAll(".btn-tire-schedule").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const vehicle = dashboardVehicles.find(v => v.id === btn.dataset.vehicle);
      if (!vehicle) return;
      await openServiceForm(vehicle, null, { serviceType: "tires" }, {
        onSaved: () => loadDashboardData(),
      });
    });
  });

  // Podsetnik za gume: "Podseti me kasnije" → za koliko dana, ili trajno
  document.querySelectorAll(".btn-tire-snooze").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const vehicleId = btn.dataset.vehicle;
      openSnoozeModal({
        permanent: true,
        onPick: async (days) => {
          const ref = doc(db, "companies", S.companyId, "vehicles", vehicleId);
          const v = dashboardVehicles.find(x => x.id === vehicleId);
          if (days === "forever") {
            await updateDoc(ref, { tireReminderDisabled: true });
            if (v) v.tireReminderDisabled = true;
            showToast(t("tire_snoozed_forever_toast"), "success");
          } else {
            const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
            await updateDoc(ref, { tireReminderSnoozedUntil: until });
            if (v) v.tireReminderSnoozedUntil = until;
            showToast(t("tire_snoozed_toast", { n: days }), "success");
          }
        },
      });
    });
  });

  // Klik na nadolazeći servis u panelu → detalji vozila, tab "Servisna istorija"
  // (za podsetnik o gumama: tab "Bezbednost", gde se vide pneumatici)
  document.querySelectorAll("[data-vehicle-id]").forEach(item => {
    item.addEventListener("click", () => {
      const vehicleId = item.dataset.vehicleId;
      if (!vehicleId) return;
      const vehicleTab = item.dataset.vehicleTab || "service";
      S.activeTab = "vehicles";
      document.querySelectorAll(".nav-btn").forEach(btn => {
        btn.classList.toggle("nav-btn--active", btn.dataset.tab === "vehicles");
      });
      openVehicleDetail(vehicleId, vehicleTab, null, () => navigateTo("dashboard"));
    });
  });
}

// Zajednički prozor "Podseti me kasnije": pita za koliko dana odložiti
// (opciono i "Trajno"). onPick(days | "forever") snima odluku.
function openSnoozeModal({ permanent = false, onPick }) {
  const opts = [1, 3, 7, 14];
  openModal(t("svc_rem_snooze"), `
    <div class="form-group">
      <label class="form-label">${t("tire_snooze_question")}</label>
      <select id="snooze-days" class="form-select">
        ${opts.map(n => `<option value="${n}" ${n === 3 ? "selected" : ""}>${t("tire_snooze_opt_" + n)}</option>`).join("")}
        ${permanent ? `<option value="forever">${t("tire_snooze_opt_forever")}</option>` : ""}
      </select>
      ${permanent ? `<div class="form-hint">${t("tire_snooze_forever_hint")}</div>` : ""}
    </div>
  `, async () => {
    const raw = document.getElementById("snooze-days")?.value;
    const pick = raw === "forever" ? "forever" : (parseInt(raw, 10) || 1);
    try {
      await onPick(pick);
      loadDashboardData();
      return true;
    } catch (err) {
      showToast(`${t("error")}: ${err.message}`, "error");
      return false;
    }
  });
}

function formatDate(date) {
  return formatDateDMY(date);
}

