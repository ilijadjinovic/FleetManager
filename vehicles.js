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

// ── PREDEFINISANE BOJE VOZILA ────────────────────────────────
const VEHICLE_COLORS = [
  "white", "black", "red", "blue", "orange",
  "green", "yellow", "light_gray", "dark_gray", "brown", "other"
];

function colorLabel(code) {
  if (!code) return null;
  return VEHICLE_COLORS.includes(code) ? t("color_" + code) : code;
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
        <button class="chip ${currentFilter === 'unregistered' ? 'chip--active' : ''}" data-filter="unregistered">${t("vehicle_status_unregistered")}</button>
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
  if (currentFilter !== "all") {
    if (currentFilter === "unregistered") {
      filtered = filtered.filter(v => isVehicleRegistered(v) === false);
    } else {
      filtered = filtered.filter(v => v.status === currentFilter);
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
    <div class="vehicle-card" data-id="${v.id}">
      <div class="vehicle-card__header">
        <div class="vehicle-card__info">
          <div class="vehicle-card__name">${v.brand} ${v.model}</div>
          <div class="vehicle-card__plate">${v.plate}</div>
        </div>
        <span class="badge badge--${v.status || 'active'}">${t("vehicle_status_" + (v.status || "active"))}</span>
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
    </div>
  `;
}

// ── DETAIL POGLED ─────────────────────────────────────────────
// initialTab — omogućava da se skoči direktno na neki tab (npr. sa dashboarda na "service")
export async function openVehicleDetail(vehicleId, initialTab = "tech") {
  currentVehicleId = vehicleId;
  let vehicle = allVehicles.find(v => v.id === vehicleId);

  // Ako vozilo nije u kešu (npr. ulazak direktno sa dashboarda, bez prethodne posete
  // tabu "Vozila"), dohvati ga direktno iz Firestore-a.
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
    { key: "finance",     label: t("vehicle_tab_finance") },
    { key: "service",     label: t("vehicle_tab_service") },
    { key: "assignments", label: t("vehicle_tab_assignments") },
  ];

  container.innerHTML = `
    <div class="detail-header">
      <button class="btn btn--ghost btn--sm" id="btn-back">${t("vehicle_back")}</button>
      <div class="detail-header__title">
        <h2>${vehicle.brand} ${vehicle.model}</h2>
        <span class="badge badge--${vehicle.status || 'active'}">${t("vehicle_status_" + (vehicle.status || "active"))}</span>
      </div>
      ${canEdit ? `
        <div class="detail-header__actions">
          <button class="btn btn--secondary btn--sm" id="btn-edit-vehicle">✏️ ${t("edit")}</button>
          <button class="btn btn--danger btn--sm" id="btn-delete-vehicle">🗑️ ${t("delete")}</button>
        </div>
      ` : ""}
    </div>

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
    document.getElementById("btn-delete-vehicle")?.addEventListener("click", () => confirmDeleteVehicle(vehicle));
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
    case "finance":  content.innerHTML = renderFinanceTab(vehicle); break;
    case "service":    loadServiceTab(content, vehicle); break;
    case "assignments": loadAssignmentsTab(content, vehicle); break;
  }
}

function renderTechTab(v) {
  const rows = [
    [t("vehicle_brand"),      v.brand],
    [t("vehicle_model"),      v.model],
    [t("vehicle_type"),       v.vehicleType],
    [t("vehicle_category"),   v.category],
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

function renderFinanceTab(v) {
  const rows = [
    [t("vehicle_purchase_date"),  formatDate(v.purchaseDate)],
    [t("vehicle_purchase_type"),  v.purchaseType],
    [t("vehicle_purchase_value"), v.purchaseValue ? Number(v.purchaseValue).toLocaleString() + " RSD" : null],
  ];
  return detailTable(rows);
}

async function loadServiceTab(container, vehicle) {
  container.innerHTML = `<div class="loading">${t("loading")}</div>`;
  const canEdit = S.profile?.role !== "driver";
  try {
    const snap = await getDocs(
      query(
        collection(db, "companies", S.companyId, "services"),
        where("vehicleId", "==", vehicle.id),
        orderBy("serviceDate", "desc")
      )
    );
    const services = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    container.innerHTML = `
      ${canEdit ? `<div style="margin-bottom:12px"><button class="btn btn--primary btn--sm" id="btn-add-service">+ ${t("service_add")}</button></div>` : ""}
      ${services.length === 0
        ? `<div class="empty-state"><div class="empty-state__icon">🔧</div><p>${t("no_data")}</p></div>`
        : `<div class="service-list">${services.map(s => serviceItem(s)).join("")}</div>`
      }
    `;

    if (canEdit) {
      document.getElementById("btn-add-service")?.addEventListener("click", () => openServiceForm(vehicle));
    }
  } catch (e) {
    container.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
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
        <input id="f-vehicleType" class="form-input" type="text" value="${v.vehicleType || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_category")}</label>
        <input id="f-category" class="form-input" type="text" value="${v.category || ""}" />
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
        <input id="f-firstRegDate" class="form-input" type="date" value="${toDateInput(v.firstRegDate)}" />
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
        <input id="f-regExpiry" class="form-input" type="date" value="${toDateInput(v.regExpiry)}" />
        <div id="f-reg-badge" style="margin-top:6px">${regBadge(v)}</div>
      </div>
      <div class="form-group">
        <label class="form-label">${t("vehicle_insurance_expiry")}</label>
        <input id="f-insuranceExpiry" class="form-input" type="date" value="${toDateInput(v.insuranceExpiry)}" />
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

    <div class="form-section-title" style="margin-top:8px">${t("vehicle_tab_finance")}</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("vehicle_purchase_date")}</label>
        <input id="f-purchaseDate" class="form-input" type="date" value="${toDateInput(v.purchaseDate)}" />
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
  document.getElementById("f-regExpiry")?.addEventListener("change", (e) => {
    const insuranceInput = document.getElementById("f-insuranceExpiry");
    if (insuranceInput) insuranceInput.value = e.target.value;

    const badgeDiv = document.getElementById("f-reg-badge");
    if (badgeDiv) badgeDiv.innerHTML = regBadge({ regExpiry: e.target.value });
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

    const data = {
      brand, model, plate, vin,
      vehicleType:      document.getElementById("f-vehicleType")?.value.trim() || null,
      category:         document.getElementById("f-category")?.value.trim() || null,
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

// ── BRISANJE VOZILA ───────────────────────────────────────────
function confirmDeleteVehicle(vehicle) {
  if (!confirm(t("confirm_delete"))) return;
  deleteDoc(doc(db, "companies", S.companyId, "vehicles", vehicle.id))
    .then(() => {
      showToast(t("success"), "success");
      const container = document.getElementById("content");
      if (container) renderVehicles(container);
    })
    .catch(e => showToast(`${t("error")}: ${e.message}`, "error"));
}

// ── SERVIS FORMA ──────────────────────────────────────────────
async function openServiceForm(vehicle) {
  const servicers = await getServiceProviders();

  const bodyHTML = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("service_type")} *</label>
        <select id="sf-type" class="form-select">
          ${["regular","tech","tires","repair","other"].map(st =>
            `<option value="${st}">${t("service_type_" + st)}</option>`
          ).join("")}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${t("service_date")} *</label>
        <input id="sf-date" class="form-input" type="date" value="${new Date().toISOString().split("T")[0]}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("service_km")}</label>
        <input id="sf-km" class="form-input" type="number" value="${vehicle.currentKm || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("service_cost")}</label>
        <input id="sf-cost" class="form-input" type="number" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("service_workshop")}</label>
      <select id="sf-workshop-select" class="form-select">
        <option value="">${t("service_workshop_select_ph")}</option>
        ${servicers.map(sp => `<option value="${sp.id}">${sp.name}</option>`).join("")}
        <option value="__other__">${t("service_workshop_other")}</option>
      </select>
      <input id="sf-workshop" class="form-input" type="text" style="margin-top:8px;display:none" placeholder="${t("service_workshop")}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("service_description")}</label>
      <textarea id="sf-desc" class="form-textarea"></textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("service_next_date")}</label>
        <input id="sf-nextDate" class="form-input" type="date" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("service_next_km")}</label>
        <input id="sf-nextKm" class="form-input" type="number" />
      </div>
    </div>
  `;

  openModal(t("service_add"), bodyHTML, async () => {
    const dateVal = document.getElementById("sf-date")?.value;
    if (!dateVal) return;
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

      await addDoc(collection(db, "companies", S.companyId, "services"), {
        vehicleId:   vehicle.id,
        vehiclePlate: vehicle.plate,
        serviceType: document.getElementById("sf-type")?.value,
        serviceDate: new Date(dateVal),
        km:          numOrNull("sf-km"),
        cost:        numOrNull("sf-cost"),
        workshop,
        servicerId,
        description: document.getElementById("sf-desc")?.value.trim() || null,
        nextDate:    dateOrNull("sf-nextDate"),
        nextKm:      numOrNull("sf-nextKm"),
        createdBy:   S.user.uid,
        createdAt:   serverTimestamp(),
      });
      showToast(t("success"), "success");
      // reload service tab
      const content = document.getElementById("vehicle-tab-content");
      if (content) loadServiceTab(content, vehicle);
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
    }
  });

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

// ── ZAKAZANI SERVISI TAB je uklonjen ──────────────────────────
// (nikad nije bio povezan ni sa jednim tab dugmetom u UI — mrtav kod)


function serviceItem(s) {
  return `
    <div class="service-item">
      <div class="service-item__header">
        <span class="badge badge--info">${t("service_type_" + s.serviceType) || s.serviceType}</span>
        <span class="service-item__date">${formatDate(s.serviceDate)}</span>
      </div>
      ${s.description ? `<div class="service-item__desc">${s.description}</div>` : ""}
      <div class="service-item__meta">
        ${s.km ? `<span>📍 ${s.km.toLocaleString()} km</span>` : ""}
        ${s.cost ? `<span>💰 ${s.cost.toLocaleString()} RSD</span>` : ""}
        ${s.workshop ? `<span>🔧 ${s.workshop}</span>` : ""}
      </div>
      ${s.nextDate ? `<div class="service-item__next">${t("vehicle_service_next")}: ${formatDate(s.nextDate)}${s.nextKm ? " / " + s.nextKm.toLocaleString() + " km" : ""}</div>` : ""}
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

function toDateInput(val) {
  if (!val) return "";
  const d = val.toDate ? val.toDate() : new Date(val);
  if (isNaN(d)) return "";
  return d.toISOString().split("T")[0];
}

function numOrNull(id) {
  const val = document.getElementById(id)?.value;
  return val ? Number(val) : null;
}

function dateOrNull(id) {
  const val = document.getElementById(id)?.value;
  return val ? new Date(val) : null;
}
