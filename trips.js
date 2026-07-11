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
  const { pastAssignments, entriesByAssignment } = await loadTripHistory();

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

  container.innerHTML = renderHistorySection(pastAssignments, entriesByAssignment);
  attachDriverHistoryEvents();
}

// ── UČITAJ ISTORIJU ZADUŽENJA (zatvorena) + SVE UNOSE VOZAČA ──
async function loadTripHistory() {
  let allAssignments = [];
  let allEntries     = [];

  try {
    let assignmentsSnap = await getDocs(query(
      collection(db, "companies", S.companyId, "assignments"),
      where("driverUid", "==", S.user.uid),
      orderBy("startDate", "desc")
    )).catch(() => ({ docs: [] }));

    if (assignmentsSnap.docs.length === 0 && S.profile?.driverId) {
      assignmentsSnap = await getDocs(query(
        collection(db, "companies", S.companyId, "assignments"),
        where("driverId", "==", S.profile.driverId),
        orderBy("startDate", "desc")
      )).catch(() => ({ docs: [] }));
    }
    allAssignments = assignmentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const entriesSnap = await getDocs(query(
      collection(db, "companies", S.companyId, "tripEntries"),
      where("driverUid", "==", S.user.uid),
      orderBy("createdAt", "asc")
    )).catch(() => ({ docs: [] }));
    allEntries = entriesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  } catch (e) {
    console.error("loadTripHistory error:", e);
  }

  const entriesByAssignment = {};
  allEntries.forEach(e => {
    if (!e.assignmentId) return;
    (entriesByAssignment[e.assignmentId] ||= []).push(e);
  });
  // Upit je rastuće po datumu — okreni svaku grupu da bude najnovije prvo.
  Object.values(entriesByAssignment).forEach(list => list.reverse());

  const pastAssignments = allAssignments.filter(a => a.status === "closed");

  return { pastAssignments, entriesByAssignment };
}

// ── ISTORIJA VOŽNJI — grupisano po mesecu, na osnovu startDate ──
function renderHistorySection(pastAssignments, entriesByAssignment) {
  const locale = getCurrentLang() === "en" ? "en-GB" : "sr-RS";

  // Grupiši po mesecu/godini početka vožnje (startDate)
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
            ${items.map(a => historyAssignmentCard(a, entriesByAssignment[a.id] || [])).join("")}
          </div>
        </div>
      `;
    }).join("")}
  `;
}

function capitalizeFirst(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

// ── ISTORIJA — kartica jedne vožnje (klik = detalji) ───────────
function historyAssignmentCard(a, entries) {
  const km = (a.endKm != null && a.startKm != null) ? (a.endKm - a.startKm) : null;

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
      <div class="trip-history-card__header" data-toggle-history>
        <div>
          <div class="trip-history-card__vehicle">
            🚗 <strong>${a.vehicleBrand || ""} ${a.vehicleModel || ""}</strong> — ${a.vehiclePlate || ""}
          </div>
          <div class="trip-history-card__dates">📅 ${formatDate(a.startDate)} → ${formatDate(a.endDate)}</div>
        </div>
        <div class="trip-history-card__summary">
          ${badges}
          <span class="trip-history-card__chevron">▾</span>
        </div>
      </div>

      <div class="trip-history-card__details hidden">
        <div class="trip-history-card__km">
          🛣️ ${a.startKm?.toLocaleString() ?? "—"} → ${a.endKm?.toLocaleString() ?? "—"} km
          ${km != null ? `<strong> (${km.toLocaleString()} km)</strong>` : ""}
        </div>
        ${a.tripType === "intercity" && a.destination ? `<div class="trip-history-card__dest">📍 ${a.destination}</div>` : ""}
        ${a.reason ? `<div class="trip-history-card__reason">${a.reason}</div>` : ""}
        ${a.unassignNotes ? `<div class="trip-history-card__notes">${a.unassignNotes}</div>` : ""}

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

// Klik na header kartice istorije → toggluje prikaz detalja
function attachDriverHistoryEvents() {
  document.querySelectorAll("[data-toggle-history]").forEach(header => {
    header.addEventListener("click", () => {
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

