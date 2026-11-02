// ============================================================
//  entry-details.js  —  Fleet Manager
//  Detaljan prikaz (modal) za administratora voznog parka:
//   • točenje goriva / putarina / parking / pranje / ostali trošak
//   • vožnja
//   • zaduženje (sa vožnjama i unosima)
//   • vozač
//  Otvara se klikom na element sa jednim od atributa:
//   data-entry-id, data-detail-assignment, data-detail-trip,
//   data-detail-driver. Prikazuje SVE što se čuva pri unosu.
//  Vozači (rola "driver") vide samo detalje SVOJIH unosa (gorivo, putarina,
//  parking, pranje, ostalo, prijave) — bez detalja zaduženja/vožnje/vozača.
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, where, getDocs, doc, getDoc
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t, formatDateDMY, formatDateTimeDMY } from "./i18n.js";
import { S, openModal } from "./app.js";
import { esc, fmtNum, fmtRsd, toMillis } from "./entries-view.js";
import {
  rememberEntry, rememberAssignment, rememberTrip,
  getRememberedEntry, getRememberedAssignment, getRememberedTrip,
} from "./detail-registry.js";

const COST_TYPES  = ["toll", "parking", "washing", "other_cost"];
const ICONS  = { fuel: "⛽", toll: "🛣️", parking: "🅿️", washing: "🚿", other_cost: "📋",
                 fault: "🔧", damage: "💥", accident: "🚨", other: "📋" };

export function isAdminViewer() {
  return S.profile?.role !== "driver";
}

// Detalje unosa (račun za gorivo i ostali troškovi) mogu da otvore svi —
// vozač vidi svoje unose (pravila baze mu ni ne daju tuđe preko upita).
export function canOpenEntryDetails() {
  return !!S.profile;
}

function typeLabel(type) {
  const map = {
    fuel: t("trip_entry_fuel"), toll: t("trip_entry_toll"), parking: t("trip_entry_parking"),
    washing: t("trip_entry_washing"), other_cost: t("trip_entry_cost"),
  };
  if (map[type]) return map[type];
  const inc = t("incident_" + type);
  return inc && inc !== "incident_" + type ? inc : type;
}

// ── POMOĆNE ZA HTML ───────────────────────────────────────────
function rows(list) {
  const f = list.filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false);
  if (f.length === 0) return `<p class="empty-text">${t("no_data")}</p>`;
  return `<div class="detail-table">${f.map(([label, value, raw]) => `
    <div class="detail-row">
      <div class="detail-row__label">${esc(label)}</div>
      <div class="detail-row__value">${raw ? value : esc(value)}</div>
    </div>`).join("")}</div>`;
}

function section(title, html) {
  return `<div class="form-section-title detail-modal__section">${esc(title)}</div>${html}`;
}

function dt(val)   { return val ? formatDateTimeDMY(val) : null; }
function d(val)    { return val ? formatDateDMY(val) : null; }
function km(val)   { return val != null && val !== "" ? `${fmtNum(val)} km` : null; }
function fuelLvl(code) { return code ? t("fuel_level_" + code) : null; }

// Datum/vreme sa računa je string iz datetime-local ("2026-11-02T14:35:10")
function receiptDateTime(val) {
  if (!val) return null;
  const x = new Date(val);
  return isNaN(x) ? String(val) : formatDateTimeDMY(x);
}

function safeReceiptLink(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    return `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer" class="detail-link">${esc(u.hostname)} ↗</a>`;
  } catch { return null; }
}

// Klikabilan mali red unosa (koristi se u detaljima vožnje/zaduženja)
function entryMiniRow(e) {
  rememberEntry(e);
  const isFuel = e.type === "fuel";
  const isCost = COST_TYPES.includes(e.type);
  const main = isFuel
    ? `${fmtNum(e.fuelAmount, 2)} L · ${fmtRsd(e.fuelCost)}${e.fuelStation ? " · " + esc(e.fuelStation) : ""}`
    : isCost
      ? `${fmtRsd(e.amount)}${e.location ? " · " + esc(e.location) : ""}`
      : esc(e.description || "");
  return `
    <div class="detail-mini-row" data-entry-id="${esc(e.id)}" role="button" tabindex="0">
      <span class="detail-mini-row__icon">${ICONS[e.type] || "📋"}</span>
      <span class="detail-mini-row__type">${esc(typeLabel(e.type))}</span>
      <span class="detail-mini-row__main">${main}</span>
      <span class="detail-mini-row__date">${formatDateDMY(e.createdAt)}</span>
    </div>`;
}

