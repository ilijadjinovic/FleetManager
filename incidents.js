// ============================================================
//  incidents.js  —  Fleet Manager
//  Tab: Prijave — kvarovi, oštećenja, nezgode
//  Vozač: unosi prijave
//  Fleet admin / Master admin: pregled i upravljanje statusima
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, orderBy, getDocs, doc, getDoc,
  addDoc, updateDoc, serverTimestamp, where
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t, getCurrentLang } from "./i18n.js";
import { S, showToast, openModal } from "./app.js";
import { openServiceForm, incidentToServicePrefill } from "./vehicles.js";

// ── STANJE MODULA ─────────────────────────────────────────────
let allIncidents  = [];
let filterType    = "all";
let filterStatus  = "all";
let searchTerm    = "";
let onSavedCallback = null; // opcioni hook — poziva se posle uspešnog snimanja (npr. iz trips.js)

// ── GLAVNI RENDER ─────────────────────────────────────────────
export async function renderIncidents(container) {
  if (!S.companyId) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🏢</div><p>${t("company_select")}</p></div>`;
    return;
  }

  const isDriver = S.profile?.role === "driver";
  const canEdit  = !isDriver;

  // Vozač sme da prijavi samo u okviru trenutnog aktivnog zaduženja
  const hasActiveAssignment = isDriver ? await driverHasActiveAssignment() : false;
  const canReport = isDriver && hasActiveAssignment;

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">${t("tab_report")}</h2>
      ${canReport ? `<button id="btn-add-incident" class="btn btn--warning btn--sm">⚠️ ${t("incident_add")}</button>` : ""}
    </div>
    ${isDriver && !hasActiveAssignment ? `
      <div class="no-login-notice" style="margin-bottom:12px">⚠️ ${t("incident_no_assignment_notice")}</div>
    ` : ""}

    <div class="filter-bar">
      <div class="search-bar">
        <span class="search-bar__icon">🔍</span>
        <input id="incident-search" type="text" class="search-bar__input form-input"
          placeholder="${t("search")}..." />
      </div>
      <div class="filter-chips" id="type-chips">
        <button class="chip chip--active" data-itype="all">${t("company_all")}</button>
        <button class="chip" data-itype="fault">🔧 ${t("incident_fault")}</button>
        <button class="chip" data-itype="damage">💥 ${t("incident_damage")}</button>
        <button class="chip" data-itype="accident">🚨 ${t("incident_accident")}</button>
        <button class="chip" data-itype="other">📋 ${t("incident_other")}</button>
      </div>
    </div>

    <div class="filter-bar" style="margin-top:-8px">
      <div class="filter-chips" id="status-chips">
        <button class="chip chip--active" data-istatus="all">${t("company_all")}</button>
        <button class="chip" data-istatus="open">🔴 ${t("incident_status_open")}</button>
        <button class="chip" data-istatus="in_progress">🟡 ${t("incident_status_in_progress")}</button>
        <button class="chip" data-istatus="closed">🟢 ${t("incident_status_closed")}</button>
      </div>
    </div>

    <div id="incidents-list"><div class="loading">${t("loading")}</div></div>
  `;

  // Vozač može da doda prijavu i odavde
  document.getElementById("btn-add-incident")?.addEventListener("click", () => openIncidentForm());

  document.getElementById("incident-search")?.addEventListener("input", (e) => {
    searchTerm = e.target.value.toLowerCase();
    renderList();
  });

  document.getElementById("type-chips")?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-itype]");
    if (!chip) return;
    document.querySelectorAll("[data-itype]").forEach(c => c.classList.remove("chip--active"));
    chip.classList.add("chip--active");
    filterType = chip.dataset.itype;
    renderList();
  });

  document.getElementById("status-chips")?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-istatus]");
    if (!chip) return;
    document.querySelectorAll("[data-istatus]").forEach(c => c.classList.remove("chip--active"));
    chip.classList.add("chip--active");
    filterStatus = chip.dataset.istatus;
    renderList();
  });

  await loadIncidents();
}

