// ============================================================
//  companies.js  —  Fleet Manager
//  Tab: Firme (samo master admin)
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, getDocs, doc, updateDoc, deleteDoc,
  where, orderBy, serverTimestamp, getDoc
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t } from "./i18n.js";
import { S, showToast, openModal } from "./app.js";
import { mountPendingBanner } from "./pending-requests.js";

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
      const [adminsSnap, vehiclesSnap] = await Promise.all([
        getDocs(query(collection(db, "users"),
          where("companyId", "==", c.id),
          where("role", "==", "fleet_admin")
        )),
        getDocs(collection(db, "companies", c.id, "vehicles"))
      ]);
      return {
        ...c,
        admins:      adminsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
        vehicleCount: vehiclesSnap.size,
      };
    }));

    listEl.innerHTML = `
      <div class="companies-grid">
        ${enriched.map(c => companyCard(c)).join("")}
      </div>
    `;

    listEl.querySelectorAll(".btn-company-edit").forEach(btn => {
      btn.addEventListener("click", () => openEditCompanyModal(
        enriched.find(c => c.id === btn.dataset.id)
      ));
    });
    listEl.querySelectorAll(".btn-company-delete").forEach(btn => {
      btn.addEventListener("click", () => confirmDeleteCompany(btn.dataset.id, btn.dataset.name));
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
  const activeAdmins  = c.admins.filter(a => a.status === "active");
  const pendingAdmins = c.admins.filter(a => a.status === "pending");
  const blockedAdmins = c.admins.filter(a => a.status === "blocked");

  return `
    <div class="company-card">
      <div class="company-card__header">
        <div>
          <div class="company-card__name">${c.name}</div>
          <div class="company-card__pib">PIB: ${c.pib || "—"} ${c.mbr ? "| MBR: " + c.mbr : ""}</div>
        </div>
        <div class="company-card__actions">
          <button class="btn btn--ghost btn--sm btn-company-edit" data-id="${c.id}" title="${t("edit")}">✏️</button>
          <button class="btn btn--ghost btn--sm btn-company-delete" data-id="${c.id}" data-name="${c.name}" title="${t("delete")}">🗑️</button>
        </div>
      </div>

      <div class="company-card__details">
        ${c.address ? `<div class="company-detail"><span>📍</span> ${c.address}</div>` : ""}
        ${c.phone ? `<div class="company-detail"><span>📞</span> ${c.phone}</div>` : ""}
        ${c.email ? `<div class="company-detail"><span>✉️</span> ${c.email}</div>` : ""}
        ${c.instagram ? `<div class="company-detail"><span>📷</span> ${c.instagram}</div>` : ""}
        ${c.facebook ? `<div class="company-detail"><span>👥</span> ${c.facebook}</div>` : ""}
        ${c.owner ? `<div class="company-detail"><span>👤</span> ${t("company_owner")}: ${c.owner}</div>` : ""}
        ${c.director ? `<div class="company-detail"><span>💼</span> Direktor: ${c.director}</div>` : ""}
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
          ${activeAdmins.map(a => adminItem(a, false)).join("")}
        </div>
      ` : ""}

      ${blockedAdmins.length > 0 ? `
        <div class="company-card__admins">
          <div class="company-admins__title">${t("company_blocked_label")}</div>
          ${blockedAdmins.map(a => adminItem(a, true)).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function adminItem(a, isBlocked) {
  return `
    <div class="company-admin-item" data-admin-id="${a.id}">
      <span>👤 ${a.displayName || `${a.firstName || ""} ${a.lastName || ""}`.trim()}
        ${isBlocked ? `<span class="badge badge--danger" style="margin-left:6px">${t("company_blocked_badge")}</span>` : ""}
      </span>
      ${a.phone ? `<span class="company-admin-contact">📞 ${a.phone}</span>` : ""}
      ${a.email ? `<span class="company-admin-contact">✉️ ${a.email}</span>` : ""}
      <div class="company-admin-item__actions">
        <button class="btn btn--ghost btn--sm btn-admin-edit" data-id="${a.id}" title="${t("edit")}">✏️</button>
        <button class="btn btn--ghost btn--sm btn-admin-toggle-block" data-id="${a.id}" data-blocked="${isBlocked}"
          title="${isBlocked ? t("company_admin_unblock") : t("company_admin_block")}">
          ${isBlocked ? "🔓" : "🔒"}
        </button>
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
    await deleteDoc(doc(db, "users", uid));
    showToast(t("success"), "success");
    loadCompanies();
  } catch (e) {
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}
