// ============================================================
//  dashboard.js  —  Fleet Manager
//  Tab: Pregled / Dashboard
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, where, getDocs, orderBy
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t, getCurrentLang } from "./i18n.js";
import { S, setActiveCompany, navigateTo } from "./app.js";
import { getCompanies } from "./firebase.js";
import { isVehicleRegistered, openVehicleDetail } from "./vehicles.js";

export async function renderDashboard(container) {
  const isMasterAdmin = S.profile?.role === "master_admin";

  // Master admin company switcher
  let companySwitcherHTML = "";
  if (isMasterAdmin) {
    try {
      S.companies = await getCompanies();
      companySwitcherHTML = `
        <div class="company-switcher">
          <label class="form-label" data-i18n="company_select">${t("company_select")}</label>
          <select id="company-select" class="form-select">
            <option value="" ${!S.companyId ? "selected" : ""}>${t("company_all")}</option>
            ${S.companies.map(c => `
              <option value="${c.id}" ${S.companyId === c.id ? "selected" : ""}>${c.name}</option>
            `).join("")}
          </select>
        </div>
      `;
    } catch (e) {
      console.error("Error loading companies:", e);
    }
  }

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title" data-i18n="tab_dashboard">${t("tab_dashboard")}</h2>
      ${companySwitcherHTML}
    </div>
    <div id="dashboard-content">
      <div class="loading">${t("loading")}</div>
    </div>
  `;

  // Company switcher event
  if (isMasterAdmin) {
    document.getElementById("company-select")?.addEventListener("change", (e) => {
      setActiveCompany(e.target.value || null);
    });
  }

  if (!S.companyId) {
    if (isMasterAdmin && S.companies.length > 0) {
      document.getElementById("dashboard-content").innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">🏢</div>
          <p>${t("company_select")}</p>
        </div>
      `;
    } else {
      document.getElementById("dashboard-content").innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">⚠️</div>
          <p>${t("no_data")}</p>
        </div>
      `;
    }
    return;
  }

  await loadDashboardData();
}

async function loadDashboardData() {
  const cid = S.companyId;
  const role = S.profile?.role;
  const content = document.getElementById("dashboard-content");
  if (!content) return;

  try {
    // Dohvati vozila
    const vehiclesSnap = await getDocs(collection(db, "companies", cid, "vehicles"));
    const vehicles = vehiclesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Statistika
    const total = vehicles.length;
    const active = vehicles.filter(v => v.status === "active").length;
    const inService = vehicles.filter(v => v.status === "service").length;
    const unregistered = vehicles.filter(v => isVehicleRegistered(v) === false).length;
    const broken = vehicles.filter(v => v.status === "broken").length;

    // Nadolazeće registracije (u sledećih 30 dana)
    const today = new Date();
    const in30 = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
    const upcomingReg = vehicles
      .filter(v => {
        if (!v.regExpiry) return false;
        const d = v.regExpiry.toDate ? v.regExpiry.toDate() : new Date(v.regExpiry);
        return d >= today && d <= in30;
      })
      .sort((a, b) => {
        const da = a.regExpiry.toDate ? a.regExpiry.toDate() : new Date(a.regExpiry);
        const db2 = b.regExpiry.toDate ? b.regExpiry.toDate() : new Date(b.regExpiry);
        return da - db2;
      });

    // Danas — početak dana u lokalnom vremenu (ponoć)
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    // Aktivna zaduženja
    let assignmentsSnap;
    if (role === "driver") {
      assignmentsSnap = await getDocs(
        query(
          collection(db, "companies", cid, "assignments"),
          where("driverUid", "==", S.user.uid),
          where("status", "==", "active")
        )
      ).catch(() => ({ docs: [] }));
    } else {
      assignmentsSnap = await getDocs(
        query(
          collection(db, "companies", cid, "assignments"),
          where("status", "==", "active")
        )
      ).catch(() => ({ docs: [] }));
    }
    const assignedCount = assignmentsSnap?.docs?.length || 0;

    // Zakazani servisi = unosi u "Servisna istorija" sa datumom u budućnosti
    // (narednih 30 dana) — ovako se u praksi zakazuje, kroz "Dodaj servis".
    const servicesSnap = await getDocs(
      query(
        collection(db, "companies", cid, "services"),
        where("serviceDate", ">=", todayStart),
        where("serviceDate", "<=", in30),
        orderBy("serviceDate", "asc")
      )
    ).catch(() => ({ docs: [] }));

    const upcomingScheduled = servicesSnap.docs.map(d => {
      const s = { id: d.id, ...d.data() };
      const veh = vehicles.find(v => v.id === s.vehicleId);
      return {
        ...s,
        vehicleBrand: veh?.brand || "",
        vehicleModel: veh?.model || "",
      };
    });

    const isDriver = role === "driver";

    content.innerHTML = `
      ${isDriver ? renderDriverDashboard(assignmentsSnap) : renderAdminDashboard({
        total, active, inService, unregistered, broken, upcomingReg, vehicles, assignedCount, upcomingScheduled
      })}
    `;

    // Event listeneri za kartice
    if (!isDriver) {
      attachDashboardEvents();
    }

  } catch (e) {
    console.error("Dashboard load error:", e);
    content.innerHTML = `<div class="error-state">${t("error")}: ${e.message}</div>`;
  }
}

function renderAdminDashboard({ total, active, inService, unregistered, broken, upcomingReg, vehicles, assignedCount, upcomingScheduled }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0); // lokalna ponoć

  return `
    <div class="stats-grid">
      <div class="stat-card stat-card--total" data-nav="vehicles">
        <div class="stat-card__value">${total}</div>
        <div class="stat-card__label" data-i18n="dashboard_total_vehicles">${t("dashboard_total_vehicles")}</div>
      </div>
      <div class="stat-card stat-card--active" data-nav="vehicles" data-filter="active">
        <div class="stat-card__value">${active}</div>
        <div class="stat-card__label" data-i18n="dashboard_active">${t("dashboard_active")}</div>
      </div>
      <div class="stat-card stat-card--service" data-nav="vehicles" data-filter="service">
        <div class="stat-card__value">${inService}</div>
        <div class="stat-card__label" data-i18n="dashboard_in_service">${t("dashboard_in_service")}</div>
      </div>
      <div class="stat-card stat-card--unreg" data-nav="vehicles" data-filter="unregistered">
        <div class="stat-card__value">${unregistered}</div>
        <div class="stat-card__label" data-i18n="dashboard_unregistered">${t("dashboard_unregistered")}</div>
      </div>
      ${broken > 0 ? `
      <div class="stat-card stat-card--broken" data-nav="vehicles" data-filter="broken">
        <div class="stat-card__value">${broken}</div>
        <div class="stat-card__label">${t("vehicle_status_broken")}</div>
      </div>
      ` : ""}
      <div class="stat-card stat-card--assigned" data-nav="assignments">
        <div class="stat-card__value">${assignedCount}</div>
        <div class="stat-card__label" data-i18n="dashboard_assigned">${t("dashboard_assigned")}</div>
      </div>
    </div>

    <div class="dashboard-grid">
      <div class="dashboard-panel">
        <h3 class="panel-title" data-i18n="dashboard_upcoming_reg">${t("dashboard_upcoming_reg")}</h3>
        ${upcomingReg.length === 0
          ? `<p class="empty-text" data-i18n="dashboard_no_upcoming">${t("dashboard_no_upcoming")}</p>`
          : upcomingReg.map(v => {
              const d = v.regExpiry.toDate ? v.regExpiry.toDate() : new Date(v.regExpiry);
              const daysLeft = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
              const urgency = daysLeft <= 7 ? "urgent" : daysLeft <= 14 ? "warning" : "ok";
              return `
                <div class="upcoming-item upcoming-item--${urgency}">
                  <div class="upcoming-item__main">
                    <span class="upcoming-item__name">${v.brand} ${v.model}</span>
                    <span class="upcoming-item__plate">${v.plate}</span>
                  </div>
                  <div class="upcoming-item__right">
                    <span class="upcoming-item__date">${formatDate(d)}</span>
                    <span class="upcoming-item__days">${daysLeft} ${t("dashboard_days_left")}</span>
                  </div>
                </div>
              `;
            }).join("")
        }
      </div>

      <div class="dashboard-panel">
        <h3 class="panel-title" data-i18n="schedule_panel_title">📅 ${t("schedule_panel_title")}</h3>
        ${!upcomingScheduled || upcomingScheduled.length === 0
          ? `<p class="empty-text">${t("schedule_no_data")}</p>`
          : upcomingScheduled.map(s => {
              const d = s.serviceDate?.toDate ? s.serviceDate.toDate() : new Date(s.serviceDate);
              const daysLeft = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
              const urgency = daysLeft <= 2 ? "urgent" : daysLeft <= 7 ? "warning" : "ok";
              const dateStr = formatDate(d);
              return `
                <div class="upcoming-item upcoming-item--${urgency}" data-vehicle-id="${s.vehicleId}" style="cursor:pointer">
                  <div class="upcoming-item__main">
                    <span class="upcoming-item__name">${s.vehicleBrand} ${s.vehicleModel}</span>
                    <span class="upcoming-item__plate">${s.vehiclePlate}</span>
                    ${s.workshop ? `<span class="upcoming-item__plate">🔧 ${s.workshop}</span>` : ""}
                  </div>
                  <div class="upcoming-item__right">
                    <span class="upcoming-item__date">${dateStr}</span>
                    <span class="upcoming-item__days">${daysLeft} ${t("dashboard_days_left")}</span>
                  </div>
                </div>
              `;
            }).join("")
        }
      </div>
    </div>
  `;
}

function renderDriverDashboard(assignmentsSnap) {
  const assignments = assignmentsSnap?.docs?.map(d => ({ id: d.id, ...d.data() })) || [];

  if (assignments.length === 0) {
    return `
      <div class="empty-state">
        <div class="empty-state__icon">🚗</div>
        <p>${t("no_data")}</p>
      </div>
    `;
  }

  return `
    <div class="driver-assignments">
      ${assignments.map(a => `
        <div class="vehicle-card-preview">
          <div class="vehicle-card-preview__header">
            <span class="vehicle-card-preview__icon">🚗</span>
            <div>
              <div class="vehicle-card-preview__title">${a.vehicleBrand} ${a.vehicleModel}</div>
              <div class="vehicle-card-preview__plate">${a.vehiclePlate}</div>
            </div>
          </div>
          <div class="vehicle-card-preview__km">
            <span>${t("assignment_start_km")}:</span>
            <strong>${a.startKm?.toLocaleString() || "—"} km</strong>
          </div>
          <div class="vehicle-card-preview__actions">
            <button class="btn btn--primary btn--sm" onclick="import('./app.js').then(m => m.navigateTo('trips'))">
              ${t("trip_add")}
            </button>
            <button class="btn btn--warning btn--sm" onclick="import('./app.js').then(m => m.navigateTo('incidents'))">
              ${t("incident_add")}
            </button>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function attachDashboardEvents() {
  document.querySelectorAll(".stat-card[data-nav]").forEach(card => {
    card.style.cursor = "pointer";
    card.addEventListener("click", () => {
      const filter = card.dataset.filter || null;
      if (filter) {
        // Navigiraj na tab i primeni filter
        import("./vehicles.js").then(({ renderVehicles }) => {
          S.activeTab = "vehicles";
          document.querySelectorAll(".nav-btn").forEach(btn => {
            btn.classList.toggle("nav-btn--active", btn.dataset.tab === "vehicles");
          });
          const content = document.getElementById("content");
          if (content) renderVehicles(content, filter);
        });
      } else {
        navigateTo(card.dataset.nav);
      }
    });
  });

  // Klik na zakazani servis u panelu → detalji vozila, tab "Servisna istorija"
  document.querySelectorAll("[data-vehicle-id]").forEach(item => {
    item.addEventListener("click", () => {
      const vehicleId = item.dataset.vehicleId;
      if (!vehicleId) return;
      S.activeTab = "vehicles";
      document.querySelectorAll(".nav-btn").forEach(btn => {
        btn.classList.toggle("nav-btn--active", btn.dataset.tab === "vehicles");
      });
      openVehicleDetail(vehicleId, "service");
    });
  });
}

function formatDate(date) {
  if (!date) return "—";
  const d = date instanceof Date ? date : new Date(date);
  const locale = getCurrentLang() === "en" ? "en-GB" : "sr-RS";
  return d.toLocaleDateString(locale);
}