// ── UČITAJ INCIDENTE ──────────────────────────────────────────
async function loadIncidents() {
  try {
    let q;

    if (S.profile?.role === "driver") {
      // Vozač vidi samo svoje prijave
      q = query(
        collection(db, "companies", S.companyId, "incidents"),
        where("driverUid", "==", S.user.uid),
        orderBy("createdAt", "desc")
      );
    } else {
      q = query(
        collection(db, "companies", S.companyId, "incidents"),
        orderBy("createdAt", "desc")
      );
    }

    const snap = await getDocs(q);
    allIncidents = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
  } catch (e) {
    const list = document.getElementById("incidents-list");
    if (list) list.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

// ── RENDER LISTA ──────────────────────────────────────────────
function renderList() {
  const list = document.getElementById("incidents-list");
  if (!list) return;

  let filtered = allIncidents;

  if (filterType !== "all")   filtered = filtered.filter(i => i.type === filterType);
  if (filterStatus !== "all") filtered = filtered.filter(i => i.status === filterStatus);
  if (searchTerm) {
    filtered = filtered.filter(i =>
      `${i.vehiclePlate} ${i.driverName} ${i.description} ${i.location || ""}`
        .toLowerCase().includes(searchTerm)
    );
  }

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state__icon">✅</div><p>${t("no_data")}</p></div>`;
    return;
  }

  // Grupiši po statusu — otvorene prve
  const ordered = [
    ...filtered.filter(i => i.status === "open"),
    ...filtered.filter(i => i.status === "in_progress"),
    ...filtered.filter(i => i.status === "closed"),
  ];

  const canEdit = S.profile?.role !== "driver";

  list.innerHTML = `<div class="incidents-grid">${ordered.map(i => incidentCard(i, canEdit)).join("")}</div>`;

  if (canEdit) {
    list.querySelectorAll(".btn-incident-status").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const incident = allIncidents.find(i => i.id === btn.dataset.id);
        if (incident) openStatusModal(incident);
      });
    });
    list.querySelectorAll(".btn-incident-note").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const incident = allIncidents.find(i => i.id === btn.dataset.id);
        if (incident) openNoteModal(incident);
      });
    });
  }

  list.querySelectorAll(".btn-incident-schedule-service").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const incident = allIncidents.find(i => i.id === btn.dataset.id);
      if (incident) scheduleServiceForIncident(incident, () => loadIncidents());
    });
  });
}

// ── INCIDENT CARD ─────────────────────────────────────────────
// Eksportovano — koristi ga i drivers.js (admin prikaz prijava
// konkretnog vozača), da bi prikaz bio identičan onome što vozač
// sam vidi (km, status, admin napomena, rešenje).
// canSchedule kontroliše dugme "Zakaži servis" nezavisno od canEdit
// (npr. drivers.js želi ovo dugme, ali ne i promenu statusa/napomenu).
export function incidentCard(inc, canEdit, canSchedule = canEdit) {
  const typeConfig = {
    fault:    { icon: "🔧", label: t("incident_fault"),    color: "service" },
    damage:   { icon: "💥", label: t("incident_damage"),   color: "broken"  },
    accident: { icon: "🚨", label: t("incident_accident"), color: "broken"  },
    other:    { icon: "📋", label: t("incident_other"),    color: "inactive"},
  };

  const statusConfig = {
    open:        { label: t("incident_status_open"),        color: "broken",  dot: "🔴" },
    in_progress: { label: t("incident_status_in_progress"), color: "service", dot: "🟡" },
    closed:      { label: t("incident_status_closed"),      color: "active",  dot: "🟢" },
  };

  const tc = typeConfig[inc.type]   || typeConfig.other;
  const sc = statusConfig[inc.status] || statusConfig.open;

  return `
    <div class="incident-card incident-card--${inc.status}">
      <div class="incident-card__header">
        <div class="incident-card__type">
          <span class="incident-card__type-icon">${tc.icon}</span>
          <span class="badge badge--${tc.color}">${tc.label}</span>
        </div>
        <div class="incident-card__header-right">
          <span class="badge badge--${sc.color}">${sc.dot} ${sc.label}</span>
          ${canSchedule && inc.status === "open" ? `
            <button class="btn btn--secondary btn--sm btn-incident-schedule-service" data-id="${inc.id}">
              🔧 ${t("incident_schedule_service_btn")}
            </button>
          ` : ""}
        </div>
      </div>

      <div class="incident-card__desc">${inc.description}</div>

      <div class="incident-card__meta">
        ${inc.vehiclePlate ? `<span>🚗 ${inc.vehiclePlate}</span>` : ""}
        ${inc.driverName   ? `<span>👤 ${inc.driverName}</span>`   : ""}
        ${inc.location     ? `<span>📍 ${inc.location}</span>`     : ""}
        ${inc.currentKm    ? `<span>🛣️ ${inc.currentKm.toLocaleString()} km</span>` : ""}
        <span class="incident-card__date">${formatDate(inc.createdAt)}</span>
      </div>

      ${inc.adminNote ? `
        <div class="incident-card__note">
          <span class="incident-card__note-label">📝 ${t("incident_admin_note_label")}</span>
          ${inc.adminNote}
        </div>
      ` : ""}

      ${inc.resolution ? `
        <div class="incident-card__resolution">
          <span class="incident-card__note-label">✅ ${t("incident_resolution_prefix")}</span>
          ${inc.resolution}
        </div>
      ` : ""}

      ${canEdit ? `
        <div class="incident-card__actions">
          <button class="btn btn--secondary btn--sm btn-incident-status" data-id="${inc.id}">
            ⚙️ ${t("incident_change_status")}
          </button>
          <button class="btn btn--ghost btn--sm btn-incident-note" data-id="${inc.id}">
            📝 ${t("incident_add_note")}
          </button>
        </div>
      ` : ""}
    </div>
  `;
}

