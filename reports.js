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
import { t, getCurrentLang } from "./i18n.js";
import { S, showToast } from "./app.js";
import { isVehicleRegistered } from "./vehicles.js";
import { DEJAVU_SANS_REGULAR_B64, DEJAVU_SANS_BOLD_B64 } from "./fonts-dejavu.js";

// ── FONT ZA SRPSKA SLOVA (š đ č ć ž) ───────────────────────────
// jsPDF-ov ugradjeni "helvetica" font ne sadrzi ova slova (koristi
// stari Adobe standard encoding), pa ih PDF prikazuje kao kvadratice
// ili pogresne karaktere. Zato ugradjujemo DejaVu Sans (TTF) direktno
// u dokument. Ime fonta koje se koristi kroz ceo fajl je "DejaVuSans".
const REPORT_FONT = "DejaVuSans";

// Isti redosled/set statusa kao filter chipovi u tabu Vozila.
const VEHICLE_STATUS_GROUPS = ["active", "service", "broken", "inactive", "unregistered", "archived"];

// Ista logika poklapanja kao renderList() u vehicles.js: arhivirana vozila
// pripadaju ISKLJUČIVO grupi "archived" i ne pojavljuju se ni u jednoj drugoj.
function vehicleMatchesGroup(v, group) {
  if (group === "archived") return v.archived === true;
  if (v.archived) return false;
  if (group === "unregistered") return isVehicleRegistered(v) === false;
  return (v.status || "active") === group;
}

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
      <div class="report-card__title">📅 ${t("report_period_title")}</div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${t("report_date_from")}</label>
          <input id="rep-from" class="form-input" type="text" inputmode="numeric" maxlength="10"
            placeholder="${datePlaceholder()}" value="${toDMY(firstDayOfMonth())}" />
        </div>
        <div class="form-group">
          <label class="form-label">${t("report_date_to")}</label>
          <input id="rep-to" class="form-input" type="text" inputmode="numeric" maxlength="10"
            placeholder="${datePlaceholder()}" value="${toDMY(today())}" />
        </div>
      </div>
    </div>

    <!-- IZVEŠTAJ PO VOZILU -->
    <div class="report-card">
      <div class="report-card__title">🚗 ${t("report_vehicle")}</div>
      <div class="form-group">
        <label class="form-label">${t("report_select_vehicles")}</label>
        <div class="multi-select" id="vehicle-select">
          <div class="multi-select__all" style="flex-wrap:wrap;gap:16px">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="checkbox" id="chk-vehicles-all" checked />
              ${t("report_all")} (${vehicles.length})
            </label>
            <span style="width:1px;height:16px;background:var(--color-border)"></span>
            ${VEHICLE_STATUS_GROUPS.map(g => `
              <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer">
                <input type="checkbox" class="chk-status-group" data-group="${g}" />
                ${t("vehicle_status_" + g)}
              </label>
            `).join("")}
          </div>
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
      <button class="btn btn--secondary" id="btn-report-vehicles-table" style="margin-top:8px">
        📊 ${t("report_download_table_pdf")}
      </button>
      <button class="btn btn--secondary" id="btn-report-vehicles-csv" style="margin-top:8px">
        📊 ${t("report_download_csv")}
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

  // ── "Svi" i statusni filteri — Vozila ──────────────────────
  // "Svi" je međusobno isključiv sa svim statusnim filterima (biranje bilo
  // kog statusa automatski gasi "Svi", i obrnuto). Statusni filteri se
  // MEĐUSOBNO kombinuju kao presek (AND) — npr. "Vozno" + "Neregistrovano"
  // znači vozila koja su ISTOVREMENO aktivna I neregistrovana.
  bindVehicleFilters(vehicles);
  bindSelectAll("chk-drivers-all",  "chk-driver");

  document.getElementById("btn-report-vehicles")?.addEventListener("click", () => generateVehicleReport(vehicles));
  document.getElementById("btn-report-vehicles-table")?.addEventListener("click", () => generateVehiclesTableReport(vehicles));
  document.getElementById("btn-report-vehicles-csv")?.addEventListener("click",   () => exportVehiclesCSV(vehicles));
  document.getElementById("btn-report-drivers")?.addEventListener("click",  () => generateDriverReport(drivers));

  attachDateMask("rep-from");
  attachDateMask("rep-to");
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

