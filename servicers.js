// ============================================================
//  servicers.js  —  Fleet Manager
//  Tab: Serviseri — lista servisa sa kojima kompanija sarađuje
// ============================================================

import { db } from "./firebase.js";
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc,
  doc, orderBy, query, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t } from "./i18n.js";
import { S, showToast, openModal } from "./app.js";

let allServicers = [];

const esc = (v) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── GLAVNI RENDER ─────────────────────────────────────────────
export async function renderServicers(container) {
  if (!S.companyId) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🏢</div><p>${t("company_select")}</p></div>`;
    return;
  }

  const canEdit = S.profile?.role === "master_admin" || S.profile?.role === "fleet_admin";

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">🔧 ${t("tab_servicers")}</h2>
      ${canEdit ? `<button id="btn-add-servicer" class="btn btn--primary btn--sm">+ ${t("servicer_add")}</button>` : ""}
    </div>
    <div id="servicers-list"><div class="loading">${t("loading")}</div></div>
  `;

  if (canEdit) {
    document.getElementById("btn-add-servicer")?.addEventListener("click", () => openServicerForm());
  }

  await loadServicers();
}

// ── UČITAJ SERVISERE ──────────────────────────────────────────
async function loadServicers() {
  try {
    const snap = await getDocs(
      query(collection(db, "companies", S.companyId, "serviceProviders"), orderBy("name", "asc"))
    );
    allServicers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
  } catch (e) {
    document.getElementById("servicers-list").innerHTML =
      `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

function renderList() {
  const list = document.getElementById("servicers-list");
  if (!list) return;
  const canEdit = S.profile?.role === "master_admin" || S.profile?.role === "fleet_admin";

  if (allServicers.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">🔧</div>
        <p>${t("servicer_no_data")}</p>
      </div>`;
    return;
  }

  list.innerHTML = `
    <div class="servicer-list">
      ${allServicers.map(s => `
        <div class="servicer-card" data-id="${s.id}">
          <div class="servicer-card__header">
            <div class="servicer-card__name">🔧 ${s.name}</div>
            ${canEdit ? `
              <div class="servicer-card__actions">
                <button class="btn btn--icon btn-edit-servicer" data-id="${s.id}" title="Izmeni">✏️</button>
                <button class="btn btn--icon btn-delete-servicer" data-id="${s.id}" title="${t('delete')}">🗑️</button>
              </div>` : ""}
          </div>
          <div class="servicer-card__details">
            ${s.address ? `<div class="servicer-detail"><span>📍</span> ${s.address}</div>` : ""}
            ${s.phone ? `<div class="servicer-detail"><span>📞</span> <a href="tel:${s.phone}">${s.phone}</a></div>` : ""}
            ${s.email ? `<div class="servicer-detail"><span>✉️</span> <a href="mailto:${s.email}">${s.email}</a></div>` : ""}
            ${s.pib ? `<div class="servicer-detail"><span>🧾</span> ${t("servicer_pib")}: ${s.pib}</div>` : ""}
            ${s.mbr ? `<div class="servicer-detail"><span>🏢</span> ${t("servicer_mbr")}: ${s.mbr}</div>` : ""}
            ${s.account ? `<div class="servicer-detail"><span>💳</span> ${s.account}</div>` : ""}
            ${s.notes ? `<div class="servicer-detail servicer-detail--notes"><span>📝</span> ${s.notes}</div>` : ""}
          </div>
        </div>
      `).join("")}
    </div>
  `;

  // Event listeneri
  list.querySelectorAll(".btn-edit-servicer").forEach(btn => {
    btn.addEventListener("click", () => {
      const s = allServicers.find(x => x.id === btn.dataset.id);
      if (s) openServicerForm(s);
    });
  });

  list.querySelectorAll(".btn-delete-servicer").forEach(btn => {
    btn.addEventListener("click", () => deleteServicer(btn.dataset.id));
  });
}

