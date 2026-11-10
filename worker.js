// ============================================================
//  Fleet Manager — Cloudflare Worker: čitanje fiskalnog računa
//
//  Prima link iz QR koda (suf.purs.gov.rs/v/?vl=...), preuzima račun
//  sa poreske uprave i vraća JSON sa podacima za formu za gorivo.
//
//  PROMENLJIVE (Settings → Variables and Secrets):
//    FIREBASE_PROJECT_ID  npr. fleet-manager-cfd6c
//    ALLOWED_ORIGINS      adrese aplikacije, odvojene zarezom,
//                         npr. https://fleet-manager-cfd6c.web.app
//                         (bez kose crte na kraju i bez putanje)
// ============================================================

const SUF_HOST = "suf.purs.gov.rs";
const UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

// PIB prodavca → naziv lanca. Dopunjava se po potrebi (PIB je na računu).
const PIB_CHAINS = {
  "104052135": "NIS",
};

// Naziv firme sa računa → naziv lanca (ako PIB nije u tabeli iznad)
const CHAIN_PATTERNS = [
  [/\bNIS\b/, "NIS"],
  [/\bOMV\b/, "OMV"],
  [/\bMOL\b/, "MOL"],
  [/LUK ?OIL/, "Lukoil"],
  [/GAZPROM/, "Gazprom"],
  [/\bEKO\b/, "EKO"],
  [/\bPETROL\b/, "Petrol"],
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowed.includes(origin)) return new Response("Forbidden", { status: 403 });

    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

    // 1) Samo prijavljeni korisnici Firebase projekta
    try {
      const auth = request.headers.get("Authorization") || "";
      if (!auth.startsWith("Bearer ")) throw new Error("no token");
      await verifyFirebaseToken(auth.slice(7), env.FIREBASE_PROJECT_ID);
    } catch {
      return json({ ok: false, error: "unauthorized" }, 401, cors);
    }

    // 2) Samo linkovi sa suf.purs.gov.rs
    let rawUrl, sufUrl;
    try {
      const body = await request.json();
      rawUrl = String(body?.url || "");
      sufUrl = validateSufUrl(rawUrl);
    } catch {
      return json({ ok: false, error: "bad_url" }, 400, cors);
    }

    // 3) Učitavanje i parsiranje računa
    try {
      const result = await loadReceipt(rawUrl, sufUrl);
      return json(result, result.ok ? 200 : 502, cors);
    } catch (e) {
      return json(
        { ok: false, error: "fetch_failed", diag: { message: String(e?.message || e).slice(0, 120) } },
        502,
        cors
      );
    }
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function validateSufUrl(raw) {
  if (!raw || raw.length > 4000) throw new Error("length");
  const u = new URL(raw);
  if (u.protocol !== "https:" || u.hostname !== SUF_HOST) throw new Error("host");
  if (!u.pathname.startsWith("/v/") || !u.searchParams.get("vl")) throw new Error("path");
  return u;
}

// ── Provera Firebase ID tokena (RS256, Google javni ključevi) ──
let jwkCache = { keys: null, fetchedAt: 0 };

