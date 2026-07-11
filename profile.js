// ============================================================
//  profile.js  —  Fleet Manager
//  Tab: Profil — podaci korisnika, podešavanja, jezik
// ============================================================

import { db, auth, logout, linkLocalCredential } from "./firebase.js";
import {
  doc, getDoc, updateDoc, serverTimestamp, collection, getDocs, query, where
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t, loadLanguage, getCurrentLang, SUPPORTED_LANGS } from "./i18n.js";
import { S, showToast, openModal, buildNav, rerenderCurrentTab } from "./app.js";

// ── GLAVNI RENDER ─────────────────────────────────────────────
export async function renderProfile(container) {
  const profile = S.profile;
  const user    = S.user;
  if (!profile || !user) return;

  const role        = profile.role;
  const isDriver    = role === "driver";
  const isFleetAdmin= role === "fleet_admin";
  const isMaster    = role === "master_admin";

  // Dohvati podatke o firmi
  let company = null;
  if (S.companyId) {
    try {
      const snap = await getDoc(doc(db, "companies", S.companyId));
      if (snap.exists()) company = { id: snap.id, ...snap.data() };
    } catch (e) { /* ignoriši */ }
  }

  // Dohvati driver dokument ako je vozač
  let driverDoc = null;
  if (isDriver && profile.driverId) {
    try {
      const snap = await getDoc(doc(db, "companies", S.companyId, "drivers", profile.driverId));
      if (snap.exists()) driverDoc = { id: snap.id, ...snap.data() };
    } catch (e) { /* ignoriši */ }
  }

  const displayName = profile.displayName
    || `${profile.firstName || ""} ${profile.lastName || ""}`.trim()
    || user.displayName
    || user.email;

  const initials = displayName
    .split(" ").slice(0, 2).map(w => w[0] || "").join("").toUpperCase() || "?";

  container.innerHTML = `
    <!-- PROFIL HEADER -->
    <div class="profile-header">
      <div class="profile-avatar">${initials}</div>
      <div class="profile-header__info">
        <div class="profile-header__name">${displayName}</div>
        <div class="profile-header__role">
          <span class="badge badge--info">${t("role_" + role)}</span>
          ${company ? `<span class="profile-header__company">🏢 ${company.name}</span>` : ""}
        </div>
        <div class="profile-header__email">${user.email || ""}</div>
      </div>
    </div>

    <!-- TABOVI -->
    <div class="tab-strip" id="profile-tabs">
      <button class="tab-strip__btn tab-strip__btn--active" data-ptab="info">${t("profile_my_data")}</button>
      ${company ? `<button class="tab-strip__btn" data-ptab="company">${t("profile_company_tab")}</button>` : ""}
      <button class="tab-strip__btn" data-ptab="settings">${t("profile_settings_tab")}</button>
    </div>

    <div id="profile-tab-content"></div>
  `;

  document.getElementById("profile-tabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-strip__btn");
    if (!btn) return;
    document.querySelectorAll(".tab-strip__btn").forEach(b => b.classList.remove("tab-strip__btn--active"));
    btn.classList.add("tab-strip__btn--active");
    renderProfileTab(btn.dataset.ptab, { profile, user, company, driverDoc, role });
  });

  renderProfileTab("info", { profile, user, company, driverDoc, role });
}

// ── TABOVI ────────────────────────────────────────────────────
function renderProfileTab(tab, ctx) {
  const content = document.getElementById("profile-tab-content");
  if (!content) return;
  switch (tab) {
    case "info":     content.innerHTML = renderInfoTab(ctx); bindInfoTab(ctx); break;
    case "company":  content.innerHTML = renderCompanyTab(ctx); bindCompanyTab(ctx); break;
    case "settings": content.innerHTML = renderSettingsTab(ctx); bindSettingsTab(ctx); break;
  }
}