// ── BIND VOZILA: "Svi" + statusni filteri ─────────────────────
// "Svi" je isključiv sa statusnim filterima (biranje bilo kog statusa gasi
// "Svi", i obrnuto — biranje "Svi" gasi sve statusne filtere). Statusni
// filteri se kombinuju kao presek (AND): vozilo mora da poklopi SVAKI
// trenutno čekirani status da bi bilo selektovano.
function bindVehicleFilters(vehicles) {
  const allChk     = document.getElementById("chk-vehicles-all");
  const groupChks  = [...document.querySelectorAll(".chk-status-group")];
  const itemChks   = () => [...document.querySelectorAll(".chk-vehicle")];

  function selectAllVehicles(checked) {
    itemChks().forEach(c => { c.checked = checked; });
  }

  function applyGroupIntersection() {
    const activeGroups = groupChks.filter(c => c.checked).map(c => c.dataset.group);
    itemChks().forEach(itemChk => {
      const vehicle = vehicles.find(v => v.id === itemChk.value);
      itemChk.checked = !!vehicle && activeGroups.every(g => vehicleMatchesGroup(vehicle, g));
    });
  }

  allChk?.addEventListener("change", () => {
    if (allChk.checked) {
      groupChks.forEach(c => { c.checked = false; });
      selectAllVehicles(true);
    } else if (!groupChks.some(c => c.checked)) {
      // Ručno dečekirano "Svi" bez ijednog aktivnog statusnog filtera —
      // ponaša se kao klasično "deselektuj sve".
      selectAllVehicles(false);
    }
  });

  groupChks.forEach(groupChk => {
    groupChk.addEventListener("change", () => {
      if (groupChk.checked && allChk) allChk.checked = false;

      if (!groupChks.some(c => c.checked)) {
        // Nijedan statusni filter više nije aktivan — vrati se na "Svi".
        if (allChk) allChk.checked = true;
        selectAllVehicles(true);
        return;
      }
      applyGroupIntersection();
    });
  });

  // Ručno (pojedinačno) čekiranje vozila i dalje radi nezavisno — samo
  // ažurira "Svi" kad nijedan statusni filter nije aktivan, da ne bi
  // "oteo" stanje filterima.
  itemChks().forEach(c => {
    c.addEventListener("change", () => {
      if (groupChks.some(g => g.checked)) return;
      const all     = itemChks();
      const checked = all.filter(x => x.checked);
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
  if (selectedIds.length === 0) { showToast(t("report_select_vehicle_required"), "warning"); return; }

  const from = parseDMY(document.getElementById("rep-from")?.value);
  const to   = parseDMY(document.getElementById("rep-to")?.value);
  if (!from || !to) { showToast(t("required_field"), "warning"); return; }
  to.setHours(23, 59, 59);

  setStatus(t("loading"));

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
    showToast(t("report_pdf_downloaded"), "success");

  } catch (e) {
    console.error("Report error:", e);
    setStatus("");
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

// ── TABELARNI (SPREADSHEET) PDF IZVEŠTAJ VOZILA ────────────────
// Za razliku od generateVehicleReport (jedno vozilo po strani, sa
// detaljima/servisima/troškovima), ovo je pregledna tabela svih
// izabranih vozila — kao Excel tabela — jedan red po vozilu.
async function generateVehiclesTableReport(allVehicles) {
  const selectedIds = [...document.querySelectorAll(".chk-vehicle:checked")].map(c => c.value);
  if (selectedIds.length === 0) { showToast(t("report_select_vehicle_required"), "warning"); return; }

  setStatus(t("loading"));

  try {
    const JsPDF   = await getJsPDF();
    const company = await loadCompany();
    const vehicles = allVehicles.filter(v => selectedIds.includes(v.id));

    // Landscape — više horizontalnog prostora za 7 kolona
    const pdf = new JsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    registerReportFont(pdf);

    let y = drawTableReportHeader(pdf, company, PW_L);

    // Kratke, namenske labele kolona (ne pune labele sa kartice vozila —
    // te su predugačke za usku kolonu i "gomilaju" header).
    const cols = [
      [t("report_table_col_vehicle"), 55],
      [t("report_table_col_plate"),   25],
      [t("report_table_col_reg"),     28],
      [t("report_table_col_vin"),     45],
      [t("report_table_col_year"),    15],
      [t("report_table_col_km"),      25],
      [t("report_table_col_driver"),  50],
    ];

    y = drawTableHeaderL(pdf, cols, y);
    vehicles.forEach((v, i) => {
      y = drawTableRowWrapped(pdf, cols, [
        `${v.brand || ""} ${v.model || ""}`.trim() || "—",
        v.plate || "—",
        v.regExpiry ? formatDateSr(v.regExpiry) : "—",
        v.vin || "—",
        v.year || "—",
        v.currentKm ? v.currentKm.toLocaleString() : "—",
        v.assignedDriverName || "—",
      ], y, i % 2 === 0);
    });

    drawPageNumberL(pdf);

    const fileName = `fleet-vozila-tabelarni-${formatDateFile(new Date())}.pdf`;
    pdf.save(fileName);
    setStatus("");
    showToast(t("report_pdf_downloaded"), "success");

  } catch (e) {
    console.error("Report error:", e);
    setStatus("");
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

// ── CSV EXPORT (Excel) — ista selekcija vozila kao PDF iznad ──
// Odvojene kolone Marka/Model (umesto spojenog "Vozilo") i km kao čist
// broj (bez teksta "km") — lakše za dalje sortiranje/filtriranje/formule
// u Excel-u. ";" kao separator i BOM na početku — Excel u sr-RS regionu
// podrazumeva zapetu kao decimalni separator, pa mu je ";" ispravan
// separator kolona, a BOM obezbeđuje da se š/đ/č/ć/ž ispravno prikažu.
function exportVehiclesCSV(allVehicles) {
  const selectedIds = [...document.querySelectorAll(".chk-vehicle:checked")].map(c => c.value);
  if (selectedIds.length === 0) { showToast(t("report_select_vehicle_required"), "warning"); return; }

  const vehicles = allVehicles.filter(v => selectedIds.includes(v.id));

  const headers = [
    t("vehicle_brand"), t("vehicle_model"), t("report_table_col_plate"),
    t("report_table_col_reg"), t("report_table_col_vin"), t("vehicle_year"),
    t("vehicle_current_km"), t("report_table_col_driver"),
  ];

  const rows = vehicles.map(v => [
    v.brand || "",
    v.model || "",
    v.plate || "",
    v.regExpiry ? formatDateSr(v.regExpiry) : "",
    v.vin || "",
    v.year || "",
    v.currentKm ?? "",
    v.assignedDriverName || "",
  ]);

  const csvContent = [headers, ...rows]
    .map(row => row.map(csvEscape).join(";"))
    .join("\r\n");

  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `fleet-vozila-${formatDateFile(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  showToast(t("report_csv_downloaded"), "success");
}

function csvEscape(val) {
  const s = String(val ?? "");
  if (s.includes(";") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Header za tabelarni izveštaj — bez perioda (ovo je trenutni presek
// stanja voznog parka, ne izveštaj za vremenski period).
function drawTableReportHeader(pdf, company, pw = PW) {
  let y = M;

  pdf.setFont(REPORT_FONT, "bold");
  pdf.setFontSize(16);
  pdf.setTextColor(26, 39, 68);
  pdf.text(company.name || "Fleet Manager", M, y);
  y += 7;

  pdf.setFont(REPORT_FONT, "normal");
  pdf.setFontSize(8);
  pdf.setTextColor(100);
  const details = [
    company.pib     ? `${t("company_pib")}: ${company.pib}` : null,
    company.address ? company.address       : null,
  ].filter(Boolean);
  if (details.length > 0) {
    pdf.text(details.join("   |   "), M, y);
    y += 5;
  }

  pdf.setDrawColor(61, 126, 255);
  pdf.setLineWidth(0.5);
  pdf.line(M, y, M + pw, y);
  y += 6;

  pdf.setFont(REPORT_FONT, "bold");
  pdf.setFontSize(11);
  pdf.setTextColor(26, 39, 68);
  pdf.text(t("report_table_pdf_title"), M, y);
  y += 6;

  pdf.setFont(REPORT_FONT, "normal");
  pdf.setFontSize(8.5);
  pdf.setTextColor(120);
  pdf.text(`${t("report_pdf_generated_label")}: ${formatDateSr(new Date())}`, M, y);
  y += 6;

  return y + 2;
}

// ── IZVEŠTAJ PO VOZAČIMA ──────────────────────────────────────
async function generateDriverReport(allDrivers) {
  const selectedIds = [...document.querySelectorAll(".chk-driver:checked")].map(c => c.value);
  if (selectedIds.length === 0) { showToast(t("report_select_driver_required"), "warning"); return; }

  const from = parseDMY(document.getElementById("rep-from")?.value);
  const to   = parseDMY(document.getElementById("rep-to")?.value);
  if (!from || !to) { showToast(t("required_field"), "warning"); return; }
  to.setHours(23, 59, 59);

  setStatus(t("loading"));

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
    showToast(t("report_pdf_downloaded"), "success");

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

// Landscape dimenzije — koristi ih samo tabelarni (spreadsheet) izveštaj,
// jer mu treba više horizontalnog prostora za 7 kolona.
const PW_L = 267;  // page width  (A4 landscape 297 - 2*15)
const PH_L = 190;  // page height usable (A4 landscape 210 - 20)

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
    company.pib      ? `${t("company_pib")}: ${company.pib}`     : null,
    company.mbr      ? `${t("company_mbr")}: ${company.mbr}`     : null,
    company.address  ? company.address                            : null,
    company.phone    ? `${t("company_phone")}: ${company.phone}` : null,
    company.email    ? company.email                             : null,
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
    `${t("report_pdf_period_label")}: ${formatDateSr(from)} — ${formatDateSr(to)}   |   ${t("report_pdf_generated_label")}: ${formatDateSr(new Date())}`,
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
  pdf.text(`${t("report_pdf_page_label")} ${pageCount}`, M + PW - 10, PH + 10, { align: "right" });
}

// ── LANDSCAPE VARIJANTE (koristi ih samo tabelarni izveštaj) ──
function checkPageBreakL(pdf, y, needed = 10) {
  if (y + needed > PH_L) {
    pdf.addPage();
    drawPageNumberL(pdf);
    return M + 10;
  }
  return y;
}

function drawPageNumberL(pdf) {
  const pageCount = pdf.internal.getNumberOfPages();
  pdf.setPage(pageCount);
  pdf.setFont(REPORT_FONT, "normal");
  pdf.setFontSize(8);
  pdf.setTextColor(150);
  pdf.text(`${t("report_pdf_page_label")} ${pageCount}`, M + PW_L - 10, PH_L + 10, { align: "right" });
}

function drawTableHeaderL(pdf, cols, y) {
  y = checkPageBreakL(pdf, y, 8);
  pdf.setFillColor(26, 39, 68);
  pdf.rect(M, y - 4, PW_L, 7, "F");
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

// Red tabele koji prelama tekst po celim rečima (pdf.splitTextToSize),
// umesto da seče na fiksnom broju karaktera — potrebno za duge nazive
// vozila/vozača koji ne staju u jednu liniju. Visina reda je promenljiva:
// raste sa brojem linija koje zahteva najduži tekst u tom redu.
function drawTableRowWrapped(pdf, cols, values, y, shade = false) {
  const lineH = 4.2;

  pdf.setFont(REPORT_FONT, "normal");
  pdf.setFontSize(8);
  const wrapped = cols.map(([, width], i) => {
    const val = String(values[i] ?? "—");
    return pdf.splitTextToSize(val, width - 3);
  });
  const maxLines  = Math.max(1, ...wrapped.map(w => w.length));
  const rowHeight = maxLines * lineH + 2;

  y = checkPageBreakL(pdf, y, rowHeight + 2);

  if (shade) {
    pdf.setFillColor(248, 250, 255);
    pdf.rect(M, y - 4, PW_L, rowHeight, "F");
  }

  pdf.setTextColor(40);
  let x = M + 2;
  cols.forEach(([, width], i) => {
    let ly = y;
    wrapped[i].forEach(line => {
      pdf.text(line, x, ly);
      ly += lineH;
    });
    x += width;
  });

  return y + rowHeight + 2;
}

// ── VOZILO SEKCIJE ────────────────────────────────────────────
function drawVehicleSection(pdf, v, y) {
  y = drawSectionTitle(pdf, `${t("report_pdf_section_vehicle_label")}: ${v.brand} ${v.model} — ${v.plate}`, y);
  y = drawRow(pdf, t("vehicle_vin"),              v.vin,          y, true);
  y = drawRow(pdf, t("vehicle_year"),              v.year,         y);
  y = drawRow(pdf, t("vehicle_first_reg"),         formatDateSr(v.firstRegDate), y, true);
  y = drawRow(pdf, t("report_pdf_engine_power_label"), v.engineCc ? `${v.engineCc} cm³ / ${v.powerKw || "—"} kW` : null, y);
  y = drawRow(pdf, t("vehicle_fuel_type"),         v.fuelType ? t("fuel_" + v.fuelType) : null, y, true);
  y = drawRow(pdf, t("vehicle_seats"),             v.seats,        y);
  y = drawRow(pdf, t("vehicle_payload"),           v.payload ? `${v.payload} kg` : null, y, true);
  y = drawRow(pdf, t("vehicle_current_km"),        v.currentKm ? `${v.currentKm.toLocaleString()} km` : null, y);
  y = drawRow(pdf, t("vehicle_reg_expiry"),        formatDateSr(v.regExpiry),  y, true);
  y = drawRow(pdf, t("vehicle_insurance_expiry"),  formatDateSr(v.insuranceExpiry), y);
  y = drawRow(pdf, t("report_pdf_insurance_policy_label"), v.insuranceCompany ? `${v.insuranceCompany} / ${v.insurancePolicy || "—"}` : null, y, true);
  y = drawRow(pdf, t("vehicle_purchase_value"),    v.purchaseValue ? `${Number(v.purchaseValue).toLocaleString()} RSD` : null, y);
  return y + 4;
}

function drawAssignmentsSection(pdf, assignments, y) {
  y = drawSectionTitle(pdf, `${t("report_pdf_section_assignments")} (${assignments.length})`, y);
  if (assignments.length === 0) {
    y = drawEmptyRow(pdf, y);
    return y;
  }

  const cols = [
    [t("report_pdf_col_driver"),    55],
    [t("report_pdf_col_from"),      28],
    [t("report_pdf_col_to"),        28],
    [t("report_pdf_col_start_km"),  28],
    [t("report_pdf_col_end_km"),    28],
    [t("report_pdf_col_type"),      20],
  ];

  y = drawTableHeader(pdf, cols, y);
  assignments.forEach((a, i) => {
    y = drawTableRow(pdf, cols, [
      a.driverName,
      formatDateSr(a.startDate),
      a.endDate ? formatDateSr(a.endDate) : "—",
      a.startKm ? a.startKm.toLocaleString() : "—",
      a.endKm   ? a.endKm.toLocaleString()   : "—",
      a.tripType === "intercity" ? `${t("assignment_intercity")}: ${a.destination || ""}` : t("assignment_local"),
    ], y, i % 2 === 0);
  });

  // Ukupno km
  const totalKm = assignments.reduce((s, a) => s + ((a.endKm || 0) - (a.startKm || 0)), 0);
  if (totalKm > 0) {
    y += 2;
    pdf.setFont(REPORT_FONT, "bold");
    pdf.setFontSize(8.5);
    pdf.setTextColor(26, 39, 68);
    pdf.text(`${t("report_pdf_total_km_label")}: ${totalKm.toLocaleString()} km`, M + 2, y);
    y += 6;
  }

  return y + 2;
}

function drawServicesSection(pdf, services, y) {
  y = drawSectionTitle(pdf, `${t("report_pdf_section_services")} (${services.length})`, y);
  if (services.length === 0) { return drawEmptyRow(pdf, y); }

  const cols = [
    [t("report_pdf_col_kind"),      50],
    [t("report_pdf_col_date"),      28],
    [t("report_pdf_col_km"),        25],
    [t("report_pdf_col_cost"),      28],
    [t("report_pdf_col_workshop"),  55],
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
    pdf.text(`${t("report_pdf_total_service_cost_label")}: ${totalCost.toLocaleString()} RSD`, M + 2, y);
    y += 6;
  }

  return y + 2;
}

function drawFuelingsSection(pdf, fuelings, y) {
  y = drawSectionTitle(pdf, `${t("report_pdf_section_fuelings")} (${fuelings.length})`, y);
  if (fuelings.length === 0) { return drawEmptyRow(pdf, y); }

  const cols = [
    [t("report_pdf_col_date"),        28],
    [t("report_pdf_col_fuel"),        25],
    [t("report_pdf_col_amount"),      25],
    [t("report_pdf_col_price"),       28],
    [t("report_pdf_col_price_per_l"), 25],
    [t("report_pdf_col_station"),     55],
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
    `${t("report_pdf_fuel_total_label")}: ${totalL.toFixed(2)} L  /  ${totalCost.toLocaleString()} RSD` +
    (totalL > 0 ? `  /  ${t("report_pdf_fuel_avg_label")}: ${(totalCost/totalL).toFixed(2)} RSD/L` : ""),
    M + 2, y
  );
  return y + 8;
}

function drawCostsSection(pdf, costs, y) {
  if (costs.length === 0) return y;
  y = drawSectionTitle(pdf, `${t("report_pdf_section_costs")} (${costs.length})`, y);

  const cols = [
    [t("report_pdf_col_date"),           28],
    [t("report_pdf_col_kind"),           40],
    [t("report_pdf_col_price"),          28],
    [t("report_pdf_location_label"),     90],
  ];

  y = drawTableHeader(pdf, cols, y);
  costs.forEach((c, i) => {
    const typeLabels = {
      toll: t("trip_entry_toll"), parking: t("trip_entry_parking"),
      washing: t("trip_entry_washing"), other_cost: t("trip_entry_cost"),
    };
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
  pdf.text(`${t("report_pdf_total_other_costs_label")}: ${total.toLocaleString()} RSD`, M + 2, y);
  return y + 8;
}

function drawIncidentsSection(pdf, incidents, y) {
  if (incidents.length === 0) return y;
  y = drawSectionTitle(pdf, `${t("report_pdf_section_incidents")} (${incidents.length})`, y);

  incidents.forEach((inc, i) => {
    checkPageBreak(pdf, y, 20);
    const typeLabels = {
      fault: t("incident_fault"), damage: t("incident_damage"),
      accident: t("incident_accident"), other: t("incident_other"),
    };
    const statusLabels = {
      open: t("incident_status_open"), in_progress: t("incident_status_in_progress"),
      closed: t("incident_status_closed"),
    };

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
      pdf.text(`${t("report_pdf_location_label")}: ${inc.location}`, M + 2, y);
      y += 4.5;
    }
    if (inc.resolution) {
      pdf.setTextColor(34, 197, 94);
      pdf.text(`${t("incident_resolution_label")}: ${inc.resolution.substring(0, 80)}`, M + 2, y);
      y += 4.5;
    }
    y += 2;
  });

  return y + 2;
}

// ── VOZAČ SEKCIJE ─────────────────────────────────────────────
function drawDriverSection(pdf, d, y) {
  y = drawSectionTitle(pdf, `${t("report_pdf_section_driver_label")}: ${d.firstName} ${d.lastName}`, y);
  y = drawRow(pdf, t("driver_jmbg_label"),      d.jmbg,             y, true);
  y = drawRow(pdf, t("driver_birth_year"),      d.birthYear,        y);
  y = drawRow(pdf, t("driver_license_cat"),     d.licenseCategories,y, true);
  y = drawRow(pdf, t("driver_position"),        d.position,         y);
  y = drawRow(pdf, t("driver_phone"),           d.phone,            y, true);
  y = drawRow(pdf, t("driver_email"),           d.email,            y);
  y = drawRow(pdf, t("driver_home_address"),    d.homeAddress,      y, true);
  y = drawRow(pdf, t("driver_work_address"),    d.workAddress,      y);
  return y + 4;
}

function drawDriverAssignmentsSection(pdf, assignments, y) {
  y = drawSectionTitle(pdf, `${t("report_pdf_section_driver_assignments")} (${assignments.length})`, y);
  if (assignments.length === 0) { return drawEmptyRow(pdf, y); }

  const cols = [
    [t("report_table_col_vehicle"), 55],
    [t("report_pdf_col_plate"),     28],
    [t("report_pdf_col_from"),      25],
    [t("report_pdf_col_to"),        25],
    [t("report_pdf_col_start_km"),  25],
    [t("report_pdf_col_end_km"),    25],
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
      pdf.text(`  → ${t("assignment_intercity")}: ${a.destination}${a.route ? " / " + a.route : ""}`, M + 4, y);
      y += 4.5;
    }
  });

  if (totalKm > 0) {
    y += 2;
    pdf.setFont(REPORT_FONT, "bold");
    pdf.setFontSize(8.5);
    pdf.setTextColor(26, 39, 68);
    pdf.text(`${t("report_pdf_total_km_label")}: ${totalKm.toLocaleString()} km`, M + 2, y);
    y += 6;
  }

  return y + 2;
}

function drawEmptyRow(pdf, y) {
  pdf.setFont(REPORT_FONT, "italic");
  pdf.setFontSize(8);
  pdf.setTextColor(150);
  pdf.text(t("report_pdf_no_data"), M + 2, y);
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

// Placeholder prati jezik aplikacije (dd/mm ostaje fiksno — poslovno
// pravilo firme — menja se samo naziv za "godinu": yyyy (en) / gggg (sr)).
function datePlaceholder() {
  return getCurrentLang() === "en" ? "dd/mm/yyyy" : "dd/mm/gggg";
}

// ── DATUMI: prikaz i unos u lokalnom formatu dd/mm/yyyy ──────
// <input type="date"> prikazuje kalendar u formatu koji zavisi od
// jezika/regije podešene u browseru korisnika, ne od jezika aplikacije,
// pa koristimo tekstualno polje sa maskom umesto toga.
function toDMY(val) {
  if (!val) return "";
  const d = val.toDate ? val.toDate() : new Date(val);
  if (isNaN(d)) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function parseDMY(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

function attachDateMask(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", () => {
    const digits = el.value.replace(/\D/g, "").slice(0, 8);
    let out = digits;
    if (digits.length > 4) out = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    else if (digits.length > 2) out = `${digits.slice(0, 2)}/${digits.slice(2)}`;
    el.value = out;
  });
}
