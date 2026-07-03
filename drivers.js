// ============================================================
//  drivers.js  —  Fleet Manager
//  Tab: Vozači — lista, kartica, forma za unos/editovanje
// ============================================================

import { db, auth } from "./firebase.js";
import {
  collection, query, orderBy, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc, serverTimestamp, where
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import {
  createUserWithEmailAndPassword,
  fetchSignInMethodsForEmail,
  updatePassword,
  getAuth
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import { t, getCurrentLang } from "./i18n.js";
import { S, showToast, openModal } from "./app.js";
import { usernameToEmail, getSecondaryAuth } from "./firebase.js";

// ── STANJE MODULA ─────────────────────────────────────────────
let allDrivers = [];
let searchTerm = "";
let filterStatus = "all";

// ── GLAVNI RENDER ─────────────────────────────────────────────
export async function renderDrivers(container) {
  if (!S.companyId) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🏢</div><p>${t("company_select")}</p></div>`;
    return;
  }

  const canEdit = S.profile?.role === "master_admin" || S.profile?.role === "fleet_admin";

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">${t("tab_drivers")}</h2>
      ${canEdit ? `<button id="btn-add-driver" class="btn btn--primary btn--sm">+ ${t("driver_add")}</button>` : ""}
    </div>

    <div class="filter-bar">
      <div class="search-bar">
        <span class="search-bar__icon">🔍</span>
        <input id="driver-search" type="text" class="search-bar__input form-input"
          placeholder="${t("search")}..." />
      </div>
      <div class="filter-chips">
        <button class="chip chip--active" data-filter="all">${t("company_all")}</button>
        <button class="chip" data-filter="active">${t("driver_active")}</button>
        <button class="chip" data-filter="inactive">${t("driver_inactive")}</button>
      </div>
    </div>

    <div id="drivers-list"><div class="loading">${t("loading")}</div></div>
  `;

  if (canEdit) {
    document.getElementById("btn-add-driver")?.addEventListener("click", () => openDriverForm());
  }

  document.getElementById("driver-search")?.addEventListener("input", (e) => {
    searchTerm = e.target.value.toLowerCase();
    renderList();
  });

  document.querySelectorAll(".filter-chips .chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".filter-chips .chip").forEach(c => c.classList.remove("chip--active"));
      chip.classList.add("chip--active");
      filterStatus = chip.dataset.filter;
      renderList();
    });
  });

  await loadDrivers();
}

// ── UČITAJ VOZAČE ─────────────────────────────────────────────
async function loadDrivers() {
  try {
    const snap = await getDocs(
      query(
        collection(db, "companies", S.companyId, "drivers"),
        orderBy("lastName", "asc")
      )
    );
    allDrivers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
  } catch (e) {
    const list = document.getElementById("drivers-list");
    if (list) list.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

// ── RENDER LISTA ──────────────────────────────────────────────
function renderList() {
  const list = document.getElementById("drivers-list");
  if (!list) return;

  let filtered = allDrivers;

  if (filterStatus !== "all") {
    filtered = filtered.filter(d =>
      filterStatus === "active" ? d.active !== false : d.active === false
    );
  }

  if (searchTerm) {
    filtered = filtered.filter(d =>
      `${d.firstName} ${d.lastName} ${d.position || ""} ${d.phone || ""} ${d.username || ""}`
        .toLowerCase().includes(searchTerm)
    );
  }

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state__icon">👤</div><p>${t("no_data")}</p></div>`;
    return;
  }

  const canEdit = S.profile?.role === "master_admin" || S.profile?.role === "fleet_admin";

  list.innerHTML = `
    <div class="drivers-grid">
      ${filtered.map(d => driverCard(d, canEdit)).join("")}
    </div>
  `;

  list.querySelectorAll(".driver-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".btn")) return; // ne otvara detail ako se klikne dugme
      openDriverDetail(card.dataset.id);
    });
  });

  if (canEdit) {
    list.querySelectorAll(".btn-edit-driver").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const driver = allDrivers.find(d => d.id === btn.dataset.id);
        if (driver) openDriverForm(driver);
      });
    });
    list.querySelectorAll(".btn-toggle-driver").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const driver = allDrivers.find(d => d.id === btn.dataset.id);
        if (driver) toggleDriverActive(driver);
      });
    });
  }
}

