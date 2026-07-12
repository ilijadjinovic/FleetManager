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
import { t, getCurrentLang } from "./i18n.js";
import { S, showToast, openModal, closeModal } from "./app.js";
import { getServiceProviders } from "./servicers.js";
import { effectiveServiceStatus, isServiceToday, isServiceOverdue, overdueDays, SERVICE_STATUS } from "./service-status.js";
import { incidentCard, scheduleServiceForIncident } from "./incidents.js";

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

// ── PNEUMATICI ─────────────────────────────────────────────────
const TIRE_TYPES = ["winter", "summer", "all_season"];

function tireTypeLabel(code) {
  if (!code) return null;
  return TIRE_TYPES.includes(code) ? t("tire_" + code) : code;
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
  const style = reg
    ? "background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid rgba(34,197,94,0.4);"
    : "background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.4);";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;margin-left:6px;white-space:nowrap;${style}">${label}</span>`;
}

// ── STANJE MODULA ─────────────────────────────────────────────
let allVehicles = [];
let currentFilter = "all";
let searchTerm = "";
let currentVehicleId = null; // za detail pogled

// ── GLAVNI RENDER ─────────────────────────────────────────────
export async function renderVehicles(container, initialFilter = null) {
  if (!S.companyId) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🏢</div><p>${t("company_select")}</p></div>`;
    return;
  }

  if (initialFilter) currentFilter = initialFilter;

  const canEdit = S.profile?.role === "master_admin" || S.profile?.role === "fleet_admin";

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">${t("tab_vehicles")}</h2>
      ${canEdit ? `<button id="btn-add-vehicle" class="btn btn--primary btn--sm">+ ${t("vehicle_add")}</button>` : ""}
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

  await loadVehicles();
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

  list.innerHTML = `
    <div class="vehicle-grid">
      ${filtered.map(v => vehicleCard(v)).join("")}
    </div>
  `;

  list.querySelectorAll(".vehicle-card").forEach(card => {
    card.addEventListener("click", () => openVehicleDetail(card.dataset.id));
  });
}

// ── VEHICLE CARD (lista) ──────────────────────────────────────
function vehicleCard(v) {
  const today = new Date();
  const regDate = v.regExpiry ? (v.regExpiry.toDate ? v.regExpiry.toDate() : new Date(v.regExpiry)) : null;
  const daysToReg = regDate ? Math.ceil((regDate - today) / 86400000) : null;
  const regWarning = daysToReg !== null && daysToReg <= 30;

  return `
    <div class="vehicle-card ${v.archived ? "vehicle-card--archived" : ""}" data-id="${v.id}">
      <div class="vehicle-card__header">
        <div class="vehicle-card__info">
          <div class="vehicle-card__name">${v.brand} ${v.model}</div>
          <div class="vehicle-card__plate">${v.plate}</div>
        </div>
        ${v.archived
          ? `<span class="badge badge--cancelled">${t("vehicle_status_archived")}</span>`
          : `<span class="badge badge--${v.status || 'active'}">${t("vehicle_status_" + (v.status || "active"))}</span>`
        }
      </div>
      <div class="vehicle-card__details">
        <div class="vehicle-card__detail">
          <span class="vehicle-card__detail-label">VIN</span>
          <span class="vehicle-card__detail-value mono">${v.vin || "—"}</span>
        </div>
        <div class="vehicle-card__detail">
          <span class="vehicle-card__detail-label">${t("vehicle_current_km")}</span>
          <span class="vehicle-card__detail-value">${v.currentKm ? v.currentKm.toLocaleString() + " km" : "—"}</span>
        </div>
        <div class="vehicle-card__detail ${regWarning ? "vehicle-card__detail--warn" : ""}">
          <span class="vehicle-card__detail-label">${t("vehicle_reg_expiry")}</span>
          <span class="vehicle-card__detail-value">
            ${regDate ? regDate.toLocaleDateString(getCurrentLang() === "en" ? "en-GB" : "sr-RS") : "—"}
            ${regWarning ? ` <span class="reg-warn">(${daysToReg}d)</span>` : ""}
            ${regBadge(v)}
          </span>
        </div>
        <div class="vehicle-card__detail">
          <span class="vehicle-card__detail-label">${t("vehicle_year")}</span>
          <span class="vehicle-card__detail-value">${v.year || "—"}</span>
        </div>
      </div>
      ${v.assignedDriverName ? `
        <div class="vehicle-card__driver">
          <span>👤</span> ${v.assignedDriverName}
        </div>
      ` : ""}
      ${v.notes ? `
        <div class="vehicle-card__notes">
          <span>📝</span> ${v.notes}
        </div>
      ` : ""}
    </div>
  `;
}

// ── DETAIL POGLED ─────────────────────────────────────────────
// initialTab — omogućava skok direktno na neki tab (npr. sa dashboarda na "service")
export async function openVehicleDetail(vehicleId, initialTab = "tech") {
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

  document.getElementById("btn-back")?.addEventListener("click", () => renderVehicles(container));
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
    case "finance":  content.innerHTML = renderFinanceTab(vehicle); break;
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
    [t("vehicle_year"),       v.year],
    [t("vehicle_first_reg"),  formatDate(v.firstRegDate)],
    [t("vehicle_engine_cc"),  v.engineCc ? v.engineCc + " cm³" : null],
    [t("vehicle_power_kw"),   v.powerKw ? v.powerKw + " kW" : null],
    [t("vehicle_seats"),      v.seats],
    [t("vehicle_payload"),    v.payload ? v.payload + " kg" : null],
    [t("vehicle_mass"),       v.mass ? v.mass + " kg" : null],
    [t("vehicle_fuel_type"),  v.fuelType ? t("fuel_" + v.fuelType) : null],
    [t("vehicle_color"),      colorLabel(v.color)],
    [t("vehicle_current_km"), v.currentKm ? v.currentKm.toLocaleString() + " km" : null],
    [t("vehicle_reg_expiry"), `${formatDate(v.regExpiry)}${regBadge(v)}`],
    [t("vehicle_insurance_company"), v.insuranceCompany],
    [t("vehicle_insurance_policy"),  v.insurancePolicy],
    [t("vehicle_insurance_expiry"),  formatDate(v.insuranceExpiry)],
  ];
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

  const equipmentRows = REQUIRED_EQUIPMENT_ITEMS.map(eq => {
    const has = (v.requiredEquipment || []).includes(eq);
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

    <div class="form-section-title" style="margin-top:16px">${t("vehicle_required_equipment")}</div>
    <div class="detail-table">
      ${equipmentRows}
    </div>
  `;
}

