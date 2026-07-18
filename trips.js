// ============================================================
//  trips.js  —  Fleet Manager
//  Tab: Moje vožnje (vozački tab)
//  Prikazuje istoriju vožnji (zatvorena zaduženja).
//  Aktivno zaduženje i unosi tokom njega su na tabu "Pregled"
//  (vidi dashboard.js).
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, orderBy, getDocs, where
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t, getCurrentLang } from "./i18n.js";
import { S } from "./app.js";
import { fuelLevelLabel, fuelLevelColorClass } from "./vehicles.js";

// ── GLAVNI RENDER ─────────────────────────────────────────────
export async function renderTrips(container) {
  container.innerHTML = `<div class="loading">${t("loading")}</div>`;

  // Fleet admin / master admin vide sve vožnje
  if (S.profile?.role !== "driver") {
    await renderAdminView(container);
    return;
  }

  // Vozač vidi istoriju svojih zaduženja (aktivno zaduženje je na tabu "Pregled")
  await renderDriverHistoryView(container);
}

// ── VOZAČKI PRIKAZ: ISTORIJA VOŽNJI ────────────────────────────
async function renderDriverHistoryView(container) {
  const { pastAssignments, tripsByAssignment, entriesByTrip, entriesByAssignment } = await loadTripHistory();

  if (pastAssignments.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">📋</div>
        <h3>${t("trip_history_title")}</h3>
        <p>${t("no_data")}</p>
      </div>
    `;
    return;
  }

  container.innerHTML = renderHistorySection(pastAssignments, tripsByAssignment, entriesByTrip, entriesByAssignment);
  attachAssignmentHistoryEvents(container);
}

// ── UČITAJ ISTORIJU ZADUŽENJA (zatvorena + aktivna sa bar jednom
//    zatvorenom vožnjom) + VOŽNJE + SVE UNOSE ──────────────────
async function loadTripHistory() {
  const { assignments, tripsByAssignment, entriesByTrip, entriesByAssignment } =
    await loadDriverAssignmentHistory({
      primaryField: "driverUid", primaryValue: S.user.uid,
      fallbackField: "driverId", fallbackValue: S.profile?.driverId,
    });

  // Zaduženje se prikazuje ovde ako je zatvoreno, ILI ako je i dalje
  // aktivno ali već ima bar jednu ZATVORENU vožnju unutar sebe — inače
  // bi ta zatvorena vožnja ostala nevidljiva sve dok se ne zatvori celo
  // zaduženje (npr. vozač zatvori vožnju da bi krenuo na sledeću, ali
  // vozilo ostaje zaduženo). Zaduženje koje ima SAMO trenutnu, još
  // otvorenu vožnju ostaje isključivo na tabu "Pregled" — ovde bi bilo
  // prazno i zbunjujuće.
  const pastAssignments = assignments.filter(a => {
    if (a.status === "closed") return true;
    const trips = tripsByAssignment[a.id] || [];
    return trips.some(tr => tr.status === "closed");
  });

  return { pastAssignments, tripsByAssignment, entriesByTrip, entriesByAssignment };
}

// ── GENERALIZOVANI UČITAVAČ ISTORIJE (koristi ga i drivers.js za
//    prikaz zaduženja/vožnji konkretnog vozača iz admin panela) ───
// Podaci su istorijski mešoviti — neki dokumenti imaju popunjen
// driverUid, neki samo driverId (npr. prva vožnja koju admin auto-
// matski kreira uz zaduženje, kod vozača bez lokalnog/Google naloga
// u tom trenutku). Zato se OBA upita uvek pokreću i rezultati
// spajaju (bez duplikata po id-ju) — raniji "sve ili ništa" fallback
// (pokušaj fallbackField SAMO ako primaryField vrati 0 rezultata)
// je tiho gubio dokumente koji su se poklapali samo po jednom od ta
// dva polja, čim bi bar jedan dokument uspešno pogodio primaryField.
export async function loadDriverAssignmentHistory({ primaryField, primaryValue, fallbackField, fallbackValue }) {
  async function fetchWithFallback(collName, orderField, orderDir) {
    const byId = new Map();

    async function runQuery(field, value) {
      if (!value) return;
      try {
        const snap = await getDocs(query(
          collection(db, "companies", S.companyId, collName),
          where(field, "==", value),
          orderBy(orderField, orderDir)
        ));
        snap.docs.forEach(d => byId.set(d.id, { id: d.id, ...d.data() }));
      } catch (e) {
        console.error(`fetchWithFallback(${collName}, ${field}) failed:`, e);
      }
    }

    await runQuery(primaryField, primaryValue);
    await runQuery(fallbackField, fallbackValue);

    const list = [...byId.values()];
    list.sort((a, b) => {
      const ta = toMillis(a[orderField]);
      const tb = toMillis(b[orderField]);
      return orderDir === "desc" ? tb - ta : ta - tb;
    });
    return list;
  }

  let assignments = [], trips = [], entries = [];
  try {
    assignments = await fetchWithFallback("assignments", "startDate", "desc");
    trips       = await fetchWithFallback("trips", "startDate", "asc");
    entries     = await fetchWithFallback("tripEntries", "createdAt", "asc");
  } catch (e) {
    console.error("loadDriverAssignmentHistory error:", e);
  }

  const tripsByAssignment = {};
  trips.forEach(tr => {
    if (!tr.assignmentId) return;
    (tripsByAssignment[tr.assignmentId] ||= []).push(tr);
  });

  const entriesByTrip = {};
  const entriesByAssignment = {};
  entries.forEach(e => {
    if (e.assignmentId) (entriesByAssignment[e.assignmentId] ||= []).push(e);
    if (e.tripId) (entriesByTrip[e.tripId] ||= []).push(e);
  });
  // Upiti su rastuće po datumu — okreni svaku grupu da bude najnovije prvo.
  Object.values(entriesByAssignment).forEach(list => list.reverse());
  Object.values(entriesByTrip).forEach(list => list.reverse());

  return { assignments, tripsByAssignment, entriesByTrip, entriesByAssignment };
}

// ── ISTORIJA VOŽNJI — grupisano po mesecu, na osnovu startDate ──
function renderHistorySection(pastAssignments, tripsByAssignment, entriesByTrip, entriesByAssignment) {
  const locale = getCurrentLang() === "en" ? "en-GB" : "sr-RS";

  // Grupiši po mesecu/godini početka zaduženja (startDate)
  const groups = new Map(); // "YYYY-MM" -> { date, items: [] }
  pastAssignments.forEach(a => {
    const d = toJsDate(a.startDate);
    const key = d ? `${d.getFullYear()}-${String(d.getMonth()).padStart(2, "0")}` : "unknown";
    if (!groups.has(key)) groups.set(key, { date: d, items: [] });
    groups.get(key).items.push(a);
  });

  // Meseci od najnovijeg ka najstarijem ("unknown" ide na kraj)
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return b.localeCompare(a);
  });

  return `
    <div class="trip-history-header">
      <h3>${t("trip_history_title")}</h3>
    </div>
    ${sortedKeys.map(key => {
      const group = groups.get(key);
      const monthLabel = group.date
        ? capitalizeFirst(group.date.toLocaleDateString(locale, { month: "long", year: "numeric" }))
        : t("no_data");
      // Unutar meseca, sortiraj od najnovije ka najstarijoj vožnji
      const items = [...group.items].sort((x, y) => {
        const dx = toJsDate(x.startDate), dy = toJsDate(y.startDate);
        return (dy?.getTime() || 0) - (dx?.getTime() || 0);
      });
      return `
        <div class="trip-history-month">
          <div class="trip-history-month__label">${monthLabel}</div>
          <div class="trip-history-list">
            ${items.map(a => historyAssignmentCard(a, tripsByAssignment, entriesByTrip, entriesByAssignment)).join("")}
          </div>
        </div>
      `;
    }).join("")}
  `;
}

function capitalizeFirst(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

// ── ISTORIJA — kartica ZADUŽENJA (klik = proširi listu vožnji) ──
// Eksportovano — koristi ga i drivers.js za identičan prikaz u admin
// panelu (tab "Zaduženja" kod konkretnog vozača).
export function historyAssignmentCard(a, tripsByAssignment, entriesByTrip, entriesByAssignment) {
  const assignmentEntries = entriesByAssignment[a.id] || [];

  let trips = (tripsByAssignment[a.id] || []).slice().sort((x, y) => {
    const dx = toJsDate(x.startDate), dy = toJsDate(y.startDate);
    return (dx?.getTime() || 0) - (dy?.getTime() || 0);
  });

  // Zaduženje bez zabeleženih pojedinačnih vožnji (npr. iz perioda pre
  // uvođenja koncepta "vožnji") — tretiraj celo zaduženje kao jednu vožnju,
  // da ništa ne "nestane" iz istorije.
  if (trips.length === 0) {
    trips = [{
      id: `legacy-${a.id}`, _legacy: true,
      startDate: a.startDate, endDate: a.endDate,
      startKm: a.startKm, endKm: a.endKm, fuelLevel: a.fuelLevel || null,
      tripType: a.tripType, destination: a.destination, route: a.route,
      reason: a.reason, notes: a.unassignNotes || null, status: a.status,
    }];
  }

  // Unosi bez tripId (nastali pre uvođenja vožnji) — pripoji ih prvoj
  // vožnji da se ne bi izgubili iz prikaza.
  const orphanEntries = assignmentEntries.filter(e => !e.tripId);

  const km = trips.reduce((s, tr) =>
    s + ((tr.endKm != null && tr.startKm != null) ? (tr.endKm - tr.startKm) : 0), 0);
  const fuelEntries   = assignmentEntries.filter(e => e.type === "fuel");
  const totalFuelL    = fuelEntries.reduce((s, e) => s + (e.fuelAmount || 0), 0);
  const totalFuelCost = fuelEntries.reduce((s, e) => s + (e.fuelCost || 0), 0);
  const totalOtherCost = assignmentEntries
    .filter(e => ["toll", "parking", "washing", "other_cost"].includes(e.type))
    .reduce((s, e) => s + (e.amount || 0), 0);
  const incidentCount = assignmentEntries.filter(e => ["fault", "damage", "accident"].includes(e.type)).length;

  // Ukupna km od-do za CELO zaduženje: početna km prve vožnje i krajnja
  // km poslednje (trips je već hronološki sortiran gore).
  const firstTrip = trips[0];
  const lastTrip   = trips[trips.length - 1];
  const assignmentStartKm = firstTrip?.startKm ?? a.startKm ?? null;
  const assignmentEndKm   = lastTrip?.endKm ?? a.endKm ?? null;

  return `
    <div class="assignment-history-card ${a.status !== "closed" ? "assignment-history-card--active" : ""}">
      <div class="assignment-history-card__header" data-toggle-assignment>
        <div>
          <div class="trip-history-card__vehicle">
            🚗 <strong>${a.vehicleBrand || ""} ${a.vehicleModel || ""}</strong> — ${a.vehiclePlate || ""}
          </div>
          <div class="trip-history-card__dates">📅 ${formatDate(a.startDate)} → ${a.status === "closed" ? formatDate(a.endDate) : t("assignment_status_active")}</div>
          <div class="trip-history-card__km-range">
            🛣️ ${assignmentStartKm?.toLocaleString() ?? "—"} → ${assignmentEndKm != null ? assignmentEndKm.toLocaleString() : t("assignment_status_active")} km
          </div>
        </div>
        <div class="trip-history-card__summary">
          ${a.status !== "closed" ? `<span class="trip-history-badge trip-history-badge--active">🟢 ${t("assignment_status_active")}</span>` : ""}
          <span class="trip-history-badge">🔑 ${trips.length} ${t("driver_trips_count")}</span>
          ${incidentCount > 0 ? `<span class="trip-history-badge trip-history-badge--warn">⚠️ ${incidentCount}</span>` : ""}
          <span class="trip-history-card__chevron">▾</span>
        </div>
      </div>

      <div class="assignment-history-card__trips hidden">
        ${trips.map((trip, idx) => {
          const entries = trip._legacy
            ? assignmentEntries
            : [...(entriesByTrip[trip.id] || []), ...(idx === 0 ? orphanEntries : [])];
          return tripHistoryCard(trip, entries, idx + 1);
        }).join("")}
      </div>

      <div class="assignment-history-summary">
        <div class="assignment-history-summary__item">
          <span class="assignment-history-summary__value">${km.toLocaleString()} km</span>
          <span class="assignment-history-summary__label">${t("assignment_summary_km")}</span>
        </div>
        <div class="assignment-history-summary__item">
          <span class="assignment-history-summary__value">${totalFuelL.toFixed(1)} L</span>
          <span class="assignment-history-summary__label">${t("trip_stats_fuel")}</span>
        </div>
        <div class="assignment-history-summary__item">
          <span class="assignment-history-summary__value">${(totalFuelCost + totalOtherCost).toLocaleString()} RSD</span>
          <span class="assignment-history-summary__label">${t("assignment_summary_costs")}</span>
        </div>
        <div class="assignment-history-summary__item ${incidentCount > 0 ? "assignment-history-summary__item--warn" : ""}">
          <span class="assignment-history-summary__value">${incidentCount}</span>
          <span class="assignment-history-summary__label">${t("trip_stats_incidents")}</span>
        </div>
      </div>
    </div>
  `;
}

// ── ISTORIJA — kartica JEDNE VOŽNJE (klik = detalji/unosi) ─────
function tripHistoryCard(trip, entries, index) {
  const km = (trip.endKm != null && trip.startKm != null) ? (trip.endKm - trip.startKm) : null;

  const fuelEntries = entries.filter(e => e.type === "fuel");
  const costEntries  = entries.filter(e => ["toll", "parking", "washing", "other_cost"].includes(e.type));
  const incEntries   = entries.filter(e => ["fault", "damage", "accident", "other"].includes(e.type));

  const badges = [
    fuelEntries.length > 0 ? `<span class="trip-history-badge">⛽ ${fuelEntries.length}</span>` : "",
    costEntries.length > 0 ? `<span class="trip-history-badge">🛣️ ${costEntries.length}</span>` : "",
    incEntries.length > 0 ? `<span class="trip-history-badge trip-history-badge--warn">⚠️ ${incEntries.length}</span>` : "",
  ].filter(Boolean).join("");

  return `
    <div class="trip-history-card">
      <div class="trip-history-card__header" data-toggle-trip>
        <div>
          <div class="trip-history-card__vehicle">🔑 ${t("driver_trip_label")} ${index}</div>
          <div class="trip-history-card__dates">📅 ${formatDate(trip.startDate)} → ${trip.endDate ? formatDate(trip.endDate) : t("assignment_status_active")}</div>
          <div class="trip-history-card__km-range">
            🛣️ ${trip.startKm?.toLocaleString() ?? "—"} → ${trip.endKm != null ? trip.endKm.toLocaleString() : t("assignment_status_active")} km
          </div>
        </div>
        <div class="trip-history-card__summary">
          ${badges}
          <span class="trip-history-card__chevron">▾</span>
        </div>
      </div>

      <div class="trip-history-card__details hidden">
        <div class="trip-history-card__km">
          🛣️ ${trip.startKm?.toLocaleString() ?? "—"} → ${trip.endKm?.toLocaleString() ?? "—"} km
          ${km != null ? `<strong> (${km.toLocaleString()} km)</strong>` : ""}
        </div>
        ${trip.fuelLevel ? `<div class="trip-history-card__fuel">⛽ <span class="fuel-level-text--${fuelLevelColorClass(trip.fuelLevel)}">${fuelLevelLabel(trip.fuelLevel)}</span></div>` : ""}
        ${trip.tripType === "intercity" && trip.destination ? `<div class="trip-history-card__dest">📍 ${trip.destination}</div>` : ""}
        ${trip.reason ? `<div class="trip-history-card__reason">${trip.reason}</div>` : ""}
        ${trip.notes ? `<div class="trip-history-card__notes">${trip.notes}</div>` : ""}

        ${entries.length === 0
          ? `<p class="trip-history-card__empty">${t("trip_no_entries")}</p>`
          : `<div class="trip-history-card__entries">${entries.map(e => historyEntryItem(e)).join("")}</div>`
        }
      </div>
    </div>
  `;
}

// ── Pojedinačan unos unutar razvijene kartice istorije ─────────
function historyEntryItem(entry) {
  if (entry.type === "fuel") {
    return `
      <div class="trip-history-entry">
        <span>⛽ ${t("trip_entry_fuel")}</span>
        <span>${entry.fuelAmount ?? "—"} L${entry.fuelCost ? ` / ${entry.fuelCost.toLocaleString()} RSD` : ""}</span>
        ${entry.fuelStation ? `<span>🏪 ${entry.fuelStation}</span>` : ""}
        ${entry.currentKm ? `<span>🛣️ ${entry.currentKm.toLocaleString()} km</span>` : ""}
        <span class="trip-history-entry__date">${formatDate(entry.createdAt)}</span>
      </div>
    `;
  }
  if (["toll", "parking", "washing", "other_cost"].includes(entry.type)) {
    const costIcons  = { toll: "🛣️", parking: "🅿️", washing: "🚿", other_cost: "📋" };
    const costLabels = { toll: t("trip_entry_toll"), parking: t("trip_entry_parking"), washing: t("trip_entry_washing"), other_cost: t("trip_entry_cost") };
    return `
      <div class="trip-history-entry">
        <span>${costIcons[entry.type] || "📋"} ${costLabels[entry.type] || entry.type}</span>
        <span><strong>${entry.amount?.toLocaleString() ?? "—"} RSD</strong></span>
        ${entry.location ? `<span>📍 ${entry.location}</span>` : ""}
        ${entry.currentKm ? `<span>🛣️ ${entry.currentKm.toLocaleString()} km</span>` : ""}
        <span class="trip-history-entry__date">${formatDate(entry.createdAt)}</span>
      </div>
    `;
  }
  // fault / damage / accident / other
  const typeIcons = { fault: "🔧", damage: "💥", accident: "🚨", other: "📋" };
  return `
    <div class="trip-history-entry">
      <span>${typeIcons[entry.type] || "⚠️"} ${t("incident_" + entry.type) || entry.type}</span>
      ${entry.description ? `<span>${entry.description}</span>` : ""}
      ${entry.currentKm ? `<span>🛣️ ${entry.currentKm.toLocaleString()} km</span>` : ""}
      <span class="trip-history-entry__date">${formatDate(entry.createdAt)}</span>
    </div>
  `;
}

// Klik na header kartice ZADUŽENJA → toggluje listu vožnji;
// klik na header kartice VOŽNJE → toggluje njene detalje/unose.
// Eksportovano — koristi ga i drivers.js (admin prikaz vozača).
export function attachAssignmentHistoryEvents(container = document) {
  container.querySelectorAll("[data-toggle-assignment]").forEach(header => {
    header.addEventListener("click", () => {
      const tripsBox = header.parentElement.querySelector(".assignment-history-card__trips");
      tripsBox?.classList.toggle("hidden");
      header.classList.toggle("assignment-history-card__header--open");
    });
  });
  container.querySelectorAll("[data-toggle-trip]").forEach(header => {
    header.addEventListener("click", (e) => {
      e.stopPropagation();
      const details = header.parentElement.querySelector(".trip-history-card__details");
      details?.classList.toggle("hidden");
      header.classList.toggle("trip-history-card__header--open");
    });
  });
}

function toJsDate(val) {
  if (!val) return null;
  const d = val.toDate ? val.toDate() : new Date(val);
  return isNaN(d) ? null : d;
}

function toMillis(val) {
  if (!val) return 0;
  if (val.toMillis) return val.toMillis();
  const d = new Date(val);
  return isNaN(d) ? 0 : d.getTime();
}

// ── ENTRY CARD ────────────────────────────────────────────────
// Eksportovano — koristi ga i dashboard.js za prikaz unosa tokom
// aktivne vožnje na tabu "Pregled".
export function tripEntryCard(entry) {
  const typeConfig = {
    fuel:       { icon: "⛽", label: t("trip_entry_fuel"),   color: "info" },
    toll:       { icon: "🛣️", label: t("trip_entry_toll"),   color: "inactive" },
    parking:    { icon: "🅿️", label: t("trip_entry_parking"), color: "inactive" },
    washing:    { icon: "🚿", label: t("trip_entry_washing"), color: "inactive" },
    other_cost: { icon: "📋", label: t("trip_entry_cost"),   color: "inactive" },
    fault:      { icon: "🔧", label: t("incident_fault"),   color: "service" },
    damage:     { icon: "💥", label: t("incident_damage"),  color: "broken" },
    accident:   { icon: "🚨", label: t("incident_accident"),color: "broken" },
    other:      { icon: "📋", label: t("incident_other"),   color: "inactive" },
  };

  const cfg = typeConfig[entry.type] || { icon: "📋", label: entry.type, color: "inactive" };

  return `
    <div class="trip-entry-card">
      <div class="trip-entry-card__type">
        <span class="trip-entry-card__icon">${cfg.icon}</span>
        <span class="badge badge--${cfg.color}">${cfg.label}</span>
      </div>
      <div class="trip-entry-card__content">
        ${entry.type === "fuel" ? `
          <div class="trip-entry-card__main">
            <strong>${entry.fuelAmount} L</strong> ${entry.fuelType ? t("fuel_" + entry.fuelType) : ""}
            — <strong>${entry.fuelCost?.toLocaleString()} RSD</strong>
            ${entry.pricePerL ? `(${entry.pricePerL.toFixed(2)} RSD/L)` : ""}
          </div>
          <div class="trip-entry-card__sub">
            🏪 ${entry.fuelStation}
            ${entry.receiptNo ? ` · ${t("trip_fuel_receipt")}: ${entry.receiptNo}` : ""}
            ${entry.currentKm ? ` · ${entry.currentKm.toLocaleString()} km` : ""}
          </div>
        ` : entry.type === "toll" || entry.type === "parking" || entry.type === "washing" || entry.type === "other_cost" ? `
          <div class="trip-entry-card__main">
            <strong>${entry.amount?.toLocaleString()} RSD</strong>
          </div>
          ${entry.location ? `<div class="trip-entry-card__sub">📍 ${entry.location}</div>` : ""}
          ${entry.receiptNo ? `<div class="trip-entry-card__sub">${t("trip_fuel_receipt")}: ${entry.receiptNo}</div>` : ""}
          ${entry.currentKm ? `<div class="trip-entry-card__sub">🛣️ ${entry.currentKm.toLocaleString()} km</div>` : ""}
        ` : `
          <div class="trip-entry-card__main">${entry.description || ""}</div>
          ${entry.location ? `<div class="trip-entry-card__sub">📍 ${entry.location}</div>` : ""}
          ${entry.currentKm ? `<div class="trip-entry-card__sub">🛣️ ${entry.currentKm.toLocaleString()} km</div>` : ""}
        `}
        ${entry.notes ? `<div class="trip-entry-card__notes">${entry.notes}</div>` : ""}
      </div>
      <div class="trip-entry-card__date">${formatDate(entry.createdAt)}</div>
    </div>
  `;
}

// ── ADMIN PRIKAZ ──────────────────────────────────────────────
async function renderAdminView(container) {
  if (!S.companyId) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🏢</div><p>${t("company_select")}</p></div>`;
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">${t("trip_admin_title")}</h2>
    </div>
    <div class="filter-bar">
      <div class="search-bar">
        <span class="search-bar__icon">🔍</span>
        <input id="admin-trips-search" type="text" class="search-bar__input form-input"
          placeholder="${t('search')}..." />
      </div>
      <div class="filter-chips">
        <button class="chip chip--active" data-afilter="all">${t("company_all")}</button>
        <button class="chip" data-afilter="fuel">⛽ ${t("trip_filter_fuel")}</button>
        <button class="chip" data-afilter="toll">🛣️ ${t("trip_filter_tolls")}</button>
        <button class="chip" data-afilter="incident">⚠️ ${t("trip_filter_incidents")}</button>
      </div>
    </div>
    <div id="admin-trips-list"><div class="loading">${t("loading")}</div></div>
  `;

  let allEntries = [];
  let adminFilter = "all";
  let adminSearch = "";

  try {
    const snap = await getDocs(query(
      collection(db, "companies", S.companyId, "tripEntries"),
      orderBy("createdAt", "desc")
    ));
    allEntries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAdminList(allEntries, adminFilter, adminSearch);
  } catch (e) {
    document.getElementById("admin-trips-list").innerHTML =
      `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }

  document.getElementById("admin-trips-search")?.addEventListener("input", (e) => {
    adminSearch = e.target.value.toLowerCase();
    renderAdminList(allEntries, adminFilter, adminSearch);
  });

  document.querySelectorAll("[data-afilter]").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-afilter]").forEach(c => c.classList.remove("chip--active"));
      chip.classList.add("chip--active");
      adminFilter = chip.dataset.afilter;
      renderAdminList(allEntries, adminFilter, adminSearch);
    });
  });
}

