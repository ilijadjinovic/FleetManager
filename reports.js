// ============================================================
//  reports.js  —  Fleet Manager
//  Tab: Izveštaji — generisanje PDF izveštaja
//  Koristi jsPDF (CDN)
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, where, orderBy, getDocs,
  doc, getDoc
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t } from "./i18n.js";
import { S, showToast } from "./app.js";
import { DEJAVU_SANS_REGULAR_B64, DEJAVU_SANS_BOLD_B64 } from "./fonts-dejavu.js";

// ── FONT ZA SRPSKA SLOVA (š đ č ć ž) ───────────────────────────
// jsPDF-ov ugradjeni "helvetica" font ne sadrzi ova slova (koristi
// stari Adobe standard encoding), pa ih PDF prikazuje kao kvadratice
// ili pogresne karaktere. Zato ugradjujemo DejaVu Sans (TTF) direktno
// u dokument. Ime fonta koje se koristi kroz ceo fajl je "DejaVuSans".
const REPORT_FONT = "DejaVuSans";

function registerReportFont(pdf) {
  pdf.addFileToVFS("DejaVuSans.ttf", DEJAVU_SANS_REGULAR_B64);
  pdf.addFileToVFS("DejaVuSans-Bold.ttf", DEJAVU_SANS_BOLD_B64);
  pdf.addFont("DejaVuSans.ttf", REPORT_FONT, "normal");
  pdf.addFont("DejaVuSans-Bold.ttf", REPORT_FONT, "bold");
  // Nemamo pravu kurziv (italic) varijantu fonta — mapiramo je na
  // regular, jer je bolje da tekst ostane citljiv (sa š/đ/č/ć/ž)
  // nego da jsPDF nemo padne na helvetica-italic (bez tih slova).
  pdf.addFont("DejaVuSans.ttf", REPORT_FONT, "italic");
  pdf.setFont(REPORT_FONT, "normal");
}

// ── jsPDF LOADER ──────────────────────────────────────────────
async function getJsPDF() {
  if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return window.jspdf.jsPDF;
}

// ── GLAVNI RENDER ─────────────────────────────────────────────
export async function renderReports(container) {
  if (!S.companyId) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🏢</div><p>${t("company_select")}</p></div>`;
    return;
  }

  // Učitaj vozila i vozače za selectore
  const [vehiclesSnap, driversSnap] = await Promise.all([
    getDocs(query(collection(db, "companies", S.companyId, "vehicles"), orderBy("brand", "asc"))),
    getDocs(query(collection(db, "companies", S.companyId, "drivers"), orderBy("lastName", "asc"))),
  ]);

  const vehicles = vehiclesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const drivers  = driversSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">${t("tab_reports")}</h2>
    </div>

    <!-- PERIOD -->
    <div class="report-card">
      <div class="report-card__title">📅 Period izveštaja</div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${t("report_date_from")}</label>
          <input id="rep-from" class="form-input" type="date"
            value="${firstDayOfMonth()}" />
        </div>
        <div class="form-group">
          <label class="form-label">${t("report_date_to")}</label>
          <input id="rep-to" class="form-input" type="date"
            value="${today()}" />
        </div>
      </div>
    </div>

    <!-- IZVEŠTAJ PO VOZILU -->
    <div class="report-card">
      <div class="report-card__title">🚗 ${t("report_vehicle")}</div>
      <div class="form-group">
        <label class="form-label">${t("report_select_vehicles")}</label>
        <div class="multi-select" id="vehicle-select">
          <label class="multi-select__all">
            <input type="checkbox" id="chk-vehicles-all" checked />
            ${t("report_all")} (${vehicles.length})
          </label>
          <div class="multi-select__list">
            ${vehicles.map(v => `
              <label class="multi-select__item">
                <input type="checkbox" class="chk-vehicle" value="${v.id}" checked />
                <span>${v.brand} ${v.model}</span>
                <span class="multi-select__sub">${v.plate}</span>
              </label>
            `).join("")}
          </div>
        </div>
      </div>
      <button class="btn btn--primary" id="btn-report-vehicles">
        📄 ${t("report_download_pdf")} — Vozila
      </button>
    </div>

    <!-- IZVEŠTAJ PO VOZAČU -->
    <div class="report-card">
      <div class="report-card__title">👤 ${t("report_driver")}</div>
      <div class="form-group">
        <label class="form-label">${t("report_select_drivers")}</label>
        <div class="multi-select" id="driver-select">
          <label class="multi-select__all">
            <input type="checkbox" id="chk-drivers-all" checked />
            ${t("report_all")} (${drivers.length})
          </label>
          <div class="multi-select__list">
            ${drivers.map(d => `
              <label class="multi-select__item">
                <input type="checkbox" class="chk-driver" value="${d.id}" checked />
                <span>${d.firstName} ${d.lastName}</span>
                <span class="multi-select__sub">${d.position || ""}</span>
              </label>
            `).join("")}
          </div>
        </div>
      </div>
      <button class="btn btn--primary" id="btn-report-drivers">
        📄 ${t("report_download_pdf")} — Vozači
      </button>
    </div>

    <div id="report-status"></div>
  `;

  // Select all checkboxes
  bindSelectAll("chk-vehicles-all", "chk-vehicle");
  bindSelectAll("chk-drivers-all",  "chk-driver");

  document.getElementById("btn-report-vehicles")?.addEventListener("click", () => generateVehicleReport(vehicles));
  document.getElementById("btn-report-drivers")?.addEventListener("click",  () => generateDriverReport(drivers));
}