// Otvara formu za zakazivanje servisa na osnovu prijave (predpopunjeno
// tipom/opisom/km), i po uspešnom čuvanju automatski prebacuje prijavu
// u status "u obradi". Koriste ga i incidents.js (glavni tab) i
// drivers.js (prijave konkretnog vozača) — onSaved je caller-ov refresh.
export function scheduleServiceForIncident(inc, onSaved) {
  const vehicleStub = {
    id:        inc.vehicleId,
    plate:     inc.vehiclePlate,
    currentKm: inc.currentKm ?? null,
  };
  openServiceForm(vehicleStub, null, incidentToServicePrefill(inc), {
    linkedIncidentId: inc.id,
    onSaved,
  });
}

// ── DA LI VOZAČ IMA AKTIVNO ZADUŽENJE ──────────────────────────
async function driverHasActiveAssignment() {
  try {
    const snap = await getDocs(query(
      collection(db, "companies", S.companyId, "assignments"),
      where("driverUid", "==", S.user.uid),
      where("status", "==", "active")
    ));
    return !snap.empty;
  } catch (e) {
    console.error("driverHasActiveAssignment error:", e);
    return false;
  }
}

// ── FORMA ZA NOVU PRIJAVU ─────────────────────────────────────
// prefillType: unapred izabran tip (npr. kad se poziva sa dugmeta "⚠️" u Mojim vožnjama)
// onSaved:     opciona callback funkcija — poziva se posle uspešnog snimanja
//              (koristi je npr. trips.js da osveži svoju listu unosa)
export async function openIncidentForm(prefillType = null, onSaved = null) {
  onSavedCallback = onSaved;

  // Predpopuni km polje trenutnom km vozila (ako vozač ima aktivno zaduženje)
  let prefillCurrentKm = null;
  if (S.profile?.role === "driver") {
    try {
      const assignSnap = await getDocs(query(
        collection(db, "companies", S.companyId, "assignments"),
        where("driverUid", "==", S.user.uid),
        where("status", "==", "active")
      ));
      if (!assignSnap.empty) {
        const a = assignSnap.docs[0].data();
        prefillCurrentKm = a.startKm ?? null;
        if (a.vehicleId) {
          const vehSnap = await getDoc(doc(db, "companies", S.companyId, "vehicles", a.vehicleId));
          if (vehSnap.exists() && vehSnap.data().currentKm != null) {
            prefillCurrentKm = vehSnap.data().currentKm;
          }
        }
      }
    } catch (e) { /* ignoriši — polje ostaje prazno, vozač unosi ručno */ }
  }

  const bodyHTML = `
    <div class="form-section-title">${t("incident_type")}</div>
    <div class="incident-type-grid">
      <label class="incident-type-btn ${prefillType === 'fault' ? 'incident-type-btn--active' : ''}">
        <input type="radio" name="inc-type" value="fault"
          ${(!prefillType || prefillType === 'fault') ? "checked" : ""} />
        <span class="incident-type-btn__icon">🔧</span>
        <span>${t("incident_fault")}</span>
      </label>
      <label class="incident-type-btn ${prefillType === 'damage' ? 'incident-type-btn--active' : ''}">
        <input type="radio" name="inc-type" value="damage"
          ${prefillType === 'damage' ? "checked" : ""} />
        <span class="incident-type-btn__icon">💥</span>
        <span>${t("incident_damage")}</span>
      </label>
      <label class="incident-type-btn ${prefillType === 'accident' ? 'incident-type-btn--active' : ''}">
        <input type="radio" name="inc-type" value="accident"
          ${prefillType === 'accident' ? "checked" : ""} />
        <span class="incident-type-btn__icon">🚨</span>
        <span>${t("incident_accident")}</span>
      </label>
      <label class="incident-type-btn ${prefillType === 'other' ? 'incident-type-btn--active' : ''}">
        <input type="radio" name="inc-type" value="other"
          ${prefillType === 'other' ? "checked" : ""} />
        <span class="incident-type-btn__icon">📋</span>
        <span>${t("incident_other")}</span>
      </label>
    </div>

    <div class="form-group">
      <label class="form-label">${t("incident_description")} *</label>
      <textarea id="inc-description" class="form-textarea" rows="4"
        placeholder="${t('incident_description_ph')}"></textarea>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("incident_location")}</label>
        <input id="inc-location" class="form-input" type="text"
          placeholder="${t('incident_location_ph')}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_current_km")} *</label>
        <input id="inc-km" class="form-input" type="number"
          value="${prefillCurrentKm || ""}" placeholder="${t('trip_current_km')}" />
      </div>
    </div>

    <div id="accident-fields" class="hidden">
      <div class="form-section-title" style="margin-top:4px">${t("incident_accident_section")}</div>
      <div class="form-group">
        <label class="form-label">${t("incident_third_party")}</label>
        <input id="inc-thirdParty" class="form-input" type="text" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("incident_police_report")}</label>
        <input id="inc-policeReport" class="form-input" type="text" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("incident_insurance")}</label>
        <input id="inc-insurance" class="form-input" type="text" />
      </div>
    </div>

    <p id="incident-form-error" class="login-error hidden"></p>
  `;

  openModal(t("incident_add"), bodyHTML, () => saveIncident());

  // Prikaži dodatna polja za nezgodu
  setTimeout(() => {
    document.querySelectorAll("input[name='inc-type']").forEach(radio => {
      radio.addEventListener("change", () => {
        const accidentFields = document.getElementById("accident-fields");
        if (accidentFields) {
          accidentFields.classList.toggle("hidden", radio.value !== "accident");
        }
        // Vizuelni feedback
        document.querySelectorAll(".incident-type-btn").forEach(btn => {
          btn.classList.toggle("incident-type-btn--active",
            btn.querySelector("input")?.checked);
        });
      });
    });

    // Inicijalni check za accident
    if (prefillType === "accident") {
      document.getElementById("accident-fields")?.classList.remove("hidden");
    }
  }, 100);
}

