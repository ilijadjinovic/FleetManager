// ============================================================
//  receipt-scan.js  —  Fleet Manager
//  Skeniranje QR koda fiskalnog računa + učitavanje podataka računa
//
//  1) parseFiscalQR()  — čita PFR broj, iznos i vreme direktno iz QR
//                        koda (radi bez interneta i bez servera)
//  2) fetchReceiptDetails() — poziva Cloudflare Worker koji sa
//                        suf.purs.gov.rs učita pumpu, adresu, gorivo,
//                        litre i cenu po litru
// ============================================================

import { auth } from "./firebase.js";
import { t } from "./i18n.js";

// Adresa Cloudflare Worker-a, npr. "https://fleet-receipt.moj-nalog.workers.dev"
// Dok je prazna, koriste se samo podaci iz QR koda.
export const RECEIPT_WORKER_URL = "https://fleet-receipt.ilija-djinovic.workers.dev";

const JSQR_URL = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";

// ── 1) QR sadržaj ─────────────────────────────────────────────
/**
 * Raspakuje link iz QR koda fiskalnog računa (suf.purs.gov.rs/v/?vl=...).
 * Vraća { pfr, amount, dateTime } ili null ako to nije fiskalni QR.
 */
export function parseFiscalQR(text) {
  let u;
  try { u = new URL(String(text).trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== "suf.purs.gov.rs") return null;
  const vl = u.searchParams.get("vl");
  if (!vl) return null;

  let bytes;
  try {
    const bin = atob(vl.replace(/ /g, "+"));
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch { return null; }
  if (bytes.length < 41) return null;

  const dv = new DataView(bytes.buffer);
  const id = String.fromCharCode(...bytes.slice(1, 17));
  if (!/^[A-Z0-9]{16}$/.test(id)) return null;

  const counter = dv.getUint32(17, true);
  const amountRaw = dv.getUint32(25, true) + dv.getUint32(29, true) * 4294967296;
  const ms = dv.getUint32(33, false) * 4294967296 + dv.getUint32(37, false);
  if (!counter || !ms) return null;

  const pfr = `${id.slice(0, 8)}-${id.slice(8, 16)}-${counter}`;
  const amount = Math.round(amountRaw / 100) / 100;

  // Vreme računa po beogradskom vremenu → "YYYY-MM-DDTHH:MM:SS"
  const dateTime = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Belgrade",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms)).replace(" ", "T");

  return { pfr, amount, dateTime };
}

// ── 2) Podaci sa računa preko Worker-a ────────────────────────
export function receiptWorkerConfigured() {
  return !!RECEIPT_WORKER_URL;
}

export async function fetchReceiptDetails(url) {
  if (!RECEIPT_WORKER_URL) throw new Error("not_configured");
  const user = auth.currentUser;
  if (!user) throw new Error("no_auth");
  const token = await user.getIdToken();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(RECEIPT_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      const err = new Error(data?.error || `http_${res.status}`);
      err.diag = data?.diag;
      throw err;
    }
    return data.receipt;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("timeout");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── 3) Skener (kamera) ────────────────────────────────────────
let _jsQRPromise = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve();
  if (!_jsQRPromise) {
    _jsQRPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = JSQR_URL;
      s.onload = resolve;
      s.onerror = () => { _jsQRPromise = null; reject(new Error("jsqr_load")); };
      document.head.appendChild(s);
    });
  }
  return _jsQRPromise;
}

/**
 * Otvara kameru preko celog ekrana i vraća tekst prvog pročitanog QR koda.
 * Vraća null ako korisnik zatvori skener. Baca grešku sa .code:
 * "denied" (nema dozvole) ili "unavailable" (nema kamere / nije HTTPS).
 */
export async function scanQRCode() {
  if (!navigator.mediaDevices?.getUserMedia) {
    const e = new Error("unavailable"); e.code = "unavailable"; throw e;
  }

  const overlay = document.createElement("div");
  overlay.className = "scan-overlay";
  overlay.innerHTML = `
    <video class="scan-overlay__video" playsinline muted autoplay></video>
    <div class="scan-overlay__frame"></div>
    <div class="scan-overlay__hint">${t("receipt_scan_hint")}</div>
    <button type="button" class="scan-overlay__close" aria-label="${t("receipt_scan_close")}">✕</button>
  `;
  document.body.appendChild(overlay);
  const video = overlay.querySelector("video");

  let stream = null;
  let finished = false;
  let resolveFn;
  const result = new Promise((res) => { resolveFn = res; });

  const finish = (value) => {
    if (finished) return;
    finished = true;
    stream?.getTracks().forEach((tr) => tr.stop());
    overlay.remove();
    resolveFn(value);
  };
  overlay.querySelector(".scan-overlay__close").onclick = () => finish(null);

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (e) {
    overlay.remove();
    const err = new Error("camera");
    err.code = (e.name === "NotAllowedError" || e.name === "SecurityError") ? "denied" : "unavailable";
    throw err;
  }
  if (finished) { stream.getTracks().forEach((tr) => tr.stop()); return result; }

  video.srcObject = stream;
  try { await video.play(); } catch { /* autoplay je već uključen */ }

  // Ugrađeni detektor (Chrome/Android) ili jsQR (iPhone i ostali)
  let detector = null;
  if ("BarcodeDetector" in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    } catch { /* koristi jsQR */ }
  }
  if (!detector) {
    try { await loadJsQR(); }
    catch { finish(null); const e = new Error("jsqr"); e.code = "unavailable"; throw e; }
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const tick = async () => {
    if (finished) return;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        if (detector) {
          const codes = await detector.detect(video);
          if (codes.length) return finish(codes[0].rawValue);
        } else {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          if (code?.data) return finish(code.data);
        }
      } catch { /* sledeći kadar */ }
    }
    setTimeout(tick, 200);
  };
  tick();

  return result;
}