// ── DRIVER CARD ───────────────────────────────────────────────
function driverCard(d, canEdit) {
  const isActive = d.active !== false;
  const hasLogin = d.username || d.googleEmail;
  const initials = `${(d.firstName || "?")[0]}${(d.lastName || "?")[0]}`.toUpperCase();

  return `
    <div class="driver-card ${!isActive ? "driver-card--inactive" : ""}" data-id="${d.id}">
      <div class="driver-card__avatar">${initials}</div>
      <div class="driver-card__body">
        <div class="driver-card__header">
          <div class="driver-card__name">${d.firstName} ${d.lastName}</div>
          <span class="badge badge--${isActive ? "active" : "inactive"}">
            ${isActive ? t("driver_active") : t("driver_inactive")}
          </span>
        </div>
        ${d.position ? `<div class="driver-card__position">💼 ${d.position}</div>` : ""}
        <div class="driver-card__details">
          ${d.licenseCategories ? `<span class="driver-detail">🪪 ${d.licenseCategories}</span>` : ""}
          ${d.phone ? `<span class="driver-detail">📞 ${d.phone}</span>` : ""}
          ${d.birthYear ? `<span class="driver-detail">📅 ${d.birthYear}</span>` : ""}
        </div>
        <div class="driver-card__login">
          ${d.googleEmail ? `<span class="login-chip login-chip--google">G</span>` : ""}
          ${d.username ? `<span class="login-chip login-chip--local">UN</span>` : ""}
          ${!hasLogin ? `<span class="login-chip login-chip--none">${t("driver_no_access")}</span>` : ""}
        </div>
      </div>
      ${canEdit ? `
        <div class="driver-card__actions">
          <button class="btn btn--ghost btn--sm btn-edit-driver" data-id="${d.id}" title="${t("edit")}">✏️</button>
          <button class="btn btn--ghost btn--sm btn-toggle-driver" data-id="${d.id}"
            title="${isActive ? t("driver_inactive") : t("driver_active")}">
            ${isActive ? "⏸️" : "▶️"}
          </button>
        </div>
      ` : ""}
    </div>
  `;
}

// ── DETAIL POGLED ─────────────────────────────────────────────
async function openDriverDetail(driverId) {
  const driver = allDrivers.find(d => d.id === driverId);
  if (!driver) return;

  const canEdit = S.profile?.role === "master_admin" || S.profile?.role === "fleet_admin";
  const container = document.getElementById("content");

  // Dohvati aktivno zaduženje
  let activeAssignment = null;
  try {
    const snap = await getDocs(query(
      collection(db, "companies", S.companyId, "assignments"),
      where("driverId", "==", driverId),
      where("status", "==", "active")
    ));
    if (!snap.empty) activeAssignment = { id: snap.docs[0].id, ...snap.docs[0].data() };
  } catch (e) { /* ignoriši */ }

  container.innerHTML = `
    <div class="detail-header">
      <button class="btn btn--ghost btn--sm" id="btn-back">${t("vehicle_back")}</button>
      <div class="detail-header__title">
        <div class="driver-avatar-lg">${(driver.firstName[0] + driver.lastName[0]).toUpperCase()}</div>
        <div>
          <h2>${driver.firstName} ${driver.lastName}</h2>
          ${driver.position ? `<div class="driver-detail-position">${driver.position}</div>` : ""}
        </div>
        <span class="badge badge--${driver.active !== false ? "active" : "inactive"}">
          ${driver.active !== false ? t("driver_active") : t("driver_inactive")}
        </span>
      </div>
      ${canEdit ? `
        <div class="detail-header__actions">
          <button class="btn btn--secondary btn--sm" id="btn-edit-driver-detail">✏️ ${t("edit")}</button>
          <button class="btn btn--danger btn--sm" id="btn-delete-driver">🗑️ ${t("delete")}</button>
        </div>
      ` : ""}
    </div>

    <div class="tab-strip" id="driver-tabs">
      <button class="tab-strip__btn tab-strip__btn--active" data-dtab="info">${t("driver_tab_info")}</button>
      <button class="tab-strip__btn" data-dtab="assignments">${t("driver_tab_assignments")}</button>
      <button class="tab-strip__btn" data-dtab="trips">${t("driver_tab_trips")}</button>
      <button class="tab-strip__btn" data-dtab="incidents">${t("driver_tab_incidents")}</button>
    </div>

    ${activeAssignment ? `
      <div class="active-assignment-banner">
        🔑 Trenutno zadužen: <strong>${activeAssignment.vehicleBrand} ${activeAssignment.vehicleModel}</strong>
        — ${activeAssignment.vehiclePlate}
        ${activeAssignment.tripType === "intercity" ? `📍 ${activeAssignment.destination || ""}` : ""}
      </div>
    ` : ""}

    <div id="driver-tab-content"></div>
  `;

  document.getElementById("btn-back")?.addEventListener("click", () => {
    const c = document.getElementById("content");
    if (c) renderDrivers(c);
  });

  if (canEdit) {
    document.getElementById("btn-edit-driver-detail")?.addEventListener("click", () => openDriverForm(driver));
    document.getElementById("btn-delete-driver")?.addEventListener("click", () => confirmDeleteDriver(driver));
  }

  document.getElementById("driver-tabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-strip__btn");
    if (!btn) return;
    document.querySelectorAll(".tab-strip__btn").forEach(b => b.classList.remove("tab-strip__btn--active"));
    btn.classList.add("tab-strip__btn--active");
    renderDriverTab(btn.dataset.dtab, driver);
  });

  renderDriverTab("info", driver);
}

