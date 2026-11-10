// ============================================================
//  entry-forms.js  —  Fleet Manager
//  Zajednički deo za unos GORIVA i TROŠKOVA:
//   1) polja forme za trošak + skeniranje QR koda fiskalnog računa
//      (koristi ga forma za trošak kod vozača i adminski unos)
//   2) adminski unos goriva / troška za izabrano vozilo (i vozača)
//      — za račune koje admin parka unosi umesto vozača
//
//  Adminski unosi se ne vezuju za zaduženje ni za vožnju, imaju
//  datum računa (createdAt = izabrani datum), ne menjaju trenutnu
//  kilometražu vozila i nose oznaku enteredByAdmin.
// ============================================================

import { getVehicles, getDrivers } from "./firebase.js";
import { Timestamp, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t } from "./i18n.js";
import { S, openModal, showToast } from "./app.js";
import { scanQRCode, parseFiscalQR, fetchReceiptDetails, receiptWorkerConfigured } from "./receipt-scan.js";
import { findReceiptDuplicate, saveTripEntry, DuplicateReceiptError, normalizeReceiptNo } from "./receipt-guard.js";
import { COST_TYPES, COST_META, esc } from "./entries-view.js";
import { attachDateMask, todayDMY, collectDates } from "./date-input.js";

// ── POMOĆNE ───────────────────────────────────────────────────
function setField(id, value) {
  const el = document.getElementById(id);
  if (!el || value === null || value === undefined || value === "") return;
  if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === String(value))) return;
  el.value = value;
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
}

function duplicateMessage(pfr, existing) {
  const when = existing?.createdAt?.toDate ? existing.createdAt.toDate().toLocaleDateString("sr-RS") : "—";
  const who = [existing?.driverName, existing?.vehiclePlate].filter(Boolean).join(", ") || "—";
  return t("receipt_duplicate_detail", { pfr, date: when, who });
}

async function checkDuplicate(pfr) {
  if (!normalizeReceiptNo(pfr)) return { duplicate: null };
  try {
    return { duplicate: await findReceiptDuplicate(S.companyId, pfr) };
  } catch (e) {
    console.warn("Provera duplikata računa nije uspela:", e);
    return { error: t("receipt_check_failed") };
  }
}

// ── 1) POLJA FORME ZA TROŠAK + SKENER ─────────────────────────
// p = prefiks ID-jeva (npr. "tc" ili "ac"). Km i napomene dodaje pozivalac.
export function costFieldsHTML(p) {
  return `
    <button type="button" id="${p}-scan-btn" class="btn btn--secondary btn--full">${t("receipt_scan_btn")}</button>
    <p id="${p}-scan-status" class="scan-status hidden"></p>
    <div class="form-group">
      <label class="form-label">${t("trip_cost_type")}</label>
      <select id="${p}-type" class="form-select">
        ${COST_TYPES.map(k => `<option value="${k}">${COST_META[k].icon} ${t(k === "other_cost" ? "trip_cost_other" : "trip_cost_" + k)}</option>`).join("")}
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_cost_amount")}</label>
        <input id="${p}-amount" class="form-input" type="number" min="0" step="0.01" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_cost_receipt")}</label>
        <input id="${p}-receiptNo" class="form-input" type="text" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_cost_merchant")}</label>
        <input id="${p}-merchant" class="form-input" type="text" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_receipt_time")}</label>
        <input id="${p}-receiptTime" class="form-input" type="datetime-local" step="1" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("trip_cost_location")}</label>
      <input id="${p}-location" class="form-input" type="text" placeholder="${t("trip_cost_location_ph")}" />
    </div>
  `;
}