function renderFinanceTab(v) {
  const rows = [
    [t("vehicle_purchase_date"),  formatDate(v.purchaseDate)],
    [t("vehicle_purchase_type"),  v.purchaseType],
    [t("vehicle_purchase_value"), v.purchaseValue ? Number(v.purchaseValue).toLocaleString() + " RSD" : null],
  ];
  return detailTable(rows);
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

    container.innerHTML = `
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

    container.innerHTML = items.length === 0
      ? `<div class="empty-state"><div class="empty-state__icon">⚠️</div><p>${t("no_data")}</p></div>`
      : `<div class="incidents-list">${items.map(i => incidentCard(i, false, canEdit)).join("")}</div>`;

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

async function loadAssignmentsTab(container, vehicle) {
  container.innerHTML = `<div class="loading">${t("loading")}</div>`;
  try {
    const snap = await getDocs(
      query(
        collection(db, "companies", S.companyId, "assignments"),
        where("vehicleId", "==", vehicle.id),
        orderBy("startDate", "desc")
      )
    );
    const assignments = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    container.innerHTML = assignments.length === 0
      ? `<div class="empty-state"><div class="empty-state__icon">🔑</div><p>${t("no_data")}</p></div>`
      : `<div class="assignment-list">${assignments.map(a => assignmentItem(a)).join("")}</div>`;
  } catch (e) {
    container.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

// ── FORMA ZA DODAVANJE / EDITOVANJE ──────────────────────────
function openVehicleForm(vehicle = null) {
  const isEdit = !!vehicle;
  const v = vehicle || {};

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
          ${["petrol","diesel","lpg","electric","hybrid"].map(ft =>
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
      <div class="form-group"></div>
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

    <div class="form-section-title" style="margin-top:8px">${t("vehicle_tab_finance")}</div>
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
  ["f-firstRegDate", "f-regExpiry", "f-insuranceExpiry", "f-purchaseDate"].forEach(attachDateMask);

  document.getElementById("f-regExpiry")?.addEventListener("change", (e) => {
    const insuranceInput = document.getElementById("f-insuranceExpiry");
    if (insuranceInput) insuranceInput.value = e.target.value;

    const badgeDiv = document.getElementById("f-reg-badge");
    if (badgeDiv) badgeDiv.innerHTML = regBadge({ regExpiry: parseDMY(e.target.value) });
  });
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

  // ── OSNOVNA VALIDACIJA ────────────────────────────────────────
  let valid = true;
  if (!brand) { fieldError("f-brand", t("vehicle_brand_required")); valid = false; }
  if (!model) { fieldError("f-model", t("vehicle_model_required")); valid = false; }
  if (!plate) { fieldError("f-plate", t("vehicle_plate_required")); valid = false; }
  if (vin && vin.length > 17) { fieldError("f-vin", t("vehicle_vin_max_error")); valid = false; }
  if (!valid) throw new Error("validation");

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
      brand, model, plate, vin,
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
      color:            document.getElementById("f-color")?.value || null,
      status:           document.getElementById("f-status")?.value || "active",
      currentKm:        numOrNull("f-currentKm"),
      regExpiry:        dateOrNull("f-regExpiry"),
      insuranceExpiry:  dateOrNull("f-insuranceExpiry"),
      insuranceCompany: document.getElementById("f-insuranceCompany")?.value.trim() || null,
      insurancePolicy:  document.getElementById("f-insurancePolicy")?.value.trim() || null,
      requiredEquipment,
      tires: (tiresType || tiresDimensions) ? { type: tiresType, dimensions: tiresDimensions } : null,
      purchaseDate:     dateOrNull("f-purchaseDate"),
      purchaseType:     document.getElementById("f-purchaseType")?.value.trim() || null,
      purchaseValue:    numOrNull("f-purchaseValue"),
      notes:            document.getElementById("f-notes")?.value.trim() || null,
    };

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

  const bodyHTML = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("service_type")} *</label>
        <select id="sf-type" class="form-select">
          ${["regular","tech","tires","repair","other"].map(st =>
            `<option value="${st}" ${s.serviceType === st ? "selected" : ""}>${t("service_type_" + st)}</option>`
          ).join("")}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${t("service_date")} *</label>
        <input id="sf-date" class="form-input" type="text" inputmode="numeric" maxlength="10" placeholder="${datePlaceholder()}"
          value="${isEdit ? toDMY(s.serviceDate) : todayDMY()}" />
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
    <div class="form-group">
      <label class="form-label">${t("service_workshop")}</label>
      <select id="sf-workshop-select" class="form-select">
        <option value="">${t("service_workshop_select_ph")}</option>
        ${servicers.map(sp => `<option value="${sp.id}" ${s.servicerId === sp.id ? "selected" : ""}>${sp.name}</option>`).join("")}
        <option value="__other__" ${!s.servicerId && s.workshop ? "selected" : ""}>${t("service_workshop_other")}</option>
      </select>
      <input id="sf-workshop" class="form-input" type="text" style="margin-top:8px;display:${!s.servicerId && s.workshop ? "" : "none"}"
        placeholder="${t("service_workshop")}" value="${!s.servicerId && s.workshop ? s.workshop : ""}" />
    </div>
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
    const serviceDateVal = dateOrNull("sf-date");
    if (!serviceDateVal) return;
    try {
      const selectedId = document.getElementById("sf-workshop-select")?.value || "";
      let workshop = null;
      let servicerId = null;
      if (selectedId === "__other__") {
        workshop = document.getElementById("sf-workshop")?.value.trim() || null;
      } else if (selectedId) {
        const sp = servicers.find(x => x.id === selectedId);
        workshop = sp?.name || null;
        servicerId = selectedId;
      }

      const data = {
        vehicleId:    vehicle.id,
        vehiclePlate: vehicle.plate,
        serviceType:  document.getElementById("sf-type")?.value,
        serviceDate:  serviceDateVal,
        km:           numOrNull("sf-km"),
        cost:         numOrNull("sf-cost"),
        workshop,
        servicerId,
        description:  document.getElementById("sf-desc")?.value.trim() || null,
        endDate:      dateOrNull("sf-endDate"),
        endKm:        numOrNull("sf-endKm"),
      };

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

        await addDoc(collection(db, "companies", S.companyId, "services"), {
          ...data, createdBy: S.user.uid, createdAt: serverTimestamp(),
        });

        // Servis zakazan iz prijave — prijava prelazi u status "u obradi"
        if (options.linkedIncidentId) {
          await updateDoc(doc(db, "companies", S.companyId, "incidents", options.linkedIncidentId), {
            status:    "in_progress",
            updatedAt: serverTimestamp(),
            updatedBy: S.user.uid,
          });
        }
      }

      showToast(t("success"), "success");
      if (options.onSaved) {
        options.onSaved();
      } else {
        const content = document.getElementById("vehicle-tab-content");
        if (content) loadServiceTab(content, vehicle);
      }
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
    }
  });

  ["sf-date", "sf-endDate"].forEach(attachDateMask);

  // Prikaži slobodno polje samo kad je izabrano "Drugo"
  document.getElementById("sf-workshop-select")?.addEventListener("change", (e) => {
    const freeInput = document.getElementById("sf-workshop");
    if (!freeInput) return;
    if (e.target.value === "__other__") {
      freeInput.style.display = "";
      freeInput.focus();
    } else {
      freeInput.style.display = "none";
      freeInput.value = "";
    }
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
function openCompleteServiceModal(vehicle, service) {
  const bodyHTML = `
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
  `;

  openModal(t("service_complete_title"), bodyHTML, async () => {
    try {
      const endKm = numOrNull("cs-endKm");
      await updateDoc(doc(db, "companies", S.companyId, "services", service.id), {
        status: SERVICE_STATUS.DONE,
        endDate: dateOrNull("cs-endDate"),
        endKm,
      });
      const vehicleUpdate = {
        status: service.previousVehicleStatus || "active",
        updatedAt: serverTimestamp(),
      };
      if (endKm && endKm > (vehicle.currentKm || 0)) vehicleUpdate.currentKm = endKm;
      await updateDoc(doc(db, "companies", S.companyId, "vehicles", vehicle.id), vehicleUpdate);

      vehicle.status = vehicleUpdate.status;
      if (vehicleUpdate.currentKm) vehicle.currentKm = vehicleUpdate.currentKm;
      refreshVehicleHeaderBadge(vehicle);
      showToast(t("success"), "success");
      const content = document.getElementById("vehicle-tab-content");
      if (content) loadServiceTab(content, vehicle);
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
    }
  });

  attachDateMask("cs-endDate");
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
        <span class="service-item__date">${formatDate(s.serviceDate)}</span>
      </div>
      ${s.description ? `<div class="service-item__desc">${s.description}</div>` : ""}
      <div class="service-item__meta">
        ${s.km ? `<span>📍 ${s.km.toLocaleString()} km</span>` : ""}
        ${s.cost ? `<span>💰 ${s.cost.toLocaleString()} RSD</span>` : ""}
        ${s.workshop ? `<span>🔧 ${s.workshop}</span>` : ""}
      </div>
      ${s.endDate || s.endKm ? `<div class="service-item__next">${t("vehicle_service_end")}: ${formatDate(s.endDate)}${s.endKm ? " / " + s.endKm.toLocaleString() + " km" : ""}</div>` : ""}
      ${actions ? `<div class="service-item__actions">${actions}</div>` : ""}
    </div>
  `;
}