function driverLink(name, driverId) {
  if (!driverId || !isAdminViewer()) return esc(name || "—");
  return `<a href="#" class="detail-link" data-detail-driver="${esc(driverId)}">${esc(name || "—")}</a>`;
}

// ── STEK MODALA (dugme "Nazad" kad se ide iz zaduženja u unos itd.) ──
let current = null;      // { title, html } trenutno prikazan detaljni modal
const stack = [];

function overlayOpen() {
  const ov = document.getElementById("modal-overlay");
  return !!ov && !ov.classList.contains("hidden");
}

function show(title, html) {
  if (current && overlayOpen()) stack.push(current);
  else stack.length = 0;
  render(title, html);
}

function render(title, html) {
  current = { title, html };
  const back = stack.length
    ? `<button type="button" class="btn btn--ghost btn--sm detail-modal__back" data-detail-back>${t("vehicle_back")}</button>`
    : "";
  openModal(title, back + html);
  const cancel = document.getElementById("modal-cancel");
  if (cancel) cancel.textContent = t("close");
}

function goBack() {
  const prev = stack.pop();
  if (prev) render(prev.title, prev.html);
}

// ── DETALJI UNOSA ─────────────────────────────────────────────
export function entryDetailHTML(e) {
  const common = [
    [t("assignment_vehicle"), e.vehiclePlate],
    [t("assignment_driver"),  e.driverName ? driverLink(e.driverName, e.driverId) : null, true],
    [t("det_entered_at"),     dt(e.createdAt)],
  ];

  if (e.type === "fuel") {
    return [
      section(t("det_section_fuel"), rows([
        [t("trip_fuel_type"),        e.fuelType ? t("fuel_" + e.fuelType) : null],
        [t("trip_fuel_amount"),      e.fuelAmount != null ? `${fmtNum(e.fuelAmount, 2)} L` : null],
        [t("trip_fuel_price"),       e.fuelCost != null ? fmtRsd(e.fuelCost) : null],
        [t("trip_fuel_price_per_l"), e.pricePerL ? `${fmtNum(e.pricePerL, 2)} RSD/L` : null],
        [t("det_km_at_entry"),       km(e.currentKm)],
      ])),
      section(t("det_section_station"), rows([
        [t("trip_fuel_station"),  e.fuelStation],
        [t("trip_fuel_address"),  e.fuelStationAddress],
        [t("det_station_pib"),    e.stationPib],
        [t("det_station_object"), e.stationObject],
        [t("det_station_contract"), e.fuelStationContracted === undefined || e.fuelStationContracted === null
          ? null : (e.fuelStationContracted ? t("yes") : t("trip_fuel_off_contract_badge"))],
      ])),
      section(t("det_section_receipt"), rows([
        [t("trip_fuel_receipt"),      e.receiptNo],
        [t("trip_fuel_receipt_time"), receiptDateTime(e.receiptTime)],
        [t("det_receipt_link"),       safeReceiptLink(e.receiptUrl), true],
        [t("det_receipt_source"),     e.receiptSource ? t(e.receiptSource === "qr" ? "det_source_qr" : "det_source_manual") : null],
      ])),
      section(t("det_section_entry"), rows([...common, [t("notes"), e.notes]])),
    ].join("");
  }

  if (COST_TYPES.includes(e.type)) {
    return [
      section(t("det_section_cost"), rows([
        [t("trip_cost_type").replace(" *", ""), typeLabel(e.type)],
        [t("trip_cost_amount").replace(" *", ""), e.amount != null ? fmtRsd(e.amount) : null],
        [t("trip_cost_location").replace(" *", ""), e.location],
        [t("trip_fuel_receipt"),     e.receiptNo],
        [t("det_km_at_entry"),       km(e.currentKm)],
      ])),
      section(t("det_section_entry"), rows([...common, [t("notes"), e.notes]])),
    ].join("");
  }

  // prijave koje se čuvaju u tripEntries (kvar, oštećenje, nezgoda, ostalo)
  return [
    section(typeLabel(e.type), rows([
      [t("incident_description"), e.description],
      [t("incident_location"),    e.location],
      [t("det_km_at_entry"),      km(e.currentKm)],
    ])),
    section(t("det_section_entry"), rows([...common, [t("notes"), e.notes]])),
  ].join("");
}

