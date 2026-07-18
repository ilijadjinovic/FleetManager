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
import { isVehicleRegistered, needsTachograph, openVehicleDetail, fuelLevelScaleHTML, bindFuelLevelScale, fuelLevelLabel } from "./vehicles.js";
import { mountPendingBanner } from "./pending-requests.js";
import { effectiveServiceStatus, isServiceToday, isServiceOverdue, overdueDays, SERVICE_STATUS } from "./service-status.js";
import { openIncidentForm } from "./incidents.js";
import { tripEntryCard } from "./trips.js";

// ── STANJE MODULA: aktivno zaduženje trenutnog vozača ─────────
// Vozač može imati VIŠE aktivnih zaduženja istovremeno (npr. dva
// vozila u isto vreme) — assignmentsState čuva podatke za svako od
// njih. activeAssignment/activeVehicle/activeTrip/tripEntries su
// "trenutno selektovani" pokazivači — postave se na konkretno
// zaduženje neposredno pre bilo koje akcije (dugme, km potvrda...)
// preko selectAssignment(), tako da sav postojeći kod ispod (forme,
// čuvanje unosa, razduženje) ostaje nepromenjen i radi nad ispravnim
// zaduženjem.
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

    content.innerHTML = `
      ${isDriver ? renderDriverDashboard(assignmentsSnap, allAssignmentsSnap, allEntriesSnap, vehicles, resolvedActiveTrips) : renderAdminDashboard({
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

function renderDriverDashboard(assignmentsSnap, allAssignmentsSnap, allEntriesSnap, vehicles, resolvedActiveTrips) {
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

  return blocksHTML;
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
        : entries.map(e => tripEntryCard(e)).join("")
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

    try {
      const updateData = {
        kmConfirmed:      true,
        kmConfirmedValue: systemKm,
        kmConfirmedAt:    serverTimestamp(),
        updatedAt:        serverTimestamp(),
      };
      if (fuelLevel) updateData.fuelLevelConfirmedValue = fuelLevel;

      const fuelMismatch = !!(fuelLevel && activeVehicle?.fuelLevel && fuelLevel !== activeVehicle.fuelLevel);
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
      tripId:       activeTrip?.id || null,
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
      tripId:       activeTrip?.id || null,
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
  const endDate   = document.getElementById("du-endDate")?.value;
  const endKm     = parseFloat(document.getElementById("du-endKm")?.value);
  const notes     = document.getElementById("du-notes")?.value.trim();
  const fuelLevel = document.getElementById("du-fuelLevel")?.value || null;

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
        fuelLevel,
        unassignNotes: notes || null,
        closedByDriver: true,
        updatedAt:     serverTimestamp(),
      }
    );

    const vehicleUpdate = {
      currentKm:          endKm,
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
      : tripEntries.map(e => tripEntryCard(e)).join("");
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