async function getJwk(kid) {
  const age = Date.now() - jwkCache.fetchedAt;
  const have = jwkCache.keys?.find((k) => k.kid === kid);
  if (!have && (age > 5 * 60 * 1000 || !jwkCache.keys)) {
    const r = await fetch(
      "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
    );
    if (!r.ok) throw new Error("jwk fetch");
    const j = await r.json();
    jwkCache = { keys: j.keys || [], fetchedAt: Date.now() };
  }
  const k = jwkCache.keys?.find((x) => x.kid === kid);
  if (!k) throw new Error("unknown kid");
  return k;
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const b64urlToString = (s) => new TextDecoder().decode(b64urlToBytes(s));

async function verifyFirebaseToken(token, projectId) {
  if (!projectId) throw new Error("no project id");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("format");
  const [h, p, s] = parts;
  const header = JSON.parse(b64urlToString(h));
  const payload = JSON.parse(b64urlToString(p));
  if (header.alg !== "RS256" || !header.kid) throw new Error("alg");

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error("aud");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("iss");
  if (!payload.sub) throw new Error("sub");
  if (!(payload.exp > now)) throw new Error("expired");
  if (payload.iat > now + 300) throw new Error("iat");

  const jwk = await getJwk(header.kid);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`)
  );
  if (!ok) throw new Error("signature");
  return payload;
}

// ── Preuzimanje računa ─────────────────────────────────────────
async function loadReceipt(rawUrl, sufUrl) {
  const diag = {};
  const page = await fetch(rawUrl, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "sr,en;q=0.8",
    },
    redirect: "follow",
  });
  diag.pageStatus = page.status;
  if (!page.ok) return { ok: false, error: "page_unavailable", diag };

  const html = await page.text();
  diag.htmlLength = html.length;
  const cookies = (page.headers.getSetCookie ? page.headers.getSetCookie() : [])
    .map((c) => c.split(";")[0])
    .join("; ");

  // 1) Žurnal (tekst računa) u samoj stranici
  let journal = extractJournal(html);
  diag.journalInPage = !!journal;

  // 2) Specifikacija računa (stavke) — poseban poziv koji koristi i sama stranica
  const spec = await loadSpecifications(html, rawUrl, cookies, diag);
  if (!journal && spec?.journal) {
    journal = extractJournal(spec.journal);
    diag.journalInSpec = !!journal;
  }

  let receipt = null;
  let source = null;
  if (journal) {
    receipt = parseJournal(journal);
    diag.journalParsed = !!receipt;
    if (receipt) source = "journal";
  }
  if (!receipt) {
    receipt = parsePage(htmlToText(html), spec?.items);
    if (receipt) source = "page";
  }
  if (!receipt || !receipt.items?.length) {
    return { ok: false, error: journal ? "journal_unparsed" : "journal_not_found", diag };
  }
  return { ok: true, source, receipt: finalize(receipt) };
}

function grab(html, regexes) {
  for (const re of regexes) {
    const m = re.exec(html);
    if (m && m[1]) return m[1];
  }
  return null;
}

async function loadSpecifications(html, rawUrl, cookies, diag) {
  const inv = grab(html, [
    /invoiceNumber["']?\s*[:=]\s*["']([^"']+)["']/i,
    /name=["']InvoiceNumber["'][^>]*?value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*?name=["']InvoiceNumber["']/i,
  ]);
  const token = grab(html, [
    /(?<![A-Za-z])token["']?\s*[:=]\s*["']([^"']+)["']/i,
    /name=["']Token["'][^>]*?value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*?name=["']Token["']/i,
  ]);
  diag.hasInvoiceNumber = !!inv;
  diag.hasToken = !!token;
  if (!inv || !token) return null;

  const res = await fetch(`https://${SUF_HOST}/specifications`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*; q=0.01",
      Referer: rawUrl,
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: new URLSearchParams({ invoiceNumber: inv, token }).toString(),
  });
  diag.specStatus = res.status;
  if (!res.ok) return null;

  let data;
  try {
    data = await res.json();
  } catch {
    diag.specJson = false;
    return null;
  }
  diag.specKeys = Object.keys(data || {}).slice(0, 12);

  const items = Array.isArray(data?.items)
    ? data.items
        .map((it) => {
          const name = String(it?.name ?? "").trim();
          const quantity = Number(it?.quantity);
          const unitPrice = Number(it?.unitPrice);
          const total = Number(it?.totalAmount ?? it?.total);
          if (!name || !(quantity > 0)) return null;
          return { name: cleanItemName(name), tariff: tariffOf(name), quantity, unitPrice, total };
        })
        .filter(Boolean)
    : null;
  const journal = typeof data?.journal === "string" ? data.journal : null;
  return { items, journal };
}

// ── Pomoćne funkcije za tekst ──────────────────────────────────
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function decodeJsEscapes(s) {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\r\\n|\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, " ")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"');
}

function htmlToText(html) {
  const noScripts = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  return decodeEntities(
    noScripts
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h\d|pre|table|section|label|td|th)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  );
}

const CYR = {
  А: "A", Б: "B", В: "V", Г: "G", Д: "D", Ђ: "Đ", Е: "E", Ж: "Ž", З: "Z", И: "I", Ј: "J",
  К: "K", Л: "L", Љ: "Lj", М: "M", Н: "N", Њ: "Nj", О: "O", П: "P", Р: "R", С: "S", Т: "T",
  Ћ: "Ć", У: "U", Ф: "F", Х: "H", Ц: "C", Ч: "Č", Џ: "Dž", Ш: "Š",
  а: "a", б: "b", в: "v", г: "g", д: "d", ђ: "đ", е: "e", ж: "ž", з: "z", и: "i", ј: "j",
  к: "k", л: "l", љ: "lj", м: "m", н: "n", њ: "nj", о: "o", п: "p", р: "r", с: "s", т: "t",
  ћ: "ć", у: "u", ф: "f", х: "h", ц: "c", ч: "č", џ: "dž", ш: "š",
};
const toLatin = (s) => String(s ?? "").replace(/[\u0400-\u04FF]/g, (c) => CYR[c] ?? c);

