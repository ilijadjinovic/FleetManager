// ============================================================
//  receipt-guard.js  —  Fleet Manager
//  Zaštita od unosa istog računa (PFR broj) više puta.
//
//  Tri sloja:
//   1) Normalizacija broja računa (razmaci, mala slova, razne crtice),
//      da isti račun ne prođe samo zato što je drugačije ukucan.
//   2) Provera u bazi PRE snimanja (poruka sa detaljima prvog unosa).
//   3) Snimanje u transakciji pod determinističkim ID-jem dokumenta
//      ("r_" + normalizovan broj računa). Dva istovremena unosa istog
//      računa (dva vozača, dupli klik) ne mogu oba da uspeju — drugi
//      dobije DuplicateReceiptError. firestore.rules traži da ID
//      odgovara polju receiptKey.
//  Unosi bez broja računa se snimaju kao i do sada (addDoc).
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, where, getDocs, doc, addDoc, runTransaction
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";

export class DuplicateReceiptError extends Error {
  constructor(receiptNo, existing = null) {
    super(`Duplicate receipt ${receiptNo}`);
    this.name = "DuplicateReceiptError";
    this.receiptNo = receiptNo;
    this.existing = existing;   // postojeći unos (ako je poznat)
  }
}

// "  rk3ab12c - 9ZX88Q1P–15 " → "RK3AB12C-9ZX88Q1P-15"
export function normalizeReceiptNo(value) {
  const s = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\u2010-\u2015\u2212_]/g, "-")   // razne crtice → "-"
    .replace(/\s*-\s*/g, "-")                  // razmaci oko crtica
    .replace(/\s+/g, "");                      // ostali razmaci
  return s ? s.slice(0, 120) : null;
}

// Kod unosa je slobodan tekst; ključ mora biti validan deo ID-ja dokumenta
export function receiptKey(normalized) {
  return normalized ? encodeURIComponent(normalized) : null;
}

const EXPENSE_TYPES = ["fuel", "toll", "parking", "washing", "other_cost"];

// Vraća postojeći unos sa istim brojem računa, ili null.
// Baca grešku ako provera ne uspe — pozivalac NE sme tada da snimi.
export async function findReceiptDuplicate(companyId, receiptNo, { ignoreId = null } = {}) {
  const norm = normalizeReceiptNo(receiptNo);
  if (!norm) return null;
  const raw = String(receiptNo).trim();
  const variants = [...new Set([norm, raw])];   // stariji unosi mogu imati nenormalizovan zapis
  const col = collection(db, "companies", companyId, "tripEntries");
  for (const v of variants) {
    const snap = await getDocs(query(col, where("receiptNo", "==", v)));
    const hit = snap.docs.find(d => d.id !== ignoreId && EXPENSE_TYPES.includes(d.data().type));
    if (hit) return { id: hit.id, ...hit.data() };
  }
  return null;
}

// Snimi unos. Ako ima broj računa: normalizuj, proveri, pa snimi u
// transakciji pod ID-jem "r_<ključ>". Vraća ID novog dokumenta.
export async function saveTripEntry(companyId, data) {
  const norm = normalizeReceiptNo(data.receiptNo);
  const col = collection(db, "companies", companyId, "tripEntries");

  if (!norm) {
    const ref = await addDoc(col, { ...data, receiptNo: null });
    return ref.id;
  }

  const existing = await findReceiptDuplicate(companyId, norm);
  if (existing) throw new DuplicateReceiptError(norm, existing);

  const key = receiptKey(norm);
  const ref = doc(col, `r_${key}`);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) throw new DuplicateReceiptError(norm, { id: snap.id, ...snap.data() });
    tx.set(ref, { ...data, receiptNo: norm, receiptKey: key });
  });
  return ref.id;
}
