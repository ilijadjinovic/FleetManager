// ============================================================
//  vehicles.js  —  Fleet Manager
//  Tab: Vozila — lista, kartica, forma za unos/editovanje
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, orderBy, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc, serverTimestamp,
  where
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t, getCurrentLang, formatDateDMY, formatDateTimeDMY } from "./i18n.js";
import {
  toDMY, todayDMY, parseDMY, datePlaceholder, attachDateMask,
  collectDates, setDateError, clearDateError
} from "./date-input.js";
import { S, showToast, openModal, closeModal } from "./app.js";
import { getServiceProviders, openServicerForm } from "./servicers.js";
import { scanQRCode, parseFiscalQR, fetchReceiptDetails, receiptWorkerConfigured } from "./receipt-scan.js";
import { findReceiptDuplicate, normalizeReceiptNo } from "./receipt-guard.js";
import {
  effectiveServiceStatus, isServiceToday, isServiceOverdue, overdueDays, SERVICE_STATUS,
  getServiceSettings, getRegularServiceInfo, nextServiceSummary, shiftToWorkday, isWeekend,
  cleanVehicleServiceOverrides
} from "./service-status.js";
import { incidentCard, scheduleServiceForIncident, openIncidentForm } from "./incidents.js";
import { openAdminEntryForm } from "./entry-forms.js";
import { COST_TYPES as COST_TYPES_V, COST_META as COST_META_V } from "./entries-view.js";
import { detailButton, isAdminViewer } from "./entry-details.js";
import { rememberEntry } from "./detail-registry.js";
import { esc as escDet, fmtNum as fmtNumDet, fmtRsd as fmtRsdDet, toMillis as toMsDet } from "./entries-view.js";
import {
  loadVehicleAssignmentHistory, groupAssignmentsByDriver, summarizeAssignments,
  historyAssignmentCard, historyEntryItem, attachAssignmentHistoryEvents
} from "./trips.js";

// ── PREDEFINISANE BOJE VOZILA ────────────────────────────────
const VEHICLE_COLORS = [
  "white", "black", "red", "blue", "orange",
  "green", "yellow", "light_gray", "dark_gray", "brown", "other"
];

function colorLabel(code) {
  if (!code) return null;
  return VEHICLE_COLORS.includes(code) ? t("color_" + code) : code;
}

// ── TIP VOZILA (prema obliku karoserije) ─────────────────────
const VEHICLE_TYPES = [
  "sedan", "hatchback", "wagon", "suv", "mpv", "coupe", "cabrio",
  "pickup", "van", "tipper", "platform", "tanker", "reefer", "curtain",
  "car_transporter", "bus", "motorcycle", "other"
];

function vehicleTypeLabel(code) {
  if (!code) return null;
  return VEHICLE_TYPES.includes(code) ? t("vehicle_type_" + code) : code;
}

// ── KATEGORIJA VOZILA (zvanična klasifikacija iz saobraćajne) ─
const VEHICLE_CATEGORIES = ["passenger", "van", "truck", "work_machine", "bus", "motorcycle", "trailer", "other"];

function vehicleCategoryLabel(code) {
  if (!code) return null;
  return VEHICLE_CATEGORIES.includes(code) ? t("vehicle_category_" + code) : code;
}

// ── OBAVEZNA OPREMA (bezbednost) ──────────────────────────────
const REQUIRED_EQUIPMENT_ITEMS = ["triangle", "first_aid", "vest", "tow_rope", "spare_wheel", "accident_report", "fire_extinguisher", "wheel_chocks"];

function equipmentLabel(code) {
  return REQUIRED_EQUIPMENT_ITEMS.includes(code) ? t("equipment_" + code) : code;
}

// Obavezna oprema prema kategoriji vozila (iz saobraćajne). Kategorija bez
// izbora (null) dobija punu listu da se ništa ne sakrije.
const REQUIRED_EQUIPMENT_BY_CATEGORY = {
  passenger:    ["triangle", "first_aid", "vest", "tow_rope", "spare_wheel", "accident_report"],
  van:          ["triangle", "first_aid", "vest", "tow_rope", "spare_wheel", "accident_report", "fire_extinguisher"],
  truck:        ["triangle", "first_aid", "vest", "tow_rope", "spare_wheel", "fire_extinguisher", "wheel_chocks"],
  bus:          ["triangle", "first_aid", "vest", "tow_rope", "spare_wheel", "fire_extinguisher", "wheel_chocks"],
  motorcycle:   ["first_aid"],
  trailer:      ["triangle", "wheel_chocks"],
  work_machine: ["fire_extinguisher", "first_aid"],
  other:        ["fire_extinguisher", "first_aid"],
};

// Lista obavezne opreme za datu kategoriju (redosled kao u REQUIRED_EQUIPMENT_ITEMS)
export function requiredEquipmentFor(category) {
  const list = REQUIRED_EQUIPMENT_BY_CATEGORY[category];
  if (!list) return [...REQUIRED_EQUIPMENT_ITEMS];
  return REQUIRED_EQUIPMENT_ITEMS.filter(eq => list.includes(eq));
}

// ── PNEUMATICI ─────────────────────────────────────────────────
const TIRE_TYPES = ["winter", "summer", "all_season"];

function tireTypeLabel(code) {
  if (!code) return null;
  return TIRE_TYPES.includes(code) ? t("tire_" + code) : code;
}

// ── NIVO GORIVA U REZERVOARU ───────────────────────────────────
export const FUEL_LEVELS = ["full", "3_4", "1_2", "1_4", "reserve"];

export function fuelLevelLabel(code) {
  if (!code) return null;
  return FUEL_LEVELS.includes(code) ? t("fuel_level_" + code) : code;
}

// 1/1 i 3/4 → zeleno, 1/2 → žuto, 1/4 i rezerva → crveno (isti sistem kao gume/oprema)
export function fuelLevelColorClass(code) {
  if (code === "full" || code === "3_4") return "green";
  if (code === "1_2") return "yellow";
  if (code === "1_4" || code === "reserve") return "red";
  return "";
}

// ── SEGMENTIRANA SKALA ZA NIVO GORIVA (reuse) ──────────────────
// Koristi se u formi za dodavanje/izmenu vozila, kao i svuda gde
// vozač unosi nivo goriva pri zatvaranju vožnje/zaduženja.
// hiddenId  — id skrivenog inputa koji čuva izabranu vrednost
// scaleId   — id kontejnera sa dugmićima
// currentValue — trenutno izabrana vrednost (ili null/"")
export function fuelLevelScaleHTML(hiddenId, scaleId, currentValue) {
  return `
    <input type="hidden" id="${hiddenId}" value="${currentValue || ""}" />
    <div id="${scaleId}" class="fuel-level-scale">
      ${FUEL_LEVELS.map(fl => {
        const active = (currentValue || "") === fl;
        const colorClass = fuelLevelColorClass(fl);
        return `<button type="button"
          class="fuel-level-btn fuel-level-btn--${colorClass}${active ? " fuel-level-btn--active" : ""}"
          data-value="${fl}">${fuelLevelLabel(fl)}</button>`;
      }).join("")}
    </div>
  `;
}

// Vezuje klik-handler na skalu iz fuelLevelScaleHTML(). Pozvati posle
// ubacivanja HTML-a u DOM (npr. posle openModal()).
export function bindFuelLevelScale(hiddenId, scaleId) {
  document.getElementById(scaleId)?.addEventListener("click", (e) => {
    const btn = e.target.closest(".fuel-level-btn");
    if (!btn) return;
    const value = btn.dataset.value;
    const hidden = document.getElementById(hiddenId);
    if (hidden) hidden.value = value;
    document.querySelectorAll(`#${scaleId} .fuel-level-btn`).forEach(b => {
      b.classList.toggle("fuel-level-btn--active", b === btn);
    });
  });
}

// ── OBAVEZNOST TAHOGRAFA ────────────────────────────────────────
// Teretna vozila preko 3,5t (mase), svi autobusi, i sva vozila koja
// prevoze preko 9 putnika (npr. kombi/van registrovan za >9 mesta)
// moraju imati tahograf i važeće uverenje o overi tahografa.
export function needsTachograph(v) {
  if (!v) return false;
  const mass = Number(v.mass) || 0;
  const seats = Number(v.seats) || 0;
  return v.category === "bus" || (v.category === "truck" && mass > 3500) || seats > 9;
}

export function isTachographValid(v) {
  if (!v || !v.tachographExpiry) return null; // nema unetog datuma — nepoznato
  const d = v.tachographExpiry.toDate ? v.tachographExpiry.toDate() : new Date(v.tachographExpiry);
  if (isNaN(d)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return d.getTime() >= today.getTime();
}

function tachographBadge(v) {
  const valid = isTachographValid(v);
  if (valid === null) return "";
  const label = valid ? t("vehicle_tachograph_valid") : t("vehicle_tachograph_expired");
  const cls = valid ? "badge--active" : "badge--danger";
  return `<span class="badge ${cls} badge--inline">${label}</span>`;
}

// ── STATUS REGISTRACIJE (automatski, na osnovu datuma isteka) ───
// Nezavisno od polja "status" (koje opisuje opšte stanje vozila:
// u funkciji / servis / kvar / van upotrebe). Ne čuva se u bazi —
// računa se svaki put pri prikazu, pa je uvek tačan i menja se
// sam čim datum isteka prođe, ili čim se unese novi datum.
export function isVehicleRegistered(v) {
  if (!v || !v.regExpiry) return null; // nema unetog datuma — nepoznato
  const regDate = v.regExpiry.toDate ? v.regExpiry.toDate() : new Date(v.regExpiry);
  if (isNaN(regDate)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  regDate.setHours(0, 0, 0, 0);
  return regDate.getTime() >= today.getTime();
}

function regBadge(v) {
  const reg = isVehicleRegistered(v);
  if (reg === null) return "";
  const label = reg ? t("vehicle_registered") : t("vehicle_status_unregistered");
  const cls = reg ? "badge--active" : "badge--danger";
  return `<span class="badge ${cls} badge--inline">${label}</span>`;
}

// Mali bedž sa nivoom goriva za karticu vozila — isti sistem boja
// (zeleno/žuto/crveno) kao segmentirana skala u formi za vozilo.
function fuelBadge(v) {
  if (!v.fuelLevel) return "";
  const colorToBadge = { green: "badge--active", yellow: "badge--service", red: "badge--broken" };
  const cls = colorToBadge[fuelLevelColorClass(v.fuelLevel)] || "badge--info";
  return `<span class="badge ${cls} badge--inline">⛽ ${fuelLevelLabel(v.fuelLevel)}</span>`;
}

// ── STANJE MODULA ─────────────────────────────────────────────
let allVehicles = [];
let currentFilter = "all";
let searchTerm = "";
let currentSort = "none";
let currentVehicleId = null; // za detail pogled

// ── GLAVNI RENDER ─────────────────────────────────────────────
export async function renderVehicles(container, initialFilter = null) {
  if (!S.companyId) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🏢</div><p>${t("company_select")}</p></div>`;
    return;
  }

  // Dolazak sa kontrolne table sa zadatim statusom: počni bez stare pretrage
  if (initialFilter) { currentFilter = initialFilter; searchTerm = ""; }

  const canEdit = S.profile?.role === "master_admin" || S.profile?.role === "fleet_admin";

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">${t("tab_vehicles")}</h2>
      <div class="page-header__actions">
        <div class="sort-control">
          <select id="vehicle-sort-select" class="form-input form-input--sm">
            <option value="none">${t("vehicle_sort_none")}</option>
            <option value="brand_asc">${t("vehicle_sort_brand")}</option>
            <option value="year_desc">${t("vehicle_sort_year_desc")}</option>
            <option value="year_asc">${t("vehicle_sort_year_asc")}</option>
            <option value="km_desc">${t("vehicle_sort_km")}</option>
            <option value="plate_asc">${t("vehicle_sort_plate")}</option>
          </select>
          <button id="btn-sort" class="btn btn--secondary btn--sm">${t("vehicle_sort_apply")}</button>
        </div>
        ${canEdit ? `<button id="btn-add-vehicle" class="btn btn--primary btn--sm">+ ${t("vehicle_add")}</button>` : ""}
      </div>
    </div>

    <div class="filter-bar">
      <div class="search-bar">
        <span class="search-bar__icon">🔍</span>
        <input id="vehicle-search" type="text" class="search-bar__input form-input"
          placeholder="${t("search")}..." />
      </div>
      <div class="filter-chips" id="filter-chips">
        <button class="chip ${currentFilter === 'all' ? 'chip--active' : ''}" data-filter="all">${t("company_all")}</button>
        <button class="chip ${currentFilter === 'active' ? 'chip--active' : ''}" data-filter="active">${t("vehicle_status_active")}</button>
        <button class="chip ${currentFilter === 'service' ? 'chip--active' : ''}" data-filter="service">${t("vehicle_status_service")}</button>
        <button class="chip ${currentFilter === 'broken' ? 'chip--active' : ''}" data-filter="broken">${t("vehicle_status_broken")}</button>
        <button class="chip ${currentFilter === 'inactive' ? 'chip--active' : ''}" data-filter="inactive">${t("vehicle_status_inactive")}</button>
        <button class="chip ${currentFilter === 'unregistered' ? 'chip--active' : ''}" data-filter="unregistered">${t("vehicle_status_unregistered")}</button>
        <button class="chip ${currentFilter === 'archived' ? 'chip--active' : ''}" data-filter="archived">${t("vehicle_status_archived")}</button>
      </div>
    </div>

    <div id="vehicles-list"><div class="loading">${t("loading")}</div></div>
  `;

  if (canEdit) {
    document.getElementById("btn-add-vehicle")?.addEventListener("click", () => openVehicleForm());
  }

  // Polje za pretragu mora da prikazuje isti tekst po kome je lista filtrirana
  // (inače se posle povratka iz kartice vozila vidi prazno polje, a lista je filtrirana)
  const vehicleSearchEl = document.getElementById("vehicle-search");
  if (vehicleSearchEl) vehicleSearchEl.value = searchTerm;

  document.getElementById("vehicle-search")?.addEventListener("input", (e) => {
    searchTerm = e.target.value.toLowerCase();
    renderList();
  });

  document.getElementById("filter-chips")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    document.querySelectorAll(".chip").forEach(c => c.classList.remove("chip--active"));
    chip.classList.add("chip--active");
    currentFilter = chip.dataset.filter;
    renderList();
  });

  const sortSelectEl = document.getElementById("vehicle-sort-select");
  if (sortSelectEl) sortSelectEl.value = currentSort;
  document.getElementById("btn-sort")?.addEventListener("click", () => {
    currentSort = document.getElementById("vehicle-sort-select")?.value || "none";
    renderList();
  });

  await loadVehicles();
}