const SMALL_WORDS = new Set(["sa", "i", "u", "na", "od", "za", "do", "kod", "pod", "iz", "uz"]);
function titleCase(s) {
  return toLatin(s)
    .toLowerCase()
    .replace(/[\p{L}\p{N}]+/gu, (w, off) =>
      off > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)
    );
}

const parseNum = (s) => Number(String(s).replace(/\./g, "").replace(",", "."));

// ── Žurnal ─────────────────────────────────────────────────────
function extractJournal(src) {
  const s = decodeJsEscapes(decodeEntities(String(src)));
  const m = /={3,}\s*(?:ФИСКАЛНИ РАЧУН|FISKALNI RA[CČ]UN)\s*={3,}/i.exec(s);
  if (!m) return null;
  const rest = s.slice(m.index);
  const end = /(?:КРАЈ ФИСКАЛНОГ РАЧУНА|KRAJ FISKALNOG RA[CČ]UNA)[\s=]*/i.exec(rest);
  const region = end ? rest.slice(0, end.index + end[0].length) : rest.slice(0, 4000);
  return region.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
}

function tariffOf(name) {
  const m = /,\s*(\d{8,10})\b/.exec(name);
  return m ? m[1] : null;
}

// "EVRO PREMIJUM BMB-95,2710124500 /LIT (Ђ )" → "EVRO PREMIJUM BMB-95"
function cleanItemName(name) {
  return String(name)
    .replace(/\s*\(\s*\S\s*\)\s*$/, "")
    .replace(/\s*\/\s*(LIT|L|KG|KOM)\b.*$/i, "")
    .replace(/,\s*\d{8,10}\b/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJournal(raw) {
  const text = toLatin(raw);
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));

  const iHead = lines.findIndex((l) => /={3,}\s*FISKALNI RA[CČ]UN\s*={3,}/i.test(l));
  if (iHead < 0) return null;

  // Zaglavlje: PIB, firma, [objekat], adresa, grad — do prve linije sa ":" ili crtama
  const head = [];
  for (let i = iHead + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^[=\-]{3,}/.test(l) || l.includes(":")) break;
    head.push(l);
  }
  const pib = /^\d{9}$/.test(head[0] || "") ? head[0] : null;
  const rest = pib ? head.slice(1) : head;
  const companyRaw = rest[0] || null;
  let object = null, address = null, city = null;
  if (rest.length >= 4) [, object, address, city] = [rest[0], rest[1], rest[rest.length - 2], rest[rest.length - 1]];
  else if (rest.length === 3) [address, city] = [rest[1], rest[2]];
  else if (rest.length === 2) address = rest[1];

  // Stavke: između zaglavlja tabele i "Ukupan iznos:"
  const iItems = lines.findIndex((l, i) => i > iHead && /Naziv\s+Cena\s+Kol/i.test(l));
  if (iItems < 0) return null;
  const iTotal = lines.findIndex((l, i) => i > iItems && /^\s*Ukupan iznos\s*:/i.test(l));
  if (iTotal < 0) return null;

  const block = lines
    .slice(iItems + 1, iTotal)
    .filter((l) => !/^[=\-\s]*$/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  // Stavke: [naziv] cena količina ukupno. Tri uzastopna broja se prihvataju samo
  // ako cena × količina ≈ ukupno (da se brojevi iz naziva, npr. "COLA 0,33", ne
  // pomešaju sa cenom). Podržani: celobrojna količina, 2-4 decimale, negativne (popust).
  const NUM_RE = /^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/;
  const tokens = block.split(" ").filter(Boolean);
  const items = [];
  let nameStart = 0;
  for (let i = 0; i + 2 < tokens.length; i++) {
    const [a, b, c] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (i === nameStart || !NUM_RE.test(a) || !NUM_RE.test(b) || !NUM_RE.test(c)) continue;
    const [unitPrice, quantity, total] = [parseNum(a), parseNum(b), parseNum(c)];
    if (Math.abs(unitPrice * quantity - total) > Math.max(0.05, Math.abs(total) * 0.01)) continue;
    const name = tokens.slice(nameStart, i).join(" ");
    items.push({ name: cleanItemName(name), tariff: tariffOf(name), unitPrice, quantity, total });
    nameStart = i + 3;
    i += 2;
  }

  const tm = /Ukupan iznos\s*:\s*([\d.]*\d,\d{2})/i.exec(lines[iTotal]);
  const total = tm ? parseNum(tm[1]) : null;

  const timeM = /PFR vreme\s*:\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\.?\s+(\d{1,2}):(\d{2}):(\d{2})/i.exec(text);
  const time = timeM
    ? `${timeM[3]}-${timeM[2].padStart(2, "0")}-${timeM[1].padStart(2, "0")}T${timeM[4].padStart(2, "0")}:${timeM[5]}:${timeM[6]}`
    : null;

  // PFR broj je u žurnalu često prelomljen u dva reda ("...-38769" / "1")
  const pfrM = /PFR broj ra[cč]una\s*:\s*([A-Z0-9]{8}-[A-Z0-9]{8}-)([\d\s]+?)\s*\n\s*(?:Broja|[=\-])/i.exec(text);
  const pfr = pfrM ? pfrM[1] + pfrM[2].replace(/\s+/g, "") : null;

  return { pib, companyRaw, object, address, city, total, time, pfr, items };
}