export function openEntryDetail(entry) {
  if (!entry) return;
  show(`${ICONS[entry.type] || "📋"} ${typeLabel(entry.type)}`, entryDetailHTML(entry));
}

// ── DOHVAT VEZANIH PODATAKA ───────────────────────────────────
async function fetchByAssignment(subcollection, assignmentId) {
  try {
    const snap = await getDocs(query(
      collection(db, "companies", S.companyId, subcollection),
      where("assignmentId", "==", assignmentId)
    ));
    return snap.docs.map(x => ({ id: x.id, ...x.data() }));
  } catch (e) {
    console.warn(`Detalji: učitavanje ${subcollection} nije uspelo:`, e);
    return [];
  }
}

async function loadAssignment(id) {
  let a = getRememberedAssignment(id);
  if (a) return a;
  try {
    const snap = await getDoc(doc(db, "companies", S.companyId, "assignments", id));
    if (snap.exists()) a = rememberAssignment({ id: snap.id, ...snap.data() });
  } catch (e) { console.warn("Detalji: zaduženje nije učitano:", e); }
  return a;
}

// ── DETALJI VOŽNJE ────────────────────────────────────────────
function tripFields(tr) {
  const tripKm = (tr.endKm != null && tr.startKm != null) ? tr.endKm - tr.startKm : null;
  return rows([
    [t("assignment_start_date"), d(tr.startDate)],
    [t("assignment_end_date"),   tr.endDate ? d(tr.endDate) : t("assignment_status_active")],
    [t("assignment_start_km"),   km(tr.startKm)],
    [t("assignment_end_km"),     km(tr.endKm)],
    [t("assignment_summary_km"), tripKm != null ? km(tripKm) : null],
    [t("det_fuel_level"),        fuelLvl(tr.fuelLevel)],
    [t("assignment_type"),       tr.tripType === "intercity" ? t("assignment_intercity") : (tr.tripType ? t("assignment_local") : null)],
    [t("assignment_destination"), tr.destination],
    [t("assignment_route"),      tr.route],
    [t("assignment_reason"),     tr.reason],
    [t("det_status"),            tr.status ? t("assignment_status_" + tr.status) : null],
    [t("notes"),                 tr.notes],
  ]);
}

export async function openTripDetail(tripId, assignmentId = null) {
  const tr = getRememberedTrip(tripId);
  if (!tr) return;
  const aId = assignmentId || tr.assignmentId;
  let entries = [];
  if (aId) {
    const all = await fetchByAssignment("tripEntries", aId);
    entries = tr._legacy ? all : all.filter(e => e.tripId === tr.id);
  }
  entries.sort((x, y) => toMillis(x.createdAt) - toMillis(y.createdAt));
  show(`🔑 ${t("det_title_trip")}`, [
    section(t("assignment_vehicle") + " / " + t("assignment_driver"), rows([
      [t("assignment_vehicle"), [tr.vehiclePlate, `${tr.vehicleBrand || ""} ${tr.vehicleModel || ""}`.trim()].filter(Boolean).join(" — ")],
      [t("assignment_driver"),  tr.driverName ? driverLink(tr.driverName, tr.driverId) : null, true],
    ])),
    section(t("driver_trip_label"), tripFields(tr)),
    section(t("det_section_entries"), entries.length
      ? `<div class="detail-mini-list">${entries.map(entryMiniRow).join("")}</div>`
      : `<p class="empty-text">${t("trip_no_entries")}</p>`),
  ].join(""));
}