// ── SNIMI PRIJAVU ─────────────────────────────────────────────
async function saveIncident() {
  const type        = document.querySelector("input[name='inc-type']:checked")?.value || "fault";
  const description = document.getElementById("inc-description")?.value.trim();

  if (!description) {
    const err = document.getElementById("incident-form-error");
    if (err) { err.textContent = t("required_field") + ": " + t("incident_description"); err.classList.remove("hidden"); }
    return;
  }

  // Dohvati aktivno zaduženje vozača (i vozilo, radi validacije km)
  let vehiclePlate = null, vehicleId = null, assignmentId = null, tripId = null,
      driverId = null, vehicleCurrentKm = null, assignmentStartKm = null;

  if (S.profile?.role === "driver") {
    try {
      const assignSnap = await getDocs(query(
        collection(db, "companies", S.companyId, "assignments"),
        where("driverUid", "==", S.user.uid),
        where("status", "==", "active")
      ));
      if (!assignSnap.empty) {
        const a = assignSnap.docs[0].data();
        vehiclePlate     = a.vehiclePlate;
        vehicleId        = a.vehicleId;
        assignmentId     = assignSnap.docs[0].id;
        assignmentStartKm = a.startKm ?? null;

        // Pronađi trenutno aktivnu vožnju unutar ovog zaduženja — prijava
        // se vezuje i za konkretnu vožnju, ne samo za zaduženje uopšte.
        try {
          const tripSnap = await getDocs(query(
            collection(db, "companies", S.companyId, "trips"),
            where("assignmentId", "==", assignmentId),
            where("status", "==", "active")
          ));
          if (!tripSnap.empty) tripId = tripSnap.docs[0].id;
        } catch (e) { /* ignoriši */ }

        if (vehicleId) {
          const vehSnap = await getDoc(doc(db, "companies", S.companyId, "vehicles", vehicleId));
          if (vehSnap.exists()) vehicleCurrentKm = vehSnap.data().currentKm ?? null;
        }
      }
      driverId = S.profile.driverId;
    } catch (e) { /* ignoriši */ }

    if (!assignmentId) {
      const err = document.getElementById("incident-form-error");
      if (err) { err.textContent = t("incident_no_assignment_notice"); err.classList.remove("hidden"); }
      return;
    }
  }

  // Km je obavezna; ako imamo referentnu vrednost (vozilo/zaduženje), ne sme biti manja od nje
  const kmRaw = document.getElementById("inc-km")?.value;
  const currentKm = parseFloat(kmRaw);
  if (!kmRaw || isNaN(currentKm) || currentKm <= 0) {
    const err = document.getElementById("incident-form-error");
    if (err) { err.textContent = t("required_field") + ": " + t("trip_current_km"); err.classList.remove("hidden"); }
    return;
  }
  const lastKm = vehicleCurrentKm ?? assignmentStartKm;
  if (lastKm != null && currentKm < lastKm) {
    const err = document.getElementById("incident-form-error");
    if (err) { err.textContent = `${t("trip_km_too_low")}: ${lastKm.toLocaleString()} km`; err.classList.remove("hidden"); }
    return;
  }

  const data = {
    type,
    description,
    location:     document.getElementById("inc-location")?.value.trim() || null,
    currentKm,
    vehicleId,
    vehiclePlate,
    assignmentId,
    tripId,
    driverId,
    driverUid:    S.user.uid,
    driverName:   S.profile?.displayName || `${S.profile?.firstName || ""} ${S.profile?.lastName || ""}`.trim(),
    status:       "open",
    adminNote:    null,
    resolution:   null,
    // Polja za nezgodu
    thirdParty:   type === "accident" ? (document.getElementById("inc-thirdParty")?.value.trim() || null) : null,
    policeReport: type === "accident" ? (document.getElementById("inc-policeReport")?.value.trim() || null) : null,
    insurance:    type === "accident" ? (document.getElementById("inc-insurance")?.value.trim() || null) : null,
    createdAt:    serverTimestamp(),
    createdBy:    S.user.uid,
  };

  try {
    const writes = [addDoc(collection(db, "companies", S.companyId, "incidents"), data)];

    // Ako postoji aktivno zaduženje, prijava se vidi i u "Mojim vožnjama" (tripEntries)
    if (assignmentId) {
      writes.push(addDoc(collection(db, "companies", S.companyId, "tripEntries"), data));
    }

    await Promise.all(writes);

    // Ažuriraj km vozila na osnovu prijave
    if (vehicleId) {
      await updateDoc(doc(db, "companies", S.companyId, "vehicles", vehicleId), {
        currentKm: currentKm,
        updatedAt: serverTimestamp(),
      });
    }

    // Notifikacija fleet adminu
    await addDoc(collection(db, "companies", S.companyId, "notifications"), {
      type:         "incident",
      incidentType: type,
      vehiclePlate: vehiclePlate || "—",
      driverName:   data.driverName,
      description:  description.substring(0, 100),
      status:       "unread",
      createdAt:    serverTimestamp(),
    });

    showToast(t("incident_sent"), "success");

    // Osveži listu prijava samo ako je trenutno na ekranu (npr. ne kad se
    // forma otvori iz "Mojih vožnji")
    if (document.getElementById("incidents-list")) {
      await loadIncidents();
    }

    if (typeof onSavedCallback === "function") await onSavedCallback();
    onSavedCallback = null;
  } catch (e) {
    const err = document.getElementById("incident-form-error");
    if (err) { err.textContent = `${t("error")}: ${e.message}`; err.classList.remove("hidden"); }
  }
}