// ── TAB: MOJI PODACI ──────────────────────────────────────────
function renderInfoTab({ profile, user, driverDoc, role }) {
  const p = driverDoc || profile;
  const isLocalLogin = !!profile.username;
  const isGoogleLogin = !!user.providerData?.find(pd => pd.providerId === "google.com");

  return `
    <div class="profile-section">
      <div class="profile-section__header">
        <h3 class="profile-section__title">${t("profile_personal_section")}</h3>
        <button class="btn btn--secondary btn--sm" id="btn-edit-profile">✏️ Izmeni</button>
      </div>
      <div class="detail-table">
        ${row(t("profile_first_name"), p.firstName)}
        ${row(t("profile_last_name"), p.lastName)}
        ${p.jmbg ? row("JMBG", p.jmbg) : ""}
        ${p.birthYear ? row(t("driver_birth_year"), p.birthYear) : ""}
        ${p.licenseCategories ? row(t("driver_license_cat"), p.licenseCategories) : ""}
        ${p.position ? row(t("driver_position"), p.position) : ""}
        ${p.phone ? row(t("driver_phone"), p.phone) : ""}
        ${p.email ? row(t("driver_email"), p.email) : ""}
        ${p.homeAddress ? row(t("driver_home_address"), p.homeAddress) : ""}
        ${p.workAddress ? row(t("driver_work_address"), p.workAddress) : ""}
      </div>
    </div>

    <div class="profile-section">
      <div class="profile-section__header">
        <h3 class="profile-section__title">${t("profile_login_section")}</h3>
      </div>
      <div class="login-methods">
        <div class="login-method ${isGoogleLogin ? "login-method--active" : "login-method--inactive"}">
          <span class="login-method__icon">G</span>
          <div class="login-method__info">
            <span class="login-method__label">${t("profile_google_login")}</span>
            <span class="login-method__value">${isGoogleLogin ? user.email : t("profile_not_connected")}</span>
          </div>
          <span class="badge badge--${isGoogleLogin ? "active" : "inactive"}">
            ${isGoogleLogin ? t("profile_active_badge") : "—"}
          </span>
        </div>
        <div class="login-method ${isLocalLogin ? "login-method--active" : "login-method--inactive"}">
          <span class="login-method__icon">UN</span>
          <div class="login-method__info">
            <span class="login-method__label">${t("profile_local_login")}</span>
            <span class="login-method__value">${isLocalLogin ? profile.username : t("profile_not_set")}</span>
          </div>
          <span class="badge badge--${isLocalLogin ? "active" : "inactive"}">
            ${isLocalLogin ? t("profile_active_badge") : "—"}
          </span>
        </div>
      </div>
    </div>

    <div class="profile-section">
      <div class="about-card">
        <div class="about-card__title">${t("about_title")}</div>
        <div class="about-card__author">
          <div class="about-card__avatar">ИЂ</div>
          <div>
            <div class="about-card__name">Ilija Đinović, d.i.e.</div>
            <div class="about-card__role">${t("about_role")}</div>
          </div>
        </div>
        <div class="about-card__divider"></div>
        <div class="about-card__row"><img src="assets/icon-192.png" alt="" class="about-card__icon" /> <span>Fleet Manager v1.0</span></div>
        <div class="about-card__row">🏢 <span>Biro za veštačenja</span></div>
        <div class="about-card__row">✉️ <span>info@bzv.rs</span></div>
        <div class="about-card__row">🌐 <a href="https://www.bzv.rs" target="_blank" rel="noopener">www.bzv.rs</a></div>
        <div class="about-card__row">📞 <span>+381(0)62303303</span></div>
      </div>
    </div>

    <div class="profile-section">
      <button class="btn btn--danger btn--sm" id="btn-logout-profile">🚪 ${t("logout")}</button>
    </div>
  `;
}

function bindInfoTab({ profile, user, driverDoc, role }) {
  document.getElementById("btn-logout-profile")?.addEventListener("click", async () => {
    await logout();
  });

  document.getElementById("btn-edit-profile")?.addEventListener("click", () => {
    openEditProfileModal(profile, driverDoc);
  });
}

