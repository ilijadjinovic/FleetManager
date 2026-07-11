// ============================================================
//  app.js  —  Fleet Manager
//  Glavni modul: auth state, routing, tab switching
// ============================================================

import { auth, getUserProfile, logout } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import { loadLanguage, t, applyTranslations } from "./i18n.js";
import { renderDashboard } from "./dashboard.js";
import { renderVehicles } from "./vehicles.js";
import { renderDrivers } from "./drivers.js";
import { renderAssignments } from "./assignments.js";
import { renderTrips } from "./trips.js";
import { renderIncidents } from "./incidents.js";
import { renderReports } from "./reports.js";
import { renderProfile } from "./profile.js";
import { renderLogin } from "./login.js";
import { renderRegister, showPendingScreen } from "./register.js";
import { renderCompanies } from "./companies.js";
import { renderServicers } from "./servicers.js";

// ── GLOBALNI STATE ────────────────────────────────────────────
export const S = {
  user: null,
  profile: null,
  companyId: null,
  companies: [],
  activeTab: "dashboard",
};

// ── INIT ──────────────────────────────────────────────────────
async function init() {
  await loadLanguage(localStorage.getItem("fm_lang") || "sr");

  onAuthStateChanged(auth, async (firebaseUser) => {
    if (firebaseUser) {
      S.user = firebaseUser;
      S.profile = await getUserProfile(firebaseUser.uid);

      if (!S.profile) {
        // Novi korisnik — prikaži registration formu
        showRegistration();
        return;
      }

      if (S.profile.status === "pending") {
        showPendingScreen();
        return;
      }

      if (S.profile.status === "rejected") {
        showRejected();
        return;
      }

      if (S.profile.status === "blocked") {
        showBlocked();
        return;
      }

      // Postavi companyId
      S.companyId = S.profile.role === "master_admin"
        ? (S.profile.lastCompanyId || null)
        : S.profile.companyId;

      showApp();
    } else {
      S.user = null;
      S.profile = null;
      S.companyId = null;
      showLogin();
    }
  });
}

// ── EKRANI ────────────────────────────────────────────────────
function showLogin() {
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  renderLogin();
}

function showRegistration() {
  document.getElementById("login-screen").classList.add("hidden");
  const app = document.getElementById("app");
  app.classList.remove("hidden");
  // Sakrij nav i header dugmad za logout tokom registracije
  app.innerHTML = `<div id="register-container"></div>`;
  renderRegister(document.getElementById("register-container"));
}

function showRejected() {
  document.getElementById("login-screen").classList.add("hidden");
  const app = document.getElementById("app");
  app.classList.remove("hidden");
  app.innerHTML = `
    <div class="access-denied">
      <div class="access-denied__icon">❌</div>
      <h2>${t("app_rejected_title")}</h2>
      <p>${t("app_rejected_msg")}</p>
      <button class="btn btn--secondary" id="btn-rejected-logout">${t("app_rejected_logout")}</button>
    </div>
  `;
  document.getElementById("btn-rejected-logout")?.addEventListener("click", doLogout);
}

function showBlocked() {
  document.getElementById("login-screen").classList.add("hidden");
  const app = document.getElementById("app");
  app.classList.remove("hidden");
  app.innerHTML = `
    <div class="access-denied">
      <div class="access-denied__icon">🔒</div>
      <h2>${t("app_blocked_title")}</h2>
      <p>${t("app_blocked_msg")}</p>
      <button class="btn btn--secondary" id="btn-blocked-logout">${t("app_blocked_logout")}</button>
    </div>
  `;
  document.getElementById("btn-blocked-logout")?.addEventListener("click", doLogout);
}

function showApp() {
  document.getElementById("login-screen").classList.add("hidden");
  // Obnovi originalni HTML ako je bio zamenjen
  const app = document.getElementById("app");
  if (!app.querySelector(".app-header")) {
    location.reload(); // Najbrži način da se vrati originalni layout
    return;
  }
  app.classList.remove("hidden");
  buildNav();
  navigateTo(S.activeTab);
}