// ── DETALJI ZADUŽENJA ─────────────────────────────────────────
export async function openAssignmentDetail(assignmentId) {
  const a = await loadAssignment(assignmentId);
  if (!a) return;
  const [trips, entries] = await Promise.all([
    fetchByAssignment("trips", assignmentId),
    fetchByAssignment("tripEntries", assignmentId),
  ]);
  trips.sort((x, y) => toMillis(x.startDate) - toMillis(y.startDate));
  entries.sort((x, y) => toMillis(x.createdAt) - toMillis(y.createdAt));
  trips.forEach(tr => rememberTrip(tr, assignmentId));

  const totalKm = trips.reduce((s, tr) =>
    s + ((tr.endKm != null && tr.startKm != null) ? tr.endKm - tr.startKm : 0), 0)
    || ((a.endKm != null && a.startKm != null) ? a.endKm - a.startKm : 0);
  const fuel  = entries.filter(e => e.type === "fuel");
  const costs = entries.filter(e => COST_TYPES.includes(e.type));
  const fuelL    = fuel.reduce((s, e) => s + (Number(e.fuelAmount) || 0), 0);
  const fuelCost = fuel.reduce((s, e) => s + (Number(e.fuelCost) || 0), 0);
  const costSum  = costs.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const mismatch = [];
  if (a.kmMismatch) {
    mismatch.push(t("assignment_km_mismatch_detail")
      .replace("{0}", a.driverStartKm != null ? fmtNum(a.driverStartKm) : "?")
      .replace("{1}", a.startKm != null ? fmtNum(a.startKm) : "?"));
  }
  if (a.fuelLevelMismatch) {
    mismatch.push(t("assignment_fuel_mismatch_detail")
      .replace("{0}", fuelLvl(a.fuelLevelConfirmedValue) || "?")
      .replace("{1}", fuelLvl(a.systemFuelLevel) || "?"));
  }

  show(`🔑 ${t("det_title_assignment")}`, [
    section(t("assignment_vehicle") + " / " + t("assignment_driver"), rows([
      [t("assignment_vehicle"), `${a.vehiclePlate || ""} — ${a.vehicleBrand || ""} ${a.vehicleModel || ""}`.trim()],
      ["VIN", a.vehicleVin],
      [t("assignment_driver"), a.driverName ? driverLink(a.driverName, a.driverId) : null, true],
    ])),
    section(t("det_section_assignment"), rows([
      [t("det_status"),            t("assignment_status_" + a.status)],
      [t("assignment_start_date"), d(a.startDate)],
      [t("assignment_end_date"),   a.endDate ? d(a.endDate) : (a.status === "closed" ? null : t("assignment_status_active"))],
      [t("assignment_start_km"),   km(a.startKm)],
      [t("assignment_end_km"),     km(a.endKm)],
      [t("assignment_summary_km"), totalKm > 0 ? km(totalKm) : null],
      [t("det_fuel_level"),        fuelLvl(a.fuelLevel)],
      [t("assignment_type"),       a.tripType === "intercity" ? t("assignment_intercity") : t("assignment_local")],
      [t("assignment_destination"), a.destination],
      [t("assignment_route"),      a.route],
      [t("assignment_reason"),     a.reason],
      [t("det_unassign_notes"),    a.unassignNotes],
      [t("det_entered_at"),        dt(a.createdAt)],
    ])),
    mismatch.length ? section(t("det_section_mismatch"), `<div class="assignment-card__mismatch">${mismatch.map(m => `⚠️ ${esc(m)}`).join("<br>")}</div>`) : "",
    section(t("det_section_totals"), rows([
      [t("trip_stats_fuel"),            `${fmtNum(fuelL, 2)} L · ${fmtRsd(fuelCost)} (${fuel.length})`],
      [t("det_other_costs"),            `${fmtRsd(costSum)} (${costs.length})`],
      [t("assignment_summary_costs"),   fmtRsd(fuelCost + costSum)],
    ])),
    section(`${t("det_section_trips")} (${trips.length})`, trips.length
      ? `<div class="detail-mini-list">${trips.map((tr, i) => `
          <div class="detail-mini-row" data-detail-trip="${esc(tr.id)}" role="button" tabindex="0">
            <span class="detail-mini-row__icon">🔑</span>
            <span class="detail-mini-row__type">${t("driver_trip_label")} ${i + 1}</span>
            <span class="detail-mini-row__main">${d(tr.startDate) || "—"} → ${tr.endDate ? d(tr.endDate) : t("assignment_status_active")} · ${km(tr.startKm) || "—"} → ${km(tr.endKm) || "—"}</span>
          </div>`).join("")}</div>`
      : `<p class="empty-text">${t("no_data")}</p>`),
    section(`${t("det_section_entries")} (${entries.length})`, entries.length
      ? `<div class="detail-mini-list">${entries.map(entryMiniRow).join("")}</div>`
      : `<p class="empty-text">${t("trip_no_entries")}</p>`),
  ].join(""));
}