// ── MODAL ZA PROMENU STATUSA ──────────────────────────────────
function openStatusModal(incident) {
  const bodyHTML = `
    <div class="incident-summary">
      <div class="incident-summary__type">${typeIcon(incident.type)} ${t("incident_" + incident.type)}</div>
      <div class="incident-summary__desc">${incident.description}</div>
      <div class="incident-summary__meta">
        ${incident.vehiclePlate ? `🚗 ${incident.vehiclePlate}` : ""}
        ${incident.driverName ? ` · 👤 ${incident.driverName}` : ""}
      </div>
    </div>

    <div class="form-section-title" style="margin-top:12px">${t("incident_status_new")}</div>
    <div class="status-option-group">
      <label class="status-option ${incident.status === 'open' ? 'status-option--active' : ''}">
        <input type="radio" name="new-status" value="open"
          ${incident.status === "open" ? "checked" : ""} />
        🔴 ${t("incident_status_open")}
      </label>
      <label class="status-option ${incident.status === 'in_progress' ? 'status-option--active' : ''}">
        <input type="radio" name="new-status" value="in_progress"
          ${incident.status === "in_progress" ? "checked" : ""} />
        🟡 ${t("incident_status_in_progress")}
      </label>
      <label class="status-option ${incident.status === 'closed' ? 'status-option--active' : ''}">
        <input type="radio" name="new-status" value="closed"
          ${incident.status === "closed" ? "checked" : ""} />
        🟢 ${t("incident_status_closed")}
      </label>
    </div>

    <div class="form-group" style="margin-top:12px" id="resolution-group"
      class="${incident.status !== 'closed' ? '' : ''}">
      <label class="form-label">${t("incident_resolution_label")}</label>
      <textarea id="inc-resolution" class="form-textarea" rows="3"
        placeholder="${t('incident_resolution_ph')}">${incident.resolution || ""}</textarea>
    </div>
  `;

  openModal(t("incident_status_title"), bodyHTML, () => updateIncidentStatus(incident));

  setTimeout(() => {
    document.querySelectorAll("input[name='new-status']").forEach(r => {
      r.addEventListener("change", () => {
        document.querySelectorAll(".status-option").forEach(o =>
          o.classList.toggle("status-option--active", o.querySelector("input")?.checked));
      });
    });
  }, 100);
}