// ── SORTIRANJE ──────────────────────────────────────────────────
function sortVehicles(arr) {
  const sorted = arr.slice();
  const lang = getCurrentLang() === "en" ? "en" : "sr";
  switch (currentSort) {
    case "brand_asc":
      sorted.sort((a, b) => `${a.brand || ""} ${a.model || ""}`.localeCompare(`${b.brand || ""} ${b.model || ""}`, lang));
      break;
    case "year_desc":
      sorted.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
      break;
    case "year_asc":
      sorted.sort((a, b) => (Number(a.year) || 0) - (Number(b.year) || 0));
      break;
    case "km_desc":
      sorted.sort((a, b) => (Number(b.currentKm) || 0) - (Number(a.currentKm) || 0));
      break;
    case "plate_asc":
      sorted.sort((a, b) => (a.plate || "").localeCompare(b.plate || "", lang));
      break;
    default:
      break; // "none" — zadržava se redosled iz baze (createdAt desc)
  }
  return sorted;
}

// ── UČITAJ VOZILA ─────────────────────────────────────────────
async function loadVehicles() {
  try {
    const snap = await getDocs(
      query(collection(db, "companies", S.companyId, "vehicles"), orderBy("createdAt", "desc"))
    );
    allVehicles = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
  } catch (e) {
    document.getElementById("vehicles-list").innerHTML =
      `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

// ── RENDER LISTA ──────────────────────────────────────────────
function renderList() {
  const list = document.getElementById("vehicles-list");
  if (!list) return;

  let filtered = allVehicles;
  if (currentFilter === "archived") {
    filtered = filtered.filter(v => v.archived === true);
  } else {
    // Arhivirana vozila se ne prikazuju ni u jednom drugom filteru
    // (uključujući "svi") — vidljiva su samo iza posebnog filtera.
    filtered = filtered.filter(v => v.archived !== true);
    if (currentFilter !== "all") {
      if (currentFilter === "unregistered") {
        filtered = filtered.filter(v => isVehicleRegistered(v) === false);
      } else {
        filtered = filtered.filter(v => v.status === currentFilter);
      }
    }
  }
  if (searchTerm) {
    filtered = filtered.filter(v =>
      `${v.brand} ${v.model} ${v.plate} ${v.vin}`.toLowerCase().includes(searchTerm)
    );
  }

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🚗</div><p>${t("no_data")}</p></div>`;
    return;
  }

  filtered = sortVehicles(filtered);

  // ── GRUPISANJE PO VLASNIKU ────────────────────────────────────
  // Vozila se prikazuju grupisana po vlasniku (v.ownerName) — svaki
  // vlasnik dobija svoju vizuelno odvojenu sekciju sa svojim vozilima.
  // Vozila bez unetog vlasnika idu u zajedničku grupu na kraju.
  const groupsMap = new Map();
  filtered.forEach(v => {
    const key = (v.ownerName || "").trim();
    if (!groupsMap.has(key)) groupsMap.set(key, []);
    groupsMap.get(key).push(v);
  });

  const ownerKeys = Array.from(groupsMap.keys())
    .filter(k => k !== "")
    .sort((a, b) => a.localeCompare(b, getCurrentLang() === "en" ? "en" : "sr"));
  if (groupsMap.has("")) ownerKeys.push(""); // "bez vlasnika" uvek poslednje

  list.innerHTML = `
    <div class="vehicle-table-wrap">
      ${ownerKeys.map(key => `
        <div class="vehicle-owner-group">
          <div class="vehicle-owner-group__header">
            <span class="vehicle-owner-group__icon">👤</span>
            <span class="vehicle-owner-group__name">${key || t("vehicle_no_owner")}</span>
            <span class="vehicle-owner-group__count">${groupsMap.get(key).length}</span>
          </div>
          <div class="vehicle-table">
            ${groupsMap.get(key).map(v => vehicleRow(v)).join("")}
          </div>
        </div>
      `).join("")}
    </div>
  `;

  list.querySelectorAll(".vehicle-row").forEach(row => {
    row.addEventListener("click", () => openVehicleDetail(row.dataset.id, "tech", null, null));
  });
}

// ── VEHICLE ROW (tabelarni prikaz liste) ────────────────────────
function vehicleRow(v) {
  const today = new Date();
  const regDate = v.regExpiry ? (v.regExpiry.toDate ? v.regExpiry.toDate() : new Date(v.regExpiry)) : null;
  const daysToReg = regDate ? Math.ceil((regDate - today) / 86400000) : null;
  const regWarning = daysToReg !== null && daysToReg <= 30;

  return `
    <div class="vehicle-row ${v.archived ? "vehicle-row--archived" : ""}" data-id="${v.id}">
      <div class="vehicle-row__top">
        <div class="vehicle-row__info">
          <div class="vehicle-row__name">${v.brand} ${v.model}</div>
          <div class="vehicle-row__plate">${v.plate}</div>
        </div>
        <div class="vehicle-row__badges">
          ${v.archived
            ? `<span class="badge badge--cancelled">${t("vehicle_status_archived")}</span>`
            : `<span class="badge badge--${v.status || 'active'}">${t("vehicle_status_" + (v.status || "active"))}</span>`
          }
          ${regBadge(v)}
          ${fuelBadge(v)}
        </div>
      </div>
      <div class="vehicle-row__fields">
        <div class="vehicle-row__field">
          <span class="vehicle-row__field-label">VIN</span>
          <span class="vehicle-row__field-value mono">${v.vin || "—"}</span>
        </div>
        <div class="vehicle-row__field">
          <span class="vehicle-row__field-label">${t("vehicle_current_km")}</span>
          <span class="vehicle-row__field-value">${v.currentKm ? v.currentKm.toLocaleString() + " km" : "—"}</span>
        </div>
        <div class="vehicle-row__field ${regWarning ? "vehicle-row__field--warn" : ""}">
          <span class="vehicle-row__field-label">${t("vehicle_reg_expiry")}</span>
          <span class="vehicle-row__field-value">
            ${regDate ? formatDateDMY(regDate) : "—"}
            ${regWarning ? ` <span class="reg-warn">(${daysToReg}d)</span>` : ""}
          </span>
        </div>
        <div class="vehicle-row__field">
          <span class="vehicle-row__field-label">${t("vehicle_year")}</span>
          <span class="vehicle-row__field-value">${v.year || "—"}</span>
        </div>
        ${v.assignedDriverName ? `
          <div class="vehicle-row__field">
            <span class="vehicle-row__field-label">👤</span>
            <span class="vehicle-row__field-value">${v.assignedDriverName}</span>
          </div>
        ` : ""}
      </div>
      ${v.notes ? `
        <div class="vehicle-row__notes">
          <span>📝</span> ${v.notes}
        </div>
      ` : ""}
    </div>
  `;
}

// ── DETAIL POGLED ─────────────────────────────────────────────
// initialTab — omogućava skok direktno na neki tab (npr. sa dashboarda na "service")
// Zaduženje koje treba otvoriti/istaći kad se tab "Zaduženja" učita
// (link iz liste zaduženja → vozilo → to zaduženje).
let pendingFocusAssignmentId = null;

// Kuda vraća "← Nazad" u kartici vozila: { vehicleId, fn } ili null (= lista vozila).
// Ponovno otvaranje iste kartice (npr. posle izmene) ne dira ovu vrednost.
let vehicleBack = null;

export async function openVehicleDetail(vehicleId, initialTab = "tech", focusAssignmentId = null, onBack = undefined) {
  if (onBack !== undefined) vehicleBack = onBack ? { vehicleId, fn: onBack } : null;
  pendingFocusAssignmentId = focusAssignmentId;
  currentVehicleId = vehicleId;
  let vehicle = allVehicles.find(v => v.id === vehicleId);

  // Ako vozilo nije u kešu (npr. ulazak direktno sa dashboarda, bez prethodne
  // posete tabu "Vozila"), dohvati ga direktno iz Firestore-a.
  if (!vehicle) {
    try {
      const snap = await getDoc(doc(db, "companies", S.companyId, "vehicles", vehicleId));
      if (!snap.exists()) return;
      vehicle = { id: snap.id, ...snap.data() };
      allVehicles.push(vehicle);
    } catch {
      return;
    }
  }

  const canEdit = S.profile?.role === "master_admin" || S.profile?.role === "fleet_admin";
  const container = document.getElementById("content");

  const TABS = [
    { key: "tech",        label: t("vehicle_tab_tech") },
    { key: "safety",      label: t("vehicle_tab_safety") },
    { key: "finance",     label: t("vehicle_tab_finance") },
    { key: "service",     label: t("vehicle_tab_service") },
    { key: "incidents",   label: t("vehicle_tab_incidents") },
    { key: "assignments", label: t("vehicle_tab_assignments") },
    { key: "notes",       label: t("vehicle_tab_notes") },
  ];

  const isMasterAdmin = S.profile?.role === "master_admin";

  container.innerHTML = `
    <div class="detail-header">
      <button class="btn btn--ghost btn--sm" id="btn-back">${t("vehicle_back")}</button>
      <div class="detail-header__title">
        <h2>${vehicle.brand} ${vehicle.model}</h2>
        ${vehicle.archived
          ? `<span class="badge badge--cancelled">${t("vehicle_status_archived")}</span>`
          : `<span class="badge badge--${vehicle.status || 'active'}">${t("vehicle_status_" + (vehicle.status || "active"))}</span>`
        }
      </div>
      ${canEdit ? `
        <div class="detail-header__actions">
          ${vehicle.archived ? `
            <button class="btn btn--secondary btn--sm" id="btn-unarchive-vehicle">${t("vehicle_unarchive_btn")}</button>
            ${isMasterAdmin ? `<button class="btn btn--danger btn--sm" id="btn-hard-delete-vehicle">${t("vehicle_hard_delete_btn")}</button>` : ""}
          ` : `
            <button class="btn btn--secondary btn--sm" id="btn-edit-vehicle">✏️ ${t("edit")}</button>
            <button class="btn btn--danger btn--sm" id="btn-delete-vehicle">${t("vehicle_archive_btn")}</button>
          `}
        </div>
      ` : ""}
    </div>
    ${vehicle.archived ? `<div class="empty-state" style="padding:14px;margin-bottom:14px;text-align:left;background:var(--color-surface-2);border-radius:var(--radius-md);border:1px solid var(--color-border);">${t("vehicle_archived_notice")}</div>` : ""}

    <div class="tab-strip" id="vehicle-tabs">
      ${TABS.map(tb => `
        <button class="tab-strip__btn ${tb.key === initialTab ? "tab-strip__btn--active" : ""}" data-vtab="${tb.key}">${tb.label}</button>
      `).join("")}
    </div>

    <div id="vehicle-tab-content"></div>
  `;

  document.getElementById("btn-back")?.addEventListener("click", () => {
    const back = vehicleBack?.vehicleId === vehicleId ? vehicleBack.fn : null;
    vehicleBack = null;
    if (back) back(); else renderVehicles(container);
  });
  if (canEdit) {
    document.getElementById("btn-edit-vehicle")?.addEventListener("click", () => openVehicleForm(vehicle));
    document.getElementById("btn-delete-vehicle")?.addEventListener("click", () => archiveVehicle(vehicle));
    document.getElementById("btn-unarchive-vehicle")?.addEventListener("click", () => unarchiveVehicle(vehicle));
    document.getElementById("btn-hard-delete-vehicle")?.addEventListener("click", () => confirmHardDeleteVehicle(vehicle));
  }

  document.getElementById("vehicle-tabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-strip__btn");
    if (!btn) return;
    document.querySelectorAll(".tab-strip__btn").forEach(b => b.classList.remove("tab-strip__btn--active"));
    btn.classList.add("tab-strip__btn--active");
    renderVehicleTab(btn.dataset.vtab, vehicle);
  });

  renderVehicleTab(initialTab, vehicle);
}

// ── VEHICLE TABOVI ────────────────────────────────────────────
function renderVehicleTab(tab, vehicle) {
  const content = document.getElementById("vehicle-tab-content");
  if (!content) return;

  switch (tab) {
    case "tech":     content.innerHTML = renderTechTab(vehicle); break;
    case "safety":   content.innerHTML = renderSafetyTab(vehicle); break;
    case "finance":  loadFinanceTab(content, vehicle); break;
    case "service":    loadServiceTab(content, vehicle); break;
    case "incidents":  loadIncidentsTab(content, vehicle); break;
    case "assignments": loadAssignmentsTab(content, vehicle); break;
    case "notes":    content.innerHTML = renderNotesTab(vehicle); break;
  }
}

function renderTechTab(v) {
  const rows = [
    [t("vehicle_brand"),      v.brand],
    [t("vehicle_model"),      v.model],
    [t("vehicle_type"),       vehicleTypeLabel(v.vehicleType)],
    [t("vehicle_category"),   vehicleCategoryLabel(v.category)],
    [t("vehicle_plate"),      v.plate],
    [t("vehicle_vin"),        v.vin],
    [t("vehicle_engine_code"), v.engineCode],
    [t("vehicle_year"),       v.year],
    [t("vehicle_first_reg"),  formatDate(v.firstRegDate)],
    [t("vehicle_engine_cc"),  v.engineCc ? v.engineCc + " cm³" : null],
    [t("vehicle_power_kw"),   v.powerKw ? v.powerKw + " kW" : null],
    [t("vehicle_seats"),      v.seats],
    [t("vehicle_payload"),    v.payload ? v.payload + " kg" : null],
    [t("vehicle_mass"),       v.mass ? v.mass + " kg" : null],
    [t("vehicle_fuel_type"),  v.fuelType ? t("fuel_" + v.fuelType) : null],
    [t("vehicle_fuel_level"), v.fuelLevel
      ? `<span class="fuel-level-text--${fuelLevelColorClass(v.fuelLevel)}">${fuelLevelLabel(v.fuelLevel)}</span>`
      : null],
    [t("vehicle_color"),      colorLabel(v.color)],
    [t("vehicle_current_km"), v.currentKm
      ? v.currentKm.toLocaleString() + " km"
        + (v.currentKmUpdatedAt
            ? ` <span style="color:var(--color-danger,#dc2626);font-weight:700;margin-left:16px">${formatDate(v.currentKmUpdatedAt)}</span>`
            : "")
      : null],
    [t("vehicle_reg_expiry"), `${formatDate(v.regExpiry)}${regBadge(v)}`],
    [t("vehicle_insurance_company"), v.insuranceCompany],
    [t("vehicle_insurance_policy"),  v.insurancePolicy],
    [t("vehicle_insurance_expiry"),  formatDate(v.insuranceExpiry)],
    (needsTachograph(v) || v.tachographExpiry)
      ? [t("vehicle_tachograph_expiry"), `${formatDate(v.tachographExpiry)}${tachographBadge(v)}`]
      : null,
  ].filter(Boolean);
  return detailTable(rows);
}

