// ============================================================
//  entries-view.js  —  Fleet Manager
//  Zajednička logika za prikaz GORIVA, PUTARINA i OSTALIH TROŠKOVA
//  (tripEntries) zajedno sa PRIJAVAMA (incidents):
//   • tab "Prijave i troškovi" kod vozila (vehicles.js)
//   • tab "Prijave i troškovi" kod vozača (drivers.js)
//   • tab "Finansijski podaci" kod vozila (vehicles.js)
//   • PDF izveštaji (reports.js) — isto sabiranje, da se brojke
//     u aplikaciji i u izveštaju nikad ne razilaze
// ============================================================

import { t, getCurrentLang, formatDateDMY } from "./i18n.js";

// ── TIPOVI UNOSA ──────────────────────────────────────────────
export const FUEL_TYPE  = "fuel";
export const COST_TYPES = ["toll", "parking", "washing", "other_cost"];
export const EXPENSE_TYPES = [FUEL_TYPE, ...COST_TYPES];

export function isExpenseEntry(e) {
  return EXPENSE_TYPES.includes(e?.type);
}

// ── POMOĆNE ───────────────────────────────────────────────────
export function toMillis(val) {
  if (!val) return 0;
  if (val.toMillis) return val.toMillis();
  const d = val instanceof Date ? val : new Date(val);
  return isNaN(d) ? 0 : d.getTime();
}

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function locale() {
  return getCurrentLang() === "sr" ? "sr-RS" : "en-GB";
}

export function fmtNum(n, maxDigits = 0) {
  return (Number(n) || 0).toLocaleString(locale(), { maximumFractionDigits: maxDigits });
}

export function fmtRsd(n) {
  return `${fmtNum(n)} RSD`;
}

// ── SABIRANJE (koristi i reports.js) ──────────────────────────
// Prima listu tripEntries dokumenata (bilo kojih tipova — nepoznati
// tipovi se ignorišu) i vraća sve zbirove na jednom mestu.
export function sumEntries(entries = []) {
  const s = {
    fuelL: 0, fuelCost: 0, fuelCount: 0, avgPricePerL: 0,
    toll: 0,    tollCount: 0,
    parking: 0, parkingCount: 0,
    washing: 0, washingCount: 0,
    other: 0,   otherCount: 0,
    costsTotal: 0,   // toll + parking + washing + other (bez goriva)
    total: 0,        // gorivo + svi ostali troškovi
  };
  for (const e of entries) {
    if (e.type === FUEL_TYPE) {
      s.fuelL    += Number(e.fuelAmount) || 0;
      s.fuelCost += Number(e.fuelCost)   || 0;
      s.fuelCount++;
    } else if (e.type === "toll")       { s.toll    += Number(e.amount) || 0; s.tollCount++; }
    else if (e.type === "parking")      { s.parking += Number(e.amount) || 0; s.parkingCount++; }
    else if (e.type === "washing")      { s.washing += Number(e.amount) || 0; s.washingCount++; }
    else if (e.type === "other_cost")   { s.other   += Number(e.amount) || 0; s.otherCount++; }
  }
  s.avgPricePerL = s.fuelL > 0 ? s.fuelCost / s.fuelL : 0;
  s.costsTotal   = s.toll + s.parking + s.washing + s.other;
  s.total        = s.fuelCost + s.costsTotal;
  return s;
}

// ── PRIJAVE: brojači po statusu ───────────────────────────────
// Nepoznat/prazan status se tretira kao "open" (isto kao incidentCard).
export function incidentStatusOf(inc) {
  return inc?.status === "in_progress" || inc?.status === "closed" ? inc.status : "open";
}

export function countIncidents(incidents = []) {
  const c = { open: 0, in_progress: 0, closed: 0, total: incidents.length };
  incidents.forEach(i => { c[incidentStatusOf(i)]++; });
  return c;
}

// ── PERIOD (Finansijski podaci) ───────────────────────────────
export const PERIODS = ["3m", "12m", "year", "all"];
export const DEFAULT_PERIOD = "12m";

// Vraća početak perioda kao Date (ili null za "sve").
export function periodStart(period, now = new Date()) {
  if (period === "3m")   { const d = new Date(now); d.setMonth(d.getMonth() - 3);  return d; }
  if (period === "12m")  { const d = new Date(now); d.setMonth(d.getMonth() - 12); return d; }
  if (period === "year") { return new Date(now.getFullYear(), 0, 1); }
  return null;
}