async function updateIncidentStatus(incident) {
  const newStatus  = document.querySelector("input[name='new-status']:checked")?.value;
  const resolution = document.getElementById("inc-resolution")?.value.trim() || null;

  if (!newStatus) return;

  try {
    await updateDoc(doc(db, "companies", S.companyId, "incidents", incident.id), {
      status:     newStatus,
      resolution: resolution,
      updatedAt:  serverTimestamp(),
      updatedBy:  S.user.uid,
    });
    showToast(t("success"), "success");
    await loadIncidents();
  } catch (e) {
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

// ── MODAL ZA NAPOMENU ─────────────────────────────────────────
function openNoteModal(incident) {
  const bodyHTML = `
    <div class="incident-summary">
      <div class="incident-summary__type">${typeIcon(incident.type)} ${t("incident_" + incident.type)}</div>
      <div class="incident-summary__desc">${incident.description}</div>
    </div>
    <div class="form-group" style="margin-top:12px">
      <label class="form-label">${t("incident_note_label")}</label>
      <textarea id="inc-admin-note" class="form-textarea" rows="4"
        placeholder="${t('incident_note_ph')}">${incident.adminNote || ""}</textarea>
    </div>
  `;

  openModal(t("incident_note_title"), bodyHTML, () => saveAdminNote(incident));
}

async function saveAdminNote(incident) {
  const note = document.getElementById("inc-admin-note")?.value.trim();
  try {
    await updateDoc(doc(db, "companies", S.companyId, "incidents", incident.id), {
      adminNote: note || null,
      updatedAt: serverTimestamp(),
      updatedBy: S.user.uid,
    });
    showToast(t("success"), "success");
    await loadIncidents();
  } catch (e) {
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

// ── UTILS ─────────────────────────────────────────────────────
function typeIcon(type) {
  return { fault: "🔧", damage: "💥", accident: "🚨", other: "📋" }[type] || "⚠️";
}

function formatDate(val) {
  if (!val) return "—";
  const d = val.toDate ? val.toDate() : new Date(val);
  const locale = getCurrentLang() === "en" ? "en-GB" : "sr-RS";
  return isNaN(d) ? "—" : d.toLocaleDateString(locale);
}