// Vezuje dugme "Skeniraj račun". Vraća objekat sa read() koji daje
// sva polja troška (uključujući podatke dobijene skeniranjem).
export function bindCostScanner(p, notesId = `${p}-notes`) {
  const scan = { url: null, source: "manual", pib: null, items: null, merchantAddress: null };
  let autoNotes = "";   // tekst koji je aplikacija sama upisala u napomenu

  // Stavke sa računa → polje "Napomena" (ne briše ono što je korisnik sam ukucao)
  const fmt = (n) => Number(n).toLocaleString("sr-RS", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fillNotes = (items) => {
    const el = document.getElementById(notesId);
    if (!el || !items.length) return;
    const lines = items.map(it => {
      const qty = it.quantity != null ? Number(it.quantity).toLocaleString("sr-RS", { maximumFractionDigits: 3 }) : "";
      const price = it.unitPrice != null ? fmt(it.unitPrice) : "";
      const tot = it.total != null ? fmt(it.total) : "";
      return `• ${it.name || "—"}${qty ? ` — ${qty} × ${price}` : ""}${tot ? ` = ${tot}` : ""}`;
    });
    const text = `${t("receipt_items_label")}\n${lines.join("\n")}`;
    const cur = el.value.trim();
    if (!cur || cur === autoNotes) el.value = text;                 // prazno ili prethodno auto → zameni
    else if (!cur.includes(text)) el.value = `${cur}\n\n${text}`;  // korisnikov tekst → dopiši
    autoNotes = text;
  };

  const btn = document.getElementById(`${p}-scan-btn`);
  const setStatus = (msg, kind = "info") => {
    const el = document.getElementById(`${p}-scan-status`);
    if (!el) return;
    el.textContent = msg;
    el.className = `scan-status scan-status--${kind}`;
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
    const dup = await checkDuplicate(qr.pfr);
    if (dup.error) { setStatus(dup.error, "error"); return; }
    if (dup.duplicate) { setStatus(duplicateMessage(qr.pfr, dup.duplicate), "error"); return; }

    // Podaci iz samog QR koda (rade i bez Worker-a)
    scan.url = text.trim();
    scan.source = "qr";
    setField(`${p}-receiptNo`, qr.pfr);
    setField(`${p}-amount`, qr.amount);
    setField(`${p}-receiptTime`, qr.dateTime);

    if (!receiptWorkerConfigured()) { setStatus(t("receipt_scan_qr_only_cost"), "warn"); return; }

    setStatus(t("receipt_scan_loading"), "info");
    if (btn) btn.disabled = true;
    try {
      const r = await fetchReceiptDetails(scan.url);
      const items = r.items || [];
      setField(`${p}-merchant`, r.chain);
      const place = [r.address, r.city].filter(Boolean).join(", ");
      scan.merchantAddress = place || null;
      const locEl = document.getElementById(`${p}-location`);
      if (locEl && !locEl.value && place) locEl.value = place;
      setField(`${p}-receiptTime`, r.time);
      if (r.total > 0) setField(`${p}-amount`, r.total);
      scan.pib = r.pib || null;
      scan.items = items.map(it => ({
        name: it.name || null,
        quantity: it.quantity ?? null,
        unitPrice: it.unitPrice ?? null,
        total: it.total ?? null,
      }));
      fillNotes(scan.items);

      const notes = [];
      if (r.total > 0 && Math.abs(r.total - qr.amount) > 0.01) {
        notes.push(t("receipt_scan_total_mismatch", { a: r.total.toFixed(2), b: qr.amount.toFixed(2) }));
      }
      if (items.some(it => it.fuelType)) notes.push(t("receipt_scan_fuel_in_cost"));
      setStatus(notes.length ? notes.join(" ") : t("receipt_scan_ok_cost"), notes.length ? "warn" : "ok");
    } catch (e) {
      console.warn("Učitavanje računa nije uspelo:", e.message, e.diag || "");
      setStatus(`${t("receipt_scan_qr_only_cost")} (${e.message})`, "warn");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  return {
    scan,
    // Sva polja troška; amount je broj (ili NaN ako je prazno)
    read() {
      const v = (id) => document.getElementById(`${p}-${id}`)?.value?.trim() || null;
      return {
        type:            document.getElementById(`${p}-type`)?.value || "other_cost",
        amount:          parseFloat(document.getElementById(`${p}-amount`)?.value),
        receiptNoRaw:    v("receiptNo"),
        merchant:        v("merchant"),
        merchantAddress: scan.merchantAddress,
        receiptTime:     document.getElementById(`${p}-receiptTime`)?.value || null,
        location:        v("location"),
        receiptUrl:      scan.url || null,
        receiptSource:   scan.source,
        stationPib:      scan.pib || null,
        receiptItems:    scan.items && scan.items.length ? scan.items : null,
      };
    },
  };
}

// ── 2) ADMINSKI UNOS ──────────────────────────────────────────
function adminName() {
  return S.profile?.displayName
    || `${S.profile?.firstName || ""} ${S.profile?.lastName || ""}`.trim()
    || S.user?.email || null;
}

// Datum iz polja dd.mm.gggg → Firestore Timestamp (današnji datum = serverski trenutak)
function dateFieldToTimestamp(id) {
  const res = collectDates([{ id, required: true }]);
  if (!res.ok) return { ok: false };
  const d = res.values[id];
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (d > now && !isToday) {
    showError("ae-error", t("admin_entry_date_future"));
    return { ok: false };
  }
  if (isToday) return { ok: true, value: serverTimestamp() };
  // Prošli datum: koristi se vreme u danu od sada, da redosled u listi bude smislen
  d.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);
  return { ok: true, value: Timestamp.fromDate(d) };
}

// Zajednički blok: vozilo + vozač + datum. Vraća HTML.
export function vehicleDriverDateHTML(p, vehicles, drivers, preVehicleId = null) {
  const vOpts = vehicles
    .filter(v => !v.archived)
    .map(v => `<option value="${esc(v.id)}" ${v.id === preVehicleId ? "selected" : ""}>${esc(v.brand || "")} ${esc(v.model || "")} — ${esc(v.plate || v.licensePlate || "")}</option>`)
    .join("");
  const dOpts = drivers
    .map(d => `<option value="${esc(d.id)}">${esc(`${d.firstName || ""} ${d.lastName || ""}`.trim() || d.id)}</option>`)
    .join("");
  return `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("assignment_vehicle")} *</label>
        <select id="${p}-vehicle" class="form-select">
          <option value="">${t("admin_entry_pick_vehicle")}</option>${vOpts}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${t("assignment_driver")}</label>
        <select id="${p}-driver" class="form-select">
          <option value="">${t("admin_entry_no_driver")}</option>${dOpts}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("admin_entry_date")} *</label>
      <input id="${p}-date" class="form-input" type="text" value="${todayDMY()}" />
    </div>
  `;
}

// Čita izbor vozila/vozača; vraća { vehicle, driver } ili null uz poruku
export function readVehicleDriver(p, vehicles, drivers, errId) {
  const vehicle = vehicles.find(v => v.id === document.getElementById(`${p}-vehicle`)?.value);
  if (!vehicle) { showError(errId, `${t("required_field")}: ${t("assignment_vehicle")}`); return null; }
  const driverId = document.getElementById(`${p}-driver`)?.value || "";
  const driver = driverId ? drivers.find(d => d.id === driverId) : null;
  return { vehicle, driver };
}

export function driverDisplayName(d) {
  return d ? (`${d.firstName || ""} ${d.lastName || ""}`.trim() || null) : null;
}

async function loadLists() {
  const [vehicles, drivers] = await Promise.all([getVehicles(S.companyId), getDrivers(S.companyId)]);
  return { vehicles, drivers };
}

function optionalKm(id) {
  const raw = document.getElementById(id)?.value;
  const n = parseFloat(raw);
  return raw && !isNaN(n) && n > 0 ? n : null;
}

/**
 * Adminski unos: kind = "fuel" | "cost".
 * opts: { vehicleId (predizbor), onSaved }
 */
export async function openAdminEntryForm(kind, { vehicleId = null, onSaved = null } = {}) {
  if (!S.companyId || S.profile?.role === "driver") return;
  let lists;
  try { lists = await loadLists(); }
  catch (e) { showToast(`${t("error")}: ${e.message}`, "error"); return; }
  const { vehicles, drivers } = lists;

  const isFuel = kind === "fuel";
  const fuelFields = `
    <button type="button" id="af-scan-btn" class="btn btn--secondary btn--full">${t("receipt_scan_btn")}</button>
    <p id="af-scan-status" class="scan-status hidden"></p>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_type")} *</label>
        <select id="af-fuelType" class="form-select">
          ${["diesel", "petrol", "lpg", "cng", "electric"].map(k => `<option value="${k}">${t("fuel_" + k)}</option>`).join("")}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_amount")} (L) *</label>
        <input id="af-fuelAmount" class="form-input" type="number" step="0.01" min="0" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_price")} (RSD) *</label>
        <input id="af-fuelCost" class="form-input" type="number" min="0" step="0.01" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_price_per_l")}</label>
        <input id="af-pricePerL" class="form-input" type="number" step="0.01" min="0" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_station")} *</label>
        <input id="af-fuelStation" class="form-input" type="text" placeholder="npr. NIS Petrol" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_receipt")}</label>
        <input id="af-receiptNo" class="form-input" type="text" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_address")}</label>
        <input id="af-fuelStationAddress" class="form-input" type="text" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("trip_fuel_receipt_time")}</label>
        <input id="af-receiptTime" class="form-input" type="datetime-local" step="1" />
      </div>
    </div>`;

  const bodyHTML = `
    <div class="form-section-title">${t(isFuel ? "admin_entry_fuel_title" : "admin_entry_cost_title")}</div>
    ${vehicleDriverDateHTML("ae", vehicles, drivers, vehicleId)}
    ${isFuel ? fuelFields : costFieldsHTML("ac")}
    <div class="form-group">
      <label class="form-label">${t("admin_entry_km_optional")}</label>
      <input id="ae-km" class="form-input" type="number" min="0" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("notes")}</label>
      <textarea id="ae-notes" class="form-textarea" rows="2"></textarea>
    </div>
    <p id="ae-error" class="login-error hidden"></p>
  `;

  openModal(t(isFuel ? "admin_entry_fuel_add" : "admin_entry_cost_add"), bodyHTML, () => save());

  let costScanner = null;
  const fuelScan = { url: null, source: "manual", pib: null, object: null };

  setTimeout(() => {
    attachDateMask("ae-date");
    if (isFuel) bindFuelScan(fuelScan);
    else costScanner = bindCostScanner("ac", "ae-notes");

    // cena po litru se računa dok je polje prazno / nije ručno menjano
    if (isFuel) {
      const calc = () => {
        const a = parseFloat(document.getElementById("af-fuelAmount")?.value);
        const c = parseFloat(document.getElementById("af-fuelCost")?.value);
        const pEl = document.getElementById("af-pricePerL");
        if (pEl && !pEl.dataset.manual && a > 0 && c > 0) pEl.value = (c / a).toFixed(2);
      };
      document.getElementById("af-fuelAmount")?.addEventListener("input", calc);
      document.getElementById("af-fuelCost")?.addEventListener("input", calc);
      document.getElementById("af-pricePerL")?.addEventListener("input", (e) => { e.target.dataset.manual = "1"; });
    }
  }, 50);

  function bindFuelScan(state) {
    const btn = document.getElementById("af-scan-btn");
    const setStatus = (msg, k = "info") => {
      const el = document.getElementById("af-scan-status");
      if (!el) return;
      el.textContent = msg;
      el.className = `scan-status scan-status--${k}`;
    };
    btn?.addEventListener("click", async () => {
      let text;
      try { text = await scanQRCode(); }
      catch (e) { setStatus(t(e.code === "denied" ? "receipt_scan_camera_denied" : "receipt_scan_camera_unavailable"), "error"); return; }
      if (text === null) return;
      const qr = parseFiscalQR(text);
      if (!qr) { setStatus(t("receipt_scan_not_fiscal"), "error"); return; }
      const dup = await checkDuplicate(qr.pfr);
      if (dup.error) { setStatus(dup.error, "error"); return; }
      if (dup.duplicate) { setStatus(duplicateMessage(qr.pfr, dup.duplicate), "error"); return; }

      state.url = text.trim(); state.source = "qr";
      setField("af-receiptNo", qr.pfr);
      setField("af-fuelCost", qr.amount);
      setField("af-receiptTime", qr.dateTime);
      document.getElementById("af-fuelCost")?.dispatchEvent(new Event("input"));
      if (!receiptWorkerConfigured()) { setStatus(t("receipt_scan_qr_only"), "warn"); return; }

      setStatus(t("receipt_scan_loading"), "info");
      if (btn) btn.disabled = true;
      try {
        const r = await fetchReceiptDetails(state.url);
        const items = r.items || [];
        const fuelItem = items.find(i => i.fuelType) || (items.length === 1 ? items[0] : null);
        setField("af-fuelStation", r.chain);
        setField("af-fuelStationAddress", [r.address, r.city].filter(Boolean).join(", "));
        setField("af-receiptTime", r.time);
        state.pib = r.pib || null; state.object = r.object || null;
        if (fuelItem) {
          setField("af-fuelType", fuelItem.fuelType);
          setField("af-fuelAmount", fuelItem.quantity);
          if (fuelItem.total > 0) setField("af-fuelCost", fuelItem.total);
          const pEl = document.getElementById("af-pricePerL");
          if (pEl && fuelItem.unitPrice > 0) { pEl.value = fuelItem.unitPrice.toFixed(2); pEl.dataset.manual = ""; }
        }
        const notes = [];
        if (r.total > 0 && Math.abs(r.total - qr.amount) > 0.01) notes.push(t("receipt_scan_total_mismatch", { a: r.total.toFixed(2), b: qr.amount.toFixed(2) }));
        if (!fuelItem) notes.push(t("receipt_scan_no_fuel_item"));
        else if (items.length > 1) notes.push(t("receipt_scan_extra_items", { total: (r.total || qr.amount).toFixed(2) }));
        setStatus(notes.length ? notes.join(" ") : t("receipt_scan_ok"), notes.length ? "warn" : "ok");
      } catch (e) {
        console.warn("Učitavanje računa nije uspelo:", e.message, e.diag || "");
        setStatus(`${t("receipt_scan_qr_only")} (${e.message})`, "warn");
      } finally { if (btn) btn.disabled = false; }
    });
  }

  async function save() {
    document.getElementById("ae-error")?.classList.add("hidden");
    const vd = readVehicleDriver("ae", vehicles, drivers, "ae-error");
    if (!vd) return false;
    const ts = dateFieldToTimestamp("ae-date");
    if (!ts.ok) return false;

    const base = {
      assignmentId: null,
      tripId:       null,
      vehicleId:    vd.vehicle.id,
      vehiclePlate: vd.vehicle.plate || vd.vehicle.licensePlate || null,
      driverId:     vd.driver?.id || null,
      driverUid:    null,   // vozač ne može da menja/briše unos koji je uneo admin
      driverName:   driverDisplayName(vd.driver),
      currentKm:    optionalKm("ae-km"),
      notes:        document.getElementById("ae-notes")?.value.trim() || null,
      enteredByAdmin: true,
      enteredByUid:   S.user?.uid || null,
      enteredByName:  adminName(),
      createdAt:    ts.value,
      recordedAt:   serverTimestamp(),
    };

    try {
      if (isFuel) {
        const fuelAmount  = parseFloat(document.getElementById("af-fuelAmount")?.value);
        const fuelCost    = parseFloat(document.getElementById("af-fuelCost")?.value);
        const fuelStation = document.getElementById("af-fuelStation")?.value.trim();
        if (!fuelAmount || !fuelCost || !fuelStation) { showError("ae-error", t("required_field")); return false; }
        const receiptNo = normalizeReceiptNo(document.getElementById("af-receiptNo")?.value);
        if (receiptNo) {
          const dup = await checkDuplicate(receiptNo);
          if (dup.error || dup.duplicate) { showError("ae-error", dup.error || duplicateMessage(receiptNo, dup.duplicate)); return false; }
        }
        const priceField = parseFloat(document.getElementById("af-pricePerL")?.value);
        await saveTripEntry(S.companyId, {
          ...base,
          type: "fuel",
          fuelType: document.getElementById("af-fuelType")?.value,
          fuelAmount, fuelCost,
          pricePerL: priceField > 0 ? priceField : fuelCost / fuelAmount,
          fuelStation,
          fuelStationAddress: document.getElementById("af-fuelStationAddress")?.value.trim() || null,
          stationObject: fuelScan.object || null,
          stationPib:    fuelScan.pib || null,
          receiptNo,
          receiptTime:   document.getElementById("af-receiptTime")?.value || null,
          receiptUrl:    fuelScan.url || null,
          receiptSource: fuelScan.source,
        });
      } else {
        const c = costScanner.read();
        if (!c.amount || c.amount <= 0) { showError("ae-error", t("required_field")); return false; }
        const receiptNo = normalizeReceiptNo(c.receiptNoRaw);
        if (receiptNo) {
          const dup = await checkDuplicate(receiptNo);
          if (dup.error || dup.duplicate) { showError("ae-error", dup.error || duplicateMessage(receiptNo, dup.duplicate)); return false; }
        }
        await saveTripEntry(S.companyId, {
          ...base,
          type: c.type, amount: c.amount, receiptNo,
          merchant: c.merchant, merchantAddress: c.merchantAddress,
          location: c.location,
          receiptTime: c.receiptTime, receiptUrl: c.receiptUrl, receiptSource: c.receiptSource,
          stationPib: c.stationPib, receiptItems: c.receiptItems,
        });
      }
      showToast(t("success"), "success");
      if (typeof onSaved === "function") await onSaved();
    } catch (e) {
      showError("ae-error", e instanceof DuplicateReceiptError
        ? duplicateMessage(e.receiptNo, e.existing)
        : `${t("error")}: ${e.message}`);
      return false;
    }
  }
}