// Rezerva: podaci sa same stranice računa (labele) + stavke iz specifikacije
function parsePage(pageText, items) {
  if (!items?.length) return null;
  const lines = toLatin(pageText)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const after = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    return i >= 0 ? lines[i + 1] || null : null;
  };
  const pib = after(/^PIB$/i);
  const object = after(/^Ime prodajnog mesta$/i);
  const address = after(/^Adresa$/i);
  const city = after(/^Grad$/i);
  const totalS = after(/^Ukupan iznos$/i);
  const timeS = after(/^PFR vreme/i);
  const pfr = after(/^Zatra[zž]io - Potpisao - Broja/i);

  const tm = timeS && /(\d{1,2})\.(\d{1,2})\.(\d{4})\.?\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(timeS);
  return {
    pib: pib && /^\d{9}$/.test(pib) ? pib : null,
    companyRaw: null,
    object,
    address,
    city,
    total: totalS ? parseNum(totalS) : null,
    time: tm
      ? `${tm[3]}-${tm[2].padStart(2, "0")}-${tm[1].padStart(2, "0")}T${tm[4].padStart(2, "0")}:${tm[5]}:${tm[6]}`
      : null,
    pfr: pfr && /^[A-Z0-9]{8}-[A-Z0-9]{8}-\d+$/.test(pfr) ? pfr : null,
    items,
  };
}

// ── Vrsta goriva i lanac ───────────────────────────────────────
// Naziv artikla + carinska tarifna oznaka (npr. 2710124500 = benzin).
// Oznake za dizel/TNG/CNG su prema tarifi, proveriti na pravom računu.
function classifyFuel(name, tariff) {
  const n = String(name).toUpperCase();
  if (/DIZEL|DIESEL|\bD2\b|EVRODIZ|EURODIZ/.test(n)) return "diesel";
  if (/\bTNG\b|\bLPG\b|AUTOGAS|AUTO GAS/.test(n)) return "lpg";
  if (/\bCNG\b|\bKPG\b/.test(n)) return "cng";
  if (/ELEKTR|PUNJENJE|\bKWH\b/.test(n)) return "electric";
  if (/BMB|BENZIN|EURO ?SUPER|EVRO ?SUPER/.test(n)) return "petrol";
  const t = String(tariff || "");
  if (/^271012/.test(t)) return "petrol";
  if (/^271019/.test(t)) return "diesel";
  if (/^271121/.test(t)) return "cng";
  if (/^2711/.test(t)) return "lpg";
  return null;
}

function chainName(companyRaw, pib) {
  if (pib && PIB_CHAINS[pib]) return PIB_CHAINS[pib];
  const c = toLatin(companyRaw || "").toUpperCase();
  for (const [re, name] of CHAIN_PATTERNS) if (re.test(c)) return name;
  return companyRaw ? titleCase(companyRaw) : null;
}

function finalize(r) {
  return {
    pib: r.pib,
    chain: chainName(r.companyRaw, r.pib),
    object: r.object ? toLatin(r.object) : null,
    address: r.address ? titleCase(r.address) : null,
    city: r.city ? titleCase(r.city.split(/[-(]/)[0].trim()) : null,
    pfr: r.pfr,
    time: r.time,
    total: r.total,
    items: r.items.map((it) => ({
      name: it.name,
      tariff: it.tariff,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      total: it.total,
      fuelType: classifyFuel(it.name, it.tariff),
    })),
  };
}