// ── BIND SELECT ALL ───────────────────────────────────────────
function bindSelectAll(allId, itemClass) {
  const allChk = document.getElementById(allId);
  allChk?.addEventListener("change", () => {
    document.querySelectorAll(`.${itemClass}`).forEach(c => c.checked = allChk.checked);
  });
  document.querySelectorAll(`.${itemClass}`).forEach(c => {
    c.addEventListener("change", () => {
      const all   = document.querySelectorAll(`.${itemClass}`);
      const checked = document.querySelectorAll(`.${itemClass}:checked`);
      if (allChk) allChk.checked = all.length === checked.length;
    });
  });
}

// ── UČITAJ PODATKE FIRME ──────────────────────────────────────
async function loadCompany() {
  const snap = await getDoc(doc(db, "companies", S.companyId));
  return snap.exists() ? snap.data() : {};
}

// ── IZVEŠTAJ PO VOZILIMA ──────────────────────────────────────
async function generateVehicleReport(allVehicles) {
  const selectedIds = [...document.querySelectorAll(".chk-vehicle:checked")].map(c => c.value);
  if (selectedIds.length === 0) { showToast("Izaberite bar jedno vozilo", "warning"); return; }

  const from = new Date(document.getElementById("rep-from")?.value);
  const to   = new Date(document.getElementById("rep-to")?.value);
  to.setHours(23, 59, 59);

  setStatus("Učitavanje podataka...");

  try {
    const JsPDF  = await getJsPDF();
    const company = await loadCompany();
    const vehicles = allVehicles.filter(v => selectedIds.includes(v.id));

    const pdf = new JsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    registerReportFont(pdf);
    let firstPage = true;

    for (const vehicle of vehicles) {
      if (!firstPage) pdf.addPage();
      firstPage = false;

      // Dohvati podatke za vozilo u periodu
      const [assignments, services, entries] = await Promise.all([
        getDocsInPeriod("assignments", "startDate", from, to, [
          where("vehicleId", "==", vehicle.id)
        ]),
        getDocsInPeriod("services", "serviceDate", from, to, [
          where("vehicleId", "==", vehicle.id)
        ]),
        getDocsInPeriod("tripEntries", "createdAt", from, to, [
          where("vehicleId", "==", vehicle.id)
        ]),
      ]);

      const incidents = entries.filter(e => ["fault","damage","accident","other"].includes(e.type));
      const fuelings  = entries.filter(e => e.type === "fuel");
      const costs     = entries.filter(e => ["toll","parking","washing","other_cost"].includes(e.type));

      let y = drawHeader(pdf, company, from, to);
      y = drawVehicleSection(pdf, vehicle, y);
      y = drawAssignmentsSection(pdf, assignments, y);
      y = drawServicesSection(pdf, services, y);
      y = drawFuelingsSection(pdf, fuelings, y);
      y = drawCostsSection(pdf, costs, y);
      y = drawIncidentsSection(pdf, incidents, y);

      drawPageNumber(pdf);
    }

    const fileName = `fleet-vozila-${formatDateFile(from)}-${formatDateFile(to)}.pdf`;
    pdf.save(fileName);
    setStatus("");
    showToast("PDF je preuzet", "success");

  } catch (e) {
    console.error("Report error:", e);
    setStatus("");
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

// ── IZVEŠTAJ PO VOZAČIMA ──────────────────────────────────────
async function generateDriverReport(allDrivers) {
  const selectedIds = [...document.querySelectorAll(".chk-driver:checked")].map(c => c.value);
  if (selectedIds.length === 0) { showToast("Izaberite bar jednog vozača", "warning"); return; }

  const from = new Date(document.getElementById("rep-from")?.value);
  const to   = new Date(document.getElementById("rep-to")?.value);
  to.setHours(23, 59, 59);

  setStatus("Učitavanje podataka...");

  try {
    const JsPDF   = await getJsPDF();
    const company = await loadCompany();
    const drivers = allDrivers.filter(d => selectedIds.includes(d.id));

    const pdf = new JsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    registerReportFont(pdf);
    let firstPage = true;

    for (const driver of drivers) {
      if (!firstPage) pdf.addPage();
      firstPage = false;

      const [assignments, entries, incidents] = await Promise.all([
        getDocsInPeriod("assignments", "startDate", from, to, [
          where("driverId", "==", driver.id)
        ]),
        getDocsInPeriod("tripEntries", "createdAt", from, to, [
          where("driverId", "==", driver.id)
        ]),
        getDocsInPeriod("incidents", "createdAt", from, to, [
          where("driverId", "==", driver.id)
        ]),
      ]);

      const fuelings = entries.filter(e => e.type === "fuel");
      const costs    = entries.filter(e => ["toll","parking","washing","other_cost"].includes(e.type));

      let y = drawHeader(pdf, company, from, to);
      y = drawDriverSection(pdf, driver, y);
      y = drawDriverAssignmentsSection(pdf, assignments, y);
      y = drawFuelingsSection(pdf, fuelings, y);
      y = drawCostsSection(pdf, costs, y);
      y = drawIncidentsSection(pdf, incidents, y);

      drawPageNumber(pdf);
    }

    const fileName = `fleet-vozaci-${formatDateFile(from)}-${formatDateFile(to)}.pdf`;
    pdf.save(fileName);
    setStatus("");
    showToast("PDF je preuzet", "success");

  } catch (e) {
    console.error("Report error:", e);
    setStatus("");
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

// ── PDF CRTANJE ───────────────────────────────────────────────
const M  = 15;   // margin
const PW = 180;  // page width (A4 210 - 2*15)
const PH = 277;  // page height usable

function drawHeader(pdf, company, from, to) {
  let y = M;

  // Naziv firme — veliki
  pdf.setFont(REPORT_FONT, "bold");
  pdf.setFontSize(16);
  pdf.setTextColor(26, 39, 68);
  pdf.text(company.name || "Fleet Manager", M, y);
  y += 7;

  // Podaci o firmi — mali
  pdf.setFont(REPORT_FONT, "normal");
  pdf.setFontSize(8);
  pdf.setTextColor(100);

  const details = [
    company.pib      ? `PIB: ${company.pib}`           : null,
    company.mbr      ? `MBR: ${company.mbr}`           : null,
    company.address  ? company.address                  : null,
    company.phone    ? `Tel: ${company.phone}`          : null,
    company.email    ? company.email                    : null,
  ].filter(Boolean);

  if (details.length > 0) {
    pdf.text(details.join("   |   "), M, y);
    y += 5;
  }

  // Linija
  pdf.setDrawColor(61, 126, 255);
  pdf.setLineWidth(0.5);
  pdf.line(M, y, M + PW, y);
  y += 4;

  // Period
  pdf.setFontSize(9);
  pdf.setTextColor(120);
  pdf.text(
    `Period: ${formatDateSr(from)} — ${formatDateSr(to)}   |   Generisano: ${formatDateSr(new Date())}`,
    M, y
  );
  y += 8;

  return y;
}

function drawSectionTitle(pdf, title, y) {
  checkPageBreak(pdf, y, 12);
  pdf.setFillColor(240, 244, 255);
  pdf.rect(M, y - 4, PW, 8, "F");
  pdf.setFont(REPORT_FONT, "bold");
  pdf.setFontSize(10);
  pdf.setTextColor(26, 39, 68);
  pdf.text(title, M + 2, y + 1);
  return y + 8;
}

function drawRow(pdf, label, value, y, highlight = false) {
  if (!value && value !== 0) return y;
  checkPageBreak(pdf, y, 7);
  if (highlight) {
    pdf.setFillColor(248, 250, 255);
    pdf.rect(M, y - 3, PW, 6, "F");
  }
  pdf.setFont(REPORT_FONT, "bold");
  pdf.setFontSize(8.5);
  pdf.setTextColor(80);
  pdf.text(String(label), M + 2, y);
  pdf.setFont(REPORT_FONT, "normal");
  pdf.setTextColor(30);
  pdf.text(String(value), M + 65, y);
  return y + 6;
}

function drawTableHeader(pdf, cols, y) {
  checkPageBreak(pdf, y, 8);
  pdf.setFillColor(26, 39, 68);
  pdf.rect(M, y - 4, PW, 7, "F");
  pdf.setFont(REPORT_FONT, "bold");
  pdf.setFontSize(8);
  pdf.setTextColor(255);
  let x = M + 2;
  cols.forEach(([label, width]) => {
    pdf.text(label, x, y);
    x += width;
  });
  return y + 6;
}

function drawTableRow(pdf, cols, values, y, shade = false) {
  checkPageBreak(pdf, y, 7);
  if (shade) {
    pdf.setFillColor(248, 250, 255);
    pdf.rect(M, y - 4, PW, 6, "F");
  }
  pdf.setFont(REPORT_FONT, "normal");
  pdf.setFontSize(8);
  pdf.setTextColor(40);
  let x = M + 2;
  cols.forEach(([, width], i) => {
    const val = String(values[i] ?? "—");
    pdf.text(val.substring(0, 30), x, y); // max 30 chars
    x += width;
  });
  return y + 6;
}

function checkPageBreak(pdf, y, needed = 10) {
  if (y + needed > PH) {
    pdf.addPage();
    drawPageNumber(pdf);
    return M + 10;
  }
  return y;
}

function drawPageNumber(pdf) {
  const pageCount = pdf.internal.getNumberOfPages();
  pdf.setPage(pageCount);
  pdf.setFont(REPORT_FONT, "normal");
  pdf.setFontSize(8);
  pdf.setTextColor(150);
  pdf.text(`Strana ${pageCount}`, M + PW - 10, PH + 10, { align: "right" });
}

// ── VOZILO SEKCIJE ────────────────────────────────────────────
function drawVehicleSection(pdf, v, y) {
  y = drawSectionTitle(pdf, `VOZILO: ${v.brand} ${v.model} — ${v.plate}`, y);
  y = drawRow(pdf, "VIN / Broj šasije",    v.vin,          y, true);
  y = drawRow(pdf, "Godina proizvodnje",   v.year,         y);
  y = drawRow(pdf, "Prva registracija",    formatDateSr(v.firstRegDate), y, true);
  y = drawRow(pdf, "Zapremina / Snaga",    v.engineCc ? `${v.engineCc} cm³ / ${v.powerKw || "—"} kW` : null, y);
  y = drawRow(pdf, "Vrsta goriva",         v.fuelType ? t("fuel_" + v.fuelType) : null, y, true);
  y = drawRow(pdf, "Broj sedišta",         v.seats,        y);
  y = drawRow(pdf, "Nosivost",             v.payload ? `${v.payload} kg` : null, y, true);
  y = drawRow(pdf, "Trenutna km",          v.currentKm ? `${v.currentKm.toLocaleString()} km` : null, y);
  y = drawRow(pdf, "Registracija ističe",  formatDateSr(v.regExpiry),  y, true);
  y = drawRow(pdf, "Osiguranje ističe",    formatDateSr(v.insuranceExpiry), y);
  y = drawRow(pdf, "Osiguravač / Polisa",  v.insuranceCompany ? `${v.insuranceCompany} / ${v.insurancePolicy || "—"}` : null, y, true);
  y = drawRow(pdf, "Nabavna vrednost",     v.purchaseValue ? `${Number(v.purchaseValue).toLocaleString()} RSD` : null, y);
  return y + 4;
}

function drawAssignmentsSection(pdf, assignments, y) {
  y = drawSectionTitle(pdf, `ZADUŽENJA (${assignments.length})`, y);
  if (assignments.length === 0) {
    y = drawEmptyRow(pdf, y);
    return y;
  }

  const cols = [
    ["Vozač",       55],
    ["Od",          28],
    ["Do",          28],
    ["Poč. km",     28],
    ["Kraj. km",    28],
    ["Tip",         20],
  ];

  y = drawTableHeader(pdf, cols, y);
  assignments.forEach((a, i) => {
    y = drawTableRow(pdf, cols, [
      a.driverName,
      formatDateSr(a.startDate),
      a.endDate ? formatDateSr(a.endDate) : "—",
      a.startKm ? a.startKm.toLocaleString() : "—",
      a.endKm   ? a.endKm.toLocaleString()   : "—",
      a.tripType === "intercity" ? `Međugrad: ${a.destination || ""}` : "Lokalno",
    ], y, i % 2 === 0);
  });

  // Ukupno km
  const totalKm = assignments.reduce((s, a) => s + ((a.endKm || 0) - (a.startKm || 0)), 0);
  if (totalKm > 0) {
    y += 2;
    pdf.setFont(REPORT_FONT, "bold");
    pdf.setFontSize(8.5);
    pdf.setTextColor(26, 39, 68);
    pdf.text(`Ukupno pređeno: ${totalKm.toLocaleString()} km`, M + 2, y);
    y += 6;
  }

  return y + 2;
}

function drawServicesSection(pdf, services, y) {
  y = drawSectionTitle(pdf, `SERVISNA ISTORIJA (${services.length})`, y);
  if (services.length === 0) { return drawEmptyRow(pdf, y); }

  const cols = [
    ["Vrsta",       50],
    ["Datum",       28],
    ["Km",          25],
    ["Troškovi",    28],
    ["Servis",      55],
  ];

  y = drawTableHeader(pdf, cols, y);
  services.forEach((s, i) => {
    y = drawTableRow(pdf, cols, [
      t("service_type_" + s.serviceType) || s.serviceType,
      formatDateSr(s.serviceDate),
      s.km ? s.km.toLocaleString() : "—",
      s.cost ? s.cost.toLocaleString() + " RSD" : "—",
      s.workshop || "—",
    ], y, i % 2 === 0);

    if (s.description) {
      checkPageBreak(pdf, y, 6);
      pdf.setFont(REPORT_FONT, "italic");
      pdf.setFontSize(7.5);
      pdf.setTextColor(100);
      pdf.text(`  → ${s.description.substring(0, 80)}`, M + 4, y);
      y += 5;
    }
  });

  const totalCost = services.reduce((s, srv) => s + (srv.cost || 0), 0);
  if (totalCost > 0) {
    y += 2;
    pdf.setFont(REPORT_FONT, "bold");
    pdf.setFontSize(8.5);
    pdf.setTextColor(26, 39, 68);
    pdf.text(`Ukupni troškovi servisa: ${totalCost.toLocaleString()} RSD`, M + 2, y);
    y += 6;
  }

  return y + 2;
}

function drawFuelingsSection(pdf, fuelings, y) {
  y = drawSectionTitle(pdf, `TOČENJA GORIVA (${fuelings.length})`, y);
  if (fuelings.length === 0) { return drawEmptyRow(pdf, y); }

  const cols = [
    ["Datum",     28],
    ["Gorivo",    25],
    ["Količina",  25],
    ["Iznos",     28],
    ["Cena/L",    25],
    ["Pumpa",     55],
  ];

  y = drawTableHeader(pdf, cols, y);
  fuelings.forEach((f, i) => {
    y = drawTableRow(pdf, cols, [
      formatDateSr(f.createdAt),
      f.fuelType ? t("fuel_" + f.fuelType) : "—",
      f.fuelAmount ? f.fuelAmount.toFixed(2) + " L" : "—",
      f.fuelCost ? f.fuelCost.toLocaleString() + " RSD" : "—",
      f.pricePerL ? f.pricePerL.toFixed(2) + " RSD" : "—",
      f.fuelStation || "—",
    ], y, i % 2 === 0);
  });

  // Sumarni red
  const totalL    = fuelings.reduce((s, f) => s + (f.fuelAmount || 0), 0);
  const totalCost = fuelings.reduce((s, f) => s + (f.fuelCost   || 0), 0);
  y += 2;
  pdf.setFont(REPORT_FONT, "bold");
  pdf.setFontSize(8.5);
  pdf.setTextColor(26, 39, 68);
  pdf.text(
    `Ukupno: ${totalL.toFixed(2)} L  /  ${totalCost.toLocaleString()} RSD` +
    (totalL > 0 ? `  /  prosek: ${(totalCost/totalL).toFixed(2)} RSD/L` : ""),
    M + 2, y
  );
  return y + 8;
}

function drawCostsSection(pdf, costs, y) {
  if (costs.length === 0) return y;
  y = drawSectionTitle(pdf, `OSTALI TROŠKOVI (${costs.length})`, y);

  const cols = [
    ["Datum",    28],
    ["Vrsta",    40],
    ["Iznos",    28],
    ["Lokacija", 90],
  ];

  y = drawTableHeader(pdf, cols, y);
  costs.forEach((c, i) => {
    const typeLabels = { toll:"Putarina", parking:"Parking", washing:"Pranje", other_cost:"Ostalo" };
    y = drawTableRow(pdf, cols, [
      formatDateSr(c.createdAt),
      typeLabels[c.type] || c.type,
      c.amount ? c.amount.toLocaleString() + " RSD" : "—",
      c.location || "—",
    ], y, i % 2 === 0);
  });

  const total = costs.reduce((s, c) => s + (c.amount || 0), 0);
  y += 2;
  pdf.setFont(REPORT_FONT, "bold");
  pdf.setFontSize(8.5);
  pdf.setTextColor(26, 39, 68);
  pdf.text(`Ukupno ostali troškovi: ${total.toLocaleString()} RSD`, M + 2, y);
  return y + 8;
}

function drawIncidentsSection(pdf, incidents, y) {
  if (incidents.length === 0) return y;
  y = drawSectionTitle(pdf, `PRIJAVE — KVAROVI / OŠTEĆENJA / NEZGODE (${incidents.length})`, y);

  incidents.forEach((inc, i) => {
    checkPageBreak(pdf, y, 20);
    const typeLabels = { fault:"Kvar", damage:"Oštećenje", accident:"Nezgoda", other:"Ostalo" };
    const statusLabels = { open:"Otvoreno", in_progress:"U obradi", closed:"Zatvoreno" };

    if (i % 2 === 0) {
      pdf.setFillColor(248, 250, 255);
      pdf.rect(M, y - 3, PW, 16, "F");
    }

    pdf.setFont(REPORT_FONT, "bold");
    pdf.setFontSize(8.5);
    pdf.setTextColor(26, 39, 68);
    pdf.text(
      `${typeLabels[inc.type] || inc.type}  |  ${formatDateSr(inc.createdAt)}  |  ${statusLabels[inc.status] || inc.status}`,
      M + 2, y
    );
    y += 5;

    pdf.setFont(REPORT_FONT, "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(50);
    const descLines = pdf.splitTextToSize(inc.description || "", PW - 4);
    descLines.slice(0, 3).forEach(line => {
      pdf.text(line, M + 2, y);
      y += 4.5;
    });

    if (inc.location) {
      pdf.setTextColor(100);
      pdf.text(`Lokacija: ${inc.location}`, M + 2, y);
      y += 4.5;
    }
    if (inc.resolution) {
      pdf.setTextColor(34, 197, 94);
      pdf.text(`Rešenje: ${inc.resolution.substring(0, 80)}`, M + 2, y);
      y += 4.5;
    }
    y += 2;
  });

  return y + 2;
}

// ── VOZAČ SEKCIJE ─────────────────────────────────────────────
function drawDriverSection(pdf, d, y) {
  y = drawSectionTitle(pdf, `VOZAČ: ${d.firstName} ${d.lastName}`, y);
  y = drawRow(pdf, "JMBG",                    d.jmbg,             y, true);
  y = drawRow(pdf, "Godište",                 d.birthYear,        y);
  y = drawRow(pdf, "Kategorije dozvole",      d.licenseCategories,y, true);
  y = drawRow(pdf, "Radno mesto",             d.position,         y);
  y = drawRow(pdf, "Telefon",                 d.phone,            y, true);
  y = drawRow(pdf, "Email",                   d.email,            y);
  y = drawRow(pdf, "Adresa stanovanja",       d.homeAddress,      y, true);
  y = drawRow(pdf, "Adresa radnog mesta",     d.workAddress,      y);
  return y + 4;
}

function drawDriverAssignmentsSection(pdf, assignments, y) {
  y = drawSectionTitle(pdf, `ZADUŽENA VOZILA (${assignments.length})`, y);
  if (assignments.length === 0) { return drawEmptyRow(pdf, y); }

  const cols = [
    ["Vozilo",      55],
    ["Tablica",     28],
    ["Od",          25],
    ["Do",          25],
    ["Poč. km",     25],
    ["Kraj. km",    25],
  ];

  y = drawTableHeader(pdf, cols, y);
  let totalKm = 0;
  assignments.forEach((a, i) => {
    const km = (a.endKm || 0) - (a.startKm || 0);
    if (km > 0) totalKm += km;
    y = drawTableRow(pdf, cols, [
      `${a.vehicleBrand} ${a.vehicleModel}`,
      a.vehiclePlate,
      formatDateSr(a.startDate),
      a.endDate ? formatDateSr(a.endDate) : "—",
      a.startKm ? a.startKm.toLocaleString() : "—",
      a.endKm   ? a.endKm.toLocaleString()   : "—",
    ], y, i % 2 === 0);

    if (a.tripType === "intercity" && a.destination) {
      checkPageBreak(pdf, y, 5);
      pdf.setFont(REPORT_FONT, "italic");
      pdf.setFontSize(7.5);
      pdf.setTextColor(100);
      pdf.text(`  → Međugrad: ${a.destination}${a.route ? " / " + a.route : ""}`, M + 4, y);
      y += 4.5;
    }
  });

  if (totalKm > 0) {
    y += 2;
    pdf.setFont(REPORT_FONT, "bold");
    pdf.setFontSize(8.5);
    pdf.setTextColor(26, 39, 68);
    pdf.text(`Ukupno pređeno: ${totalKm.toLocaleString()} km`, M + 2, y);
    y += 6;
  }

  return y + 2;
}

function drawEmptyRow(pdf, y) {
  pdf.setFont(REPORT_FONT, "italic");
  pdf.setFontSize(8);
  pdf.setTextColor(150);
  pdf.text("Nema podataka za izabrani period", M + 2, y);
  return y + 8;
}

// ── FIRESTORE HELPER ──────────────────────────────────────────
async function getDocsInPeriod(subcollection, dateField, from, to, extraWhere = []) {
  try {
    const q = query(
      collection(db, "companies", S.companyId, subcollection),
      ...extraWhere,
      where(dateField, ">=", from),
      where(dateField, "<=", to),
      orderBy(dateField, "asc")
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn(`getDocsInPeriod(${subcollection}) error:`, e);
    return [];
  }
}

// ── UTILS ─────────────────────────────────────────────────────
function setStatus(msg) {
  const el = document.getElementById("report-status");
  if (!el) return;
  el.innerHTML = msg
    ? `<div class="loading">${msg}</div>`
    : "";
}

function formatDateSr(val) {
  if (!val) return "—";
  const d = val.toDate ? val.toDate() : new Date(val);
  return isNaN(d) ? "—" : d.toLocaleDateString("sr-RS");
}

function formatDateFile(date) {
  return date.toISOString().split("T")[0];
}

function firstDayOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split("T")[0];
}

function today() {
  return new Date().toISOString().split("T")[0];
}
