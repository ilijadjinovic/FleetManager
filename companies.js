// ============================================================
//  companies.js  —  Fleet Manager
//  Tab: Firme (samo master admin)
// ============================================================

import { db, usernameToEmail, getSecondaryAuth } from "./firebase.js";
import {
  collection, query, getDocs, doc, updateDoc, deleteDoc, setDoc,
  where, orderBy, serverTimestamp, getDoc
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import { t } from "./i18n.js";
import { S, showToast, openModal } from "./app.js";
import { mountPendingBanner } from "./pending-requests.js";
import { normalizeServiceSettings } from "./service-status.js";

// Firme čije su kartice raširene — pamti se između ponovnog iscrtavanja liste
const openCompanyIds = new Set();

function infoRow(label, value) {
  return `
    <div class="detail-row">
      <div class="detail-row__label">${label}</div>
      <div class="detail-row__value">${value ? esc(value) : "—"}</div>
    </div>
  `;
}

export async function renderCompanies(container) {
  if (S.profile?.role !== "master_admin") {
    container.innerHTML = `<div class="empty-state"><p>${t("company_access_denied")}</p></div>`;
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">${t("tab_companies")}</h2>
    </div>

    <!-- PENDING ZAHTEVI -->
    <div id="pending-section"></div>

    <!-- LISTA FIRMI -->
    <div id="companies-list"><div class="loading">${t("loading")}</div></div>
  `;

  await Promise.all([
    mountPendingBanner(document.getElementById("pending-section"), {
      compact: false,
      onChange: loadCompanies, // posle approve/reject — refresh broja admina na karticama
    }),
    loadCompanies(),
  ]);
}

// ── LISTA FIRMI ───────────────────────────────────────────────
async function loadCompanies() {
  const listEl = document.getElementById("companies-list");
  if (!listEl) return;

  try {
    const companiesSnap = await getDocs(
      query(collection(db, "companies"), orderBy("createdAt", "desc"))
    );
    const companies = companiesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (companies.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🏢</div><p>${t("no_data")}</p></div>`;
      return;
    }

    // Za svaku firmu dohvati admins i broj vozila
    const enriched = await Promise.all(companies.map(async c => {
      const [adminsSnap, vehiclesSnap, invitesSnap] = await Promise.all([
        getDocs(query(collection(db, "users"),
          where("companyId", "==", c.id),
          where("role", "==", "fleet_admin")
        )),
        getDocs(collection(db, "companies", c.id, "vehicles")),
        getDocs(query(collection(db, "invites"), where("companyId", "==", c.id)))
          .catch(() => ({ docs: [] })),
      ]);
      return {
        ...c,
        admins:      adminsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
        invites:     invitesSnap.docs.map(d => ({ id: d.id, ...d.data() })),
        vehicleCount: vehiclesSnap.size,
      };
    }));

    listEl.innerHTML = `
      <div class="companies-grid">
        ${enriched.map(c => companyCard(c)).join("")}
      </div>
    `;

    // ── RAŠIRIVANJE KARTICE ────────────────────────────────────
    listEl.querySelectorAll(".company-card__toggle").forEach(head => {
      const toggle = () => {
        const card = head.closest(".company-card");
        if (!card) return;
        const open = card.classList.toggle("company-card--open");
        head.setAttribute("aria-expanded", String(open));
        if (open) openCompanyIds.add(card.dataset.companyId);
        else openCompanyIds.delete(card.dataset.companyId);
      };
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });

    // ── SERVISNI PODSETNIK PO FIRMI ────────────────────────────
    listEl.querySelectorAll(".btn-company-svc-save").forEach(btn => {
      btn.addEventListener("click", async () => {
        const card    = btn.closest(".company-card");
        const company = enriched.find(c => c.id === btn.dataset.id);
        if (!card || !company) return;

        const raw = (sel) => (card.querySelector(sel)?.value ?? "").trim();
        const fields = {
          intervalKm:     raw(".js-svc-interval-km"),
          intervalMonths: raw(".js-svc-interval-months"),
          alarmKm:        raw(".js-svc-alarm-km"),
          alarmDays:      raw(".js-svc-alarm-days"),
        };
        const intervalKm     = Number(fields.intervalKm);
        const intervalMonths = Number(fields.intervalMonths);
        const alarmKm        = Number(fields.alarmKm);
        const alarmDays      = Number(fields.alarmDays);

        if (Object.values(fields).some(v => v === "")
            || !(intervalKm > 0) || !(intervalMonths > 0)
            || !(alarmKm >= 0) || !(alarmDays >= 0)
            || !Number.isInteger(intervalMonths) || !Number.isInteger(alarmDays)) {
          showToast(t("svc_settings_invalid"), "error");
          return;
        }

        const serviceSettings = { intervalKm, intervalMonths, alarmKm, alarmDays };
        btn.disabled = true;
        try {
          await updateDoc(doc(db, "companies", company.id), {
            serviceSettings, updatedAt: serverTimestamp()
          });
          company.serviceSettings = serviceSettings;
          showToast(t("svc_settings_saved"), "success");
        } catch (e) {
          showToast(`${t("error")}: ${e.message}`, "error");
        } finally {
          btn.disabled = false;
        }
      });
    });

    listEl.querySelectorAll(".btn-company-edit").forEach(btn => {
      btn.addEventListener("click", () => openEditCompanyModal(
        enriched.find(c => c.id === btn.dataset.id)
      ));
    });
    listEl.querySelectorAll(".btn-company-delete").forEach(btn => {
      btn.addEventListener("click", () => confirmDeleteCompany(btn.dataset.id, btn.dataset.name));
    });
    listEl.querySelectorAll(".btn-company-add-admin").forEach(btn => {
      btn.addEventListener("click", () => openAddAdminModal(
        enriched.find(c => c.id === btn.dataset.id)
      ));
    });
    listEl.querySelectorAll(".btn-invite-delete").forEach(btn => {
      btn.addEventListener("click", () => confirmDeleteInvite(btn.dataset.email));
    });

    // ── AKCIJE NAD FLEET ADMINIMA ──────────────────────────────
    listEl.querySelectorAll(".btn-admin-edit").forEach(btn => {
      btn.addEventListener("click", () => {
        const admin = enriched.flatMap(c => c.admins).find(a => a.id === btn.dataset.id);
        if (admin) openEditAdminModal(admin);
      });
    });
    listEl.querySelectorAll(".btn-admin-toggle-block").forEach(btn => {
      btn.addEventListener("click", () => {
        const isBlocked = btn.dataset.blocked === "true";
        toggleBlockAdmin(btn.dataset.id, isBlocked);
      });
    });
    listEl.querySelectorAll(".btn-admin-delete").forEach(btn => {
      btn.addEventListener("click", () => confirmDeleteAdmin(btn.dataset.id, btn.dataset.name));
    });

  } catch (e) {
    listEl.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

function companyCard(c) {
  const activeAdmins   = c.admins.filter(a => a.status === "active" || !a.status);
  const pendingAdmins  = c.admins.filter(a => a.status === "pending");
  const blockedAdmins  = c.admins.filter(a => a.status === "blocked");
  const rejectedAdmins = c.admins.filter(a => a.status === "rejected");
  const invites        = c.invites || [];

  const isOpen = openCompanyIds.has(c.id);
  const svc    = normalizeServiceSettings(c.serviceSettings);

  return `
    <div class="company-card ${isOpen ? "company-card--open" : ""}" data-company-id="${c.id}">
      <div class="company-card__header company-card__toggle" role="button" tabindex="0" aria-expanded="${isOpen}">
        <div>
          <div class="company-card__name">${esc(c.name)}</div>
          <div class="company-card__pib">PIB: ${esc(c.pib) || "—"} ${c.mbr ? "| MBR: " + esc(c.mbr) : ""}</div>
        </div>
        <div class="company-card__summary">
          <span title="${t("company_vehicles_label")}">🚗 ${c.vehicleCount}</span>
          <span title="${t("company_fleet_admins_label")}">👤 ${activeAdmins.length}</span>
          ${pendingAdmins.length > 0 ? `<span title="${t("company_pending_label")}" style="color:var(--color-warning)">⏳ ${pendingAdmins.length}</span>` : ""}
          ${blockedAdmins.length > 0 ? `<span title="${t("company_blocked_label")}" style="color:var(--color-danger)">🔒 ${blockedAdmins.length}</span>` : ""}
          <span class="company-card__chevron">▾</span>
        </div>
      </div>

      <div class="company-card__body">
        <div class="company-card__toolbar">
          <button class="btn btn--secondary btn--sm btn-company-add-admin" data-id="${c.id}">➕👤 ${t("company_add_admin")}</button>
          <button class="btn btn--secondary btn--sm btn-company-edit" data-id="${c.id}">✏️ ${t("edit")}</button>
          <button class="btn btn--danger btn--sm btn-company-delete" data-id="${c.id}" data-name="${esc(c.name)}">🗑️ ${t("delete")}</button>
        </div>

        <div class="company-card__section">
          <div class="company-admins__title">${t("company_section_info")}</div>
          <div class="detail-table">
            ${infoRow(t("company_pib"), c.pib)}
            ${infoRow(t("company_mbr"), c.mbr)}
            ${infoRow(t("company_owner"), c.owner)}
            ${infoRow(t("company_director"), c.director)}
            ${infoRow(t("company_address"), c.address)}
            ${infoRow(t("company_phone"), c.phone)}
            ${infoRow(t("company_email"), c.email)}
            ${infoRow(t("company_instagram"), c.instagram)}
            ${infoRow(t("company_facebook"), c.facebook)}
          </div>
        </div>

        <div class="company-card__section">
          <div class="company-admins__title">🔧 ${t("svc_settings_section")}</div>
          <p class="form-hint">${t("svc_settings_hint")}</p>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">${t("svc_settings_interval_km")}</label>
              <input class="form-input js-svc-interval-km" type="number" min="1" value="${svc.intervalKm}" />
            </div>
            <div class="form-group">
              <label class="form-label">${t("svc_settings_interval_months")}</label>
              <input class="form-input js-svc-interval-months" type="number" min="1" value="${svc.intervalMonths}" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">${t("svc_settings_alarm_km")}</label>
              <input class="form-input js-svc-alarm-km" type="number" min="0" value="${svc.alarmKm}" />
            </div>
            <div class="form-group">
              <label class="form-label">${t("svc_settings_alarm_days")}</label>
              <input class="form-input js-svc-alarm-days" type="number" min="0" value="${svc.alarmDays}" />
            </div>
          </div>
          <div>
            <button class="btn btn--primary btn--sm btn-company-svc-save" data-id="${c.id}">${t("svc_settings_save")}</button>
          </div>
        </div>

        <div class="company-card__stats">
          <div class="company-stat">
            <span class="company-stat__value">${c.vehicleCount}</span>
            <span class="company-stat__label">${t("company_vehicles_label")}</span>
          </div>
          <div class="company-stat">
            <span class="company-stat__value">${activeAdmins.length}</span>
            <span class="company-stat__label">${t("company_fleet_admins_label")}</span>
          </div>
          ${pendingAdmins.length > 0 ? `
            <div class="company-stat">
              <span class="company-stat__value" style="color:var(--color-warning)">${pendingAdmins.length}</span>
              <span class="company-stat__label">${t("company_pending_label")}</span>
            </div>
          ` : ""}
          ${blockedAdmins.length > 0 ? `
            <div class="company-stat">
              <span class="company-stat__value" style="color:var(--color-danger)">${blockedAdmins.length}</span>
              <span class="company-stat__label">${t("company_blocked_label")}</span>
            </div>
          ` : ""}
        </div>

      ${activeAdmins.length > 0 ? `
        <div class="company-card__admins">
          <div class="company-admins__title">${t("company_fleet_admins_title")}</div>
          ${activeAdmins.map(a => adminItem(a, "active")).join("")}
        </div>
      ` : ""}

      ${blockedAdmins.length > 0 ? `
        <div class="company-card__admins">
          <div class="company-admins__title">${t("company_blocked_label")}</div>
          ${blockedAdmins.map(a => adminItem(a, "blocked")).join("")}
        </div>
      ` : ""}

      ${rejectedAdmins.length > 0 ? `
        <div class="company-card__admins">
          <div class="company-admins__title">${t("company_rejected_label")}</div>
          ${rejectedAdmins.map(a => adminItem(a, "rejected")).join("")}
        </div>
      ` : ""}

      ${invites.length > 0 ? `
        <div class="company-card__admins">
          <div class="company-admins__title">${t("company_invites_title")}</div>
          ${invites.map(inviteItem).join("")}
        </div>
      ` : ""}
      </div>
    </div>
  `;
}

// state: "active" | "blocked" | "rejected"
function adminItem(a, state) {
  const isBlocked  = state === "blocked";
  const isRejected = state === "rejected";
  return `
    <div class="company-admin-item" data-admin-id="${a.id}">
      <span>👤 ${a.displayName || `${a.firstName || ""} ${a.lastName || ""}`.trim()}
        ${isBlocked ? `<span class="badge badge--danger" style="margin-left:6px">${t("company_blocked_badge")}</span>` : ""}
        ${isRejected ? `<span class="badge badge--danger" style="margin-left:6px">${t("company_rejected_badge")}</span>` : ""}
      </span>
      ${a.phone ? `<span class="company-admin-contact">📞 ${a.phone}</span>` : ""}
      ${a.email ? `<span class="company-admin-contact">✉️ ${a.email}</span>` : ""}
      <div class="company-admin-item__actions">
        ${isRejected ? "" : `
        <button class="btn btn--ghost btn--sm btn-admin-edit" data-id="${a.id}" title="${t("edit")}">✏️</button>
        <button class="btn btn--ghost btn--sm btn-admin-toggle-block" data-id="${a.id}" data-blocked="${isBlocked}"
          title="${isBlocked ? t("company_admin_unblock") : t("company_admin_block")}">
          ${isBlocked ? "🔓" : "🔒"}
        </button>`}
        <button class="btn btn--ghost btn--sm btn-admin-delete" data-id="${a.id}"
          data-name="${a.displayName || `${a.firstName || ""} ${a.lastName || ""}`.trim()}" title="${t("delete")}">🗑️</button>
      </div>
    </div>
  `;
}

// ── EDIT MODAL ────────────────────────────────────────────────
function openEditCompanyModal(company) {
  const c = company;
  const bodyHTML = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Naziv firme *</label>
        <input id="ec-name" class="form-input" type="text" value="${c.name || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">PIB</label>
        <input id="ec-pib" class="form-input" type="text" value="${c.pib || ""}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">MBR</label>
        <input id="ec-mbr" class="form-input" type="text" value="${c.mbr || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">Vlasnik</label>
        <input id="ec-owner" class="form-input" type="text" value="${c.owner || ""}" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("company_director")}</label>
      <input id="ec-director" class="form-input" type="text" value="${c.director || ""}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("company_address")}</label>
      <input id="ec-address" class="form-input" type="text" value="${c.address || ""}" />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Telefon</label>
        <input id="ec-phone" class="form-input" type="tel" value="${c.phone || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input id="ec-email" class="form-input" type="email" value="${c.email || ""}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Instagram</label>
        <input id="ec-instagram" class="form-input" type="text" value="${c.instagram || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">Facebook</label>
        <input id="ec-facebook" class="form-input" type="text" value="${c.facebook || ""}" />
      </div>
    </div>
  `;

  openModal(`${t("edit")}: ${c.name}`, bodyHTML, async () => {
    const name = document.getElementById("ec-name")?.value.trim();
    if (!name) return;
    try {
      await updateDoc(doc(db, "companies", c.id), {
        name,
        pib:      document.getElementById("ec-pib")?.value.trim() || null,
        mbr:      document.getElementById("ec-mbr")?.value.trim() || null,
        owner:    document.getElementById("ec-owner")?.value.trim() || null,
        director: document.getElementById("ec-director")?.value.trim() || null,
        address:  document.getElementById("ec-address")?.value.trim() || null,
        phone:    document.getElementById("ec-phone")?.value.trim() || null,
        email:    document.getElementById("ec-email")?.value.trim() || null,
        instagram:document.getElementById("ec-instagram")?.value.trim() || null,
        facebook: document.getElementById("ec-facebook")?.value.trim() || null,
        updatedAt: serverTimestamp(),
      });
      showToast(t("success"), "success");
      loadCompanies();
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
    }
  });
}

// ── BRISANJE FIRME ────────────────────────────────────────────
async function confirmDeleteCompany(id, name) {
  if (!confirm(`${t("company_delete_confirm")} "${name}"?`)) return;
  try {
    await deleteDoc(doc(db, "companies", id));
    openCompanyIds.delete(id);
    showToast(t("success"), "success");
    loadCompanies();
  } catch (e) {
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

// ── IZMENA FLEET ADMINA ────────────────────────────────────────
function openEditAdminModal(admin) {
  const a = admin;
  const bodyHTML = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Ime</label>
        <input id="ea-firstName" class="form-input" type="text" value="${a.firstName || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">Prezime</label>
        <input id="ea-lastName" class="form-input" type="text" value="${a.lastName || ""}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Telefon</label>
        <input id="ea-phone" class="form-input" type="tel" value="${a.phone || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("driver_email")} (kontakt)</label>
        <input id="ea-email" class="form-input" type="email" value="${a.email || ""}" />
      </div>
    </div>
    <p class="form-hint">${t("company_admin_google_hint")}</p>
  `;

  openModal(`${t("edit")}: ${a.displayName || a.firstName}`, bodyHTML, async () => {
    const firstName = document.getElementById("ea-firstName")?.value.trim();
    const lastName  = document.getElementById("ea-lastName")?.value.trim();
    if (!firstName || !lastName) return;
    try {
      await updateDoc(doc(db, "users", a.id), {
        firstName,
        lastName,
        displayName: `${firstName} ${lastName}`,
        phone: document.getElementById("ea-phone")?.value.trim() || null,
        email: document.getElementById("ea-email")?.value.trim() || null,
        updatedAt: serverTimestamp(),
      });
      showToast(t("success"), "success");
      loadCompanies();
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
    }
  });
}

// ── BLOKIRANJE / ODBLOKIRANJE FLEET ADMINA ─────────────────────
// Privremena mera — profil i sve veze (firma, istorija) ostaju netaknuti.
// Blokirani korisnik biva odmah izbačen na sledeći auth-state okidač
// (app.js proverava status === "blocked").
async function toggleBlockAdmin(uid, isCurrentlyBlocked) {
  const action = isCurrentlyBlocked ? t("company_admin_unblock") : t("company_admin_block");
  if (!confirm(`${action}?`)) return;
  try {
    await updateDoc(doc(db, "users", uid), {
      status: isCurrentlyBlocked ? "active" : "blocked",
      updatedAt: serverTimestamp(),
    });
    showToast(t("success"), "success");
    loadCompanies();
  } catch (e) {
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

// ── TRAJNO BRISANJE FLEET ADMINA ───────────────────────────────
// Briše samo Firestore profil (users/{uid}). Google Auth nalog fizički
// ostaje (klijentski SDK ne može da obriše tuđi Auth nalog bez Cloud
// Function/Admin SDK-a) — osoba može ponovo da se registruje od nule.
async function confirmDeleteAdmin(uid, name) {
  if (!confirm(`${t("company_admin_delete_confirm")} "${name}"?\n\n${t("company_admin_delete_note")}`)) return;
  try {
    // Ako je admin imao korisničko ime, ukloni i njegov unos iz indeksa
    let username = null;
    try {
      const snap = await getDoc(doc(db, "users", uid));
      username = snap.exists() ? snap.data().username || null : null;
    } catch (_) { /* nastavi bez čišćenja indeksa */ }

    await deleteDoc(doc(db, "users", uid));
    if (username) {
      try { await deleteDoc(doc(db, "usernameIndex", username)); } catch (_) { /* ignoriši */ }
    }
    showToast(t("success"), "success");
    loadCompanies();
  } catch (e) {
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}


// ── POZIVNICE (prikaz i brisanje) ──────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function inviteItem(inv) {
  const name = `${inv.firstName || ""} ${inv.lastName || ""}`.trim();
  return `
    <div class="company-admin-item">
      <span>✉️ ${esc(inv.email || inv.id)}
        <span class="badge badge--service badge--inline">${t("company_pending_label")}</span>
      </span>
      ${name ? `<span class="company-admin-contact">👤 ${esc(name)}</span>` : ""}
      <div class="company-admin-item__actions">
        <button class="btn btn--ghost btn--sm btn-invite-delete" data-email="${esc(inv.id)}" title="${t("delete")}">🗑️</button>
      </div>
    </div>
  `;
}

async function confirmDeleteInvite(email) {
  if (!confirm(`${t("company_invite_delete_confirm")} "${email}"?`)) return;
  try {
    await deleteDoc(doc(db, "invites", email));
    showToast(t("success"), "success");
    loadCompanies();
  } catch (e) {
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

// ── DODAVANJE FLEET ADMINA ZA ODREĐENU FIRMU (master admin) ────
// Dva načina:
//  • "google" — pravi se poziv invites/{email}; osoba se prvi put prijavi
//    Google nalogom sa tom adresom i odmah je aktivan fleet_admin firme.
//  • "local"  — pravi se Auth nalog (korisničko ime + lozinka), za osobu
//    bez Google naloga; ne treba prava email adresa.
function openAddAdminModal(company) {
  if (!company) return;

  const bodyHTML = `
    <div class="form-group">
      <label class="form-label">${t("company_admin_login_mode")}</label>
      <select id="na-mode" class="form-input">
        <option value="google">${t("company_admin_mode_google")}</option>
        <option value="local">${t("company_admin_mode_local")}</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("profile_first_name")} *</label>
        <input id="na-firstName" class="form-input" type="text" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("profile_last_name")} *</label>
        <input id="na-lastName" class="form-input" type="text" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("driver_phone")}</label>
      <input id="na-phone" class="form-input" type="tel" />
    </div>

    <div id="na-google">
      <div class="form-group">
        <label class="form-label">${t("company_admin_google_email")}</label>
        <input id="na-email" class="form-input" type="email" placeholder="ime@gmail.com" />
      </div>
      <p class="form-hint">${t("company_admin_invite_hint")}</p>
    </div>

    <div id="na-local" class="hidden">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${t("company_admin_username")}</label>
          <input id="na-username" class="form-input" type="text" autocomplete="off" />
        </div>
        <div class="form-group">
          <label class="form-label">${t("company_admin_password")}</label>
          <input id="na-password" class="form-input" type="text" autocomplete="off" />
        </div>
      </div>
      <p class="form-hint">${t("company_admin_local_hint")}</p>
    </div>
  `;

  openModal(`${t("company_add_admin_title")}: ${company.name || ""}`, bodyHTML, async () => {
    const val = id => document.getElementById(id)?.value.trim() || "";
    const mode      = document.getElementById("na-mode")?.value || "google";
    const firstName = val("na-firstName");
    const lastName  = val("na-lastName");
    const phone     = val("na-phone") || null;

    if (!firstName || !lastName) {
      showToast(t("required_field"), "warning");
      return false;
    }

    try {
      if (mode === "google") {
        return await createAdminInvite(company, {
          firstName, lastName, phone, email: val("na-email").toLowerCase(),
        });
      }
      return await createLocalAdmin(company, {
        firstName, lastName, phone,
        username: val("na-username").toLowerCase(),
        password: document.getElementById("na-password")?.value || "",
      });
    } catch (e) {
      console.error("Dodavanje fleet admina:", e);
      showToast(`${t("error")}: ${e.message}`, "error");
      return false;
    }
  });

  const modeEl = document.getElementById("na-mode");
  modeEl?.addEventListener("change", () => {
    const local = modeEl.value === "local";
    document.getElementById("na-google")?.classList.toggle("hidden", local);
    document.getElementById("na-local")?.classList.toggle("hidden", !local);
  });
}

async function createAdminInvite(company, { firstName, lastName, phone, email }) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast(t("company_admin_email_invalid"), "warning");
    return false;
  }

  // Osoba već ima nalog (npr. čeka odobrenje) — poziv nema smisla
  const existing = await getDocs(query(collection(db, "users"), where("googleEmail", "==", email)));
  if (!existing.empty) {
    showToast(t("company_admin_exists"), "warning");
    return false;
  }

  const inviteRef = doc(db, "invites", email);
  const oldInvite = await getDoc(inviteRef);
  if (oldInvite.exists() && oldInvite.data().companyId !== company.id) {
    showToast(t("company_admin_invited_other"), "warning");
    return false;
  }

  await setDoc(inviteRef, {
    email,
    role:        "fleet_admin",
    companyId:   company.id,
    companyName: company.name || null,
    firstName,
    lastName,
    phone,
    invitedBy:   S.user.uid,
    createdAt:   serverTimestamp(),
  });

  showToast(t("company_admin_invite_created"), "success");
  loadCompanies();
  return true;
}

async function createLocalAdmin(company, { firstName, lastName, phone, username, password }) {
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
    showToast(t("company_admin_username_invalid"), "warning");
    return false;
  }
  if (password.length < 6) {
    showToast(t("driver_password_min").replace("{0}", password.length), "warning");
    return false;
  }
  if ((await getDoc(doc(db, "usernameIndex", username))).exists()) {
    showToast(t("company_admin_username_taken"), "warning");
    return false;
  }

  const authEmail     = usernameToEmail(username);
  const secondaryAuth = getSecondaryAuth();   // master ostaje prijavljen
  const undo = [];

  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, authEmail, password);
    undo.push(() => cred.user.delete());
    const uid = cred.user.uid;

    await setDoc(doc(db, "users", uid), {
      role:        "fleet_admin",
      status:      "active",
      companyId:   company.id,
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`,
      phone,
      email:       null,
      username,
      googleEmail: null,
      createdAt:   serverTimestamp(),
      createdBy:   S.user.uid,
      approvedAt:  serverTimestamp(),
      approvedBy:  S.user.uid,
    });
    undo.push(() => deleteDoc(doc(db, "users", uid)));

    await setDoc(doc(db, "usernameIndex", username), {
      authEmail,
      companyId: company.id,
      updatedAt: serverTimestamp(),
    });
  } catch (e) {
    for (const fn of undo.reverse()) {
      try { await fn(); } catch (rb) { console.warn("rollback:", rb?.code); }
    }
    try { await secondaryAuth.signOut(); } catch (_) { /* ignoriši */ }
    if (e.code === "auth/email-already-in-use") {
      showToast(t("company_admin_username_taken"), "warning");
      return false;
    }
    throw e;
  }

  try { await secondaryAuth.signOut(); } catch (_) { /* ignoriši */ }
  showToast(t("company_admin_created"), "success");
  loadCompanies();

  // openModal zatvara modal čim ovaj tok vrati true — kredencijale prikaži posle toga
  setTimeout(() => showAdminCredentials(`${firstName} ${lastName}`, username, password), 50);
  return true;
}

function showAdminCredentials(fullName, username, password) {
  const bodyHTML = `
    <div class="password-reveal">
      <div class="password-reveal__icon">🔐</div>
      <p class="password-reveal__msg" id="cred-name"></p>
      <div class="password-reveal__field">
        <span class="password-reveal__label">${t("login_username")}</span>
        <span class="password-reveal__value" id="cred-username"></span>
        <button class="btn btn--ghost btn--sm" id="cred-copy-username">📋</button>
      </div>
      <div class="password-reveal__field">
        <span class="password-reveal__label">${t("login_password")}</span>
        <span class="password-reveal__value" id="cred-password"></span>
        <button class="btn btn--ghost btn--sm" id="cred-copy-password">📋</button>
      </div>
      <div class="password-reveal__warning">⚠️ ${t("company_admin_credentials_note")}</div>
    </div>
  `;
  openModal(t("company_admin_credentials_title"), bodyHTML, null);
  document.getElementById("cred-name").textContent     = fullName;
  document.getElementById("cred-username").textContent = username;
  document.getElementById("cred-password").textContent = password;
  document.getElementById("cred-copy-username")?.addEventListener("click", () => navigator.clipboard?.writeText(username));
  document.getElementById("cred-copy-password")?.addEventListener("click", () => navigator.clipboard?.writeText(password));
  const cancelBtn = document.getElementById("modal-cancel");
  if (cancelBtn) cancelBtn.textContent = t("driver_credentials_close");
}