// ── DETALJI VOZAČA ────────────────────────────────────────────
export async function openDriverDetail(driverId) {
  let drv = null;
  try {
    const snap = await getDoc(doc(db, "companies", S.companyId, "drivers", driverId));
    if (snap.exists()) drv = { id: snap.id, ...snap.data() };
  } catch (e) { console.warn("Detalji: vozač nije učitan:", e); }
  if (!drv) return;

  let active = [];
  try {
    const snap = await getDocs(query(
      collection(db, "companies", S.companyId, "assignments"),
      where("driverId", "==", driverId),
      where("status", "==", "active")
    ));
    active = snap.docs.map(x => rememberAssignment({ id: x.id, ...x.data() }));
  } catch (e) { /* bez aktivnih zaduženja u prikazu */ }

  show(`👤 ${drv.firstName || ""} ${drv.lastName || ""}`.trim(), [
    section(t("driver_personal_section"), rows([
      [t("driver_firstname"),   drv.firstName],
      [t("driver_lastname"),    drv.lastName],
      [t("driver_jmbg_label"),  drv.jmbg],
      [t("driver_birth_year"),  drv.birthYear],
      [t("driver_license_cat"), Array.isArray(drv.licenseCategories) ? drv.licenseCategories.join(", ") : drv.licenseCategories],
      [t("driver_position"),    drv.position],
      [t("driver_status_label"), drv.active !== false ? t("driver_active") : t("driver_inactive")],
    ])),
    section(t("driver_contact_section"), rows([
      [t("driver_phone"),        drv.phone],
      [t("driver_email"),        drv.email],
      [t("driver_home_address"), drv.homeAddress],
      [t("driver_work_address"), drv.workAddress],
    ])),
    section(t("det_current_assignments"), active.length
      ? `<div class="detail-mini-list">${active.map(a => `
          <div class="detail-mini-row" data-detail-assignment="${esc(a.id)}" role="button" tabindex="0">
            <span class="detail-mini-row__icon">🚗</span>
            <span class="detail-mini-row__type">${esc(a.vehiclePlate || "")}</span>
            <span class="detail-mini-row__main">${esc(`${a.vehicleBrand || ""} ${a.vehicleModel || ""}`.trim())}${a.tripType === "intercity" && a.destination ? " · 📍 " + esc(a.destination) : ""}</span>
            <span class="detail-mini-row__date">${d(a.startDate) || ""}</span>
          </div>`).join("")}</div>`
      : `<p class="empty-text">${t("det_no_active_assignment")}</p>`),
    drv.notes ? section(t("notes"), `<div class="vehicle-notes-box">${esc(drv.notes)}</div>`) : "",
  ].join(""));
}

// ── GLOBALNI KLIK (capture, da ne okine toggle roditeljskog zaglavlja) ──
function onActivate(e) {
  if (!canOpenEntryDetails()) return;
  const el = e.target.closest?.(
    "[data-detail-back], [data-entry-id], [data-detail-assignment], [data-detail-trip], [data-detail-driver]"
  );
  if (!el) return;

  // Vozač: dozvoljeni su samo detalji unosa i dugme "Nazad" u modalu
  if (!isAdminViewer() && !el.hasAttribute("data-detail-back") && !el.dataset.entryId) return;

  e.preventDefault();
  e.stopPropagation();

  if (el.hasAttribute("data-detail-back"))       { goBack(); return; }
  if (el.dataset.entryId)                         { openEntryDetail(getRememberedEntry(el.dataset.entryId)); return; }
  if (el.dataset.detailAssignment)                { openAssignmentDetail(el.dataset.detailAssignment); return; }
  if (el.dataset.detailTrip)                      { openTripDetail(el.dataset.detailTrip); return; }
  if (el.dataset.detailDriver)                    { openDriverDetail(el.dataset.detailDriver); return; }
}

if (!window.__fmDetailHandlersInstalled) {
  window.__fmDetailHandlersInstalled = true;
  document.addEventListener("click", onActivate, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (!e.target.closest?.("[role='button'][data-entry-id], [role='button'][data-detail-assignment], [role='button'][data-detail-trip]")) return;
    onActivate(e);
  }, true);
}

// Pomoćnik za HTML dugme "ℹ️" u zaglavljima (vraća "" za vozače)
export function detailButton(attr, id, title = null) {
  if (!isAdminViewer()) return "";
  return `<button type="button" class="btn btn--ghost btn--sm detail-btn" ${attr}="${esc(id)}" title="${esc(title || t("det_btn_details"))}" aria-label="${esc(title || t("det_btn_details"))}">ℹ️</button>`;
}