function assignmentItem(a) {
  return `
    <div class="assignment-item">
      <div class="assignment-item__header">
        <span class="badge badge--${a.status === 'active' ? 'active' : 'inactive'}">
          ${t("assignment_status_" + a.status)}
        </span>
        <span class="assignment-item__dates">
          ${formatDate(a.startDate)} ${a.endDate ? "→ " + formatDate(a.endDate) : ""}
        </span>
      </div>
      <div class="assignment-item__driver">👤 ${a.driverName || "—"}</div>
      <div class="assignment-item__km">
        ${a.startKm ? a.startKm.toLocaleString() + " km" : ""}
        ${a.endKm ? " → " + a.endKm.toLocaleString() + " km" : ""}
      </div>
      ${a.reason ? `<div class="assignment-item__reason">${a.reason}</div>` : ""}
      ${a.tripType === "intercity" && a.destination ? `<div class="assignment-item__dest">📍 ${a.destination}</div>` : ""}
    </div>
  `;
}

function formatDate(val) {
  if (!val) return "—";
  const d = val.toDate ? val.toDate() : new Date(val);
  const locale = getCurrentLang() === "en" ? "en-GB" : "sr-RS";
  return isNaN(d) ? "—" : d.toLocaleDateString(locale);
}

// ── DATUMI: prikaz i unos u lokalnom formatu dd/mm/yyyy ──────
// Napomena: <input type="date"> prikazuje kalendar/datum u formatu koji
// zavisi od jezika/regije PODEŠENE U BROWSERU/OS-u korisnika (mm/dd/yyyy
// za en-US, dd/mm/yyyy za sr-RS, itd.) — to nije nešto što aplikacija može
// da promeni preko HTML/CSS/JS za taj input tip. Zato ovde koristimo obično
// tekstualno polje sa maskom, tako da je format uvek dd/mm/yyyy za sve
// korisnike, nezavisno od podešavanja njihovog browsera.

function toDMY(val) {
  if (!val) return "";
  const d = val.toDate ? val.toDate() : new Date(val);
  if (isNaN(d)) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function todayDMY() {
  return toDMY(new Date());
}

// Placeholder prati jezik aplikacije (dd/mm ostaje fiksno — poslovno
// pravilo firme — menja se samo naziv za "godinu": yyyy (en) / gggg (sr)).
function datePlaceholder() {
  return getCurrentLang() === "en" ? "dd/mm/yyyy" : "dd/mm/gggg";
}

// Parsira "dd/mm/yyyy" u Date objekat (lokalno vreme, ponoć). Vraća null
// ako string nije kompletan ili predstavlja nepostojeći datum (npr. 31/02).
function parseDMY(str) {
  if (!str) return null;
  const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

// Auto-formatiranje dok korisnik kuca: cifre se same grupišu u dd/mm/yyyy.
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

function numOrNull(id) {
  const val = document.getElementById(id)?.value;
  return val ? Number(val) : null;
}

function dateOrNull(id) {
  const val = document.getElementById(id)?.value;
  return val ? parseDMY(val) : null;
}