function openEditProfileModal(profile, driverDoc) {
  const p = driverDoc || profile;
  // Vozač može da menja samo kontakt podatke, ne username/password
  const isDriver = profile.role === "driver";

  const bodyHTML = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Ime</label>
        <input id="ep-firstName" class="form-input" type="text" value="${p.firstName || ""}"
          ${isDriver ? "readonly" : ""} />
      </div>
      <div class="form-group">
        <label class="form-label">Prezime</label>
        <input id="ep-lastName" class="form-input" type="text" value="${p.lastName || ""}"
          ${isDriver ? "readonly" : ""} />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">${t("driver_phone")}</label>
        <input id="ep-phone" class="form-input" type="tel" value="${p.phone || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("driver_email")}</label>
        <input id="ep-email" class="form-input" type="email" value="${p.email || ""}" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("driver_home_address")}</label>
      <input id="ep-homeAddress" class="form-input" type="text" value="${p.homeAddress || ""}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("driver_work_address")}</label>
      <input id="ep-workAddress" class="form-input" type="text" value="${p.workAddress || ""}" />
    </div>
    ${isDriver ? `<span class="form-hint">${t("profile_driver_note")}</span>` : ""}
  `;

  openModal(t("profile_edit_title"), bodyHTML, async () => {
    const updates = {
      phone:       document.getElementById("ep-phone")?.value.trim() || null,
      email:       document.getElementById("ep-email")?.value.trim() || null,
      homeAddress: document.getElementById("ep-homeAddress")?.value.trim() || null,
      workAddress: document.getElementById("ep-workAddress")?.value.trim() || null,
      updatedAt:   serverTimestamp(),
    };

    if (!isDriver) {
      updates.firstName   = document.getElementById("ep-firstName")?.value.trim();
      updates.lastName    = document.getElementById("ep-lastName")?.value.trim();
      updates.displayName = `${updates.firstName} ${updates.lastName}`;
    }

    try {
      // Ažuriraj users dokument
      await updateDoc(doc(db, "users", S.user.uid), updates);

      // Ako je vozač, ažuriraj i drivers dokument
      if (isDriver && profile.driverId) {
        await updateDoc(
          doc(db, "companies", S.companyId, "drivers", profile.driverId),
          updates
        );
      }

      // Ažuriraj lokalni state
      Object.assign(S.profile, updates);

      showToast(t("success"), "success");
      const container = document.getElementById("content");
      if (container) renderProfile(container);
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
    }
  });
}

// ── TAB: FIRMA ────────────────────────────────────────────────
function renderCompanyTab({ company, role }) {
  if (!company) return `<div class="empty-state"><p>${t("no_data")}</p></div>`;

  const canEdit = role === "fleet_admin" || role === "master_admin";

  return `
    <div class="profile-section">
      <div class="profile-section__header">
        <h3 class="profile-section__title">${company.name}</h3>
        ${canEdit ? `<button class="btn btn--secondary btn--sm" id="btn-edit-company">✏️ Izmeni</button>` : ""}
      </div>
      <div class="detail-table">
        ${company.pib      ? row(t("company_pib"), company.pib) : ""}
        ${company.mbr      ? row(t("company_mbr"), company.mbr) : ""}
        ${company.owner    ? row(t("company_owner"), company.owner) : ""}
        ${company.director ? row(t("company_director"), company.director) : ""}
        ${company.address  ? row(t("company_address"), company.address) : ""}
        ${company.phone    ? row(t("company_phone"), company.phone) : ""}
        ${company.email    ? row(t("company_email"), company.email) : ""}
        ${company.instagram? row(t("company_instagram"), company.instagram) : ""}
        ${company.facebook ? row(t("company_facebook"), company.facebook) : ""}
      </div>
    </div>
  `;
}

function bindCompanyTab({ company, role }) {
  if (role !== "fleet_admin" && role !== "master_admin") return;
  document.getElementById("btn-edit-company")?.addEventListener("click", () => {
    openEditCompanyModal(company);
  });
}

function openEditCompanyModal(company) {
  const bodyHTML = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Naziv firme *</label>
        <input id="ec-name" class="form-input" type="text" value="${company.name || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">PIB</label>
        <input id="ec-pib" class="form-input" type="text" value="${company.pib || ""}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">MBR</label>
        <input id="ec-mbr" class="form-input" type="text" value="${company.mbr || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">Vlasnik</label>
        <input id="ec-owner" class="form-input" type="text" value="${company.owner || ""}" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">${t("company_director")}</label>
      <input id="ec-director" class="form-input" type="text" value="${company.director || ""}" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("company_address")}</label>
      <input id="ec-address" class="form-input" type="text" value="${company.address || ""}" />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Telefon</label>
        <input id="ec-phone" class="form-input" type="tel" value="${company.phone || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input id="ec-email" class="form-input" type="email" value="${company.email || ""}" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Instagram</label>
        <input id="ec-instagram" class="form-input" type="text" value="${company.instagram || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">Facebook</label>
        <input id="ec-facebook" class="form-input" type="text" value="${company.facebook || ""}" />
      </div>
    </div>
  `;

  openModal(`Izmeni: ${company.name}`, bodyHTML, async () => {
    const name = document.getElementById("ec-name")?.value.trim();
    if (!name) return;
    try {
      await updateDoc(doc(db, "companies", S.companyId), {
        name,
        pib:       document.getElementById("ec-pib")?.value.trim() || null,
        mbr:       document.getElementById("ec-mbr")?.value.trim() || null,
        owner:     document.getElementById("ec-owner")?.value.trim() || null,
        director:  document.getElementById("ec-director")?.value.trim() || null,
        address:   document.getElementById("ec-address")?.value.trim() || null,
        phone:     document.getElementById("ec-phone")?.value.trim() || null,
        email:     document.getElementById("ec-email")?.value.trim() || null,
        instagram: document.getElementById("ec-instagram")?.value.trim() || null,
        facebook:  document.getElementById("ec-facebook")?.value.trim() || null,
        updatedAt: serverTimestamp(),
      });
      showToast(t("success"), "success");
      const container = document.getElementById("content");
      if (container) renderProfile(container);
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
    }
  });
}

