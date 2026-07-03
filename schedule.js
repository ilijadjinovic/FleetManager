// ============================================================
//  schedule.js  —  Fleet Manager
//  Zakazivanje servisa: forma, push notifikacije, .ics export
// ============================================================

import { db } from "./firebase.js";
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc, doc,
  query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t, getCurrentLang } from "./i18n.js";
import { S, showToast, openModal } from "./app.js";
import { getServiceProviders } from "./servicers.js";

const SERVICE_TYPES = ["oil", "tires", "brakes", "technical", "registration", "ac", "other"];

// Lokalni datum/vreme za <input type="date"/"time"> — bez UTC pomeranja (za razliku od toISOString)
function toLocalDateInput(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function toLocalTimeInput(d) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mi}`;
}

// ── ZAKAŽI SERVIS — otvori formu (kreiranje ili izmena) ───────
// options.existing  — postojeći zakazani servis (uključuje formu u režim izmene)
// options.onSuccess — poziva se posle uspešnog snimanja (npr. da se lista osveži)
export async function openScheduleForm(vehicle, options = {}) {
  const { existing = null, onSuccess = null } = options;
  const isEdit = !!existing;
  const providers = await getServiceProviders();

  const existingDate = existing?.scheduledDate
    ? (existing.scheduledDate.toDate ? existing.scheduledDate.toDate() : new Date(existing.scheduledDate))
    : null;
  const dateVal0 = existingDate ? toLocalDateInput(existingDate) : "";
  const timeVal0 = existingDate ? toLocalTimeInput(existingDate) : "08:00";

  const typeOptions = SERVICE_TYPES.map(st =>
    `<option value="${st}" ${existing?.serviceType === st ? "selected" : ""}>${t("service_type_" + st) || st}</option>`
  ).join("");

  const providerOptions = providers.length > 0
    ? providers.map(p => `<option value="${p.id}" data-name="${p.name}" data-address="${p.address || ''}" data-phone="${p.phone || ''}" ${existing?.serviceProviderId === p.id ? "selected" : ""}>${p.name}</option>`).join("")
    : "";

  const bodyHTML = `
    <div class="form-grid">
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">${t("schedule_service_type")}</label>
        <select id="sch-type" class="form-input form-select">
          ${typeOptions}
        </select>
      </div>

      <div class="form-group">
        <label class="form-label">${t("schedule_date")}</label>
        <input id="sch-date" class="form-input" type="date" value="${dateVal0}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("schedule_time")}</label>
        <input id="sch-time" class="form-input" type="time" value="${timeVal0}" />
      </div>

      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">${t("schedule_provider")}</label>
        <select id="sch-provider" class="form-input form-select">
          <option value="">${t("schedule_provider_manual")}</option>
          ${providerOptions}
        </select>
      </div>

      <div id="sch-manual-fields" style="grid-column:1/-1; display:grid; grid-template-columns:1fr 1fr; gap:12px">
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">${t("schedule_provider_name")}</label>
          <input id="sch-name" class="form-input" type="text" placeholder="Naziv servisa..." value="${!existing?.serviceProviderId && existing?.serviceProviderName ? existing.serviceProviderName : ""}" />
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">${t("schedule_provider_address")}</label>
          <input id="sch-address" class="form-input" type="text" placeholder="${t("schedule_provider_address_ph")}" value="${!existing?.serviceProviderId && existing?.serviceProviderAddress ? existing.serviceProviderAddress : ""}" />
        </div>
        <div class="form-group">
          <label class="form-label">${t("servicer_phone")}</label>
          <input id="sch-phone" class="form-input" type="tel" placeholder="+381..." value="${!existing?.serviceProviderId && existing?.serviceProviderPhone ? existing.serviceProviderPhone : ""}" />
        </div>
      </div>

      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">${t("schedule_notes")}</label>
        <textarea id="sch-notes" class="form-input form-textarea" rows="2" placeholder="${t("schedule_notes_ph")}">${existing?.notes || ""}</textarea>
      </div>

      <div class="form-group" style="grid-column:1/-1">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="sch-push" ${isEdit ? "" : "checked"} />
          <span>${t("schedule_push")}</span>
        </label>
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="sch-ics" ${isEdit ? "" : "checked"} />
          <span>${t("schedule_ics")}</span>
        </label>
      </div>
    </div>
    <p id="sch-error" class="login-error hidden"></p>
  `;

  openModal(
    isEdit
      ? `✏️ ${t("edit")} — ${vehicle.brand} ${vehicle.model} (${vehicle.plate})`
      : `📅 ${t("schedule_title_prefix")} — ${vehicle.brand} ${vehicle.model} (${vehicle.plate})`,
    bodyHTML,
    async () => {
      const dateVal = document.getElementById("sch-date")?.value;
      const timeVal = document.getElementById("sch-time")?.value || "08:00";
      const type    = document.getElementById("sch-type")?.value;

      if (!dateVal) {
        const err = document.getElementById("sch-error");
        err.textContent = t("schedule_date_required");
        err.classList.remove("hidden");
        throw new Error("validation");
      }

      const scheduledDate = new Date(`${dateVal}T${timeVal}:00`);

      // Serviser — iz liste ili ručni unos
      const providerSelect = document.getElementById("sch-provider");
      const providerId = providerSelect?.value || null;
      let providerName, providerAddress, providerPhone;

      if (providerId) {
        const opt = providerSelect.options[providerSelect.selectedIndex];
        providerName    = opt.dataset.name;
        providerAddress = opt.dataset.address;
        providerPhone   = opt.dataset.phone;
      } else {
        providerName    = document.getElementById("sch-name")?.value.trim() || null;
        providerAddress = document.getElementById("sch-address")?.value.trim() || null;
        providerPhone   = document.getElementById("sch-phone")?.value.trim() || null;
      }

      const notes = document.getElementById("sch-notes")?.value.trim() || null;
      const sendPush = document.getElementById("sch-push")?.checked;
      const exportIcs = document.getElementById("sch-ics")?.checked;

      // Snimi u Firestore — kreiranje ili izmena
      if (isEdit) {
        await updateDoc(doc(db, "companies", S.companyId, "scheduledServices", existing.id), {
          serviceType:     type,
          scheduledDate,
          serviceProviderId:      providerId,
          serviceProviderName:    providerName,
          serviceProviderAddress: providerAddress,
          serviceProviderPhone:   providerPhone,
          notes,
          updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, "companies", S.companyId, "scheduledServices"), {
          vehicleId:       vehicle.id,
          vehiclePlate:    vehicle.plate,
          vehicleBrand:    vehicle.brand,
          vehicleModel:    vehicle.model,
          serviceType:     type,
          scheduledDate,
          serviceProviderId:      providerId,
          serviceProviderName:    providerName,
          serviceProviderAddress: providerAddress,
          serviceProviderPhone:   providerPhone,
          notes,
          createdBy:  S.user.uid,
          createdAt:  serverTimestamp(),
          status:     "scheduled",
        });
      }

      showToast(isEdit ? t("schedule_updated") : t("schedule_success"), "success");

      // Push notifikacija
      if (sendPush) {
        await sendPushToDrivers(vehicle, type, scheduledDate, providerName);
      }

      // .ics export
      if (exportIcs) {
        downloadIcs({
          title:    `Servis: ${vehicle.brand} ${vehicle.model} (${vehicle.plate})`,
          date:     scheduledDate,
          location: providerAddress || providerName || "",
          description: [
            `Tip: ${t("service_type_" + type) || type}`,
            providerName ? `Serviser: ${providerName}` : "",
            providerPhone ? `Tel: ${providerPhone}` : "",
            notes ? `Napomena: ${notes}` : "",
          ].filter(Boolean).join("\\n"),
        });
      }

      if (onSuccess) onSuccess();
    }
  );

  // Provider select — popuni polja kada se izabere serviser iz liste
  setTimeout(() => {
    const sel = document.getElementById("sch-provider");
    const manualFields = document.getElementById("sch-manual-fields");
    if (!sel || !manualFields) return;

    const toggle = () => {
      if (sel.value) {
        // Izabran serviser iz liste — sakrij ručni unos
        manualFields.style.display = "none";
      } else {
        manualFields.style.display = "grid";
      }
    };
    sel.addEventListener("change", toggle);
    toggle();
  }, 50);
}

// ── DETALJI POJEDINAČNOG ZAKAZANOG SERVISA ────────────────────
// Poziva se sa dashboard-a (klik na stavku u panelu "Zakazani servisi").
export function openScheduledServiceDetail(s) {
  const container = document.getElementById("content");
  if (!container) return;

  const d = s.scheduledDate?.toDate ? s.scheduledDate.toDate() : new Date(s.scheduledDate);
  const dateStr = d.toLocaleDateString(getCurrentLang() === "en" ? "en-GB" : "sr-RS", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
  });

  container.innerHTML = `
    <div class="detail-header">
      <button class="btn btn--ghost btn--sm" id="btn-back-scheduled">${t("vehicle_back")}</button>
      <div class="detail-header__title">
        <h2>${s.vehicleBrand} ${s.vehicleModel}</h2>
        <span class="badge badge--info">${s.vehiclePlate}</span>
      </div>
    </div>
    ${scheduledDetailTable([
      [t("schedule_service_type"), t("service_type_" + s.serviceType) || s.serviceType],
      [t("schedule_date"), dateStr],
      [t("schedule_provider_name"), s.serviceProviderName],
      [t("schedule_provider_address"), s.serviceProviderAddress],
      [t("servicer_phone"), s.serviceProviderPhone],
      [t("schedule_notes"), s.notes],
    ])}
  `;

  document.getElementById("btn-back-scheduled")?.addEventListener("click", () => {
    import("./app.js").then(({ navigateTo }) => navigateTo("dashboard"));
  });
}

function scheduledDetailTable(rows) {
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

// ── DOHVATI ZAKAZANE SERVISE ──────────────────────────────────
export async function getScheduledServices(companyId, options = {}) {
  try {
    let q;
    if (options.vehicleId) {
      q = query(
        collection(db, "companies", companyId, "scheduledServices"),
        where("vehicleId", "==", options.vehicleId),
        where("status", "==", "scheduled"),
        orderBy("scheduledDate", "asc")
      );
    } else {
      q = query(
        collection(db, "companies", companyId, "scheduledServices"),
        where("status", "==", "scheduled"),
        orderBy("scheduledDate", "asc")
      );
    }
    const snap = await getDocs(q);
    const result = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log("[DEBUG] getScheduledServices companyId=", companyId, "options=", options, "→ broj dokumenata:", result.length, result);
    return result;
  } catch (e) {
    console.error("[DEBUG] getScheduledServices GREŠKA:", e);
    return [];
  }
}

// ── OTKAŽI ZAKAZANI SERVIS ────────────────────────────────────
export async function cancelScheduledService(id) {
  await deleteDoc(doc(db, "companies", S.companyId, "scheduledServices", id));
}

// ── PUSH NOTIFIKACIJA ─────────────────────────────────────────
async function sendPushToDrivers(vehicle, serviceType, date, providerName) {
  if (!("Notification" in window)) return;

  const permission = Notification.permission === "default"
    ? await Notification.requestPermission()
    : Notification.permission;

  if (permission !== "granted") return;

  const dateStr = date.toLocaleDateString(getCurrentLang() === "en" ? "en-GB" : "sr-RS", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });

  const title = `🔧 ${t("schedule_title_prefix")} — ${vehicle.brand} ${vehicle.model}`;
  const body  = [
    `Tablice: ${vehicle.plate}`,
    `Tip: ${t("service_type_" + serviceType) || serviceType}`,
    `Datum: ${dateStr}`,
    providerName ? `Serviser: ${providerName}` : "",
  ].filter(Boolean).join("\n");

  if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "SHOW_NOTIFICATION",
      title,
      body,
      icon: "/icons/icon-192.png",
    });
  } else {
    new Notification(title, { body, icon: "/icons/icon-192.png" });
  }
}

export async function requestPushPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  const result = await Notification.requestPermission();
  return result === "granted";
}

// ── .ICS EXPORT ───────────────────────────────────────────────
function downloadIcs({ title, date, location, description }) {
  const fmt = (d) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const end  = new Date(date.getTime() + 60 * 60 * 1000); // +1h

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Fleet Manager//SR",
    "BEGIN:VEVENT",
    `UID:${Date.now()}@fleetmanager`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(date)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${title}`,
    location ? `LOCATION:${location}` : "",
    description ? `DESCRIPTION:${description}` : "",
    "BEGIN:VALARM",
    "TRIGGER:-PT60M",
    "ACTION:DISPLAY",
    `DESCRIPTION:Podsetnik: ${title}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");

  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `servis-${Date.now()}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}