export function inPeriod(val, from) {
  if (!from) return true;
  const ms = toMillis(val);
  return ms > 0 && ms >= from.getTime();
}

// ── STAVKE ZA LISTU (prijave + troškovi zajedno) ──────────────
// kind: "incident" | "expense"
export function buildItems(incidents = [], entries = []) {
  const items = [
    ...incidents.map(d => ({ kind: "incident", data: d, ms: toMillis(d.createdAt) })),
    ...entries.filter(isExpenseEntry).map(d => ({ kind: "expense", data: d, ms: toMillis(d.createdAt) })),
  ];
  items.sort((a, b) => b.ms - a.ms);
  return items;
}

export const ENTRY_FILTERS = ["all", "incidents", "fuel", "toll", "other"];

export function matchesFilter(item, filter) {
  if (filter === "all") return true;
  if (filter === "incidents") return item.kind === "incident";
  if (item.kind !== "expense") return false;
  if (filter === "fuel")  return item.data.type === FUEL_TYPE;
  if (filter === "toll")  return item.data.type === "toll";
  if (filter === "other") return ["parking", "washing", "other_cost"].includes(item.data.type);
  return false;
}

export function filterCounts(items) {
  const c = {};
  ENTRY_FILTERS.forEach(f => { c[f] = items.filter(i => matchesFilter(i, f)).length; });
  return c;
}

const FILTER_META = {
  all:       { icon: "",    key: "entries_filter_all" },
  incidents: { icon: "🔧", key: "entries_filter_incidents" },
  fuel:      { icon: "⛽", key: "entries_filter_fuel" },
  toll:      { icon: "🛣️", key: "entries_filter_toll" },
  other:     { icon: "📋", key: "entries_filter_other" },
};

export function renderFilterChips(counts, active) {
  return `
    <div class="filter-chips entries-chips" id="entries-chips">
      ${ENTRY_FILTERS.map(f => `
        <button type="button" class="chip ${f === active ? "chip--active" : ""}" data-efilter="${f}">
          ${FILTER_META[f].icon ? FILTER_META[f].icon + " " : ""}${t(FILTER_META[f].key)} <span class="chip__count">${counts[f] ?? 0}</span>
        </button>
      `).join("")}
    </div>
  `;
}

// ── BROJAČI PRIJAVA (vrh taba "Prijave i troškovi") ───────────
// totalAll = ukupan broj SVEGA (prijave + gorivo + troškovi) za to vozilo/vozača
export function renderCounters(totalAll, incCounts) {
  const cell = (value, label, mod = "") => `
    <div class="entries-counter ${mod}">
      <span class="entries-counter__value">${value}</span>
      <span class="entries-counter__label">${label}</span>
    </div>`;
  return `
    <div class="entries-counters">
      ${cell(totalAll,           t("entries_counter_total"))}
      ${cell(incCounts.open,        t("incident_status_open"),        incCounts.open ? "entries-counter--danger" : "")}
      ${cell(incCounts.in_progress, t("incident_status_in_progress"), incCounts.in_progress ? "entries-counter--warn" : "")}
      ${cell(incCounts.closed,      t("incident_status_closed"))}
    </div>
  `;
}