// ── TAB: PODEŠAVANJA ──────────────────────────────────────────
function renderSettingsTab({ profile }) {
  const currentLang = getCurrentLang();
  const isLocalLogin = !!profile.username;
  const canSetLocalLogin = profile.role === "fleet_admin" || profile.role === "master_admin";

  return `
    <div class="profile-section">
      <div class="profile-section__header">
        <h3 class="profile-section__title">${t("profile_lang_section")}</h3>
      </div>
      <div class="lang-options">
        <label class="lang-option ${currentLang === "sr" ? "lang-option--active" : ""}">
          <input type="radio" name="lang" value="sr" ${currentLang === "sr" ? "checked" : ""} />
          <span class="lang-option__flag">🇷🇸</span>
          <span>Srpski</span>
        </label>
        <label class="lang-option ${currentLang === "en" ? "lang-option--active" : ""}">
          <input type="radio" name="lang" value="en" ${currentLang === "en" ? "checked" : ""} />
          <span class="lang-option__flag">🇬🇧</span>
          <span>English</span>
        </label>
      </div>
    </div>

    ${canSetLocalLogin ? `
      <div class="profile-section">
        <div class="profile-section__header">
          <h3 class="profile-section__title">${t("profile_local_login_section")}</h3>
        </div>
        ${isLocalLogin ? `
          <p class="form-hint">${t("profile_local_login_already_set")}: <strong>${profile.username}</strong></p>
        ` : `
          <p class="form-hint">${t("profile_local_login_hint")}</p>
          <button class="btn btn--secondary btn--sm" id="btn-setup-local-login">🔑 ${t("profile_local_login_setup_btn")}</button>
        `}
      </div>
    ` : ""}

    <div class="profile-section">
      <div class="profile-section__header">
        <h3 class="profile-section__title">${t("profile_account_section")}</h3>
      </div>
      <div class="settings-info">
        <div class="settings-info__row">
          <span>${t("profile_uid_label")}</span>
          <span class="mono" style="font-size:11px">${S.user?.uid || "—"}</span>
        </div>
        <div class="settings-info__row">
          <span>${t("profile_role_label")}</span>
          <span>${t("role_" + profile.role)}</span>
        </div>
        <div class="settings-info__row">
          <span>${t("profile_status_label")}</span>
          <span class="badge badge--active">${t("profile_active_badge")}</span>
        </div>
      </div>
    </div>
  `;
}

function bindSettingsTab({ profile }) {
  // Promena jezika
  document.querySelectorAll("input[name='lang']").forEach(radio => {
    radio.addEventListener("change", async () => {
      await loadLanguage(radio.value);
      // Sačuvaj preferencu u Firestore
      try {
        await updateDoc(doc(db, "users", S.user.uid), {
          preferredLang: radio.value, updatedAt: serverTimestamp()
        });
      } catch (e) { /* ignoriši */ }
      // Re-renderuj celu app sa novim prevodima (uključujući aktivni tab)
      rerenderCurrentTab();
      showToast(radio.value === "sr" ? t("profile_lang_changed_sr") : t("profile_lang_changed_en"), "success");
    });
  });

  // Podešavanje lokalnog login-a (fleet_admin / master_admin)
  document.getElementById("btn-setup-local-login")?.addEventListener("click", () => {
    openSetupLocalLoginModal(profile);
  });
}

function openSetupLocalLoginModal(profile) {
  const bodyHTML = `
    <div class="form-group">
      <label class="form-label">${t("profile_local_login_username")}</label>
      <input id="ll-username" class="form-input" type="text" autocomplete="off" />
    </div>
    <div class="form-group">
      <label class="form-label">${t("profile_local_login_password")}</label>
      <input id="ll-password" class="form-input" type="password" autocomplete="new-password" />
    </div>
    <p class="form-hint">${t("profile_local_login_hint")}</p>
  `;

  openModal(t("profile_local_login_setup_btn"), bodyHTML, async () => {
    const username = document.getElementById("ll-username")?.value.trim();
    const password = document.getElementById("ll-password")?.value;
    if (!username || !password) {
      showToast(t("required_field"), "warning");
      return;
    }
    if (password.length < 6) {
      showToast(t("profile_local_login_pw_short"), "warning");
      return;
    }
    try {
      await linkLocalCredential(username, password);
      await updateDoc(doc(db, "users", S.user.uid), {
        username, updatedAt: serverTimestamp()
      });
      S.profile.username = username;
      showToast(t("profile_local_login_success"), "success");
      const container = document.getElementById("content");
      if (container) renderProfile(container);
    } catch (e) {
      showToast(`${t("error")}: ${e.message}`, "error");
    }
  });
}

// ── UTILS ─────────────────────────────────────────────────────
function row(label, value) {
  if (!value && value !== 0) return "";
  return `
    <div class="detail-row">
      <div class="detail-row__label">${label}</div>
      <div class="detail-row__value">${value}</div>
    </div>
  `;
}