// ── OČEKIVANA SEZONA PNEUMATIKA ───────────────────────────────
// Zimske gume moraju biti na vozilu od 01.11. do 31.03. (meseci 11,12,1,2,3),
// letnje od 01.04. do 31.10. (meseci 4–10) tekuće godine. Pošto se period
// uvek poklapa sa punim mesecima (počinje 1., završava se poslednjim danom
// meseca), dovoljno je porediti samo mesec — bez potrebe za danom u mesecu.
function expectedTireSeason(date = new Date()) {
  const m = date.getMonth() + 1; // 1–12
  return (m === 11 || m === 12 || m <= 3) ? "winter" : "summer";
}

function renderSafetyTab(v) {
  const tireType = v.tires?.type || null;
  const tireDimensions = v.tires?.dimensions || null;

  // all_season je uvek "u redu"; za zimske/letnje poredi se sa tekućim periodom
  const tireOk = !tireType ? null : (tireType === "all_season" || tireType === expectedTireSeason());
  const tireBadgeClass = tireType ? (tireOk ? "badge--active" : "badge--broken") : "badge--inactive";

  const required = requiredEquipmentFor(v.category);
  const owned = v.requiredEquipment || [];
  const extra = owned.filter(eq => !required.includes(eq));
  const equipmentRows = required.map(eq => {
    const has = owned.includes(eq);
    const color = has ? "var(--color-success)" : "var(--color-danger)";
    return `
      <div class="detail-row">
        <div class="detail-row__label">${equipmentLabel(eq)}</div>
        <div class="detail-row__value" style="color:${color};font-weight:700">${has ? "✓ " + t("yes") : "✕ " + t("no")}</div>
      </div>
    `;
  }).join("");

  return `
    <div class="form-section-title">${t("vehicle_tires")}</div>
    <div class="detail-table">
      <div class="detail-row">
        <div class="detail-row__label">${t("vehicle_tires_type")}</div>
        <div class="detail-row__value">
          ${tireType ? `<span class="badge ${tireBadgeClass}">${tireTypeLabel(tireType)}</span>` : "—"}
        </div>
      </div>
      <div class="detail-row">
        <div class="detail-row__label">${t("vehicle_tires_dimensions")}</div>
        <div class="detail-row__value">${tireDimensions || "—"}</div>
      </div>
    </div>

    <div class="form-section-title" style="margin-top:16px">${t("vehicle_required_equipment")}${v.category ? ` — ${vehicleCategoryLabel(v.category)}` : ""}</div>
    <div class="detail-table">
      ${equipmentRows}
    </div>
    ${extra.length ? `
      <div class="form-section-title" style="margin-top:16px">${t("vehicle_equipment_extra")}</div>
      <div class="detail-table">
        <div class="detail-row"><div class="detail-row__value">${extra.map(equipmentLabel).join(", ")}</div></div>
      </div>` : ""}
  `;
}

// ── TAB "FINANSIJSKI PODACI" ──────────────────────────────────
// Zbir troškova vozila za izabrani period: gorivo, putarine, parking,
// pranje, ostali troškovi i servisi. Servisi se računaju SAMO kad su
// završeni (planirani i otkazani nisu trošak). Podaci se učitavaju jednom
// (upiti samo po vehicleId, bez složenih indeksa), a promena perioda ih
// samo filtrira u memoriji.
function financeTotals(services, entries, from, to) {
  const fromMs = from ? from.getTime() : -Infinity;
  const toMs   = to   ? to.getTime()   : Infinity;
  const inPeriod = (val) => {
    const ms = val?.toMillis ? val.toMillis() : new Date(val).getTime();
    return !isNaN(ms) && ms >= fromMs && ms <= toMs;
  };

  const sum = {
    fuelCount: 0, fuelL: 0, fuelCost: 0,
    toll: 0, parking: 0, washing: 0, cosmetics: 0, adblue: 0, other: 0,
    serviceCount: 0, serviceCost: 0, servicePlanned: 0, serviceCancelled: 0,
  };

  entries.filter(e => inPeriod(e.createdAt)).forEach(e => {
    if (e.type === "fuel") {
      sum.fuelCount++;
      sum.fuelL    += Number(e.fuelAmount) || 0;
      sum.fuelCost += Number(e.fuelCost)   || 0;
    } else if (e.type === "toll")       sum.toll    += Number(e.amount) || 0;
    else if (e.type === "parking")      sum.parking += Number(e.amount) || 0;
    else if (e.type === "washing")      sum.washing += Number(e.amount) || 0;
    else if (e.type === "cosmetics")    sum.cosmetics += Number(e.amount) || 0;
    else if (e.type === "adblue")       sum.adblue  += Number(e.amount) || 0;
    else if (e.type === "other_cost")   sum.other   += Number(e.amount) || 0;
  });

  services.filter(sv => inPeriod(sv.serviceDate)).forEach(sv => {
    const status = effectiveServiceStatus(sv);
    if (status === SERVICE_STATUS.DONE) {
      sum.serviceCount++;
      sum.serviceCost += Number(sv.cost) || 0;
    } else if (status === SERVICE_STATUS.CANCELLED) {
      sum.serviceCancelled++;
    } else {
      sum.servicePlanned++; // zakazano ili u servisu
    }
  });

  sum.total = sum.fuelCost + sum.toll + sum.parking + sum.washing + sum.cosmetics + sum.adblue + sum.other + sum.serviceCost;
  return sum;
}

function financeSummaryHTML(sum, from, to) {
  const rsd = (n) => `${Math.round(n).toLocaleString()} RSD`;
  const periodLabel = (from || to)
    ? `${from ? toDMY(from) : "…"} – ${to ? toDMY(to) : "…"}`
    : t("finance_all_period");
  const avgPrice = sum.fuelL > 0 ? `${t("finance_avg_price")}: ${(sum.fuelCost / sum.fuelL).toFixed(2)} RSD/L` : "";

  const card = (icon, label, value, sub = "") => `
    <div class="finance-card">
      <div class="finance-card__label">${icon} ${label}</div>
      <div class="finance-card__value">${value}</div>
      ${sub ? `<div class="finance-card__sub">${sub}</div>` : ""}
    </div>`;

  const skipped = [];
  if (sum.servicePlanned)   skipped.push(`${t("service_status_planned").toLowerCase()}: ${sum.servicePlanned}`);
  if (sum.serviceCancelled) skipped.push(`${t("service_status_cancelled").toLowerCase()}: ${sum.serviceCancelled}`);

  return `
    <div class="finance-period-label">📅 ${t("finance_period_label")}: <strong>${periodLabel}</strong></div>
    <div class="finance-grid">
      ${card("⛽", t("trip_entry_fuel"), rsd(sum.fuelCost),
          `${sum.fuelL.toFixed(1)} L · ${sum.fuelCount} ${t("finance_fillups")}${avgPrice ? " · " + avgPrice : ""}`)}
      ${card("🛣️", t("trip_entry_toll"),    rsd(sum.toll))}
      ${card("🅿️", t("trip_entry_parking"), rsd(sum.parking))}
      ${card("🚿", t("trip_entry_washing"), rsd(sum.washing))}
      ${card("🧴", t("trip_entry_cosmetics"), rsd(sum.cosmetics))}
      ${card("💧", t("trip_entry_adblue"),  rsd(sum.adblue))}
      ${card("📋", t("trip_entry_cost"),    rsd(sum.other))}
      ${card("🔧", t("finance_services"),   rsd(sum.serviceCost),
          `${sum.serviceCount} ${t("finance_services_done")}${skipped.length ? " · " + t("finance_services_not_counted") + " (" + skipped.join(", ") + ")" : ""}`)}
      <div class="finance-card finance-card--total">
        <div class="finance-card__label">💰 ${t("finance_total")}</div>
        <div class="finance-card__value">${rsd(sum.total)}</div>
      </div>
    </div>`;
}

// Lista pojedinačnih troškova za izabrani period (gorivo, putarine, parking,
// pranje, ostalo + servisi). Unosi su klikabilni (svi detalji), a lista se
// slaže sa zbirnim karticama iznad (isti period, isti datum = createdAt).
function financeListHTML(services, entries, from, to) {
  const fromMs = from ? from.getTime() : -Infinity;
  const toMs   = to   ? to.getTime()   : Infinity;
  const inPeriod = (val) => { const ms = toMsDet(val); return ms && ms >= fromMs && ms <= toMs; };
  const icons = { fuel: "⛽", ...Object.fromEntries(COST_TYPES_V.map(k => [k, COST_META_V[k].icon])) };
  const labels = {
    fuel: t("trip_entry_fuel"),
    ...Object.fromEntries(COST_TYPES_V.map(k => [k, t(COST_META_V[k].label)])),
  };
  const admin = isAdminViewer();

  const items = [];
  entries.filter(e => icons[e.type] && inPeriod(e.createdAt)).forEach(e => {
    rememberEntry(e);
    const isFuel = e.type === "fuel";
    const main = isFuel
      ? `${fmtNumDet(e.fuelAmount, 2)} L · ${fmtRsdDet(e.fuelCost)}`
      : fmtRsdDet(e.amount);
    const sub = [
      isFuel && e.fuelType ? t("fuel_" + e.fuelType) : null,
      isFuel && e.fuelStation ? "🏪 " + e.fuelStation : null,
      !isFuel && e.merchant ? "🏪 " + e.merchant : null,
      !isFuel && e.location ? "📍 " + e.location : null,
      e.receiptNo ? `${t("trip_fuel_receipt")}: ${e.receiptNo}` : null,
      e.driverName ? "👤 " + e.driverName : null,
    ].filter(Boolean).map(escDet).join(" · ");
    items.push({
      ms: toMsDet(e.createdAt),
      html: `
        <div class="finance-list-row${admin ? " finance-list-row--clickable" : ""}"
          ${admin ? `data-entry-id="${escDet(e.id)}" role="button" tabindex="0"` : ""}>
          <span class="finance-list-row__icon">${icons[e.type]}</span>
          <div class="finance-list-row__body">
            <div class="finance-list-row__main"><span class="badge badge--${isFuel ? "info" : "inactive"}">${labels[e.type]}</span> <strong>${main}</strong></div>
            ${sub ? `<div class="finance-list-row__sub">${sub}</div>` : ""}
          </div>
          <div class="finance-list-row__date">${formatDate(e.createdAt)}</div>
        </div>`,
    });
  });

  services.filter(sv => inPeriod(sv.serviceDate)).forEach(sv => {
    const status = effectiveServiceStatus(sv);
    const done = status === SERVICE_STATUS.DONE;
    const sub = [
      sv.workshop ? "🏭 " + sv.workshop : null,
      sv.km ? "🛣️ " + fmtNumDet(sv.km) + " km" : null,
      sv.description || null,
    ].filter(Boolean).map(escDet).join(" · ");
    items.push({
      ms: toMsDet(sv.serviceDate),
      html: `
        <div class="finance-list-row">
          <span class="finance-list-row__icon">🔧</span>
          <div class="finance-list-row__body">
            <div class="finance-list-row__main"><span class="badge badge--service">${escDet(t("service_type_" + sv.serviceType) || sv.serviceType || "")}</span>
              <strong>${done ? fmtRsdDet(sv.cost) : escDet(t("service_status_" + status))}</strong></div>
            ${sub ? `<div class="finance-list-row__sub">${sub}</div>` : ""}
          </div>
          <div class="finance-list-row__date">${formatDate(sv.serviceDate)}</div>
        </div>`,
    });
  });

  if (items.length === 0) return `<div class="empty-state"><p>${t("no_data")}</p></div>`;
  items.sort((a, b) => b.ms - a.ms);
  return `<div class="finance-list">${items.map(i => i.html).join("")}</div>`;
}