// ── DRIVER TABOVI ─────────────────────────────────────────────
function renderDriverTab(tab, driver) {
  const content = document.getElementById("driver-tab-content");
  if (!content) return;
  switch (tab) {
    case "info":        content.innerHTML = renderInfoTab(driver); break;
    case "assignments": loadDriverAssignments(content, driver); break;
    case "trips":       loadDriverTrips(content, driver); break;
    case "incidents":   loadDriverIncidents(content, driver); break;
  }
}

function renderInfoTab(d) {
  const hasLogin = d.username || d.googleEmail;
  const rows = [
    [t("driver_firstname"),    d.firstName],
    [t("driver_lastname"),     d.lastName],
    ["JMBG",                   d.jmbg],
    [t("driver_birth_year"),   d.birthYear],
    [t("driver_license_cat"),  d.licenseCategories],
    [t("driver_position"),     d.position],
    [t("driver_phone"),        d.phone],
    [t("driver_email"),        d.email],
    [t("driver_home_address"),  d.homeAddress],
    [t("driver_work_address"), d.workAddress],
  ];

  const loginRows = [
    [t("driver_google_email"), d.googleEmail],
    [t("driver_username"),     d.username],
    [t("driver_password_label"), d.username ? "••••••••" : null],
  ];

  return `
    ${detailTable(rows)}
    <div class="form-section-title" style="margin:16px 0 12px">${t("driver_app_access")}</div>
    ${!hasLogin
      ? `<div class="no-login-notice">⚠️ ${t("driver_no_access_msg")}</div>`
      : detailTable(loginRows)
    }
  `;
}