function renderAdminList(entries, filter, search) {
  const list = document.getElementById("admin-trips-list");
  if (!list) return;

  let filtered = entries;
  if (filter === "fuel")     filtered = filtered.filter(e => e.type === "fuel");
  if (filter === "toll")     filtered = filtered.filter(e => e.type === "toll" || e.type === "parking");
  if (filter === "incident") filtered = filtered.filter(e => ["fault","damage","accident"].includes(e.type));
  if (search) filtered = filtered.filter(e =>
    `${e.vehiclePlate} ${e.driverName} ${e.fuelStation || ""} ${e.location || ""} ${e.description || ""}`
      .toLowerCase().includes(search)
  );

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state__icon">📋</div><p>${t("no_data")}</p></div>`;
    return;
  }

  list.innerHTML = `<div class="trip-entries-admin">${filtered.map(e => `
    <div class="trip-entry-admin">
      <div class="trip-entry-admin__meta">
        <span class="trip-entry-admin__plate">${e.vehiclePlate}</span>
        <span class="trip-entry-admin__driver">👤 ${e.driverName}</span>
        <span class="trip-entry-admin__date">${formatDate(e.createdAt)}</span>
      </div>
      ${tripEntryCard(e)}
    </div>
  `).join("")}</div>`;
}

// ── UTILS ─────────────────────────────────────────────────────
function formatDate(val) {
  if (!val) return "—";
  const d = val.toDate ? val.toDate() : new Date(val);
  const locale = getCurrentLang() === "en" ? "en-GB" : "sr-RS";
  return isNaN(d) ? "—" : d.toLocaleDateString(locale);
}