async function loadFinanceTab(container, v) {
  container.innerHTML = `<div class="loading">${t("loading")}</div>`;
  try {
    const col = (name) => collection(db, "companies", S.companyId, name);
    const [svcSnap, entSnap] = await Promise.all([
      getDocs(query(col("services"),    where("vehicleId", "==", v.id))),
      getDocs(query(col("tripEntries"), where("vehicleId", "==", v.id))),
    ]);
    const services = svcSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const entries  = entSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const rows = [
      [t("vehicle_owner"),          v.ownerName],
      [t("vehicle_purchase_date"),  formatDate(v.purchaseDate)],
      [t("vehicle_purchase_type"),  v.purchaseType],
      [t("vehicle_purchase_value"), v.purchaseValue ? Number(v.purchaseValue).toLocaleString() + " RSD" : null],
    ];

    const defaultFrom = new Date();
    defaultFrom.setDate(defaultFrom.getDate() - 30);

    const canAddEntries = S.profile?.role !== "driver" && !v.archived;
    container.innerHTML = `
      ${canAddEntries ? `
        <div class="admin-entry-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <button type="button" class="btn btn--primary btn--sm" id="btn-v-add-fuel">⛽ ${t("admin_entry_fuel_add")}</button>
          <button type="button" class="btn btn--primary btn--sm" id="btn-v-add-cost">🧾 ${t("admin_entry_cost_add")}</button>
        </div>` : ""}
      <div class="finance-period">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">${t("report_date_from")}</label>
            <input id="fin-from" class="form-input" type="text" inputmode="numeric" maxlength="10"
              placeholder="${datePlaceholder()}" value="${toDMY(defaultFrom)}" />
          </div>
          <div class="form-group">
            <label class="form-label">${t("report_date_to")}</label>
            <input id="fin-to" class="form-input" type="text" inputmode="numeric" maxlength="10"
              placeholder="${datePlaceholder()}" value="${todayDMY()}" />
          </div>
        </div>
        <div class="finance-period__actions">
          <button type="button" class="btn btn--secondary btn--sm" data-fin-preset="30">${t("finance_preset_30")}</button>
          <button type="button" class="btn btn--secondary btn--sm" data-fin-preset="year">${t("finance_preset_year")}</button>
          <button type="button" class="btn btn--secondary btn--sm" data-fin-preset="all">${t("finance_preset_all")}</button>
          <button type="button" class="btn btn--primary btn--sm" id="fin-apply">${t("finance_apply")}</button>
        </div>
      </div>

      <div id="fin-summary"></div>

      <div class="form-section-title" style="margin-top:18px">${t("finance_list_title")}</div>
      ${isAdminViewer() ? `<div class="form-hint" style="margin-bottom:8px">${t("finance_list_hint")}</div>` : ""}
      <div id="fin-list"></div>

      <div class="form-section-title" style="margin-top:18px">${t("finance_purchase_title")}</div>
      ${detailTable(rows)}
    `;

    attachDateMask("fin-from");
    attachDateMask("fin-to");
    if (canAddEntries) {
      const reload = () => loadFinanceTab(container, v);
      document.getElementById("btn-v-add-fuel")?.addEventListener("click", () => openAdminEntryForm("fuel", { vehicleId: v.id, onSaved: reload }));
      document.getElementById("btn-v-add-cost")?.addEventListener("click", () => openAdminEntryForm("cost", { vehicleId: v.id, onSaved: reload }));
    }

    const apply = () => {
      // Oba datuma su opciona: prazno "Od" = od početka, prazno "Do" = do danas i dalje
      const res = collectDates([{ id: "fin-from" }, { id: "fin-to" }]);
      if (!res.ok) return;
      const from = res.values["fin-from"];
      const to   = res.values["fin-to"];
      if (from && to && from > to) {
        setDateError("fin-to", t("date_err_range_to_before_from"), { focus: true });
        return;
      }
      if (to) to.setHours(23, 59, 59, 999);
      const sum = financeTotals(services, entries, from, to);
      document.getElementById("fin-summary").innerHTML = financeSummaryHTML(sum, from, to);
      document.getElementById("fin-list").innerHTML = financeListHTML(services, entries, from, to);
    };

    const setPeriod = (from, to) => {
      document.getElementById("fin-from").value = from ? toDMY(from) : "";
      document.getElementById("fin-to").value   = to   ? toDMY(to)   : "";
      apply();
    };

    container.querySelectorAll("[data-fin-preset]").forEach(btn => {
      btn.addEventListener("click", () => {
        const kind = btn.dataset.finPreset;
        const today = new Date();
        if (kind === "30") {
          const d = new Date(); d.setDate(d.getDate() - 30);
          setPeriod(d, today);
        } else if (kind === "year") {
          setPeriod(new Date(today.getFullYear(), 0, 1), today);
        } else {
          setPeriod(null, null); // ceo period
        }
      });
    });
    document.getElementById("fin-apply")?.addEventListener("click", apply);
    ["fin-from", "fin-to"].forEach(id =>
      document.getElementById(id)?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); apply(); }
      })
    );

    apply();
  } catch (e) {
    container.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

function renderNotesTab(v) {
  if (!v.notes) {
    return `<div class="empty-state">${t("no_data")}</div>`;
  }
  return `<div class="vehicle-notes-box">${v.notes}</div>`;
}

async function loadServiceTab(container, vehicle) {
  container.innerHTML = `<div class="loading">${t("loading")}</div>`;
  const canEdit = S.profile?.role !== "driver" && !vehicle.archived;
  try {
    const snap = await getDocs(
      query(
        collection(db, "companies", S.companyId, "services"),
        where("vehicleId", "==", vehicle.id),
        orderBy("serviceDate", "desc")
      )
    );
    const services = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Nadolazeći/u toku/propušteni servisi na vrh (najzakasneliji/najbliži
    // prvi), završeni i otkazani ispod (najskoriji prvi) — a ne prosto po
    // datumu opadajuće za sve.
    services.sort((a, b) => {
      const da = a.serviceDate?.toDate ? a.serviceDate.toDate() : new Date(a.serviceDate);
      const db_ = b.serviceDate?.toDate ? b.serviceDate.toDate() : new Date(b.serviceDate);
      const aResolved = [SERVICE_STATUS.DONE, SERVICE_STATUS.CANCELLED].includes(effectiveServiceStatus(a));
      const bResolved = [SERVICE_STATUS.DONE, SERVICE_STATUS.CANCELLED].includes(effectiveServiceStatus(b));
      if (aResolved !== bResolved) return aResolved ? 1 : -1;
      return aResolved ? (db_ - da) : (da - db_);
    });

    // Informacija o sledećem redovnom servisu (uvek vidljiva, bez obzira
    // na "odloži podsetnik" sa dashboarda).
    let nextServiceBanner = "";
    try {
      const settings = await getServiceSettings(S.companyId);
      const info = vehicle.archived ? null : getRegularServiceInfo(vehicle, services, settings);
      if (info) {
        if (info.hasOpen) {
          nextServiceBanner = `<div class="next-service-banner">🔧 <strong>${t("svc_next_regular")}:</strong> ${t("svc_next_regular_booked")}</div>`;
        } else {
          const when = t("svc_next_regular_date", { date: formatDate(info.nextDate) });
          const kmPart = info.nextKm != null ? " " + t("svc_next_regular_km", { km: info.nextKm.toLocaleString() }) : "";
          nextServiceBanner = `
            <div class="next-service-banner ${info.alarm ? "next-service-banner--alarm" : ""}">
              ${info.alarm ? "⚠️" : "🔧"} <strong>${t("svc_next_regular")}:</strong> ${when}${kmPart}
              <div class="next-service-banner__sub">${nextServiceSummary(info)}</div>
              ${info.customSettings ? `<div class="next-service-banner__custom">⚙️ ${t("svc_custom_badge")}</div>` : ""}
            </div>`;
        }
      }
    } catch (e) { /* banner je dodatak — greška ne sme da blokira tab */ }

    container.innerHTML = `
      ${nextServiceBanner}
      ${canEdit ? `<div style="margin-bottom:12px"><button class="btn btn--primary btn--sm" id="btn-add-service">+ ${t("service_add")}</button></div>` : ""}
      ${services.length === 0
        ? `<div class="empty-state"><div class="empty-state__icon">🔧</div><p>${t("no_data")}</p></div>`
        : `<div class="service-list">${services.map(s => serviceItem(s, vehicle, canEdit)).join("")}</div>`
      }
    `;

    if (canEdit) {
      document.getElementById("btn-add-service")?.addEventListener("click", () => openServiceForm(vehicle));

      container.querySelectorAll(".btn-edit-service").forEach(btn => {
        btn.addEventListener("click", () => {
          const s = services.find(x => x.id === btn.dataset.id);
          if (s) openServiceForm(vehicle, s);
        });
      });
      container.querySelectorAll(".btn-delete-service").forEach(btn => {
        btn.addEventListener("click", () => confirmDeleteService(vehicle, btn.dataset.id));
      });
      container.querySelectorAll(".btn-service-taken").forEach(btn => {
        btn.addEventListener("click", () => {
          const s = services.find(x => x.id === btn.dataset.id);
          if (s) markServiceTaken(vehicle, s);
        });
      });
      container.querySelectorAll(".btn-service-complete").forEach(btn => {
        btn.addEventListener("click", () => {
          const s = services.find(x => x.id === btn.dataset.id);
          if (s) openCompleteServiceModal(vehicle, s);
        });
      });
      container.querySelectorAll(".btn-service-cancel").forEach(btn => {
        btn.addEventListener("click", () => {
          const s = services.find(x => x.id === btn.dataset.id);
          if (s) cancelService(vehicle, s);
        });
      });
    }
  } catch (e) {
    container.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

// ── TAB "PRIJAVE" (kvarovi/oštećenja/nezgode za ovo vozilo) ────
// Isti vizuelni prikaz i logika kao u drivers.js (tab "Prijave" kod
// konkretnog vozača) — koristi se ista incidentCard komponenta.
async function loadIncidentsTab(container, vehicle) {
  container.innerHTML = `<div class="loading">${t("loading")}</div>`;
  const canEdit = S.profile?.role !== "driver" && !vehicle.archived;
  try {
    const snap = await getDocs(
      query(
        collection(db, "companies", S.companyId, "incidents"),
        where("vehicleId", "==", vehicle.id),
        orderBy("createdAt", "desc")
      )
    );
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const addBtn = canEdit
      ? `<div style="margin-bottom:12px"><button type="button" class="btn btn--warning btn--sm" id="btn-v-add-incident">⚠️ ${t("incident_add")}</button></div>`
      : "";
    container.innerHTML = addBtn + (items.length === 0
      ? `<div class="empty-state"><div class="empty-state__icon">⚠️</div><p>${t("no_data")}</p></div>`
      : `<div class="incidents-list">${items.map(i => incidentCard(i, false, canEdit)).join("")}</div>`);
    document.getElementById("btn-v-add-incident")?.addEventListener("click", () =>
      openIncidentForm(null, () => loadIncidentsTab(container, vehicle), null, vehicle.id));

    if (canEdit) {
      container.querySelectorAll(".btn-incident-schedule-service").forEach(btn => {
        btn.addEventListener("click", () => {
          const inc = items.find(x => x.id === btn.dataset.id);
          if (inc) scheduleServiceForIncident(inc, () => loadIncidentsTab(container, vehicle));
        });
      });
    }
  } catch (e) {
    container.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

// Priprema početnih vrednosti za formu "Dodaj servis" na osnovu prijave
// (ne tretira se kao edit — samo predpopunjava polja nove forme).
// Eksportovano — koristi ga i incidents.js/drivers.js.
export function incidentToServicePrefill(inc) {
  const typeLabels = {
    fault:    t("incident_fault"),
    damage:   t("incident_damage"),
    accident: t("incident_accident"),
    other:    t("incident_other"),
  };
  const prefix = typeLabels[inc.type] || inc.type;
  return {
    serviceType: inc.type === "other" ? "other" : "repair",
    km:          inc.currentKm ?? null,
    description: `${prefix}${inc.description ? ": " + inc.description : ""}`,
  };
}

// ── TAB "ZADUŽENJA" — sve aktivnosti svih vozača na ovom vozilu ──
// Zaduženja su grupisana po vozaču. Klik na vozača otvara/zatvara njegova
// zaduženja, a klik na zaduženje otvara vožnje sa gorivom, troškovima i
// prijavama (ista kartica kao u tabu "Zaduženja" kod vozača).
function escText(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function assignSummaryBoxes(sum) {
  return `
    <div class="assignment-history-summary assignment-history-summary--five">
      <div class="assignment-history-summary__item">
        <span class="assignment-history-summary__value">${sum.count}</span>
        <span class="assignment-history-summary__label">${t("vehicle_assign_count")}</span>
      </div>
      <div class="assignment-history-summary__item">
        <span class="assignment-history-summary__value">${sum.km.toLocaleString()} km</span>
        <span class="assignment-history-summary__label">${t("assignment_summary_km")}</span>
      </div>
      <div class="assignment-history-summary__item">
        <span class="assignment-history-summary__value">${sum.fuelL.toFixed(1)} L</span>
        <span class="assignment-history-summary__label">${t("trip_stats_fuel")}</span>
      </div>
      <div class="assignment-history-summary__item">
        <span class="assignment-history-summary__value">${(sum.fuelCost + sum.otherCost).toLocaleString()} RSD</span>
        <span class="assignment-history-summary__label">${t("assignment_summary_costs")}</span>
      </div>
      <div class="assignment-history-summary__item ${sum.incidents > 0 ? "assignment-history-summary__item--warn" : ""}">
        <span class="assignment-history-summary__value">${sum.incidents}</span>
        <span class="assignment-history-summary__label">${t("trip_stats_incidents")}</span>
      </div>
    </div>`;
}

function driverGroupHTML(group, history) {
  const { tripsByAssignment, entriesByTrip, entriesByAssignment } = history;
  const sum = summarizeAssignments(group.assignments, tripsByAssignment, entriesByAssignment);

  // Period: od najranijeg početka do najkasnijeg kraja (ili "Aktivno")
  const first = group.assignments[group.assignments.length - 1];
  const last  = group.assignments[0];
  const periodEnd = sum.hasActive
    ? t("assignment_status_active")
    : (last?.endDate ? formatDate(last.endDate) : "—");

  return `
    <section class="vehicle-driver-group">
      <div class="vehicle-driver-group__header" data-toggle-driver-group role="button" tabindex="0" aria-expanded="true">
        <div class="vehicle-driver-group__who">
          <div class="vehicle-driver-group__name">
            👤 <strong>${escText(group.driverName)}</strong>
            ${group.assignments[0]?.driverId ? detailButton("data-detail-driver", group.assignments[0].driverId, t("det_title_driver")) : ""}
            ${sum.hasActive ? `<span class="trip-history-badge trip-history-badge--active">🟢 ${t("assignment_status_active")}</span>` : ""}
          </div>
          <div class="vehicle-driver-group__period">
            📅 ${formatDate(first?.startDate)} → ${periodEnd} · ${sum.count} ${t("vehicle_assign_assignments_n")}
          </div>
        </div>
        <div class="vehicle-driver-group__stats">
          <span class="trip-history-badge">🛣️ ${sum.km.toLocaleString()} km</span>
          <span class="trip-history-badge">⛽ ${sum.fuelL.toFixed(1)} L</span>
          <span class="trip-history-badge">💰 ${(sum.fuelCost + sum.otherCost).toLocaleString()} RSD</span>
          ${sum.incidents > 0 ? `<span class="trip-history-badge trip-history-badge--warn">⚠️ ${sum.incidents}</span>` : ""}
          <span class="vehicle-driver-group__chevron">▾</span>
        </div>
      </div>
      <div class="vehicle-driver-group__body">
        ${group.assignments.map(a =>
          historyAssignmentCard(a, tripsByAssignment, entriesByTrip, entriesByAssignment, { hideVehicle: true })
        ).join("")}
      </div>
    </section>`;
}

async function loadAssignmentsTab(container, vehicle) {
  container.innerHTML = `<div class="loading">${t("loading")}</div>`;
  try {
    const history = await loadVehicleAssignmentHistory(vehicle.id);
    const { assignments, tripsByAssignment, entriesByAssignment, orphanEntries } = history;

    if (assignments.length === 0 && orphanEntries.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🔑</div><p>${t("no_data")}</p></div>`;
      return;
    }

    const groups = groupAssignmentsByDriver(assignments);
    const total  = summarizeAssignments(assignments, tripsByAssignment, entriesByAssignment);

    container.innerHTML = `
      ${assignSummaryBoxes(total)}

      <div class="vehicle-assign-toolbar">
        <span class="form-hint">${t("vehicle_assign_hint")}</span>
        ${groups.length > 1 ? `<button type="button" class="btn btn--secondary btn--sm" id="btn-toggle-all-drivers"
          data-state="open">${t("vehicle_assign_collapse_all")}</button>` : ""}
      </div>

      <div class="vehicle-driver-groups">
        ${groups.map(g => driverGroupHTML(g, history)).join("")}
      </div>

      ${orphanEntries.length > 0 ? `
        <section class="vehicle-driver-group vehicle-driver-group--orphans">
          <div class="vehicle-driver-group__header vehicle-driver-group__header--static">
            <div class="vehicle-driver-group__name">📋 <strong>${t("vehicle_assign_orphans")}</strong> (${orphanEntries.length})</div>
          </div>
          <div class="vehicle-driver-group__body">
            <div class="trip-history-card__entries">${orphanEntries.map(e => historyEntryItem(e)).join("")}</div>
          </div>
        </section>` : ""}
    `;

    // Otvaranje/zatvaranje zaduženja i vožnji (isti handleri kao kod vozača)
    attachAssignmentHistoryEvents(container);

    // Dolazak iz liste zaduženja: razvij traženo zaduženje, skroluj do njega i istakni ga
    if (pendingFocusAssignmentId) {
      const target = [...container.querySelectorAll("[data-assignment-id]")]
        .find(el => el.dataset.assignmentId === pendingFocusAssignmentId);
      pendingFocusAssignmentId = null;
      if (target) {
        target.querySelector(".assignment-history-card__trips")?.classList.remove("hidden");
        target.querySelector("[data-toggle-assignment]")?.classList.add("assignment-history-card__header--open");
        target.classList.add("assignment-history-card--focus");
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => target.classList.remove("assignment-history-card--focus"), 2500);
      }
    }

    // Otvaranje/zatvaranje grupe jednog vozača
    const setGroupOpen = (group, open) => {
      group.classList.toggle("vehicle-driver-group--collapsed", !open);
      group.querySelector("[data-toggle-driver-group]")?.setAttribute("aria-expanded", String(open));
    };
    container.querySelectorAll("[data-toggle-driver-group]").forEach(header => {
      const toggle = () => {
        const group = header.closest(".vehicle-driver-group");
        setGroupOpen(group, group.classList.contains("vehicle-driver-group--collapsed"));
      };
      header.addEventListener("click", toggle);
      header.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });

    // "Skupi sve / Razvij sve"
    const toggleAll = document.getElementById("btn-toggle-all-drivers");
    toggleAll?.addEventListener("click", () => {
      const open = toggleAll.dataset.state !== "open"; // sledeće stanje
      container.querySelectorAll("section.vehicle-driver-group:not(.vehicle-driver-group--orphans)")
        .forEach(g => setGroupOpen(g, open));
      toggleAll.dataset.state = open ? "open" : "closed";
      toggleAll.textContent = open ? t("vehicle_assign_collapse_all") : t("vehicle_assign_expand_all");
    });
  } catch (e) {
    container.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

// ── FORMA ZA DODAVANJE / EDITOVANJE ──────────────────────────
async function openVehicleForm(vehicle = null) {
  const isEdit = !!vehicle;
  const v = vehicle || {};
  // Firmska podrazumevana podešavanja servisnog podsetnika (prikazuju se kao placeholder)
  const svcDefaults = await getServiceSettings(S.companyId);
  const svcOv = cleanVehicleServiceOverrides(v.serviceSettings);

  const bodyHTML = `
    <div class="form-section-title">${t("vehicle_tab_tech")}</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_brand")} *</label>
        <input id="f-brand" class="form-input" type="text" value="${v.brand || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_model")} *</label>
        <input id="f-model" class="form-input" type="text" value="${v.model || ""}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_type")}</label>
        <select id="f-vehicleType" class="form-select">
          <option value="">—</option>
          ${VEHICLE_TYPES.map(vt =>
            `<option value="${vt}" ${v.vehicleType === vt ? "selected" : ""}>${t("vehicle_type_" + vt)}</option>`
          ).join("")}
          ${v.vehicleType && !VEHICLE_TYPES.includes(v.vehicleType)
            ? `<option value="${v.vehicleType}" selected>${v.vehicleType}</option>`
            : ""}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_category")}</label>
        <select id="f-category" class="form-select">
          <option value="">—</option>
          ${VEHICLE_CATEGORIES.map(c =>
            `<option value="${c}" ${v.category === c ? "selected" : ""}>${t("vehicle_category_" + c)}</option>`
          ).join("")}
          ${v.category && !VEHICLE_CATEGORIES.includes(v.category)
            ? `<option value="${v.category}" selected>${v.category}</option>`
            : ""}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_plate")} *</label>
        <input id="f-plate" class="form-input" type="text" value="${v.plate || ""}" style="text-transform:uppercase" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_vin")}</label>
        <input id="f-vin" class="form-input" type="text" maxlength="17" value="${v.vin || ""}" style="text-transform:uppercase" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_engine_code")}</label>
        <input id="f-engineCode" class="form-input" type="text" value="${v.engineCode || ""}" style="text-transform:uppercase" />
      </div>
      <div class="form-group"></div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_year")}</label>
        <input id="f-year" class="form-input" type="number" min="1990" max="2030" value="${v.year || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_first_reg")}</label>
        <input id="f-firstRegDate" class="form-input" type="text" inputmode="numeric" maxlength="10"
          placeholder="${datePlaceholder()}" value="${toDMY(v.firstRegDate)}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_engine_cc")}</label>
        <input id="f-engineCc" class="form-input" type="number" value="${v.engineCc || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_power_kw")}</label>
        <input id="f-powerKw" class="form-input" type="number" value="${v.powerKw || ""}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_seats")}</label>
        <input id="f-seats" class="form-input" type="number" min="1" max="60" value="${v.seats || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_payload")}</label>
        <input id="f-payload" class="form-input" type="number" value="${v.payload || ""}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_mass")}</label>
        <input id="f-mass" class="form-input" type="number" value="${v.mass || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_fuel_type")}</label>
        <select id="f-fuelType" class="form-select">
          <option value="">—</option>
          ${["petrol","diesel","lpg","cng","electric","hybrid_petrol","hybrid_diesel","hybrid_tng_cng"].map(ft =>
            `<option value="${ft}" ${v.fuelType === ft ? "selected" : ""}>${t("fuel_" + ft)}</option>`
          ).join("")}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_color")}</label>
        <select id="f-color" class="form-select">
          <option value="">—</option>
          ${VEHICLE_COLORS.map(c =>
            `<option value="${c}" ${v.color === c ? "selected" : ""}>${t("color_" + c)}</option>`
          ).join("")}
          ${v.color && !VEHICLE_COLORS.includes(v.color)
            ? `<option value="${v.color}" selected>${v.color}</option>`
            : ""}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_fuel_level")}</label>
        ${fuelLevelScaleHTML("f-fuelLevel", "f-fuelLevel-scale", v.fuelLevel)}
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_status")}</label>
        <select id="f-status" class="form-select">
          ${["active","service","broken","inactive"].map(s =>
            `<option value="${s}" ${(v.status || "active") === s ? "selected" : ""}>${t("vehicle_status_" + s)}</option>`
          ).join("")}
          ${v.status === "unregistered"
            ? `<option value="unregistered" selected>${t("vehicle_status_unregistered")}</option>`
            : ""}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_current_km")}</label>
        <input id="f-currentKm" class="form-input" type="number" value="${v.currentKm || ""}" />
      </div>
    </div>

    <div class="form-section-title" style="margin-top:8px">${t("vehicle_reg_expiry")} / ${t("vehicle_insurance_company")}</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_reg_expiry")}</label>
        <input id="f-regExpiry" class="form-input" type="text" inputmode="numeric" maxlength="10"
          placeholder="${datePlaceholder()}" value="${toDMY(v.regExpiry)}" />
        <div id="f-reg-badge" style="margin-top:6px">${regBadge(v)}</div>
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_insurance_expiry")}</label>
        <input id="f-insuranceExpiry" class="form-input" type="text" inputmode="numeric" maxlength="10"
          placeholder="${datePlaceholder()}" value="${toDMY(v.insuranceExpiry)}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_insurance_company")}</label>
        <input id="f-insuranceCompany" class="form-input" type="text" value="${v.insuranceCompany || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_insurance_policy")}</label>
        <input id="f-insurancePolicy" class="form-input" type="text" value="${v.insurancePolicy || ""}" />
      </div>
    </div>
    <div class="form-row" id="f-tachograph-wrap" style="display:${needsTachograph(v) ? "flex" : "none"}">
      <div class="form-group">
        <label class="form-label">${t("vehicle_tachograph_expiry")}</label>
        <input id="f-tachographExpiry" class="form-input" type="text" inputmode="numeric" maxlength="10"
          placeholder="${datePlaceholder()}" value="${toDMY(v.tachographExpiry)}" />
        <div id="f-tachograph-badge" style="margin-top:6px">${tachographBadge(v)}</div>
      </div>
      <div class="form-group"></div>
    </div>

    <div class="form-section-title" style="margin-top:8px">${t("vehicle_section_safety")}</div>
    <div class="form-group">
      <label class="form-label">${t("vehicle_required_equipment")}</label>
      <div class="checkbox-grid">
        ${REQUIRED_EQUIPMENT_ITEMS.map(eq => `
          <label class="form-checkbox-label">
            <input type="checkbox" class="f-equipment" value="${eq}" ${(v.requiredEquipment || []).includes(eq) ? "checked" : ""} />
            ${t("equipment_" + eq)}
          </label>
        `).join("")}
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_tires_type")}</label>
        <select id="f-tiresType" class="form-select">
          <option value="">—</option>
          ${TIRE_TYPES.map(tt =>
            `<option value="${tt}" ${v.tires?.type === tt ? "selected" : ""}>${t("tire_" + tt)}</option>`
          ).join("")}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_tires_dimensions")}</label>
        <input id="f-tiresDimensions" class="form-input" type="text" placeholder="205/55/16" value="${v.tires?.dimensions || ""}" />
      </div>
    </div>
    <div class="form-group form-group--checkbox">
      <label class="form-checkbox-label">
        <input id="f-tireReminderDisabled" type="checkbox" ${v.tireReminderDisabled === true ? "checked" : ""} />
        ${t("vehicle_tire_reminder_disabled")}
      </label>
    </div>

    <div class="form-section-title" style="margin-top:8px">${t("vehicle_tab_finance")}</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_owner")}</label>
        <input id="f-ownerName" class="form-input" type="text" value="${v.ownerName || ""}" />
      </div>
      <div class="form-group"></div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_purchase_date")}</label>
        <input id="f-purchaseDate" class="form-input" type="text" inputmode="numeric" maxlength="10"
          placeholder="${datePlaceholder()}" value="${toDMY(v.purchaseDate)}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_purchase_type")}</label>
        <input id="f-purchaseType" class="form-input" type="text" value="${v.purchaseType || ""}" placeholder="${t("vehicle_purchase_type_ph")}" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("vehicle_purchase_value")}</label>
      <input id="f-purchaseValue" class="form-input" type="number" value="${v.purchaseValue || ""}" />
    </div>
    <div class="form-section-title">🔧 ${t("svc_vehicle_section")}</div>
    <p class="form-hint">${t("svc_vehicle_hint")}</p>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("svc_settings_interval_km")}</label>
        <input id="f-svc-intervalKm" class="form-input" type="number" min="1"
          value="${svcOv.intervalKm ?? ""}" placeholder="${t("svc_vehicle_default_ph", { n: svcDefaults.intervalKm.toLocaleString() })}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("svc_settings_interval_months")}</label>
        <input id="f-svc-intervalMonths" class="form-input" type="number" min="1" step="1"
          value="${svcOv.intervalMonths ?? ""}" placeholder="${t("svc_vehicle_default_ph", { n: svcDefaults.intervalMonths })}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("svc_settings_alarm_km")}</label>
        <input id="f-svc-alarmKm" class="form-input" type="number" min="0"
          value="${svcOv.alarmKm ?? ""}" placeholder="${t("svc_vehicle_default_ph", { n: svcDefaults.alarmKm.toLocaleString() })}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("svc_settings_alarm_days")}</label>
        <input id="f-svc-alarmDays" class="form-input" type="number" min="0" step="1"
          value="${svcOv.alarmDays ?? ""}" placeholder="${t("svc_vehicle_default_ph", { n: svcDefaults.alarmDays })}" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("notes")}</label>
      <textarea id="f-notes" class="form-textarea">${v.notes || ""}</textarea>
    </div>
    <p id="vehicle-form-error" class="login-error hidden"></p>
  `;

  openModal(
    isEdit ? `${t("edit")}: ${v.brand} ${v.model}` : t("vehicle_add"),
    bodyHTML,
    async () => saveVehicle(vehicle?.id || null)
  );

  // Datum isteka registracije se kod nas poklapa sa datumom isteka osiguranja —
  // automatski se prepisuje, ali ostaje editabilno po potrebi.
  ["f-firstRegDate", "f-regExpiry", "f-insuranceExpiry", "f-purchaseDate", "f-tachographExpiry"].forEach(attachDateMask);

  document.getElementById("f-regExpiry")?.addEventListener("change", (e) => {
    const insuranceInput = document.getElementById("f-insuranceExpiry");
    if (insuranceInput) insuranceInput.value = e.target.value;

    const badgeDiv = document.getElementById("f-reg-badge");
    if (badgeDiv) badgeDiv.innerHTML = regBadge({ regExpiry: parseDMY(e.target.value) });
  });

  document.getElementById("f-tachographExpiry")?.addEventListener("change", (e) => {
    const badgeDiv = document.getElementById("f-tachograph-badge");
    if (badgeDiv) badgeDiv.innerHTML = tachographBadge({ tachographExpiry: parseDMY(e.target.value) });
  });

  // Polje za tahograf se prikazuje/sakriva automatski dok korisnik menja
  // kategoriju, masu ili broj sedišta — po istom pravilu kao needsTachograph().
  function refreshTachographVisibility() {
    const wrap = document.getElementById("f-tachograph-wrap");
    if (!wrap) return;
    const fakeVehicle = {
      category: document.getElementById("f-category")?.value || null,
      mass: numOrNull("f-mass"),
      seats: numOrNull("f-seats"),
    };
    wrap.style.display = needsTachograph(fakeVehicle) ? "flex" : "none";
  }
  ["f-category", "f-mass", "f-seats"].forEach(id => {
    document.getElementById(id)?.addEventListener("change", refreshTachographVisibility);
    document.getElementById(id)?.addEventListener("input", refreshTachographVisibility);
  });

  // Segmentirana skala za nivo goriva — klik bira vrednost i oboji dugme.
  bindFuelLevelScale("f-fuelLevel", "f-fuelLevel-scale");
}

// ── FIELD ERROR HELPER ───────────────────────────────────────
function fieldError(inputId, msg) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.classList.add("input--error");
  el.parentElement.querySelectorAll(".field-error-msg").forEach(e => e.remove());
  const hint = document.createElement("span");
  hint.className = "field-error-msg";
  hint.textContent = msg;
  el.parentElement.appendChild(hint);
  el.addEventListener("input", () => {
    el.classList.remove("input--error");
    hint.remove();
  }, { once: true });
}

function clearFieldErrors() {
  document.querySelectorAll(".input--error").forEach(el => el.classList.remove("input--error"));
  document.querySelectorAll(".field-error-msg").forEach(el => el.remove());
}

// ── SNIMI VOZILO ──────────────────────────────────────────────
async function saveVehicle(vehicleId) {
  clearFieldErrors();

  const brand = document.getElementById("f-brand")?.value.trim();
  const model = document.getElementById("f-model")?.value.trim();
  const plate = document.getElementById("f-plate")?.value.trim().toUpperCase();
  const vin   = document.getElementById("f-vin")?.value.trim().toUpperCase() || null;
  const engineCode = document.getElementById("f-engineCode")?.value.trim().toUpperCase() || null;

  // ── OSNOVNA VALIDACIJA ────────────────────────────────────────
  let valid = true;
  if (!brand) { fieldError("f-brand", t("vehicle_brand_required")); valid = false; }
  if (!model) { fieldError("f-model", t("vehicle_model_required")); valid = false; }
  if (!plate) { fieldError("f-plate", t("vehicle_plate_required")); valid = false; }
  if (vin && vin.length > 17) { fieldError("f-vin", t("vehicle_vin_max_error")); valid = false; }

  // Sopstvena podešavanja servisnog podsetnika (prazno = nasleđuje firmska)
  const svcRaw = {
    intervalKm:     document.getElementById("f-svc-intervalKm")?.value.trim(),
    intervalMonths: document.getElementById("f-svc-intervalMonths")?.value.trim(),
    alarmKm:        document.getElementById("f-svc-alarmKm")?.value.trim(),
    alarmDays:      document.getElementById("f-svc-alarmDays")?.value.trim(),
  };
  const svcRules = {
    intervalKm:     { min: 1, int: false },
    intervalMonths: { min: 1, int: true },
    alarmKm:        { min: 0, int: false },
    alarmDays:      { min: 0, int: true },
  };
  Object.keys(svcRules).forEach(k => {
    if (svcRaw[k] === "" || svcRaw[k] == null) return;
    const n = Number(svcRaw[k]);
    if (!isFinite(n) || n < svcRules[k].min || (svcRules[k].int && !Number.isInteger(n))) {
      fieldError("f-svc-" + k, t("svc_vehicle_invalid"));
      valid = false;
    }
  });

  // Datumi (svi opcioni): nepostojeći datum (npr. 31.09.2026) više se ne
  // pretvara tiho u prazno polje — korisnik dobija poruku ispod polja.
  const vehicleDates = collectDates([
    { id: "f-firstRegDate" },
    { id: "f-regExpiry" },
    { id: "f-insuranceExpiry" },
    { id: "f-purchaseDate" },
    { id: "f-tachographExpiry" },
  ]);
  if (!vehicleDates.ok) valid = false;

  if (!valid) {
    // Fokus na prvo pogrešno polje po redosledu u formi
    const firstBad = document.querySelector(".input--error");
    firstBad?.focus();
    firstBad?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    throw new Error("validation");
  }

  try {
    // ── JEDINSTVENOST TABLICE ─────────────────────────────────
    const plateSnap = await getDocs(query(
      collection(db, "companies", S.companyId, "vehicles"),
      where("plate", "==", plate)
    ));
    const plateConflict = plateSnap.docs.find(d => d.id !== vehicleId);
    if (plateConflict) {
      const v = plateConflict.data();
      fieldError("f-plate", `${t("vehicle_plate_exists").replace("{0}", v.brand).replace("{1}", v.model)}`);
      throw new Error("validation");
    }

    // ── JEDINSTVENOST VIN ─────────────────────────────────────
    if (vin) {
      const vinSnap = await getDocs(query(
        collection(db, "companies", S.companyId, "vehicles"),
        where("vin", "==", vin)
      ));
      const vinConflict = vinSnap.docs.find(d => d.id !== vehicleId);
      if (vinConflict) {
        const v = vinConflict.data();
        fieldError("f-vin", `${t("vehicle_vin_exists").replace("{0}", v.brand).replace("{1}", v.model).replace("{2}", v.plate)}`);
        throw new Error("validation");
      }
    }

    const tiresType = document.getElementById("f-tiresType")?.value || null;
    const tiresDimensions = document.getElementById("f-tiresDimensions")?.value.trim() || null;
    const requiredEquipment = Array.from(document.querySelectorAll(".f-equipment:checked")).map(el => el.value);

    const data = {
      brand, model, plate, vin, engineCode,
      vehicleType:      document.getElementById("f-vehicleType")?.value || null,
      category:         document.getElementById("f-category")?.value || null,
      year:             numOrNull("f-year"),
      firstRegDate:     dateOrNull("f-firstRegDate"),
      engineCc:         numOrNull("f-engineCc"),
      powerKw:          numOrNull("f-powerKw"),
      seats:            numOrNull("f-seats"),
      payload:          numOrNull("f-payload"),
      mass:             numOrNull("f-mass"),
      fuelType:         document.getElementById("f-fuelType")?.value || null,
      fuelLevel:        document.getElementById("f-fuelLevel")?.value || null,
      color:            document.getElementById("f-color")?.value || null,
      status:           document.getElementById("f-status")?.value || "active",
      currentKm:        numOrNull("f-currentKm"),
      regExpiry:        dateOrNull("f-regExpiry"),
      insuranceExpiry:  dateOrNull("f-insuranceExpiry"),
      insuranceCompany: document.getElementById("f-insuranceCompany")?.value.trim() || null,
      insurancePolicy:  document.getElementById("f-insurancePolicy")?.value.trim() || null,
      tachographExpiry: dateOrNull("f-tachographExpiry"),
      requiredEquipment,
      tires: (tiresType || tiresDimensions) ? { type: tiresType, dimensions: tiresDimensions } : null,
      tireReminderDisabled: !!document.getElementById("f-tireReminderDisabled")?.checked,
      purchaseDate:     dateOrNull("f-purchaseDate"),
      purchaseType:     document.getElementById("f-purchaseType")?.value.trim() || null,
      purchaseValue:    numOrNull("f-purchaseValue"),
      ownerName:        document.getElementById("f-ownerName")?.value.trim() || null,
      serviceSettings:  (() => {
        const ov = cleanVehicleServiceOverrides(svcRaw);
        return Object.keys(ov).length ? ov : null;
      })(),
      notes:            document.getElementById("f-notes")?.value.trim() || null,
    };

    const prevKm = vehicleId ? (allVehicles.find(x => x.id === vehicleId)?.currentKm ?? null) : null;
    const kmChanged = data.currentKm != null && data.currentKm !== prevKm;
    if (kmChanged) data.currentKmUpdatedAt = serverTimestamp();

    if (vehicleId) {
      await updateDoc(doc(db, "companies", S.companyId, "vehicles", vehicleId), {
        ...data, updatedAt: serverTimestamp()
      });
    } else {
      await addDoc(collection(db, "companies", S.companyId, "vehicles"), {
        ...data, createdAt: serverTimestamp()
      });
    }

    showToast(t("success"), "success");
    await loadVehicles();
    const container = document.getElementById("content");
    if (container) renderVehicles(container);

  } catch (e) {
    if (e.message === "validation") throw e;
    showToast(`${t("error")}: ${e.message}`, "error");
    throw e;
  }
}

// ── ARHIVIRANJE / VRAĆANJE / TRAJNO BRISANJE VOZILA ───────────
function archiveVehicle(vehicle) {
  if (!confirm(t("vehicle_archive_confirm"))) return;
  updateDoc(doc(db, "companies", S.companyId, "vehicles", vehicle.id), {
    archived: true,
    archivedAt: serverTimestamp(),
    archivedBy: S.user?.uid || null,
  })
    .then(() => {
      vehicle.archived = true;
      showToast(t("success"), "success");
      const container = document.getElementById("content");
      if (container) openVehicleDetail(vehicle.id);
    })
    .catch(e => showToast(`${t("error")}: ${e.message}`, "error"));
}

function unarchiveVehicle(vehicle) {
  if (!confirm(t("vehicle_unarchive_confirm"))) return;
  updateDoc(doc(db, "companies", S.companyId, "vehicles", vehicle.id), {
    archived: false,
  })
    .then(() => {
      vehicle.archived = false;
      showToast(t("success"), "success");
      const container = document.getElementById("content");
      if (container) openVehicleDetail(vehicle.id);
    })
    .catch(e => showToast(`${t("error")}: ${e.message}`, "error"));
}

// Trajno brisanje — samo za master_admin, samo dok je vozilo već arhivirano
// (mora se prvo svesno arhivirati pre nego što se trajno obriše). Briše samo
// dokument vozila; istorija (servisi/vožnje/zaduženja/gorivo) ostaje u bazi
// kao osirotinjeni zapisi — to je korisnik svesno prihvatio.
function confirmHardDeleteVehicle(vehicle) {
  const typed = prompt(`${t("vehicle_hard_delete_confirm_prompt")}\n\n${vehicle.plate}`);
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== (vehicle.plate || "").trim().toUpperCase()) {
    showToast(t("vehicle_hard_delete_mismatch"), "error");
    return;
  }
  deleteDoc(doc(db, "companies", S.companyId, "vehicles", vehicle.id))
    .then(() => {
      showToast(t("success"), "success");
      const container = document.getElementById("content");
      if (container) renderVehicles(container);
    })
    .catch(e => showToast(`${t("error")}: ${e.message}`, "error"));
}

// ── SERVIS: SKENIRANJE RAČUNA + SERVISER ─────────────────────
// Zajednički deo za formu "Dodaj servis" (prefiks "sf") i formu
// "Servis završen" (prefiks "cs"). Skeniranjem QR koda računa popunjavaju se
// iznos, broj i vreme računa, stavke (u opis) i serviser. Serviser se prvo traži
// po PIB-u, pa po nazivu; ako ga nema na listi bira se "Drugo (unesi ručno)",
// a posle snimanja servisa otvara se forma "Dodaj servisera" sa podacima sa računa.
const $id = (id) => document.getElementById(id);

// "Auto Servis Petrović d.o.o." → "auto servis petrovic"
function normShopName(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "dj")
    .toLowerCase()
    .replace(/(^|\s)(d\.?\s?o\.?\s?o\.?|a\.?\s?d\.?|doo|ad|pr|szr|sr)(?=\s|$)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchServicer(servicers, pib, name) {
  const p = String(pib || "").replace(/\D/g, "");
  if (p) {
    const byPib = servicers.find(sp => String(sp.pib || "").replace(/\D/g, "") === p);
    if (byPib) return byPib;
  }
  const n = normShopName(name);
  if (n.length < 4) return null;
  return servicers.find(sp => {
    const m = normShopName(sp.name);
    if (m.length < 4) return false;
    if (m === n) return true;
    return m.length >= 6 && n.length >= 6 && (m.includes(n) || n.includes(m));
  }) || null;
}

function workshopFieldsHTML(p, s, servicers) {
  const other = !s.servicerId && s.workshop;
  const addr = s.workshopAddress
    || (s.servicerId ? (servicers.find(x => x.id === s.servicerId)?.address || "") : "");
  return `
    <div class="form-group">
      <label class="form-label">${t("service_workshop")}</label>
      <select id="${p}-workshop-select" class="form-select">
        <option value="">${t("service_workshop_select_ph")}</option>
        ${servicers.map(sp => `<option value="${escDet(sp.id)}" ${s.servicerId === sp.id ? "selected" : ""}>${escDet(sp.name)}</option>`).join("")}
        <option value="__other__" ${other ? "selected" : ""}>${t("service_workshop_other")}</option>
      </select>
      <input id="${p}-workshop" class="form-input" type="text" style="margin-top:8px;display:${other ? "" : "none"}"
        placeholder="${t("service_workshop")}" value="${escDet(other ? s.workshop : "")}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("service_workshop_address")}</label>
      <input id="${p}-workshop-address" class="form-input" type="text"
        placeholder="${t("service_workshop_address_ph")}" value="${escDet(addr)}" />
    </div>`;
}

function bindWorkshopSelect(p, servicers) {
  // Prikaži slobodno polje samo kad je izabrano "Drugo"
  $id(`${p}-workshop-select`)?.addEventListener("change", (e) => {
    const freeInput = $id(`${p}-workshop`);
    const addrInput = $id(`${p}-workshop-address`);
    if (e.target.value === "__other__") {
      if (freeInput) { freeInput.style.display = ""; freeInput.focus(); }
    } else {
      if (freeInput) { freeInput.style.display = "none"; freeInput.value = ""; }
    }
    // Izabran serviser iz liste → adresa iz njegove kartice (može se ručno ispraviti)
    if (addrInput && e.target.value && e.target.value !== "__other__") {
      addrInput.value = servicers.find(x => x.id === e.target.value)?.address || "";
    }
  });
}

function readWorkshop(p, servicers) {
  const selectedId = $id(`${p}-workshop-select`)?.value || "";
  let workshop = null;
  let servicerId = null;
  if (selectedId === "__other__") {
    workshop = $id(`${p}-workshop`)?.value.trim() || null;
  } else if (selectedId) {
    const sp = servicers.find(x => x.id === selectedId);
    workshop = sp?.name || null;
    servicerId = selectedId;
  }
  // Adresa servisa — polje je predpopunjeno iz kartice servisera, ali se može ispraviti
  const workshopAddress = $id(`${p}-workshop-address`)?.value.trim() || null;
  return { selectedId, workshop, servicerId, workshopAddress };
}

function receiptBlockHTML(p, s = {}) {
  return `
    <button type="button" id="${p}-scan-btn" class="btn btn--secondary btn--full">${t("receipt_scan_btn")}</button>
    <p id="${p}-scan-status" class="scan-status hidden"></p>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("service_receipt_no")}</label>
        <input id="${p}-receiptNo" class="form-input" type="text" value="${escDet(s.receiptNo || "")}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_receipt_time")}</label>
        <input id="${p}-receiptTime" class="form-input" type="datetime-local" step="1" value="${escDet(s.receiptTime || "")}" />
      </div>
    </div>`;
}

// Vezuje dugme "Skeniraj račun". Vraća { state, read(receiptNo) }.
function bindServiceReceipt(p, { servicers, existing = {}, ignoreId = null, costId, descId }) {
  const state = {
    url: existing.receiptUrl || null,
    source: existing.receiptSource || "manual",
    pib: existing.receiptPib || null,
    items: existing.receiptItems || null,
    scannedNow: false,          // true samo ako je račun skeniran u ovoj formi
  };
  let autoDesc = "";            // tekst koji je aplikacija sama upisala u opis

  const btn = $id(`${p}-scan-btn`);
  const setStatus = (msg, kind = "info") => {
    const el = $id(`${p}-scan-status`);
    if (!el) return;
    el.textContent = msg;
    el.className = `scan-status scan-status--${kind}`;
  };
  const setVal = (id, value) => {
    const el = $id(id);
    if (el && value !== null && value !== undefined && value !== "") el.value = value;
  };

  // Stavke sa računa → polje "Opis radova" (ne briše ono što je korisnik sam ukucao)
  const fmt = (n) => Number(n).toLocaleString("sr-RS", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fillDesc = (items) => {
    const el = $id(descId);
    if (!el || !items.length) return;
    const lines = items.map(it => {
      const qty = it.quantity != null ? Number(it.quantity).toLocaleString("sr-RS", { maximumFractionDigits: 3 }) : "";
      const price = it.unitPrice != null ? fmt(it.unitPrice) : "";
      const tot = it.total != null ? fmt(it.total) : "";
      return `• ${it.name || "—"}${qty ? ` — ${qty} × ${price}` : ""}${tot ? ` = ${tot}` : ""}`;
    });
    const text = `${t("receipt_items_label")}\n${lines.join("\n")}`;
    const cur = el.value.trim();
    if (!cur || cur === autoDesc) el.value = text;
    else if (!cur.includes(text)) el.value = `${cur}\n\n${text}`;
    autoDesc = text;
  };

  // Serviser sa računa → lista servisera, ili "Drugo (unesi ručno)" sa nazivom i adresom
  const applyServicer = (r) => {
    const name = r.chain || null;
    const address = [r.address, r.city].filter(Boolean).join(", ") || null;
    const sel = $id(`${p}-workshop-select`);
    if (!sel || (!name && !r.pib)) return null;
    const free = $id(`${p}-workshop`);
    const addr = $id(`${p}-workshop-address`);
    const match = matchServicer(servicers, r.pib, name);
    if (match) {
      sel.value = match.id;
      if (free) { free.style.display = "none"; free.value = ""; }
      if (addr) addr.value = match.address || address || "";
      return match;
    }
    sel.value = "__other__";
    if (free) { free.style.display = ""; free.value = name || ""; }
    if (addr && address) addr.value = address;
    return false;
  };

  btn?.addEventListener("click", async () => {
    let text;
    try {
      text = await scanQRCode();
    } catch (e) {
      setStatus(t(e.code === "denied" ? "receipt_scan_camera_denied" : "receipt_scan_camera_unavailable"), "error");
      return;
    }
    if (text === null) return; // skener zatvoren

    const qr = parseFiscalQR(text);
    if (!qr) { setStatus(t("receipt_scan_not_fiscal"), "error"); return; }

    try {
      const dup = await findReceiptDuplicate(S.companyId, qr.pfr, { ignoreId });
      if (dup) {
        const when = dup.createdAt?.toDate ? dup.createdAt.toDate().toLocaleDateString("sr-RS") : "—";
        const who = [dup.driverName, dup.vehiclePlate].filter(Boolean).join(", ") || "—";
        setStatus(t("receipt_duplicate_detail", { pfr: qr.pfr, date: when, who }), "error");
        return;
      }
    } catch (e) {
      console.warn("Provera duplikata računa nije uspela:", e);
      setStatus(t("receipt_check_failed"), "error");
      return;
    }

    // Podaci iz samog QR koda (rade i bez Worker-a)
    state.url = text.trim();
    state.source = "qr";
    state.scannedNow = true;
    setVal(`${p}-receiptNo`, qr.pfr);
    setVal(costId, qr.amount);
    setVal(`${p}-receiptTime`, qr.dateTime);

    if (!receiptWorkerConfigured()) { setStatus(t("svc_receipt_qr_only"), "warn"); return; }

    setStatus(t("receipt_scan_loading"), "info");
    if (btn) btn.disabled = true;
    try {
      const r = await fetchReceiptDetails(state.url);
      const items = (r.items || []).map(it => ({
        name: it.name || null,
        quantity: it.quantity ?? null,
        unitPrice: it.unitPrice ?? null,
        total: it.total ?? null,
      }));
      state.pib = r.pib || null;
      state.items = items.length ? items : null;
      setVal(`${p}-receiptTime`, r.time);
      if (r.total > 0) setVal(costId, r.total);
      fillDesc(items);
      const match = applyServicer(r);

      const notes = [t("svc_receipt_ok")];
      if (match) notes.push(t("svc_receipt_servicer_matched", { name: match.name }));
      else if (match === false) notes.push(t("svc_receipt_servicer_new"));
      let warn = match === false;
      if (r.total > 0 && Math.abs(r.total - qr.amount) > 0.01) {
        notes.push(t("receipt_scan_total_mismatch", { a: r.total.toFixed(2), b: qr.amount.toFixed(2) }));
        warn = true;
      }
      setStatus(notes.join(" "), warn ? "warn" : "ok");
    } catch (e) {
      console.warn("Učitavanje računa nije uspelo:", e.message, e.diag || "");
      setStatus(`${t("svc_receipt_qr_only")} (${e.message})`, "warn");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  return {
    state,
    // Polja računa za snimanje u servisni zapis (receiptNo je već normalizovan)
    read(receiptNo) {
      const has = !!(receiptNo || state.url);
      return {
        receiptNo:     receiptNo || null,
        receiptTime:   $id(`${p}-receiptTime`)?.value || null,
        receiptUrl:    state.url || null,
        receiptSource: has ? state.source : null,
        receiptPib:    state.pib || null,
        receiptItems:  state.items && state.items.length ? state.items : null,
      };
    },
  };
}

// Normalizuje broj računa i proverava da isti račun nije već unet
// (troškovi, gorivo ili drugi servis). Vraća { ok, receiptNo }.
async function checkServiceReceipt(p, ignoreId) {
  const norm = normalizeReceiptNo($id(`${p}-receiptNo`)?.value);
  if (!norm) return { ok: true, receiptNo: null };
  try {
    const dup = await findReceiptDuplicate(S.companyId, norm, { ignoreId });
    if (dup) {
      const when = dup.createdAt?.toDate ? dup.createdAt.toDate().toLocaleDateString("sr-RS") : "—";
      const who = [dup.driverName, dup.vehiclePlate].filter(Boolean).join(", ") || "—";
      showToast(t("receipt_duplicate_detail", { pfr: norm, date: when, who }), "error");
      return { ok: false };
    }
  } catch (e) {
    console.warn("Provera duplikata računa nije uspela:", e);
    showToast(t("receipt_check_failed"), "error");
    return { ok: false };
  }
  return { ok: true, receiptNo: norm };
}

// Serviser sa skeniranog računa koji nije na listi → podaci za formu "Dodaj servisera"
function pendingServicerFrom(w, scanner) {
  if (!scanner.state.scannedNow || w.selectedId !== "__other__") return null;
  if (!w.workshop && !scanner.state.pib) return null;
  return { name: w.workshop || "", address: w.workshopAddress || "", pib: scanner.state.pib || "" };
}

// Posle zatvaranja forme servisa otvara "Dodaj servisera" sa unapred popunjenim
// podacima; kad se serviser snimi, servis se povezuje sa njim (servicerId).
function offerNewServicer(pending, serviceId, vehicle, options = {}) {
  if (!pending || !serviceId) return;
  // Odloženo: openModal posle uspešnog snimanja zatvara trenutni dijalog
  setTimeout(() => {
    openServicerForm(null, {
      prefill: pending,
      onSaved: async (newId, sp) => {
        try {
          await updateDoc(doc(db, "companies", S.companyId, "services", serviceId), {
            servicerId: newId,
            workshop: sp.name,
            workshopAddress: sp.address || pending.address || null,
            updatedAt: serverTimestamp(),
          });
        } catch (e) {
          showToast(`${t("error")}: ${e.message}`, "error");
        }
        if (options.onSaved) options.onSaved();
        else {
          const content = document.getElementById("vehicle-tab-content");
          if (content) loadServiceTab(content, vehicle);
        }
      },
    });
  }, 250);
}

// ── SERVIS FORMA (dodavanje / editovanje) ────────────────────
// Eksportovano — koristi ga i incidents.js/drivers.js za zakazivanje
// servisa direktno iz prijave (dugme "Zakaži servis").
// options.linkedIncidentId: ako je zadat, po uspešnom čuvanju NOVOG
//   servisa prijava se automatski prebacuje u status "u obradi".
// options.onSaved: ako je zadat, poziva se posle uspešnog čuvanja
//   umesto podrazumevanog osvežavanja taba "Servisi" na kartici vozila
//   (taj tab ne postoji kad se forma otvara iz prijave).
export async function openServiceForm(vehicle, service = null, prefill = null, options = {}) {
  const isEdit = !!service;
  const s = service || prefill || {};
  const servicers = await getServiceProviders();
  let scanner = null;   // vezuje se posle openModal (skener računa)

  const bodyHTML = `
    <div class="form-group">
      <label class="form-label">${t("service_type")} *</label>
      <select id="sf-type" class="form-select">
        ${["regular","tech","tires","repair","other"].map(st =>
          `<option value="${st}" ${s.serviceType === st ? "selected" : ""}>${t("service_type_" + st)}</option>`
        ).join("")}
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("service_date")} *</label>
        <input id="sf-date" class="form-input" type="text" inputmode="numeric" maxlength="10" placeholder="${datePlaceholder()}"
          value="${isEdit ? toDMY(s.serviceDate) : todayDMY()}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("service_time")} *</label>
        <input id="sf-time" class="form-input" type="text" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="HH:MM" value="${s.serviceTime || ""}" />
      </div>
    </div>
    ${!isEdit ? `
    <div class="form-group form-group--checkbox">
      <label class="form-checkbox-label">
        <input id="sf-already-done" type="checkbox" />
        ${t("service_already_done_label")}
      </label>
    </div>
    ` : ""}
    ${receiptBlockHTML("sf", s)}
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("service_km")}</label>
        <input id="sf-km" class="form-input" type="number" value="${isEdit ? (s.km ?? "") : (vehicle.currentKm || "")}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("service_cost")}</label>
        <input id="sf-cost" class="form-input" type="number" value="${s.cost ?? ""}" />
      </div>
    </div>
    ${workshopFieldsHTML("sf", s, servicers)}
    <div class="form-group">
      <label class="form-label">${t("service_description")}</label>
      <textarea id="sf-desc" class="form-textarea">${s.description || ""}</textarea>
    </div>
    <div class="form-section-title" style="margin-top:4px">${t("service_completion_section")}</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("service_end_date")}</label>
        <input id="sf-endDate" class="form-input" type="text" inputmode="numeric" maxlength="10"
          placeholder="${datePlaceholder()}" value="${toDMY(s.endDate)}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("service_end_km")}</label>
        <input id="sf-endKm" class="form-input" type="number" value="${s.endKm ?? ""}" />
      </div>
    </div>
  `;

  openModal(isEdit ? `${t("edit")}: ${t("service_type_" + s.serviceType) || s.serviceType}` : t("service_add"), bodyHTML, async () => {
    const svcDates = collectDates([
      { id: "sf-date", required: true },
      { id: "sf-endDate" },
    ]);
    if (!svcDates.ok) return false; // false = dijalog ostaje otvoren
    let serviceDateVal = svcDates.values["sf-date"];
    const serviceEndVal = svcDates.values["sf-endDate"];
    if (serviceEndVal && serviceEndVal < serviceDateVal) {
      setDateError("sf-endDate", t("date_err_service_end_before_start"), { focus: true });
      return false;
    }
    try {
      // Servis se ne zakazuje vikendom (subota → petak, nedelja → ponedeljak).
      // Ne važi za servis koji je već obavljen (unos unazad) — tu se upisuje
      // stvarni datum.
      let weekendShifted = false;
      const isDoneRecord = isEdit
        ? effectiveServiceStatus(service) === SERVICE_STATUS.DONE
        : !!document.getElementById("sf-already-done")?.checked;
      // Vreme je obavezno za zakazivanje (ne i za servis koji je već obavljen)
      // Vreme u 24-časovnom formatu 00:00–23:59 (bez AM/PM)
      const timeStr = (document.getElementById("sf-time")?.value || "").trim();
      if (!timeStr && !isDoneRecord) {
        setDateError("sf-time", t("service_time_required"), { focus: true });
        return false;
      }
      if (timeStr && !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeStr)) {
        setDateError("sf-time", t("service_time_invalid"), { focus: true });
        return false;
      }
      if (!isDoneRecord && isWeekend(serviceDateVal)) {
        serviceDateVal = shiftToWorkday(serviceDateVal, new Date());
        weekendShifted = true;
      }

      const w = readWorkshop("sf", servicers);
      const { workshop, servicerId, workshopAddress } = w;
      const rc = await checkServiceReceipt("sf", isEdit ? service.id : null);
      if (!rc.ok) return false;
      // Vreme (HH:MM) se čuva zasebno od datuma — serviceDate ostaje ponoć,
      // pa se statusi, vikend-pomeranje i izveštaji ne menjaju.
      const serviceTime = (document.getElementById("sf-time")?.value || "").trim() || null;

      const data = {
        vehicleId:    vehicle.id,
        vehiclePlate: vehicle.plate,
        serviceType:  document.getElementById("sf-type")?.value,
        serviceDate:  serviceDateVal,
        serviceTime,
        km:           numOrNull("sf-km"),
        cost:         numOrNull("sf-cost"),
        workshop,
        workshopAddress,
        servicerId,
        description:  document.getElementById("sf-desc")?.value.trim() || null,
        endDate:      dateOrNull("sf-endDate"),
        endKm:        numOrNull("sf-endKm"),
        ...scanner.read(rc.receiptNo),
      };

      let savedServiceId = isEdit ? service.id : null;
      if (isEdit) {
        await updateDoc(doc(db, "companies", S.companyId, "services", service.id), {
          ...data, updatedAt: serverTimestamp(),
        });
      } else {
        // Novi zapis: status zavisi isključivo od checkbox-a "servis je već
        // obavljen" — ne od datuma. Ako korisnik ne čekira, zapis ostaje
        // "planned" (čeka potvrdu da je vozilo odvezeno) čak i ako je datum
        // već u prošlosti — tada će se prikazati kao "propušteno" (overdue)
        // sve dok neko ručno ne potvrdi ili otkaže.
        const alreadyDone = document.getElementById("sf-already-done")?.checked || false;
        data.status = alreadyDone ? SERVICE_STATUS.DONE : SERVICE_STATUS.PLANNED;

        const newRef = await addDoc(collection(db, "companies", S.companyId, "services"), {
          ...data, createdBy: S.user.uid, createdAt: serverTimestamp(),
        });
        savedServiceId = newRef.id;

        // Servis zakazan iz prijave — prijava prelazi u status "u obradi"
        if (options.linkedIncidentId) {
          await updateDoc(doc(db, "companies", S.companyId, "incidents", options.linkedIncidentId), {
            status:    "in_progress",
            updatedAt: serverTimestamp(),
            updatedBy: S.user.uid,
          });
        }
      }

      // Km uneta uz servis (km pri servisu ili km po završetku) postaje
      // trenutna kilometraža vozila ako je veća od postojeće; pamti se i datum unosa.
      const svcKm = Math.max(data.km || 0, data.endKm || 0);
      if (svcKm > (Number(vehicle.currentKm) || 0)) {
        await updateDoc(doc(db, "companies", S.companyId, "vehicles", vehicle.id), {
          currentKm: svcKm,
          currentKmUpdatedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        vehicle.currentKm = svcKm;
        vehicle.currentKmUpdatedAt = new Date();
      }

      showToast(weekendShifted ? t("svc_weekend_shifted") : t("success"), "success");
      if (options.onSaved) {
        options.onSaved();
      } else {
        const content = document.getElementById("vehicle-tab-content");
        if (content) loadServiceTab(content, vehicle);
      }

      // Serviser sa računa nije na listi → otvori formu "Dodaj servisera" sa podacima sa računa
      offerNewServicer(pendingServicerFrom(w, scanner), savedServiceId, vehicle, options);
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
    }
  });

  ["sf-date", "sf-endDate"].forEach(attachDateMask);
  // Maska za vreme HH:MM (24h): kuca se samo cifre, dvotačka se dodaje sama;
  // prva cifra veća od 2 dobija nulu ispred (9 → 09:)
  document.getElementById("sf-time")?.addEventListener("input", (e) => {
    const el = e.target;
    let digits = el.value.replace(/\D/g, "");
    if (digits.length >= 1 && Number(digits[0]) > 2) digits = "0" + digits;
    digits = digits.slice(0, 4);
    el.value = digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
    clearDateError(el);
  });

  bindWorkshopSelect("sf", servicers);
  scanner = bindServiceReceipt("sf", {
    servicers, existing: s, ignoreId: isEdit ? service.id : null,
    costId: "sf-cost", descId: "sf-desc",
  });
}

// ── VOZILO ODVEZENO U SERVIS ──────────────────────────────────
async function markServiceTaken(vehicle, service) {
  if (!confirm(t("service_taken_confirm"))) return;
  try {
    await updateDoc(doc(db, "companies", S.companyId, "services", service.id), {
      status: SERVICE_STATUS.IN_PROGRESS,
      previousVehicleStatus: vehicle.status || "active",
      takenAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "companies", S.companyId, "vehicles", vehicle.id), {
      status: "service", updatedAt: serverTimestamp(),
    });
    vehicle.status = "service"; // isti objekat referenciran i u allVehicles — ažurira i listu
    refreshVehicleHeaderBadge(vehicle);
    showToast(t("success"), "success");
    const content = document.getElementById("vehicle-tab-content");
    if (content) loadServiceTab(content, vehicle);
  } catch (e) {
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

// ── SERVIS ZAVRŠEN ────────────────────────────────────────────
// Uz završetak može da se skenira račun: iznos, serviser i podaci računa
// upisuju se u servisni zapis.
async function openCompleteServiceModal(vehicle, service) {
  const servicers = await getServiceProviders();
  let scanner = null;

  const bodyHTML = `
    ${receiptBlockHTML("cs", service)}
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("service_end_date")}</label>
        <input id="cs-endDate" class="form-input" type="text" inputmode="numeric" maxlength="10"
          placeholder="${datePlaceholder()}" value="${todayDMY()}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("service_end_km")}</label>
        <input id="cs-endKm" class="form-input" type="number" value="${vehicle.currentKm || ""}" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("service_cost")}</label>
      <input id="cs-cost" class="form-input" type="number" value="${service.cost ?? ""}" />
    </div>
    ${workshopFieldsHTML("cs", service, servicers)}
    <div class="form-group">
      <label class="form-label">${t("service_description")}</label>
      <textarea id="cs-desc" class="form-textarea">${escDet(service.description || "")}</textarea>
    </div>
  `;

  openModal(t("service_complete_title"), bodyHTML, async () => {
    const csDates = collectDates([{ id: "cs-endDate" }]);
    if (!csDates.ok) return false; // dijalog ostaje otvoren, poruka je ispod polja
    try {
      const rc = await checkServiceReceipt("cs", service.id);
      if (!rc.ok) return false;
      const w = readWorkshop("cs", servicers);
      const endKm = numOrNull("cs-endKm");
      await updateDoc(doc(db, "companies", S.companyId, "services", service.id), {
        status: SERVICE_STATUS.DONE,
        endDate: dateOrNull("cs-endDate"),
        endKm,
        cost: numOrNull("cs-cost"),
        workshop: w.workshop,
        workshopAddress: w.workshopAddress,
        servicerId: w.servicerId,
        description: $id("cs-desc")?.value.trim() || null,
        ...scanner.read(rc.receiptNo),
        updatedAt: serverTimestamp(),
      });
      const vehicleUpdate = {
        status: service.previousVehicleStatus || "active",
        updatedAt: serverTimestamp(),
      };
      if (endKm && endKm > (vehicle.currentKm || 0)) {
        vehicleUpdate.currentKm = endKm;
        vehicleUpdate.currentKmUpdatedAt = serverTimestamp();
      }
      await updateDoc(doc(db, "companies", S.companyId, "vehicles", vehicle.id), vehicleUpdate);

      vehicle.status = vehicleUpdate.status;
      if (vehicleUpdate.currentKm) {
        vehicle.currentKm = vehicleUpdate.currentKm;
        vehicle.currentKmUpdatedAt = new Date();
      }
      refreshVehicleHeaderBadge(vehicle);
      showToast(t("success"), "success");
      const content = document.getElementById("vehicle-tab-content");
      if (content) loadServiceTab(content, vehicle);

      // Serviser sa računa nije na listi → otvori formu "Dodaj servisera"
      offerNewServicer(pendingServicerFrom(w, scanner), service.id, vehicle);
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
    }
  });

  attachDateMask("cs-endDate");
  bindWorkshopSelect("cs", servicers);
  scanner = bindServiceReceipt("cs", {
    servicers, existing: service, ignoreId: service.id,
    costId: "cs-cost", descId: "cs-desc",
  });
}

// ── OTKAZIVANJE SERVISA ───────────────────────────────────────
async function cancelService(vehicle, service) {
  if (!confirm(t("service_cancel_confirm"))) return;
  try {
    await updateDoc(doc(db, "companies", S.companyId, "services", service.id), {
      status: SERVICE_STATUS.CANCELLED,
    });

    // Ako je servis bio "u toku" (vozilo već odvezeno) — otkazivanje vraća
    // vozilo na status koji je imalo pre odlaska na servis.
    if (effectiveServiceStatus(service) === SERVICE_STATUS.IN_PROGRESS && service.previousVehicleStatus) {
      await updateDoc(doc(db, "companies", S.companyId, "vehicles", vehicle.id), {
        status: service.previousVehicleStatus, updatedAt: serverTimestamp(),
      });
      vehicle.status = service.previousVehicleStatus;
      refreshVehicleHeaderBadge(vehicle);
    }

    showToast(t("success"), "success");
    const content = document.getElementById("vehicle-tab-content");
    if (content) loadServiceTab(content, vehicle);
  } catch (e) {
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

// ── BRISANJE SERVISNOG ZAPISA ─────────────────────────────────
async function confirmDeleteService(vehicle, serviceId) {
  if (!confirm(t("confirm_delete"))) return;
  try {
    await deleteDoc(doc(db, "companies", S.companyId, "services", serviceId));
    showToast(t("success"), "success");
    const content = document.getElementById("vehicle-tab-content");
    if (content) loadServiceTab(content, vehicle);
  } catch (e) {
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

// ── AŽURIRAJ BADGE U HEADERU DETALJA (bez punog re-rendera) ───
function refreshVehicleHeaderBadge(vehicle) {
  const badge = document.querySelector(".detail-header__title .badge");
  if (badge) {
    badge.className = `badge badge--${vehicle.status || "active"}`;
    badge.textContent = t("vehicle_status_" + (vehicle.status || "active"));
  }
}

// ── HELPERS ───────────────────────────────────────────────────
function detailTable(rows) {
  return `
    <div class="detail-table">
      ${rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([label, value]) => `
        <div class="detail-row">
          <div class="detail-row__label">${label}</div>
          <div class="detail-row__value">${value}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function serviceItem(s, vehicle, canEdit) {
  const status = effectiveServiceStatus(s);
  const today = isServiceToday(s);
  const overdue = isServiceOverdue(s);

  const cancelled = status === SERVICE_STATUS.CANCELLED;

  const statusBadge = cancelled
    ? `<span class="badge badge--cancelled">${t("service_status_cancelled")}</span>`
    : overdue
      ? `<span class="badge badge--broken">⚠️ ${t("service_status_overdue")} — ${t("service_overdue_days", { n: overdueDays(s) })}</span>`
      : status === SERVICE_STATUS.PLANNED
        ? `<span class="badge badge--info">${t("service_status_planned")}</span>`
        : status === SERVICE_STATUS.IN_PROGRESS
          ? `<span class="badge badge--service">${t("service_status_in_progress")}</span>`
          : "";

  const todayBadge = today && status !== SERVICE_STATUS.DONE && !cancelled
    ? `<span class="today-badge">${t("dashboard_today")}</span>`
    : "";

  let actions = "";
  if (canEdit) {
    // Dugmad za potvrdu/otkazivanje ostaju dostupna i kad je servis propušten
    // (overdue) — administrator može da klikne i sutra i kasnije, dugmad nikad
    // sama od sebe ne nestaju dok se ne klikne ili zapis ne bude otkazan/obrisan.
    if (status === SERVICE_STATUS.PLANNED) {
      actions += `<button class="btn btn--primary btn--sm btn-service-taken" data-id="${s.id}">${t("service_taken_btn")}</button>`;
      actions += `<button class="btn btn--secondary btn--sm btn-service-cancel" data-id="${s.id}">${t("service_cancel_btn")}</button>`;
    } else if (status === SERVICE_STATUS.IN_PROGRESS) {
      actions += `<button class="btn btn--primary btn--sm btn-service-complete" data-id="${s.id}">${t("service_complete_btn")}</button>`;
      actions += `<button class="btn btn--secondary btn--sm btn-service-cancel" data-id="${s.id}">${t("service_cancel_btn")}</button>`;
    }
    if (!cancelled) {
      actions += `<button class="btn btn--ghost btn--sm btn-edit-service" data-id="${s.id}" title="${t("edit")}">✏️</button>`;
    }
    actions += `<button class="btn btn--ghost btn--sm btn-delete-service" data-id="${s.id}" title="${t("delete")}">🗑️</button>`;
  }

  return `
    <div class="service-item ${cancelled ? "service-item--cancelled" : overdue ? "service-item--overdue" : today && status !== SERVICE_STATUS.DONE ? "service-item--today" : ""}">
      <div class="service-item__header">
        <div class="service-item__badges">
          <span class="badge badge--info">${t("service_type_" + s.serviceType) || s.serviceType}</span>
          ${statusBadge}
          ${todayBadge}
        </div>
        <span class="service-item__date">${formatDate(s.serviceDate)}${s.serviceTime ? ` 🕒 ${s.serviceTime}` : ""}</span>
      </div>
      ${s.description ? `<div class="service-item__desc">${s.description}</div>` : ""}
      <div class="service-item__meta">
        ${s.km ? `<span>📍 ${s.km.toLocaleString()} km</span>` : ""}
        ${s.cost ? `<span>💰 ${s.cost.toLocaleString()} RSD</span>` : ""}
        ${s.workshop ? `<span>🔧 ${s.workshop}</span>` : ""}
        ${s.workshopAddress ? `<span>🏠 ${s.workshopAddress}</span>` : ""}
      </div>
      ${s.endDate || s.endKm ? `<div class="service-item__next">${t("vehicle_service_end")}: ${formatDate(s.endDate)}${s.endKm ? " / " + s.endKm.toLocaleString() + " km" : ""}</div>` : ""}
      ${actions ? `<div class="service-item__actions">${actions}</div>` : ""}
    </div>
  `;
}

function formatDate(val) {
  return formatDateDMY(val);
}

// Datumi (maska, kalendar, provera) — vidi date-input.js

function numOrNull(id) {
  const val = document.getElementById(id)?.value;
  return val ? Number(val) : null;
}

function dateOrNull(id) {
  const val = document.getElementById(id)?.value;
  return val ? parseDMY(val) : null;
}