async function loadDriverAssignments(container, driver) {
  container.innerHTML = `<div class="loading">${t("loading")}</div>`;
  try {
    const snap = await getDocs(query(
      collection(db, "companies", S.companyId, "assignments"),
      where("driverId", "==", driver.id),
      orderBy("startDate", "desc")
    ));
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    container.innerHTML = items.length === 0
      ? `<div class="empty-state"><div class="empty-state__icon">🔑</div><p>${t("no_data")}</p></div>`
      : `<div class="assignment-list">${items.map(a => assignmentItem(a)).join("")}</div>`;
  } catch (e) {
    container.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

async function loadDriverTrips(container, driver) {
  container.innerHTML = `<div class="loading">${t("loading")}</div>`;
  try {
    const snap = await getDocs(query(
      collection(db, "companies", S.companyId, "trips"),
      where("driverId", "==", driver.id),
      orderBy("createdAt", "desc")
    ));
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (items.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🛣️</div><p>${t("no_data")}</p></div>`;
      return;
    }
    container.innerHTML = `
      <div class="trips-summary">
        <div class="trip-stat">
          <span class="trip-stat__value">${items.length}</span>
          <span class="trip-stat__label">${t("driver_trips_count")}</span>
        </div>
        <div class="trip-stat">
          <span class="trip-stat__value">${items.reduce((s, i) => s + ((i.endKm || 0) - (i.startKm || 0)), 0).toLocaleString()}</span>
          <span class="trip-stat__label">${t("driver_trips_km")}</span>
        </div>
        <div class="trip-stat">
          <span class="trip-stat__value">${items.reduce((s, i) => s + (i.fuelAmount || 0), 0).toFixed(1)}</span>
          <span class="trip-stat__label">${t("driver_trips_fuel_l")}</span>
        </div>
        <div class="trip-stat">
          <span class="trip-stat__value">${items.reduce((s, i) => s + (i.fuelCost || 0), 0).toLocaleString()}</span>
          <span class="trip-stat__label">${t("driver_trips_fuel_rsd")}</span>
        </div>
      </div>
      <div class="trips-list">
        ${items.map(trip => tripItem(trip)).join("")}
      </div>
    `;
  } catch (e) {
    container.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

async function loadDriverIncidents(container, driver) {
  container.innerHTML = `<div class="loading">${t("loading")}</div>`;
  try {
    const snap = await getDocs(query(
      collection(db, "companies", S.companyId, "incidents"),
      where("driverId", "==", driver.id),
      orderBy("createdAt", "desc")
    ));
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    container.innerHTML = items.length === 0
      ? `<div class="empty-state"><div class="empty-state__icon">⚠️</div><p>${t("no_data")}</p></div>`
      : `<div class="incidents-list">${items.map(i => incidentItem(i)).join("")}</div>`;
  } catch (e) {
    container.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

// ── FORMA ZA DODAVANJE / EDITOVANJE ──────────────────────────
function openDriverForm(driver = null) {
  const isEdit = !!driver;
  const d = driver || {};

  const bodyHTML = `
    <div class="form-section-title">${t("driver_personal_section")}</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("driver_firstname")} *</label>
        <input id="df-firstName" class="form-input" type="text" value="${d.firstName || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("driver_lastname")} *</label>
        <input id="df-lastName" class="form-input" type="text" value="${d.lastName || ""}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("driver_birth_year")}</label>
        <input id="df-birthYear" class="form-input" type="number" min="1940" max="2010"
          value="${d.birthYear || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("driver_license_cat")}</label>
        <input id="df-licenseCategories" class="form-input" type="text"
          placeholder="B, C, CE..." value="${d.licenseCategories || ""}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("driver_jmbg_label")}</label>
        <input id="df-jmbg" class="form-input" type="text" maxlength="13"
          placeholder="1234567890123" value="${d.jmbg || ""}"
          oninput="this.value=this.value.replace(/[^0-9]/g,'')" />
        <span class="form-hint">${t("driver_jmbg_hint")}</span>
      </div>
      <div class="form-group">
        <label class="form-label">${t("driver_position")}</label>
        <input id="df-position" class="form-input" type="text" value="${d.position || ""}" />
      </div>
    </div>

    <div class="form-section-title" style="margin-top:4px">${t("driver_contact_section")}</div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("driver_phone")}</label>
        <input id="df-phone" class="form-input" type="tel" value="${d.phone || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("driver_email")}</label>
        <input id="df-email" class="form-input" type="email" value="${d.email || ""}" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("driver_home_address")}</label>
      <input id="df-homeAddress" class="form-input" type="text" value="${d.homeAddress || ""}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("driver_work_address")}</label>
      <input id="df-workAddress" class="form-input" type="text" value="${d.workAddress || ""}" />
    </div>

    <div class="form-section-title" style="margin-top:4px">${t("driver_access_section")}</div>
    <div class="form-group">
      <label class="form-label">${t("driver_google_email")}</label>
      <input id="df-googleEmail" class="form-input" type="email"
        placeholder="vozac@gmail.com" value="${d.googleEmail || ""}"
        ${isEdit && d.googleEmail ? "readonly" : ""} />
      ${isEdit && d.googleEmail
        ? `<span class="form-hint">⚠️ Gmail se ne može menjati. Za promenu — obrišite i dodajte ponovo.</span>`
        : `<span class="form-hint">Ostavite prazno ako vozač ne koristi Google login</span>`}
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("driver_username")}</label>
        <input id="df-username" class="form-input" type="text"
          placeholder="ime.prezime" value="${d.username || ""}"
          ${isEdit && d.username ? "readonly" : ""} />
        ${isEdit && d.username
          ? `<span class="form-hint">⚠️ Username se ne može menjati</span>`
          : `<span class="form-hint">${t("driver_password_hint")}</span>`}
      </div>
      <div class="form-group">
        <label class="form-label">${t("driver_password")}${isEdit && d.username ? " (nova)" : ""}</label>
        <input id="df-password" class="form-input" type="password"
          placeholder="${isEdit && d.username ? "Ostavite prazno da ne menjate" : "Min. 6 karaktera"}" />
        ${isEdit && d.username
          ? `<span class="form-hint">Samo ako želite da promenite lozinku</span>`
          : `<span class="form-hint">Obavezno ako unosite username</span>`}
      </div>
    </div>

    <div class="form-group" style="margin-top:4px">
      <label class="form-label">${t("driver_status_label")}</label>
      <select id="df-active" class="form-select">
        <option value="true"  ${d.active !== false ? "selected" : ""}>${t("driver_active")}</option>
        <option value="false" ${d.active === false  ? "selected" : ""}>${t("driver_inactive")}</option>
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">${t("notes")}</label>
      <textarea id="df-notes" class="form-textarea">${d.notes || ""}</textarea>
    </div>

    <p id="driver-form-error" class="login-error hidden"></p>
  `;

  openModal(
    isEdit ? `${t("edit")}: ${d.firstName} ${d.lastName}` : t("driver_add"),
    bodyHTML,
    async () => saveDriver(driver?.id || null, driver)
  );
}

// ── FIELD ERROR HELPER ───────────────────────────────────────
function fieldError(inputId, msg) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.classList.add("input--error");
  // Ukloni stari hint ako postoji
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

// ── SNIMI VOZAČA ──────────────────────────────────────────────
async function saveDriver(driverId, existingDriver) {
  clearFieldErrors();

  const firstName = document.getElementById("df-firstName")?.value.trim();
  const lastName  = document.getElementById("df-lastName")?.value.trim();
  const username  = document.getElementById("df-username")?.value.trim();
  const password  = document.getElementById("df-password")?.value;
  const googleEmail = document.getElementById("df-googleEmail")?.value.trim().toLowerCase();
  const jmbg = document.getElementById("df-jmbg")?.value.trim() || null;

  // ── VALIDACIJA ────────────────────────────────────────────────
  let valid = true;

  if (!firstName) { fieldError("df-firstName", t("driver_first_name_required")); valid = false; }
  if (!lastName)  { fieldError("df-lastName",  t("driver_last_name_required")); valid = false; }

  if (!driverId && username && !password) {
    fieldError("df-password", t("driver_password_required"));
    valid = false;
  }
  if (username && password && password.length < 6) {
    fieldError("df-password", t("driver_password_min").replace("{0}", password.length));
    valid = false;
  }
  if (jmbg && jmbg.length !== 13) {
    fieldError("df-jmbg", t("driver_jmbg_error"));
    valid = false;
  }

  if (!valid) throw new Error("validation");

  const data = {
    firstName,
    lastName,
    jmbg:              jmbg,
    birthYear:         numOrNull("df-birthYear"),
    licenseCategories: document.getElementById("df-licenseCategories")?.value.trim() || null,
    position:          document.getElementById("df-position")?.value.trim() || null,
    phone:             document.getElementById("df-phone")?.value.trim() || null,
    email:             document.getElementById("df-email")?.value.trim() || null,
    homeAddress:       document.getElementById("df-homeAddress")?.value.trim() || null,
    workAddress:       document.getElementById("df-workAddress")?.value.trim() || null,
    googleEmail:       googleEmail || null,
    username:          username || null,
    active:            document.getElementById("df-active")?.value === "true",
    notes:             document.getElementById("df-notes")?.value.trim() || null,
  };

  try {
    const fakeEmail = username ? usernameToEmail(username) : null;
    const isEdit    = !!driverId;
    const hasExistingLocalAuth = !!(existingDriver?.localAuthUid);
    const passwordChanged = isEdit && username && password;

    // ── VALIDACIJA JEDINSTVENOSTI JMBG (pre kreiranja Auth naloga!) ──
    if (data.jmbg && data.jmbg !== existingDriver?.jmbg) {
      const jmbgSnap = await getDocs(query(
        collection(db, "companies", S.companyId, "drivers"),
        where("jmbg", "==", data.jmbg)
      ));
      if (!jmbgSnap.empty) {
        const ex = jmbgSnap.docs[0].data();
        fieldError("df-jmbg", t("driver_jmbg_taken").replace("{0}", ex.firstName).replace("{1}", ex.lastName));
        throw new Error("validation");
      }
    }

    // ── NOVI VOZAČ — kreiraj Firebase Auth nalog ──────────────
    console.log("[saveDriver] pre Auth bloka", { isEdit, username, hasPassword: !!password, fakeEmail, companyId: S.companyId, userUid: S.user?.uid });
    // Koristimo sekundarnu instancu da ne odjavimo admina!
    if (!isEdit && username && password) {
      console.log("[saveDriver] kreiram Auth nalog za:", fakeEmail);
      try {
        const secondaryAuth = getSecondaryAuth();
        const cred = await createUserWithEmailAndPassword(secondaryAuth, fakeEmail, password);
        data.localAuthUid = cred.user.uid;
        data.lastSetPassword = password;
        await secondaryAuth.signOut();
        console.log("[saveDriver] Auth nalog kreiran OK:", cred.user.uid);
      } catch (authErr) {
        console.error("[saveDriver] Auth greška:", authErr.code, authErr.message);
        throw authErr;
      }
    }

    // ── EDIT + PROMENA PASSWORDA — briši stari, napravi novi ──
    if (isEdit && username && password && hasExistingLocalAuth) {
      // Korak 1: obriši stari users dokument
      try {
        await deleteDoc(doc(db, "users", existingDriver.localAuthUid));
      } catch (e) { /* možda već ne postoji */ }

      // Korak 2: kreiraj novi Firebase Auth nalog sa istim username, novim passwordom
      // Najpre pokušaj da obrišemo stari nalog kroz REST API
      // (nije moguće sa frontendom — zato radimo workaround)
      // Workaround: koristimo privremeni novi nalog sa timestamp sufiksom u emailu,
      // pa ga odmah zamenimo pravim
      //
      // Realistično rešenje: kreiramo novi nalog. Stari ostaje u Firebase Auth ali
      // je siroče (nema users dokument, nema pristupa app-i).
      // Novi nalog dobija isti username lookup.

      const ts = Date.now();
      const newEmail = `${username}.${ts}@fleetapp.internal`;
      const secondaryAuth = getSecondaryAuth();
      const cred = await createUserWithEmailAndPassword(secondaryAuth, newEmail, password);
      await secondaryAuth.signOut();

      data.localAuthUid    = cred.user.uid;
      data.localAuthEmail  = newEmail;
      data.lastSetPassword = password;
    }

    // ── EDIT + BEZ PROMENE PASSWORDA ─────────────────────────
    if (isEdit && username && !password && hasExistingLocalAuth) {
      // Čuva se stari localAuthUid, password se ne menja
      data.localAuthUid   = existingDriver.localAuthUid;
      data.localAuthEmail = existingDriver.localAuthEmail;
      data.lastSetPassword = existingDriver.lastSetPassword;
    }

    // ── SNIMI U FIRESTORE ─────────────────────────────────────
    let driverDocId = driverId;

    if (isEdit) {
      await updateDoc(
        doc(db, "companies", S.companyId, "drivers", driverId),
        { ...data, updatedAt: serverTimestamp() }
      );
    } else {
      console.log("[saveDriver] addDoc - snimam vozača u Firestore...", { companyId: S.companyId, data });
      const ref = await addDoc(
        collection(db, "companies", S.companyId, "drivers"),
        { ...data, createdAt: serverTimestamp(), createdBy: S.user.uid }
      );
      driverDocId = ref.id;
      console.log("[saveDriver] vozač snimljen, id:", driverDocId);
    }

    // ── KREIRAJ / AŽURIRAJ users DOKUMENT za lokalnog korisnika
    if (data.localAuthUid) {
      const { setDoc: fSetDoc } = await import(
        "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js"
      );
      await fSetDoc(doc(db, "users", data.localAuthUid), {
        role:        "driver",
        status:      "active",
        companyId:   S.companyId,
        driverId:    driverDocId,
        firstName,
        lastName,
        displayName: `${firstName} ${lastName}`,
        username,
        googleEmail: null,
        createdAt:   serverTimestamp(),
        createdBy:   S.user.uid,
      });
    }

    // ── REFRESH LISTE — uvek, odmah nakon snimanja ───────────
    await loadDrivers();
    const container = document.getElementById("content");
    if (container) renderDrivers(container);

    // ── PRIKAŽI NOVI PASSWORD ADMINU (ako je promenjen) ───────
    if (data.lastSetPassword && ((!isEdit && username) || passwordChanged)) {
      showPasswordDialog(firstName, lastName, username, data.lastSetPassword);
    } else {
      showToast(t("success"), "success");
    }

  } catch (e) {
    if (e.message === "validation") throw e; // poruka je već prikazana kao field error
    console.error("[saveDriver] GREŠKA:", e.code, e.message, e);
    if (e.code === "auth/email-already-in-use") {
      fieldError("df-username", t("driver_username_taken"));
    } else {
      showFormError(`${t("error")}: ${e.message}`);
    }
    throw e; // modal ostaje otvoren
  }
}

// ── PRIKAZ PASSWORDA ADMINU ───────────────────────────────────
function showPasswordDialog(firstName, lastName, username, password) {
  // Zatvori formu
  document.getElementById("modal-overlay")?.classList.add("hidden");

  // Otvori novi modal sa kredencijalima — bez setTimeout, direktno
  {
    const bodyHTML = `
      <div class="password-reveal">
        <div class="password-reveal__icon">🔐</div>
        <p class="password-reveal__msg">
          ${t("driver_credentials_msg").replace("{0}", firstName).replace("{1}", lastName)}
        </p>
        <div class="password-reveal__field">
          <span class="password-reveal__label">Korisničko ime</span>
          <span class="password-reveal__value" id="pw-username">${username}</span>
          <button class="btn btn--ghost btn--sm" onclick="navigator.clipboard.writeText('${username}')">📋</button>
        </div>
        <div class="password-reveal__field">
          <span class="password-reveal__label">Lozinka</span>
          <span class="password-reveal__value" id="pw-password">${password}</span>
          <button class="btn btn--ghost btn--sm" onclick="navigator.clipboard.writeText('${password}')">📋</button>
        </div>
        <div class="password-reveal__warning">
          ⚠️ ${t("driver_credentials_warning")}
        </div>
      </div>
    `;

    import("./app.js").then(({ openModal }) => {
      // Koristimo openModal bez onConfirm — confirm dugme ce biti skriveno
      // Cancel dugme postaje jedino dugme i menjamo mu tekst
      openModal(t("driver_credentials_title"), bodyHTML, null);
      const cancelBtn = document.getElementById("modal-cancel");
      if (cancelBtn) cancelBtn.textContent = t("driver_credentials_close");
    });
  }
}

// ── TOGGLE ACTIVE ─────────────────────────────────────────────
async function toggleDriverActive(driver) {
  try {
    await updateDoc(
      doc(db, "companies", S.companyId, "drivers", driver.id),
      { active: !driver.active, updatedAt: serverTimestamp() }
    );
    showToast(t("success"), "success");
    await loadDrivers();
  } catch (e) {
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

// ── BRISANJE VOZAČA ───────────────────────────────────────────
function confirmDeleteDriver(driver) {
  if (!confirm(t("confirm_delete"))) return;
  deleteDoc(doc(db, "companies", S.companyId, "drivers", driver.id))
    .then(async () => {
      showToast(t("success"), "success");
      const container = document.getElementById("content");
      await loadDrivers();
      if (container) renderDrivers(container);
    })
    .catch(e => showToast(`${t("error")}: ${e.message}`, "error"));
}

// ── HELPER RENDER FUNKCIJE ────────────────────────────────────
function detailTable(rows) {
  const filtered = rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (filtered.length === 0) return `<p class="empty-text">${t("no_data")}</p>`;
  return `
    <div class="detail-table">
      ${filtered.map(([label, value]) => `
        <div class="detail-row">
          <div class="detail-row__label">${label}</div>
          <div class="detail-row__value">${value}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function assignmentItem(a) {
  return `
    <div class="assignment-item">
      <div class="assignment-item__header">
        <span class="badge badge--${a.status === "active" ? "active" : "inactive"}">
          ${t("assignment_status_" + a.status)}
        </span>
        <span class="assignment-item__dates">
          ${formatDate(a.startDate)} ${a.endDate ? "→ " + formatDate(a.endDate) : ""}
        </span>
      </div>
      <div class="assignment-item__driver">🚗 ${a.vehicleBrand || ""} ${a.vehicleModel || ""} — ${a.vehiclePlate || ""}</div>
      <div class="assignment-item__km">
        ${a.startKm ? a.startKm.toLocaleString() + " km" : ""}
        ${a.endKm ? " → " + a.endKm.toLocaleString() + " km" : ""}
      </div>
      ${a.reason ? `<div class="assignment-item__reason">${a.reason}</div>` : ""}
      ${a.tripType === "intercity" && a.destination ? `<div class="assignment-item__dest">📍 ${a.destination}</div>` : ""}
    </div>
  `;
}

function tripItem(trip) {
  const km = (trip.endKm || 0) - (trip.startKm || 0);
  return `
    <div class="trip-item">
      <div class="trip-item__header">
        <span class="trip-item__date">${formatDate(trip.createdAt)}</span>
        <span class="trip-item__km">${km > 0 ? "+" + km.toLocaleString() + " km" : "—"}</span>
      </div>
      <div class="trip-item__meta">
        ${trip.startKm ? `<span>${trip.startKm.toLocaleString()} → ${(trip.endKm || 0).toLocaleString()} km</span>` : ""}
        ${trip.fuelAmount ? `<span>⛽ ${trip.fuelAmount}L` + (trip.fuelCost ? ` / ${trip.fuelCost.toLocaleString()} RSD` : "") + `</span>` : ""}
        ${trip.fuelStation ? `<span>🏪 ${trip.fuelStation}</span>` : ""}
      </div>
    </div>
  `;
}

function incidentItem(inc) {
  const typeIcons = { fault: "🔧", damage: "💥", accident: "🚨", other: "📋" };
  return `
    <div class="incident-item">
      <div class="incident-item__header">
        <span>${typeIcons[inc.type] || "⚠️"} ${t("incident_" + inc.type) || inc.type}</span>
        <span class="badge badge--${inc.status === "closed" ? "inactive" : inc.status === "in_progress" ? "service" : "broken"}">
          ${t("incident_status_" + inc.status) || inc.status}
        </span>
      </div>
      <div class="incident-item__desc">${inc.description || ""}</div>
      <div class="incident-item__meta">
        ${inc.vehiclePlate ? `<span>🚗 ${inc.vehiclePlate}</span>` : ""}
        ${inc.location ? `<span>📍 ${inc.location}</span>` : ""}
        <span class="incident-item__date">${formatDate(inc.createdAt)}</span>
      </div>
    </div>
  `;
}

// ── UTILS ─────────────────────────────────────────────────────
function formatDate(val) {
  if (!val) return "—";
  const d = val.toDate ? val.toDate() : new Date(val);
  const locale = getCurrentLang() === "en" ? "en-GB" : "sr-RS";
  return isNaN(d) ? "—" : d.toLocaleDateString(locale);
}

function numOrNull(id) {
  const val = document.getElementById(id)?.value;
  return val ? Number(val) : null;
}

function showFormError(msg) {
  const el = document.getElementById("driver-form-error");
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
}