// ── FORMA ZA UNOS/EDIT ────────────────────────────────────────
// opts.prefill: početne vrednosti za NOVOG servisera (npr. sa skeniranog računa)
// opts.onSaved(id, data): poziva se posle uspešnog snimanja
export function openServicerForm(servicer = null, opts = {}) {
  const isEdit = !!servicer;
  const s = servicer || opts.prefill || {};

  const bodyHTML = `
    <div class="form-grid">
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">${t("servicer_name")}</label>
        <input id="sf-name" class="form-input" type="text" value="${esc(s.name)}" placeholder="${t("servicer_name")}" />
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">${t("servicer_address")}</label>
        <input id="sf-address" class="form-input" type="text" value="${esc(s.address)}" placeholder="Ulica i broj, grad" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("servicer_phone")}</label>
        <input id="sf-phone" class="form-input" type="tel" value="${esc(s.phone)}" placeholder="+381..." />
      </div>
      <div class="form-group">
        <label class="form-label">${t("servicer_email")}</label>
        <input id="sf-email" class="form-input" type="email" value="${esc(s.email)}" placeholder="servis@example.com" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("servicer_pib")}</label>
        <input id="sf-pib" class="form-input" type="text" value="${esc(s.pib)}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("servicer_mbr")}</label>
        <input id="sf-mbr" class="form-input" type="text" value="${esc(s.mbr)}" />
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">${t("servicer_account")}</label>
        <input id="sf-account" class="form-input" type="text" value="${esc(s.account)}" placeholder="160-..." />
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">${t("notes")}</label>
        <textarea id="sf-notes" class="form-input form-textarea" rows="2">${esc(s.notes)}</textarea>
      </div>
    </div>
    <p id="servicer-form-error" class="login-error hidden"></p>
  `;

  openModal(
    isEdit ? `${t("edit")}: ${s.name}` : t("servicer_add"),
    bodyHTML,
    async () => {
      const name = document.getElementById("sf-name")?.value.trim();
      if (!name) {
        document.getElementById("servicer-form-error").textContent = t("servicer_name_required");
        document.getElementById("servicer-form-error").classList.remove("hidden");
        throw new Error("validation");
      }

      const data = {
        name,
        address: document.getElementById("sf-address")?.value.trim() || null,
        phone:   document.getElementById("sf-phone")?.value.trim() || null,
        email:   document.getElementById("sf-email")?.value.trim() || null,
        pib:     document.getElementById("sf-pib")?.value.trim() || null,
        mbr:     document.getElementById("sf-mbr")?.value.trim() || null,
        account: document.getElementById("sf-account")?.value.trim() || null,
        notes:   document.getElementById("sf-notes")?.value.trim() || null,
      };

      let newId = null;
      if (isEdit) {
        await updateDoc(doc(db, "companies", S.companyId, "serviceProviders", servicer.id), {
          ...data, updatedAt: serverTimestamp()
        });
      } else {
        newId = (await addDoc(collection(db, "companies", S.companyId, "serviceProviders"), {
          ...data, createdAt: serverTimestamp()
        })).id;
      }

      showToast(t("success"), "success");
      // Lista servisera postoji na ekranu samo kad je otvoren tab "Serviseri"
      if (document.getElementById("servicers-list")) await loadServicers();
      if (opts.onSaved) await opts.onSaved(isEdit ? servicer.id : newId, data);
    }
  );
}

// ── BRISANJE ──────────────────────────────────────────────────
async function deleteServicer(id) {
  const s = allServicers.find(x => x.id === id);
  if (!s) return;

  const bodyHTML = `<p>${t("servicer_delete_confirm")} <strong>${s.name}</strong>?</p>`;
  openModal(t("delete") + " " + t("tab_servicers").toLowerCase(), bodyHTML, async () => {
    await deleteDoc(doc(db, "companies", S.companyId, "serviceProviders", id));
    showToast(t("servicer_deleted"), "success");
    await loadServicers();
  });
}

// ── EXPORT ZA OSTALE MODULE ───────────────────────────────────
export async function getServiceProviders() {
  if (!S.companyId) return [];
  try {
    const snap = await getDocs(
      query(collection(db, "companies", S.companyId, "serviceProviders"), orderBy("name", "asc"))
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    return [];
  }
}
