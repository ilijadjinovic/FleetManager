// ============================================================
//  fiscal-qr.js  —  Fleet Manager
//  Dekodiranje QR koda srpskog fiskalnog računa (suf.purs.gov.rs)
//  + skener (kamera / fotografija).
//
//  Opcija A: iz QR-a se čita SAMO ono što je u njemu kodirano —
//  broj računa, ukupan iznos i datum/vreme. Količina litara,
//  cena po litru i vrsta goriva NISU u QR-u (nalaze se na stranici
//  poreske uprave), pa ih aplikacija ne dobija odavde.
//
//  Raspored `vl` parametra (base64, little-endian):
//    0      1B  verzija
//    1..8   8B  requestedBy (ASCII)
//    9..16  8B  signedBy    (ASCII)
//    17..20 4B  totalCounter (uint32 LE)
//    21..24 4B  transactionTypeCounter (uint32 LE)
//    25..32 8B  ukupan iznos (int64 LE, u 1/10000 dinara)
//    33..40 8B  datum/vreme (uint64 BE, ms od 1.1.1970. UTC)
//  Broj računa = requestedBy-signedBy-totalCounter
// ============================================================

import { t } from "./i18n.js";

const ALLOWED_HOSTS = ["suf.purs.gov.rs", "sandbox.suf.purs.gov.rs"];

/**
 * Dekodira tekst iz QR koda. Vraća
 *   { invoiceNo, totalAmount, dateTime }  ili  null ako nije fiskalni račun.
 */
export function decodeFiscalQr(text) {
  try {
    const url = new URL(String(text).trim());
    if (!ALLOWED_HOSTS.includes(url.hostname)) return null;
    let vl = url.searchParams.get("vl");
    if (!vl) return null;

    // searchParams već dekodira %2F/%3D; '+' bi postao razmak → vrati ga
    vl = vl.replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(vl);
    if (bin.length < 41) return null;
    const b = Uint8Array.from(bin, c => c.charCodeAt(0));
    const dv = new DataView(b.buffer);

    const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
    const requestedBy = ascii(1, 9);
    const signedBy    = ascii(9, 17);
    if (!/^[A-Za-z0-9]{8}$/.test(requestedBy) || !/^[A-Za-z0-9]{8}$/.test(signedBy)) return null;

    const counter   = dv.getUint32(17, true);
    const amountRaw = dv.getBigInt64(25, true);
    const msBig     = dv.getBigUint64(33, false);

    const totalAmount = Number(amountRaw) / 10000;
    const dateTime    = new Date(Number(msBig));
    if (!(totalAmount > 0) || isNaN(dateTime)) return null;
    const year = dateTime.getUTCFullYear();
    if (year < 2020 || year > 2100) return null;

    return {
      invoiceNo: `${requestedBy}-${signedBy}-${counter}`,
      totalAmount: Math.round(totalAmount * 100) / 100,
      dateTime,
    };
  } catch {
    return null;
  }
}

// ── jsQR (lokalna kopija, učitava se tek kad zatreba) ─────────
let jsQRPromise = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsQRPromise) {
    jsQRPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "./vendor/jsQR.js";
      s.onload  = () => window.jsQR ? resolve(window.jsQR) : reject(new Error("jsQR"));
      s.onerror = () => { jsQRPromise = null; reject(new Error("jsQR load")); };
      document.head.appendChild(s);
    });
  }
  return jsQRPromise;
}

/** Vraća funkciju (canvasOrBitmap-ImageData) → string|null */
async function makeDecoder() {
  if ("BarcodeDetector" in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) {
        const det = new window.BarcodeDetector({ formats: ["qr_code"] });
        return async (source /* canvas | image */) => {
          const res = await det.detect(source);
          return res[0]?.rawValue || null;
        };
      }
    } catch { /* pređi na jsQR */ }
  }
  const jsQR = await loadJsQR();
  return async (source) => {
    const w = source.width || source.naturalWidth;
    const h = source.height || source.naturalHeight;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    return jsQR(img.data, w, h, { inversionAttempts: "dontInvert" })?.data || null;
  };
}

/**
 * Otvara ekran skenera preko trenutnog modala.
 * Poziva onResult(decoded) kad pročita ispravan fiskalni račun.
 */
export async function openFiscalScanner(onResult) {
  const overlay = document.createElement("div");
  overlay.className = "qr-scan-overlay";
  overlay.innerHTML = `
    <div class="qr-scan">
      <div class="qr-scan__title">${t("qr_scan_title")}</div>
      <div class="qr-scan__viewport">
        <video class="qr-scan__video" playsinline muted></video>
        <div class="qr-scan__frame"></div>
      </div>
      <p class="qr-scan__hint" id="qr-scan-hint">${t("qr_scan_hint")}</p>
      <div class="qr-scan__actions">
        <label class="btn btn--secondary btn--sm">
          📷 ${t("qr_scan_from_photo")}
          <input type="file" accept="image/*" id="qr-scan-file" hidden />
        </label>
        <button type="button" class="btn btn--secondary btn--sm" id="qr-scan-cancel">${t("cancel")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const video  = overlay.querySelector("video");
  const hintEl = overlay.querySelector("#qr-scan-hint");
  const setHint = (msg, isError = false) => {
    hintEl.textContent = msg;
    hintEl.classList.toggle("qr-scan__hint--error", isError);
  };

  let stream = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    stream?.getTracks().forEach(tr => tr.stop());
    overlay.remove();
  };
  overlay.querySelector("#qr-scan-cancel").onclick = stop;

  let decodeSource;
  try {
    decodeSource = await makeDecoder();
  } catch {
    setHint(t("qr_scan_lib_error"), true);
    return;
  }

  const handleText = (text) => {
    const decoded = decodeFiscalQr(text);
    if (!decoded) return false;
    stop();
    onResult(decoded);
    return true;
  };

  // Fotografija (rezerva: iOS, odbijena dozvola za kameru...)
  overlay.querySelector("#qr-scan-file").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setHint(t("qr_scan_reading"));
    try {
      const bmp = await createImageBitmap(file);
      const text = await decodeSource(bmp);
      if (!text || !handleText(text)) setHint(t("qr_scan_photo_fail"), true);
    } catch {
      setHint(t("qr_scan_photo_fail"), true);
    }
  };

  // Kamera uživo
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    if (stopped) { stream.getTracks().forEach(tr => tr.stop()); return; }
    video.srcObject = stream;
    await video.play();
  } catch {
    setHint(t("qr_scan_camera_denied"), true);
    return;
  }

  let notFiscalShown = false;
  const tick = async () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const text = await decodeSource(video);
        if (text && !handleText(text) && !notFiscalShown) {
          notFiscalShown = true;
          setHint(t("qr_scan_not_fiscal"), true);
        }
      }
    } catch { /* sledeći frejm */ }
    if (!stopped) setTimeout(tick, 250);
  };
  tick();
}
