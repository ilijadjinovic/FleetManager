// ============================================================
//  assignments.js  —  Fleet Manager
//  Tab: Zaduženja — lista, forma za zaduživanje/razduženje
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, orderBy, getDocs, doc,
  addDoc, updateDoc, serverTimestamp, where, Timestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t, getCurrentLang } from "./i18n.js";
import { S, showToast, openModal } from "./app.js";

// ── STANJE MODULA ─────────────────────────────────────────────
let allAssignments = [];
let allVehicles    = [];
let allDrivers     = [];
let filterStatus   = "active";
let searchTerm     = "";

// ── GLAVNI RENDER ─────────────────────────────────────────────
export async function renderAssignments(container) {
  if (!S.companyId) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🏢</div><p>${t("company_select")}</p></div>`;
    return;
  }

  const canEdit = S.profile?.role === "master_admin" || S.profile?.role === "fleet_admin";

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">${t("tab_assignments")}</h2>
      ${canEdit ? `<button id="btn-add-assignment" class="btn btn--primary btn--sm">+ ${t("assignment_add")}</button>` : ""}
    </div>

    <div class="filter-bar">
      <div class="search-bar">
        <span class="search-bar__icon">🔍</span>
        <input id="assignment-search" type="text" class="search-bar__input form-input"
          placeholder="${t("search")}..." />
      </div>
      <div class="filter-chips">
        <button class="chip" data-filter="all">${t("company_all")}</button>
        <button class="chip chip--active" data-filter="active">${t("assignment_status_active")}</button>
        <button class="chip" data-filter="closed">${t("assignment_status_closed")}</button>
      </div>
    </div>

    <div id="assignments-list"><div class="loading">${t("loading")}</div></div>
  `;

  if (canEdit) {
    document.getElementById("btn-add-assignment")?.addEventListener("click", () => openAssignmentForm());
  }

  document.getElementById("assignment-search")?.addEventListener("input", (e) => {
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

  await loadData();
}

// ── UČITAJ PODATKE ────────────────────────────────────────────
async function loadData() {
  try {
    const [assignSnap, vehicleSnap, driverSnap] = await Promise.all([
      getDocs(query(
        collection(db, "companies", S.companyId, "assignments"),
        orderBy("startDate", "desc")
      )),
      getDocs(query(
        collection(db, "companies", S.companyId, "vehicles"),
        orderBy("brand", "asc")
      )),
      getDocs(query(
        collection(db, "companies", S.companyId, "drivers"),
        orderBy("lastName", "asc")
      )),
    ]);

    allAssignments = assignSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    allVehicles    = vehicleSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    allDrivers     = driverSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
  } catch (e) {
    const list = document.getElementById("assignments-list");
    if (list) list.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

// ── RENDER LISTA ──────────────────────────────────────────────
function renderList() {
  const list = document.getElementById("assignments-list");
  if (!list) return;

  let filtered = allAssignments;

  if (filterStatus !== "all") {
    filtered = filtered.filter(a => a.status === filterStatus);
  }

  if (searchTerm) {
    filtered = filtered.filter(a =>
      `${a.vehicleBrand} ${a.vehicleModel} ${a.vehiclePlate} ${a.driverName}`
        .toLowerCase().includes(searchTerm)
    );
  }

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🔑</div><p>${t("no_data")}</p></div>`;
    return;
  }

  const canEdit = S.profile?.role === "master_admin" || S.profile?.role === "fleet_admin";

  list.innerHTML = `
    <div class="assignments-list">
      ${filtered.map(a => assignmentCard(a, canEdit)).join("")}
    </div>
  `;

  if (canEdit) {
    list.querySelectorAll(".btn-unassign").forEach(btn => {
      btn.addEventListener("click", () => {
        const a = allAssignments.find(x => x.id === btn.dataset.id);
        if (a) openUnassignForm(a);
      });
    });
    list.querySelectorAll(".btn-edit-assignment").forEach(btn => {
      btn.addEventListener("click", () => {
        const a = allAssignments.find(x => x.id === btn.dataset.id);
        if (a) openAssignmentForm(a);
      });
    });
  }
}

// ── ASSIGNMENT CARD ───────────────────────────────────────────
function assignmentCard(a, canEdit) {
  const isActive = a.status === "active";
  const startDate = formatDate(a.startDate);
  const endDate   = a.endDate ? formatDate(a.endDate) : "—";

  return `
    <div class="assignment-card ${isActive ? "assignment-card--active" : ""}">
      <div class="assignment-card__left">
        <div class="assignment-card__status-dot ${isActive ? "dot--active" : "dot--closed"}"></div>
      </div>

      <div class="assignment-card__body">
        <div class="assignment-card__header">
          <div class="assignment-card__vehicle">
            🚗 <strong>${a.vehicleBrand} ${a.vehicleModel}</strong>
            <span class="assignment-card__plate">${a.vehiclePlate}</span>
          </div>
          <span class="badge badge--${isActive ? "active" : "inactive"}">
            ${t("assignment_status_" + a.status)}
          </span>
        </div>

        <div class="assignment-card__driver">
          👤 ${a.driverName}
        </div>

        <div class="assignment-card__meta">
          <span>📅 ${startDate} → ${endDate}</span>
          ${a.startKm ? `<span>🛣️ od ${a.startKm.toLocaleString()} km</span>` : ""}
          ${a.endKm ? `<span>do ${a.endKm.toLocaleString()} km</span>` : ""}
          ${a.tripType === "intercity"
            ? `<span class="assignment-card__intercity">✈️ ${t("assignment_intercity")}${a.destination ? ": " + a.destination : ""}</span>`
            : `<span>🏙️ ${t("assignment_local")}</span>`}
        </div>

        ${a.reason ? `<div class="assignment-card__reason">${a.reason}</div>` : ""}

        ${a.route ? `<div class="assignment-card__route">🗺️ ${a.route}</div>` : ""}

        ${a.kmMismatch ? `
          <div class="assignment-card__mismatch">
            ⚠️ ${t("assignment_km_mismatch_detail").replace("{0}", a.driverStartKm?.toLocaleString() || "?").replace("{1}", a.startKm?.toLocaleString() || "?")}
          </div>
        ` : ""}
      </div>

      ${canEdit ? `
        <div class="assignment-card__actions">
          ${isActive ? `
            <button class="btn btn--warning btn--sm btn-unassign" data-id="${a.id}">
              🔓 ${t("assignment_unassign")}
            </button>
          ` : ""}
          <button class="btn btn--ghost btn--sm btn-edit-assignment" data-id="${a.id}">
            ✏️
          </button>
        </div>
      ` : ""}
    </div>
  `;
}

// ── FORMA ZA ZADUŽIVANJE ──────────────────────────────────────
async function openAssignmentForm(existing = null) {
  const isEdit = !!existing;
  const a = existing || {};

  // Aktivna, ne-arhivirana vozila (i trenutno zaduženo ako editujemo —
  // makar bilo arhivirano u međuvremenu, mora ostati vidljivo pri edit-u
  // da se postojeći zapis ne bi pokvario).
  const availableVehicles = allVehicles.filter(v =>
    v.id === a.vehicleId || (!v.archived && (v.status === "active" || v.status === "unregistered"))
  );

  // Aktivni vozači
  const activeDrivers = allDrivers.filter(d => d.active !== false);

  const bodyHTML = `
    <div class="form-section-title">${t("assignment_form_section_vehicle_driver")}</div>

    <div class="form-group">
      <label class="form-label">${t("assignment_vehicle")} *</label>
      <div class="vehicle-select-wrap">
        <input id="af-vehicle-search" class="form-input" type="text"
          placeholder="${t('search')}..."
          value="${isEdit ? a.vehiclePlate + " — " + a.vehicleBrand + " " + a.vehicleModel : ""}" />
        <div id="af-vehicle-dropdown" class="select-dropdown hidden"></div>
        <input type="hidden" id="af-vehicleId" value="${a.vehicleId || ""}" />
      </div>
    </div>

    <div id="af-vehicle-info" class="${isEdit ? "" : "hidden"}">
      ${isEdit ? vehicleInfoBox(allVehicles.find(v => v.id === a.vehicleId)) : ""}
    </div>

    <div class="form-group">
      <label class="form-label">${t("assignment_driver")} *</label>
      <div class="vehicle-select-wrap">
        <input id="af-driver-search" class="form-input" type="text"
          placeholder="${t('search')}..."
          value="${isEdit ? a.driverName : ""}" />
        <div id="af-driver-dropdown" class="select-dropdown hidden"></div>
        <input type="hidden" id="af-driverId" value="${a.driverId || ""}" />
      </div>
    </div>

    <div class="form-section-title" style="margin-top:4px">${t("assignment_form_section_period")}</div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("assignment_start_date")} *</label>
        <input id="af-startDate" class="form-input" type="text" inputmode="numeric" maxlength="10"
          placeholder="${datePlaceholder()}" value="${isEdit ? toDMY(a.startDate) : todayDMY()}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("assignment_end_date")}</label>
        <input id="af-endDate" class="form-input" type="text" inputmode="numeric" maxlength="10"
          placeholder="${datePlaceholder()}" value="${isEdit ? toDMY(a.endDate) : ""}" />
        <span class="form-hint">${t("assignment_end_date_hint")}</span>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">${t("assignment_start_km")}</label>
      <input id="af-startKm" class="form-input" type="number"
        value="${a.startKm || ""}"
        placeholder="${t('assignment_start_km_placeholder')}" />
    </div>

    <div class="form-group">
      <label class="form-label">${t("assignment_type")} *</label>
      <div class="radio-group">
        <label class="radio-label">
          <input type="radio" name="af-tripType" value="local"
            ${(!a.tripType || a.tripType === "local") ? "checked" : ""}/>
          🏙️ ${t("assignment_local")}
        </label>
        <label class="radio-label">
          <input type="radio" name="af-tripType" value="intercity"
            ${a.tripType === "intercity" ? "checked" : ""} />
          ✈️ ${t("assignment_intercity")}
        </label>
      </div>
    </div>

    <div id="af-intercity-fields" class="${a.tripType === "intercity" ? "" : "hidden"}">
      <div class="form-group">
        <label class="form-label">${t("assignment_destination")}</label>
        <input id="af-destination" class="form-input" type="text"
          value="${a.destination || ""}" placeholder="${t('assignment_destination')}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("assignment_route")}</label>
        <input id="af-route" class="form-input" type="text"
          value="${a.route || ""}" placeholder="${t('assignment_route')}" />
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">${t("assignment_reason")}</label>
      <textarea id="af-reason" class="form-textarea">${a.reason || ""}</textarea>
    </div>

    <p id="assignment-form-error" class="login-error hidden"></p>
  `;

  openModal(
    isEdit ? `${t("edit")}: ${a.vehicleBrand} ${a.vehicleModel}` : t("assignment_add"),
    bodyHTML,
    () => saveAssignment(existing?.id || null, existing)
  );

  // ── Bind vehicle search ───────────────────────────────────
  bindSearchDropdown(
    "af-vehicle-search",
    "af-vehicle-dropdown",
    "af-vehicleId",
    availableVehicles,
    v => `${v.plate} — ${v.brand} ${v.model}`,
    v => v.id,
    async (v) => {
      // Učitaj info o vozilu i popuni km
      const infoBox = document.getElementById("af-vehicle-info");
      if (infoBox) {
        infoBox.classList.remove("hidden");
        infoBox.innerHTML = vehicleInfoBox(v);
      }
      // Auto-popuni startKm
      const kmInput = document.getElementById("af-startKm");
      if (kmInput && v.currentKm) kmInput.value = v.currentKm;
    }
  );

  // ── Bind driver search ────────────────────────────────────
  bindSearchDropdown(
    "af-driver-search",
    "af-driver-dropdown",
    "af-driverId",
    activeDrivers,
    d => `${d.firstName} ${d.lastName}${d.position ? " — " + d.position : ""}`,
    d => d.id,
    null
  );

  // ── Bind trip type radio ──────────────────────────────────
  document.querySelectorAll("input[name='af-tripType']").forEach(radio => {
    radio.addEventListener("change", () => {
      const intercityFields = document.getElementById("af-intercity-fields");
      if (intercityFields) {
        intercityFields.classList.toggle("hidden", radio.value !== "intercity");
      }
    });
  });

  attachDateMask("af-startDate");
  attachDateMask("af-endDate");
}

// ── INFO BOX O VOZILU ─────────────────────────────────────────
function vehicleInfoBox(vehicle) {
  if (!vehicle) return "";
  const statusColors = {
    active: "success", service: "warning", broken: "danger",
    unregistered: "unreg", inactive: "inactive"
  };
  return `
    <div class="vehicle-info-box">
      <div class="vehicle-info-box__row">
        <span class="vehicle-info-box__label">${t("assignment_vehicle_status")}</span>
        <span class="badge badge--${statusColors[vehicle.status] || "inactive"}">
          ${t("vehicle_status_" + (vehicle.status || "active"))}
        </span>
      </div>
      <div class="vehicle-info-box__row">
        <span class="vehicle-info-box__label">VIN</span>
        <span class="mono">${vehicle.vin || "—"}</span>
      </div>
      <div class="vehicle-info-box__row">
        <span class="vehicle-info-box__label">${t("assignment_vehicle_last_km")}</span>
        <span><strong>${vehicle.currentKm ? vehicle.currentKm.toLocaleString() + " km" : "—"}</strong></span>
      </div>
      <div class="vehicle-info-box__row">
        <span class="vehicle-info-box__label">${t("assignment_vehicle_reg")}</span>
        <span>${formatDate(vehicle.regExpiry)}</span>
      </div>
    </div>
  `;
}

// ── SEARCH DROPDOWN HELPER ────────────────────────────────────
function bindSearchDropdown(inputId, dropdownId, hiddenId, items, labelFn, valueFn, onSelect) {
  const input    = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  const hidden   = document.getElementById(hiddenId);
  if (!input || !dropdown || !hidden) return;

  const showDropdown = (term) => {
    const filtered = term.length === 0
      ? items.slice(0, 8)
      : items.filter(i => labelFn(i).toLowerCase().includes(term.toLowerCase())).slice(0, 8);

    if (filtered.length === 0) {
      dropdown.classList.add("hidden");
      return;
    }

    dropdown.innerHTML = filtered.map(item => `
      <div class="select-dropdown__item" data-value="${valueFn(item)}" data-label="${labelFn(item)}">
        ${labelFn(item)}
      </div>
    `).join("");
    dropdown.classList.remove("hidden");

    dropdown.querySelectorAll(".select-dropdown__item").forEach(el => {
      el.addEventListener("click", () => {
        const item = items.find(i => valueFn(i) === el.dataset.value);
        input.value  = el.dataset.label;
        hidden.value = el.dataset.value;
        dropdown.classList.add("hidden");
        if (onSelect && item) onSelect(item);
      });
    });
  };

  input.addEventListener("focus", () => showDropdown(input.value));
  input.addEventListener("input", () => {
    hidden.value = ""; // poništi selekciju dok kuca
    showDropdown(input.value);
  });

  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add("hidden");
    }
  }, { once: false });
}

// ── SNIMI ZADUŽENJE ───────────────────────────────────────────
async function saveAssignment(assignmentId, existing) {
  const vehicleId = document.getElementById("af-vehicleId")?.value;
  const driverId  = document.getElementById("af-driverId")?.value;
  const startDate = document.getElementById("af-startDate")?.value;
  const endDate   = document.getElementById("af-endDate")?.value;
  const startKm   = document.getElementById("af-startKm")?.value;
  const tripType  = document.querySelector("input[name='af-tripType']:checked")?.value || "local";
  const destination = document.getElementById("af-destination")?.value.trim();
  const route     = document.getElementById("af-route")?.value.trim();
  const reason    = document.getElementById("af-reason")?.value.trim();

  // Validacija
  if (!vehicleId) { showAssignError(t("assignment_no_vehicle")); return; }
  if (!driverId)  { showAssignError(t("assignment_no_driver")); return; }
  if (!startDate) { showAssignError(t("assignment_no_date")); return; }
  if (tripType === "intercity" && !destination) {
    showAssignError(t("assignment_no_destination"));
    return;
  }

  const vehicle = allVehicles.find(v => v.id === vehicleId);
  const driver  = allDrivers.find(d => d.id === driverId);

  const startDateObj = parseDMY(startDate);
  const endDateObj   = endDate ? parseDMY(endDate) : null;

  if (!startDateObj) { showAssignError(t("assignment_no_date")); return; }
  if (endDate && !endDateObj) { showAssignError(t("required_field")); return; }
  if (endDateObj && endDateObj <= startDateObj) {
    showAssignError(t("required_field"));
    return;
  }

  try {
    // ── Provjera preklapanja ──────────────────────────────────
    const existingSnap = await getDocs(query(
      collection(db, "companies", S.companyId, "assignments"),
      where("vehicleId", "==", vehicleId),
      where("status", "==", "active")
    ));

    const existingAssignments = existingSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(a => a.id !== assignmentId); // ignoriši sebe ako editujemo

    for (const ea of existingAssignments) {
      const eaStart = ea.startDate?.toDate ? ea.startDate.toDate() : new Date(ea.startDate);
      const eaEnd   = ea.endDate ? (ea.endDate?.toDate ? ea.endDate.toDate() : new Date(ea.endDate)) : null;

      // Ako postojeće zaduženje nema kraj (neodređeno) — mora se oročiti
      if (!eaEnd) {
        // Automatski zatvori staro zaduženje sa datumom = početak novog
        const closeDate = new Date(startDate);

        // Prikaži dialog pre snimanja
        const confirmed = await showConflictDialog(ea, driver, closeDate);
        if (!confirmed) return; // korisnik otkazao

        // Zatvori staro zaduženje
        await updateDoc(doc(db, "companies", S.companyId, "assignments", ea.id), {
          status:  "closed",
          endDate: closeDate,
          endKm:   null,
          closedReason: `${t("assignment_auto_closed_reason_label")} (${driver.firstName} ${driver.lastName})`,
          updatedAt: serverTimestamp(),
        });
        break;
      }

      // Provjera preklapanja perioda
      const newStart = startDateObj;
      const newEnd   = endDateObj || new Date("2999-01-01");
      const overlapStart = eaStart;
      const overlapEnd   = eaEnd || new Date("2999-01-01");

      if (newStart < overlapEnd && newEnd > overlapStart) {
        showAssignError(
          `${t("assignment_vehicle")} ${t("assignment_status_active").toLowerCase()}: ${ea.driverName} ` +
          `${formatDate(ea.startDate)} → ${formatDate(ea.endDate)}. ` +
          `${t("assignment_km_mismatch").split(".")[0]}.`
        );
        return;
      }
    }

    // ── Snimi zaduženje ───────────────────────────────────────
    const data = {
      vehicleId,
      vehicleBrand: vehicle?.brand || "",
      vehicleModel: vehicle?.model || "",
      vehiclePlate: vehicle?.plate || "",
      vehicleVin:   vehicle?.vin   || null,
      driverId,
      driverName:   `${driver?.firstName || ""} ${driver?.lastName || ""}`,
      driverUid:    driver?.localAuthUid || null,
      startDate:    startDateObj,
      endDate:      endDateObj,
      startKm:      startKm ? Number(startKm) : (vehicle?.currentKm || null),
      endKm:        null,
      tripType,
      destination:  tripType === "intercity" ? (destination || null) : null,
      route:        tripType === "intercity" ? (route || null) : null,
      reason:       reason || null,
      status:       "active",
      kmMismatch:   false,
    };

    if (assignmentId) {
      await updateDoc(
        doc(db, "companies", S.companyId, "assignments", assignmentId),
        { ...data, updatedAt: serverTimestamp() }
      );
    } else {
      await addDoc(
        collection(db, "companies", S.companyId, "assignments"),
        { ...data, createdAt: serverTimestamp(), createdBy: S.user.uid }
      );
    }

    // Ažuriraj currentKm na vozilu ako je unesena startKm
    if (startKm && vehicle) {
      await updateDoc(doc(db, "companies", S.companyId, "vehicles", vehicleId), {
        currentKm:          Number(startKm),
        assignedDriverName: `${driver?.firstName} ${driver?.lastName}`,
        updatedAt:          serverTimestamp(),
      });
    }

    showToast(t("success"), "success");
    await loadData();

  } catch (e) {
    console.error("saveAssignment error:", e);
    showAssignError(`${t("error")}: ${e.message}`);
  }
}

// ── CONFLICT DIALOG ───────────────────────────────────────────
function showConflictDialog(existingAssignment, newDriver, suggestedCloseDate) {
  return new Promise((resolve) => {
    document.getElementById("modal-overlay")?.classList.add("hidden");

    setTimeout(() => {
      const dateStr = suggestedCloseDate.toLocaleDateString(getCurrentLang() === "en" ? "en-GB" : "sr-RS");
      const bodyHTML = `
        <div class="conflict-dialog">
          <div class="conflict-dialog__icon">⚠️</div>
          <p>${t("assignment_conflict_vehicle_busy")}</p>
          <div class="conflict-info">
            <strong>👤 ${existingAssignment.driverName}</strong>
            <span>od ${formatDate(existingAssignment.startDate)}</span>
            <span class="badge badge--warning">${t("assignment_conflict_no_end_date_badge")}</span>
          </div>
          <p>Da biste zadužili vozilo vozaču
            <strong>${newDriver.firstName} ${newDriver.lastName}</strong>,
            prethodno zaduženje će biti automatski zatvoreno.
          </p>
          <div class="form-group" style="margin-top:12px">
            <label class="form-label">${t("assignment_conflict_close_date")}</label>
            <input id="conflict-close-date" class="form-input" type="text" inputmode="numeric" maxlength="10"
              placeholder="${datePlaceholder()}" value="${toDMY(suggestedCloseDate)}" />
            <span class="form-hint">${t("assignment_conflict_close_hint")}</span>
          </div>
        </div>
      `;

      import("./app.js").then(({ openModal }) => {
        openModal(t("assignment_conflict_title"), bodyHTML, () => {
          // Ažuriraj datum zatvaranja iz inputa
          const dateInput = document.getElementById("conflict-close-date");
          const parsed = dateInput?.value ? parseDMY(dateInput.value) : null;
          if (parsed) {
            suggestedCloseDate.setTime(parsed.getTime());
          }
          resolve(true);
        });

        // Override cancel da resolve(false)
        document.getElementById("modal-cancel").onclick = () => {
          document.getElementById("modal-overlay").classList.add("hidden");
          resolve(false);
        };
        document.getElementById("modal-confirm").textContent = t("assignment_conflict_close_btn");
        attachDateMask("conflict-close-date");
      });
    }, 150);
  });
}

// ── FORMA ZA RAZDUŽENJE ───────────────────────────────────────
function openUnassignForm(assignment) {
  const vehicle = allVehicles.find(v => v.id === assignment.vehicleId);

  const bodyHTML = `
    <div class="unassign-info">
      <div>🚗 <strong>${assignment.vehicleBrand} ${assignment.vehicleModel}</strong> — ${assignment.vehiclePlate}</div>
      <div>👤 ${assignment.driverName}</div>
      <div>📅 ${t("trip_assigned_label")}: ${formatDate(assignment.startDate)}</div>
      ${assignment.startKm ? `<div>🛣️ ${t("assignment_start_km")}: ${assignment.startKm.toLocaleString()}</div>` : ""}
    </div>

    <div class="form-section-title" style="margin-top:12px">${t("assignment_unassign_title")}</div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("assignment_unassign_date_label")}</label>
        <input id="ua-endDate" class="form-input" type="text" inputmode="numeric" maxlength="10"
          placeholder="${datePlaceholder()}" value="${todayDMY()}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("assignment_end_km")}</label>
        <input id="ua-endKm" class="form-input" type="number"
          value="${vehicle?.currentKm || ""}"
          placeholder="${t('assignment_end_km')}" />
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">${t("notes")}</label>
      <textarea id="ua-notes" class="form-textarea" placeholder="${t('assignment_unassign_notes_ph')}"></textarea>
    </div>

    <p id="unassign-error" class="login-error hidden"></p>
  `;

  openModal(
    `${t("assignment_unassign")}: ${assignment.vehicleBrand} ${assignment.vehicleModel}`,
    bodyHTML,
    () => processUnassign(assignment)
  );

  attachDateMask("ua-endDate");
}

async function processUnassign(assignment) {
  const endDate = document.getElementById("ua-endDate")?.value;
  const endKm   = document.getElementById("ua-endKm")?.value;
  const notes   = document.getElementById("ua-notes")?.value.trim();

  if (!endDate) {
    const err = document.getElementById("unassign-error");
    if (err) { err.textContent = t("assignment_unassign_date_required"); err.classList.remove("hidden"); }
    return;
  }

  const endDateObj = parseDMY(endDate);
  if (!endDateObj) {
    const err = document.getElementById("unassign-error");
    if (err) { err.textContent = t("assignment_unassign_date_required"); err.classList.remove("hidden"); }
    return;
  }
  const startDate  = assignment.startDate?.toDate
    ? assignment.startDate.toDate()
    : new Date(assignment.startDate);

  if (endDateObj < startDate) {
    const err = document.getElementById("unassign-error");
    if (err) { err.textContent = t("assignment_unassign_date_error"); err.classList.remove("hidden"); }
    return;
  }

  try {
    await updateDoc(
      doc(db, "companies", S.companyId, "assignments", assignment.id),
      {
        status:    "closed",
        endDate:   endDateObj,
        endKm:     endKm ? Number(endKm) : null,
        unassignNotes: notes || null,
        updatedAt: serverTimestamp(),
      }
    );

    // Ažuriraj currentKm na vozilu
    if (endKm) {
      await updateDoc(
        doc(db, "companies", S.companyId, "vehicles", assignment.vehicleId),
        {
          currentKm:          Number(endKm),
          assignedDriverName: null,
          updatedAt:          serverTimestamp(),
        }
      );
    }

    showToast(t("success"), "success");
    await loadData();

  } catch (e) {
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

// ── UTILS ─────────────────────────────────────────────────────
function formatDate(val) {
  if (!val) return "—";
  const d = val.toDate ? val.toDate() : new Date(val);
  const locale = getCurrentLang() === "en" ? "en-GB" : "sr-RS";
  return isNaN(d) ? "—" : d.toLocaleDateString(locale);
}

// ── DATUMI: prikaz i unos u lokalnom formatu dd/mm/yyyy ──────
// <input type="date"> prikazuje kalendar u formatu koji zavisi od
// jezika/regije podešene u browseru korisnika, ne od jezika aplikacije,
// pa koristimo tekstualno polje sa maskom umesto toga.
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

function showAssignError(msg) {
  const el = document.getElementById("assignment-form-error");
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
}