// ── SAŽETAK TROŠKOVA ──────────────────────────────────────────
// opts: { service: {cost, count} | null, incCounts | null, openLink: bool }
export function renderSummary(sums, opts = {}) {
  const { service = null, incCounts = null, openLink = false } = opts;

  const card = (icon, label, value, sub = "", mod = "") => `
    <div class="fin-card ${mod}">
      <div class="fin-card__label">${icon} ${label}</div>
      <div class="fin-card__value">${value}</div>
      ${sub ? `<div class="fin-card__sub">${sub}</div>` : ""}
    </div>`;

  const cnt = (n) => t("entries_count_n", { n });

  const grand = sums.total + (service ? service.cost : 0);
  const unresolved = incCounts ? incCounts.open + incCounts.in_progress : 0;

  return `
    <div class="fin-summary">
      ${card("⛽", t("entries_sum_fuel"), `${fmtNum(sums.fuelL, 1)} L`,
        `${fmtRsd(sums.fuelCost)}${sums.avgPricePerL > 0 ? ` · ${t("entries_sum_avg")} ${fmtNum(sums.avgPricePerL, 2)} RSD/L` : ""}<br>${cnt(sums.fuelCount)}`)}
      ${card("🛣️", t("entries_sum_toll"),    fmtRsd(sums.toll),    cnt(sums.tollCount))}
      ${card("🅿️", t("entries_sum_parking"), fmtRsd(sums.parking), cnt(sums.parkingCount))}
      ${card("🚿", t("entries_sum_washing"), fmtRsd(sums.washing), cnt(sums.washingCount))}
      ${card("📋", t("entries_sum_other"),   fmtRsd(sums.other),   cnt(sums.otherCount))}
      ${service ? card("🔧", t("entries_sum_service"), fmtRsd(service.cost), cnt(service.count)) : ""}
    </div>

    <div class="service-total-bar fin-total-bar">
      <span>${t("entries_sum_grand_total")}:</span>
      <strong>${fmtRsd(grand)}</strong>
    </div>

    ${incCounts ? `
      <div class="fin-open ${unresolved ? "fin-open--warn" : ""}">
        <span>
          ⚠️ ${t("entries_sum_open_incidents")}: <strong>${incCounts.open}</strong>
          ${incCounts.in_progress ? ` · ${t("incident_status_in_progress")}: <strong>${incCounts.in_progress}</strong>` : ""}
        </span>
        ${openLink ? `<button type="button" class="btn btn--ghost btn--sm" id="btn-fin-open-incidents">${t("entries_sum_open_link")} →</button>` : ""}
      </div>
    ` : ""}
  `;
}

// ── MESEČNA TABELA (otvara se na klik — <details>) ────────────
// rows: [{ key, label, fuel, toll, other, service, total }]
export function monthlyRows(entries, services = []) {
  const map = new Map();
  const bucket = (ms) => {
    if (!ms) return null;
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!map.has(key)) map.set(key, { key, date: new Date(d.getFullYear(), d.getMonth(), 1), fuel: 0, toll: 0, other: 0, service: 0 });
    return map.get(key);
  };
  entries.forEach(e => {
    const b = bucket(toMillis(e.createdAt));
    if (!b) return;
    if (e.type === FUEL_TYPE)            b.fuel  += Number(e.fuelCost) || 0;
    else if (e.type === "toll")          b.toll  += Number(e.amount) || 0;
    else if (["parking", "washing", "other_cost"].includes(e.type)) b.other += Number(e.amount) || 0;
  });
  services.forEach(s => {
    const b = bucket(toMillis(s.serviceDate));
    if (b) b.service += Number(s.cost) || 0;
  });
  return [...map.values()]
    .sort((a, b) => b.date - a.date)
    .map(r => ({ ...r, total: r.fuel + r.toll + r.other + r.service }));
}