// ── NAVIGACIJA ────────────────────────────────────────────────
const TAB_CONFIG = {
  master_admin: ["dashboard", "vehicles", "drivers", "assignments", "companies", "servicers", "reports", "profile"],
  fleet_admin:  ["dashboard", "vehicles", "drivers", "assignments", "servicers", "reports", "profile"],
  driver:       ["dashboard", "trips", "incidents", "profile"],
};

const TAB_ICONS = {
  dashboard:   "📊",
  vehicles:    "🚗",
  drivers:     "👤",
  assignments: "🔑",
  trips:       "🛣️",
  incidents:   "⚠️",
  companies:   "🏢",
  reports:     "📄",
  profile:     "⚙️",
  servicers:   "🔧",
};

const TAB_KEYS = {
  dashboard:   "tab_dashboard",
  vehicles:    "tab_vehicles",
  drivers:     "tab_drivers",
  assignments: "tab_assignments",
  trips:       "tab_trips",
  incidents:   "tab_report",
  companies:   "tab_companies",
  reports:     "tab_reports",
  profile:     "tab_profile",
  servicers:   "tab_servicers",
};

const TAB_RENDERERS = {
  dashboard:   renderDashboard,
  vehicles:    renderVehicles,
  drivers:     renderDrivers,
  assignments: renderAssignments,
  trips:       renderTrips,
  incidents:   renderIncidents,
  companies:   renderCompanies,
  reports:     renderReports,
  profile:     renderProfile,
  servicers:   renderServicers,
};

export function buildNav() {
  const role = S.profile?.role || "driver";
  const tabs = TAB_CONFIG[role] || TAB_CONFIG.driver;
  const nav = document.getElementById("main-nav");
  if (!nav) return;

  nav.innerHTML = tabs.map(tab => `
    <button class="nav-btn ${S.activeTab === tab ? "nav-btn--active" : ""}" data-tab="${tab}">
      <span class="nav-btn__icon">${TAB_ICONS[tab]}</span>
      <span class="nav-btn__label">${t(TAB_KEYS[tab]) || tab}</span>
    </button>
  `).join("");

  nav.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.tab));
  });
}

export function navigateTo(tab) {
  S.activeTab = tab;
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.classList.toggle("nav-btn--active", btn.dataset.tab === tab);
  });
  const content = document.getElementById("content");
  if (!content) return;
  content.innerHTML = `<div class="loading">${t("loading")}</div>`;
  const renderer = TAB_RENDERERS[tab];
  if (renderer) renderer(content);
  else content.innerHTML = `<p>${t("no_data")}</p>`;
}

/** Re-renderuje trenutni aktivni tab — koristi se posle promene jezika */
export function rerenderCurrentTab() {
  buildNav();
  navigateTo(S.activeTab);
}

// ── COMPANY SWITCHER ──────────────────────────────────────────
export function setActiveCompany(companyId) {
  S.companyId = companyId;
  import("./firebase.js").then(({ setUserProfile }) => {
    setUserProfile(S.user.uid, { lastCompanyId: companyId });
  });
  navigateTo(S.activeTab);
}

// ── LOGOUT ────────────────────────────────────────────────────
export async function doLogout() {
  await logout();
}

// ── TOAST ─────────────────────────────────────────────────────
export function showToast(message, type = "info", duration = 3500) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast--visible"));
  setTimeout(() => {
    toast.classList.remove("toast--visible");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── MODAL ─────────────────────────────────────────────────────
export function openModal(title, bodyHTML, onConfirm = null) {
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").innerHTML = bodyHTML;
  const confirmBtn = document.getElementById("modal-confirm");
  const cancelBtn  = document.getElementById("modal-cancel");
  confirmBtn.style.display = onConfirm ? "inline-flex" : "none";
  confirmBtn.disabled = false;
  confirmBtn.textContent = t("confirm");
  cancelBtn.textContent = t("cancel");
  const close = () => document.getElementById("modal-overlay").classList.add("hidden");
  if (onConfirm) confirmBtn.onclick = async () => {
    confirmBtn.disabled = true;
    let success = false;
    try {
      await onConfirm();
      success = true;
    } finally {
      confirmBtn.disabled = false;
    }
    if (success) close();
  };
  cancelBtn.onclick = close;
  document.getElementById("modal-overlay").classList.remove("hidden");
}

export function closeModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
}

// ── START ─────────────────────────────────────────────────────
init();
