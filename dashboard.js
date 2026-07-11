// ============================================================
//  dashboard.js  —  Fleet Manager
//  Tab: Pregled / Dashboard
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, where, getDocs, orderBy,
  doc, addDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t, getCurrentLang } from "./i18n.js";
import { S, setActiveCompany, navigateTo, showToast, openModal } from "./app.js";
import { getCompanies } from "./firebase.js";
import { isVehicleRegistered, openVehicleDetail } from "./vehicles.js";
import { mountPendingBanner } from "./pending-requests.js";
import { effectiveServiceStatus, isServiceToday, isServiceOverdue, overdueDays, SERVICE_STATUS } from "./service-status.js";
import { openIncidentForm } from "./incidents.js";
import { tripEntryCard } from "./trips.js";

// ── STANJE MODULA: aktivno zaduženje trenutnog vozača ─────────
// (koristi se za akcije na tabu "Pregled" — dodavanje goriva/troška/
// prijave, potvrdu kilometraže i razduženje)
let activeAssignment = null;
let activeVehicle    = null;
let tripEntries       = [];

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

    // Nadolazeće registracije (u sledećih 30 dana)
    const today = new Date();
    const in30 = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
    const upcomingReg = activeVehicles
      .filter(v => {
        if (!v.regExpiry) return false;
        const d = v.regExpiry.toDate ? v.regExpiry.toDate() : new Date(v.regExpiry);
        return d >= today && d <= in30;
      })
      .sort((a, b) => {
        const da = a.regExpiry.toDate ? a.regExpiry.toDate() : new Date(a.regExpiry);
        const db2 = b.regExpiry.toDate ? b.regExpiry.toDate() : new Date(b.regExpiry);
        return da - db2;
      });

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

    const mapService = (d) => {
      const s = { id: d.id, ...d.data() };
      const veh = vehicles.find(v => v.id === s.vehicleId);
      return {
        ...s,
        vehicleBrand: veh?.brand || "",
        vehicleModel: veh?.model || "",
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

    const isDriver = role === "driver";

    content.innerHTML = `
      ${isDriver ? renderDriverDashboard(assignmentsSnap, allAssignmentsSnap, allEntriesSnap, vehicles) : renderAdminDashboard({
        total, active, inService, unregistered, broken, inactive, upcomingReg, vehicles, assignedCount, upcomingScheduled, archivedCount
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

function renderAdminDashboard({ total, active, inService, unregistered, broken, inactive, upcomingReg, vehicles, assignedCount, upcomingScheduled, archivedCount }) {
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
          : upcomingReg.map(v => {
              const d = v.regExpiry.toDate ? v.regExpiry.toDate() : new Date(v.regExpiry);
              const daysLeft = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
              const urgency = daysLeft <= 7 ? "urgent" : daysLeft <= 14 ? "warning" : "ok";
              return `
                <div class="upcoming-item upcoming-item--${urgency}">
                  <div class="upcoming-item__main">
                    <span class="upcoming-item__name">${v.brand} ${v.model}</span>
                    <span class="upcoming-item__plate">${v.plate}</span>
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
        ${!upcomingScheduled || upcomingScheduled.length === 0
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
                    ${s.workshop ? `<span class="upcoming-item__plate">🔧 ${s.workshop}</span>` : ""}
                  </div>
                  <div class="upcoming-item__right">
                    <span class="upcoming-item__date">
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

function renderDriverDashboard(assignmentsSnap, allAssignmentsSnap, allEntriesSnap, vehicles) {
  const activeAssignments = assignmentsSnap?.docs?.map(d => ({ id: d.id, ...d.data() })) || [];
  const allEntries        = allEntriesSnap?.docs?.map(d => ({ id: d.id, ...d.data() })) || [];

  // Grupiši sve unose po zaduženju (jedan upit, lokalno grupisanje)
  const entriesByAssignment = {};
  allEntries.forEach(e => {
    if (!e.assignmentId) return;
    (entriesByAssignment[e.assignmentId] ||= []).push(e);
  });
  // Upit je učitan rastuće po datumu (radi ponovne upotrebe postojećeg
  // indeksa) — okreni svaku grupu da bude najnovije prvo, radi prikaza.
  Object.values(entriesByAssignment).forEach(list => list.reverse());

  // Vozač u praksi ima najviše jedno aktivno zaduženje — koristimo prvo
  // i pamtimo ga u stanju modula radi akcija (dodavanje unosa, km potvrda,
  // razduženje) koje se vezuju na DOM elemente ovog bloka.
  if (activeAssignments.length === 0) {
    activeAssignment = null;
    activeVehicle    = null;
    tripEntries       = [];
    return `
      <div class="empty-state">
        <div class="empty-state__icon">🚗</div>
        <h3>${t("trip_no_assignment")}</h3>
        <p>${t("trip_no_assignment_sub")}</p>
      </div>
    `;
  }

  activeAssignment = activeAssignments[0];
  activeVehicle    = vehicles?.find(v => v.id === activeAssignment.vehicleId) || null;
  tripEntries       = entriesByAssignment[activeAssignment.id] || [];

  return renderActiveAssignmentBlock(activeAssignment, tripEntries, activeVehicle);
}

// ── AKTIVNO ZADUŽENJE: kartica vozila, km potvrda, statistike,
//    akcije i lista unosa tokom vožnje ──────────────────────────
function renderActiveAssignmentBlock(a, entries, v) {
  const totalFuel     = entries.filter(e => e.type === "fuel").reduce((s, e) => s + (e.fuelAmount || 0), 0);
  const totalFuelCost = entries.filter(e => e.type === "fuel").reduce((s, e) => s + (e.fuelCost || 0), 0);
  const totalTolls    = entries.filter(e => e.type === "toll").reduce((s, e) => s + (e.amount || 0), 0);
  const totalOther    = entries.filter(e => e.type === "other_cost").reduce((s, e) => s + (e.amount || 0), 0);
  const incidents     = entries.filter(e => ["fault", "damage", "accident"].includes(e.type));

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
          <span class="trip-vehicle-detail__label">${t("trip_start_km_label")}</span>
          <span><strong>${a.startKm?.toLocaleString() || "—"} km</strong></span>
        </div>
        ${a.tripType === "intercity" ? `
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">${t("trip_destination_label")}</span>
          <span>📍 ${a.destination || "—"}</span>
        </div>
        ` : ""}
        ${a.reason ? `
        <div class="trip-vehicle-detail">
          <span class="trip-vehicle-detail__label">${t("trip_reason_label")}</span>
          <span>${a.reason}</span>
        </div>
        ` : ""}
      </div>

      <!-- KM POTVRDA -->
      <div class="km-confirm-box" id="km-confirm-box">
        ${kmConfirmBoxContent(a, v)}
      </div>
    </div>

    <!-- STATISTIKE -->
    <div class="trip-stats">
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
      <button class="btn btn--primary" id="btn-add-fuel">⛽ ${t("trip_fuel_btn")}</button>
      <button class="btn btn--secondary" id="btn-add-toll">🛣️ ${t("trip_cost_btn")}</button>
      <button class="btn btn--warning" id="btn-add-incident">⚠️ ${t("trip_incident_btn")}</button>
      <button class="btn btn--danger" id="btn-unassign">🔓 ${t("trip_unassign_btn")}</button>
    </div>

    <!-- LISTA UNOSA -->
    <div class="trip-entries-header">
      <h3>${t("trip_entries_header")}</h3>
    </div>
    <div id="trip-entries-list">
      ${entries.length === 0
        ? `<div class="empty-state"><div class="empty-state__icon">📋</div><p>${t("trip_no_entries")}</p></div>`
        : entries.map(e => tripEntryCard(e)).join("")
      }
    </div>
  `;
}

// Bind-uje akcije aktivnog zaduženja (km potvrda, dugmad za unos i razduženje)
// — poziva se posle upisa u DOM, samo ako postoji aktivno zaduženje.
function attachDriverActiveAssignmentEvents() {
  if (!activeAssignment) return;
  bindKmConfirm();
  document.getElementById("btn-add-fuel")?.addEventListener("click", () => openFuelForm());
  document.getElementById("btn-add-toll")?.addEventListener("click", () => openCostForm());
  document.getElementById("btn-add-incident")?.addEventListener("click", () => openIncidentForm(null, refreshEntries));
  document.getElementById("btn-unassign")?.addEventListener("click", () => openDriverUnassignForm());
}

// ── KM POTVRDA — sadržaj boksa (potvrđeno vs. forma) ───────────
function kmConfirmBoxContent(a, v) {
  const systemKm = v?.currentKm ?? a.startKm;

  if (a.kmConfirmed) {
    const val = a.kmConfirmedValue ?? systemKm;
    return `
      <div class="km-confirmed">
        ✅ ${t("trip_km_confirmed")}: <strong>${val?.toLocaleString()} km</strong>
        ${a.kmMismatch ? `<span class="km-mismatch-note">${t("trip_km_mismatch_reported")}</span>` : ""}
      </div>
    `;
  }

  return `
    <div class="km-confirm-box__label">${t("trip_km_system")}</div>
    <div class="km-confirm-box__value">${systemKm?.toLocaleString() || "—"} km</div>
    <div class="km-confirm-box__hint">${t("trip_km_confirm_hint")}</div>
    <div class="km-confirm-box__actions">
      <button class="btn btn--primary btn--sm" id="btn-confirm-km">✓ ${t("trip_km_confirm")}</button>
      <button class="btn btn--secondary btn--sm" id="btn-correct-km">✏️ ${t("trip_km_enter_actual")}</button>
    </div>
    <div id="km-correct-form" class="hidden" style="margin-top:10px">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${t("trip_km_actual_ph")}</label>
          <input id="input-actual-km" class="form-input" type="number"
            placeholder="${systemKm || ""}" />
        </div>
        <div style="display:flex;align-items:flex-end">
          <button class="btn btn--primary btn--sm" id="btn-submit-km">${t("trip_km_confirm")}</button>
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

// Upisuje novu km na vozilo (Firestore) i ažurira lokalno stanje.
async function bumpVehicleKm(newKm) {
  await updateDoc(doc(db, "companies", S.companyId, "vehicles", activeAssignment.vehicleId), {
    currentKm: newKm,
    updatedAt: serverTimestamp(),
  });
  if (activeVehicle) activeVehicle.currentKm = newKm;
  else activeVehicle = { id: activeAssignment.vehicleId, currentKm: newKm };
}

// ── KM POTVRDA ────────────────────────────────────────────────
function bindKmConfirm() {
  const systemKm = activeVehicle?.currentKm ?? activeAssignment?.startKm;

  document.getElementById("btn-confirm-km")?.addEventListener("click", async () => {
    try {
      await updateDoc(doc(db, "companies", S.companyId, "assignments", activeAssignment.id), {
        kmConfirmed:      true,
        kmConfirmedValue: systemKm,
        kmConfirmedAt:    serverTimestamp(),
        updatedAt:        serverTimestamp(),
      });
      activeAssignment.kmConfirmed      = true;
      activeAssignment.kmConfirmedValue = systemKm;
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
      return;
    }

    document.getElementById("km-confirm-box").innerHTML = `
      <div class="km-confirmed">✅ ${t("trip_km_confirmed")}: <strong>${systemKm?.toLocaleString()} km</strong></div>
    `;
  });

  document.getElementById("btn-correct-km")?.addEventListener("click", () => {
    document.getElementById("km-correct-form").classList.remove("hidden");
  });

  document.getElementById("btn-submit-km")?.addEventListener("click", async () => {
    const actualKm = Number(document.getElementById("input-actual-km")?.value);
    if (!actualKm || actualKm <= 0) return;

    const mismatch = actualKm !== systemKm;

    try {
      const updateData = {
        kmConfirmed:      true,
        kmConfirmedValue: actualKm,
        kmConfirmedAt:    serverTimestamp(),
        updatedAt:        serverTimestamp(),
      };

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

      await updateDoc(doc(db, "companies", S.companyId, "assignments", activeAssignment.id), updateData);

      activeAssignment.kmConfirmed      = true;
      activeAssignment.kmConfirmedValue = actualKm;
      if (mismatch) activeAssignment.kmMismatch = true;

      if (mismatch) showToast(t("trip_km_mismatch_reported"), "warning");
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
      return;
    }

    // Ažuriraj prikaz
    document.getElementById("km-confirm-box").innerHTML = `
      <div class="km-confirmed">
        ✅ Unesena km: <strong>${actualKm.toLocaleString()} km</strong>
        ${mismatch ? `<span class="km-mismatch-note">(razlika: ${(actualKm - systemKm).toLocaleString()} km)</span>` : ""}
      </div>
    `;
  });
}

// ── FORMA ZA TOČENJE GORIVA ───────────────────────────────────
function openFuelForm() {
  const bodyHTML = `
    <div class="form-section-title">${t("trip_fuel_header")}</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_type")} *</label>
        <select id="tf-fuelType" class="form-select">
          <option value="diesel">${t("fuel_diesel")}</option>
          <option value="petrol">${t("fuel_petrol")}</option>
          <option value="lpg">${t("fuel_lpg")}</option>
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
          placeholder="${t("trip_fuel_price_per_l_ph")}" readonly />
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

  openModal(t("trip_with_fueling"), bodyHTML, () => saveFuelEntry());

  // Auto-izračun cene po litru
  const calcPrice = () => {
    const amount = parseFloat(document.getElementById("tf-fuelAmount")?.value);
    const cost   = parseFloat(document.getElementById("tf-fuelCost")?.value);
    if (amount > 0 && cost > 0) {
      document.getElementById("tf-pricePerL").value = (cost / amount).toFixed(2);
    }
  };
  setTimeout(() => {
    document.getElementById("tf-fuelAmount")?.addEventListener("input", calcPrice);
    document.getElementById("tf-fuelCost")?.addEventListener("input", calcPrice);
  }, 100);
}

async function saveFuelEntry() {
  const fuelAmount  = parseFloat(document.getElementById("tf-fuelAmount")?.value);
  const fuelCost    = parseFloat(document.getElementById("tf-fuelCost")?.value);
  const fuelStation = document.getElementById("tf-fuelStation")?.value.trim();

  if (!fuelAmount || !fuelCost || !fuelStation) {
    showEntryError("fuel-form-error", t("required_field"));
    return;
  }

  const currentKm = validateKmInput(document.getElementById("tf-currentKm")?.value, "fuel-form-error");
  if (currentKm === null) return;

  try {
    await addDoc(collection(db, "companies", S.companyId, "tripEntries"), {
      type:         "fuel",
      assignmentId: activeAssignment.id,
      vehicleId:    activeAssignment.vehicleId,
      vehiclePlate: activeAssignment.vehiclePlate,
      driverId:     S.profile?.driverId || null,
      driverUid:    S.user.uid,
      driverName:   activeAssignment.driverName,
      fuelType:     document.getElementById("tf-fuelType")?.value,
      fuelAmount,
      fuelCost,
      pricePerL:    fuelAmount > 0 ? fuelCost / fuelAmount : null,
      fuelStation,
      receiptNo:    document.getElementById("tf-receiptNo")?.value.trim() || null,
      currentKm,
      notes:        document.getElementById("tf-notes")?.value.trim() || null,
      createdAt:    serverTimestamp(),
    });

    await bumpVehicleKm(currentKm);

    showToast(t("success"), "success");
    await refreshEntries();
  } catch (e) {
    showEntryError("fuel-form-error", `${t("error")}: ${e.message}`);
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

  try {
    await addDoc(collection(db, "companies", S.companyId, "tripEntries"), {
      type:         document.getElementById("tc-type")?.value || "other_cost",
      assignmentId: activeAssignment.id,
      vehicleId:    activeAssignment.vehicleId,
      vehiclePlate: activeAssignment.vehiclePlate,
      driverId:     S.profile?.driverId || null,
      driverUid:    S.user.uid,
      driverName:   activeAssignment.driverName,
      amount,
      receiptNo:    document.getElementById("tc-receiptNo")?.value.trim() || null,
      location:     document.getElementById("tc-location")?.value.trim() || null,
      currentKm,
      notes:        document.getElementById("tc-notes")?.value.trim() || null,
      createdAt:    serverTimestamp(),
    });

    await bumpVehicleKm(currentKm);

    showToast(t("success"), "success");
    await refreshEntries();
  } catch (e) {
    showEntryError("cost-form-error", `${t("error")}: ${e.message}`);
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
      <label class="form-label">${t("notes")}</label>
      <textarea id="du-notes" class="form-textarea" rows="2"></textarea>
    </div>
    <p id="unassign-form-error" class="login-error hidden"></p>
  `;

  openModal(t("assignment_unassign") + " " + t("assignment_vehicle").toLowerCase(), bodyHTML, () => processDriverUnassign());
  attachDateMask("du-endDate");
}

async function processDriverUnassign() {
  const endDate = document.getElementById("du-endDate")?.value;
  const endKm   = parseFloat(document.getElementById("du-endKm")?.value);
  const notes   = document.getElementById("du-notes")?.value.trim();

  if (!endDate) {
    showEntryError("unassign-form-error", t("assignment_unassign_date_required"));
    return;
  }
  const endDateObj = parseDMY(endDate);
  if (!endDateObj) {
    showEntryError("unassign-form-error", t("assignment_unassign_date_required"));
    return;
  }
  if (!endKm || endKm <= 0) {
    showEntryError("unassign-form-error", t("assignment_unassign_endkm_required"));
    return;
  }

  const lastKm = getLastKnownKm();
  if (endKm < lastKm) {
    showEntryError("unassign-form-error", `${t("trip_km_too_low")}: ${lastKm.toLocaleString()} km`);
    return;
  }

  try {
    await updateDoc(
      doc(db, "companies", S.companyId, "assignments", activeAssignment.id),
      {
        status:        "closed",
        endDate:       endDateObj,
        endKm,
        unassignNotes: notes || null,
        closedByDriver: true,
        updatedAt:     serverTimestamp(),
      }
    );

    await updateDoc(
      doc(db, "companies", S.companyId, "vehicles", activeAssignment.vehicleId),
      {
        currentKm:          endKm,
        assignedDriverName: null,
        updatedAt:          serverTimestamp(),
      }
    );

    showToast(t("unassign_success"), "success");
    activeAssignment = null;
    activeVehicle    = null;
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
  tripEntries = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const listEl = document.getElementById("trip-entries-list");
  if (listEl) {
    listEl.innerHTML = tripEntries.length === 0
      ? `<div class="empty-state"><div class="empty-state__icon">📋</div><p>${t("trip_no_entries")}</p></div>`
      : tripEntries.map(e => tripEntryCard(e)).join("");
  }

  // Ažuriraj statistike
  const totalFuel     = tripEntries.filter(e => e.type === "fuel").reduce((s, e) => s + (e.fuelAmount || 0), 0);
  const totalCost     = tripEntries.reduce((s, e) => s + (e.fuelCost || 0) + (e.amount || 0), 0);
  const incidentCount = tripEntries.filter(e => ["fault","damage","accident"].includes(e.type)).length;

  document.querySelector(".trip-stats")?.replaceWith((() => {
    const div = document.createElement("div");
    div.className = "trip-stats";
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

// ── DATUMI: prikaz i unos u lokalnom formatu dd/mm/yyyy ──────
// <input type="date"> prikazuje kalendar u formatu koji zavisi od
// jezika/regije podešene u browseru korisnika, ne od jezika aplikacije,
// pa koristimo tekstualno polje sa maskom umesto toga.
function todayDMY() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Placeholder prati jezik aplikacije (dd/mm ostaje fiksno — poslovno
// pravilo firme — menja se samo naziv za "godinu": yyyy (en) / gggg (sr)).
function datePlaceholder() {
  return getCurrentLang() === "en" ? "dd/mm/yyyy" : "dd/mm/gggg";
}

function parseDMY(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

function attachDateMask(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", () => {
    const digits = el.value.replace(/\D/g, "").slice(0, 8);
    let out = digits;
    if (digits.length > 4) out = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    else if (digits.length > 2) out = `${digits.slice(0, 2)}/${digits.slice(2)}`;
    el.value = out;
  });
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

  // Klik na zakazani servis u panelu → detalji vozila, tab "Servisna istorija"
  document.querySelectorAll("[data-vehicle-id]").forEach(item => {
    item.addEventListener("click", () => {
      const vehicleId = item.dataset.vehicleId;
      if (!vehicleId) return;
      S.activeTab = "vehicles";
      document.querySelectorAll(".nav-btn").forEach(btn => {
        btn.classList.toggle("nav-btn--active", btn.dataset.tab === "vehicles");
      });
      openVehicleDetail(vehicleId, "service");
    });
  });
}

function formatDate(date) {
  if (!date) return "—";
  const d = date.toDate ? date.toDate() : (date instanceof Date ? date : new Date(date));
  const locale = getCurrentLang() === "en" ? "en-GB" : "sr-RS";
  return isNaN(d) ? "—" : d.toLocaleDateString(locale);
}