export function monthLabel(date) {
  const s = date.toLocaleDateString(locale(), { month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function renderMonthlyTable(rows, { withService = true } = {}) {
  if (rows.length === 0) return "";
  const tot = rows.reduce((a, r) => ({
    fuel: a.fuel + r.fuel, toll: a.toll + r.toll, other: a.other + r.other,
    service: a.service + r.service, total: a.total + r.total,
  }), { fuel: 0, toll: 0, other: 0, service: 0, total: 0 });

  const num = (v) => v ? fmtNum(v) : "—";
  return `
    <details class="fin-monthly">
      <summary>📊 ${t("entries_monthly_title")}</summary>
      <div class="fin-monthly__scroll">
        <table class="fin-monthly__table">
          <thead>
            <tr>
              <th>${t("entries_monthly_month")}</th>
              <th>${t("entries_sum_fuel")}</th>
              <th>${t("entries_sum_toll")}</th>
              <th>${t("entries_monthly_other")}</th>
              ${withService ? `<th>${t("entries_sum_service")}</th>` : ""}
              <th>${t("entries_monthly_total")}</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${monthLabel(r.date)}</td>
                <td>${num(r.fuel)}</td>
                <td>${num(r.toll)}</td>
                <td>${num(r.other)}</td>
                ${withService ? `<td>${num(r.service)}</td>` : ""}
                <td><strong>${num(r.total)}</strong></td>
              </tr>
            `).join("")}
          </tbody>
          <tfoot>
            <tr>
              <td>${t("entries_monthly_sum")}</td>
              <td>${num(tot.fuel)}</td>
              <td>${num(tot.toll)}</td>
              <td>${num(tot.other)}</td>
              ${withService ? `<td>${num(tot.service)}</td>` : ""}
              <td><strong>${num(tot.total)}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="fin-monthly__hint">RSD</div>
    </details>
  `;
}

// ── KOMPAKTAN RED ZA GORIVO / TROŠAK ──────────────────────────
// opts: { showDriver, showPlate }
export function expenseRow(e, { showDriver = false, showPlate = false } = {}) {
  const icons = { fuel: "⛽", toll: "🛣️", parking: "🅿️", washing: "🚿", other_cost: "📋" };
  const labels = {
    fuel: t("trip_entry_fuel"), toll: t("trip_entry_toll"), parking: t("trip_entry_parking"),
    washing: t("trip_entry_washing"), other_cost: t("trip_entry_cost"),
  };

  let main, sub = [];
  if (e.type === FUEL_TYPE) {
    const l = Number(e.fuelAmount) || 0;
    main = `<strong>${fmtNum(l, 2)} L</strong> · <strong>${fmtRsd(e.fuelCost)}</strong>`;
    if (e.fuelType) sub.push(esc(t("fuel_" + e.fuelType)));
    if (e.pricePerL) sub.push(`${fmtNum(e.pricePerL, 2)} RSD/L`);
    if (e.fuelStation) {
      sub.push(`🏪 ${esc(e.fuelStation)}${e.fuelStationContracted === false
        ? ` <span class="badge badge--service badge--inline">${t("trip_fuel_off_contract_badge")}</span>` : ""}`);
    }
  } else {
    main = `<strong>${fmtRsd(e.amount)}</strong>`;
    if (e.location) sub.push(`📍 ${esc(e.location)}`);
  }
  if (e.currentKm)  sub.push(`🛣️ ${fmtNum(e.currentKm)} km`);
  if (e.receiptNo)  sub.push(`${t("trip_fuel_receipt")}: ${esc(e.receiptNo)}`);

  const who = [];
  if (showPlate  && e.vehiclePlate) who.push(`🚗 ${esc(e.vehiclePlate)}`);
  if (showDriver && e.driverName)   who.push(`👤 ${esc(e.driverName)}`);

  return `
    <div class="ledger-row ledger-row--${e.type === FUEL_TYPE ? "fuel" : "cost"}">
      <div class="ledger-row__icon">${icons[e.type] || "📋"}</div>
      <div class="ledger-row__body">
        <div class="ledger-row__main">
          <span class="badge badge--${e.type === FUEL_TYPE ? "info" : "inactive"}">${labels[e.type] || esc(e.type)}</span>
          ${main}
        </div>
        ${sub.length ? `<div class="ledger-row__sub">${sub.join(" · ")}</div>` : ""}
        ${who.length ? `<div class="ledger-row__sub">${who.join(" · ")}</div>` : ""}
        ${e.notes ? `<div class="ledger-row__notes">${esc(e.notes)}</div>` : ""}
      </div>
      <div class="ledger-row__date">${formatDateDMY(e.createdAt)}</div>
    </div>
  `;
}

// ── GRUPISANJE PO MESECU (za listu vozila) ────────────────────
// renderItem(item) => html. Vraća HTML sa naslovima meseci.
export function renderByMonth(items, renderItem) {
  const groups = [];
  let cur = null;
  items.forEach(it => {
    const d = it.ms ? new Date(it.ms) : null;
    const key = d ? `${d.getFullYear()}-${d.getMonth()}` : "none";
    if (!cur || cur.key !== key) {
      cur = { key, label: d ? monthLabel(d) : "—", items: [] };
      groups.push(cur);
    }
    cur.items.push(it);
  });
  return groups.map(g => `
    <div class="entries-month">
      <div class="entries-month__title">${g.label} <span class="entries-month__count">${g.items.length}</span></div>
      <div class="entries-month__items">${g.items.map(renderItem).join("")}</div>
    </div>
  `).join("");
}
