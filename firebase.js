// ============================================================
//  firebase.js  —  Fleet Manager
//  Inicijalizacija Firebase + Auth + Firestore helperi
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { initializeApp as initializeSecondaryApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  EmailAuthProvider,
  linkWithCredential,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updatePassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  getDocs,
  addDoc,
  serverTimestamp,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCokT2P7BfU3JIb1Kaj8J1G8FYZqn0n8vg",
  authDomain: "fleet-manager-cfd6c.firebaseapp.com",
  projectId: "fleet-manager-cfd6c",
  storageBucket: "fleet-manager-cfd6c.firebasestorage.app",
  messagingSenderId: "747911295658",
  appId: "1:747911295658:web:76624e9e49997b4a6f16d3"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();

// Sekundarna app instanca — za kreiranje novih Auth naloga bez odjave admina
let _secondaryApp = null;
function getSecondaryAuth() {
  if (!_secondaryApp) {
    _secondaryApp = initializeSecondaryApp(firebaseConfig, "secondary");
  }
  return getAuth(_secondaryApp);
}
export { getSecondaryAuth };

// ── AUTH HELPERI ──────────────────────────────────────────────

/** Google popup login */
export async function loginWithGoogle() {
  return signInWithPopup(auth, googleProvider);
}

/**
 * Login sa username + password (lokalni nalog)
 *
 * Prvo pokušava preko `usernameIndex/{username}` — javno čitljive kolekcije
 * (dozvoljeno i bez prijave) koja mapira username na TRENUTNI interni auth
 * email. Ovo je neophodno jer se email menja svaki put kad admin resetuje
 * lozinku vozaču (dobija novi email sa timestamp sufiksom, vidi drivers.js) —
 * jednostavni konstruisani email (username@fleetapp.internal) više ne važi
 * nakon reseta.
 *
 * Ako indeks ne postoji (stariji nalog kreiran pre uvođenja indeksa),
 * fallback je jednostavni konstruisani email.
 */
export async function loginWithUsername(username, password) {
  const simpleEmail = usernameToEmail(username);

  try {
    const indexSnap = await getDoc(doc(db, "usernameIndex", username));
    if (indexSnap.exists() && indexSnap.data().authEmail) {
      return await signInWithEmailAndPassword(auth, indexSnap.data().authEmail, password);
    }
  } catch (lookupErr) {
    // Indeks nije dostupan iz nekog razloga — nastavljamo na fallback ispod,
    // ne prekidamo login zbog ovoga.
    console.warn("usernameIndex lookup failed:", lookupErr.code);
  }

  return signInWithEmailAndPassword(auth, simpleEmail, password);
}

/** Logout */
export async function logout() {
  return signOut(auth);
}

/** Helper: username → fake email */
export function usernameToEmail(username) {
  return `${username.toLowerCase().replace(/\s+/g, ".")}@fleetapp.internal`;
}

/**
 * Vezuje lokalni (username/password) login za VEĆ ulogovanog korisnika
 * (fleet_admin ili master_admin sebi dodaje drugi način prijave).
 * Za razliku od createLocalAccount() (koji pravi NOV Firebase Auth nalog
 * za vozača preko sekundarne app instance), ovo koristi linkWithCredential
 * da doda email/password metod prijave NA ISTI Auth nalog (isti uid),
 * tako da korisnikov profil i sve veze ostaju netaknute.
 */
export async function linkLocalCredential(username, password) {
  const user = auth.currentUser;
  if (!user) throw new Error("Nema ulogovanog korisnika");
  const email = usernameToEmail(username);
  const credential = EmailAuthProvider.credential(email, password);
  return linkWithCredential(user, credential);
}

/**
 * Kreiranje lokalnog naloga za vozača/admina
 * Poziva Fleet Admin kada dodaje korisnika
 */
export async function createLocalAccount(username, password) {
  const email = usernameToEmail(username);
  return createUserWithEmailAndPassword(auth, email, password);
}

/**
 * Promena passworda za lokalni nalog
 * Koristi se kada Fleet Admin menja password vozaču
 */
export async function changeLocalPassword(newPassword) {
  const user = auth.currentUser;
  if (!user) throw new Error("Nema ulogovanog korisnika");
  return updatePassword(user, newPassword);
}

// ── FIRESTORE HELPERI ─────────────────────────────────────────

/** Dohvati korisnikov profil iz Firestore */
export async function getUserProfile(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** Kreiraj ili ažuriraj korisnikov profil */
export async function setUserProfile(uid, data) {
  const ref = doc(db, "users", uid);
  return setDoc(ref, { ...data, updatedAt: serverTimestamp() }, { merge: true });
}

/** Dohvati sve kompanije (samo master admin) */
export async function getCompanies() {
  const snap = await getDocs(collection(db, "companies"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Dohvati jednu kompaniju */
export async function getCompany(companyId) {
  const snap = await getDoc(doc(db, "companies", companyId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** Kreiraj kompaniju */
export async function createCompany(data) {
  return addDoc(collection(db, "companies"), {
    ...data,
    createdAt: serverTimestamp(),
  });
}

/** Dohvati vozila kompanije */
export async function getVehicles(companyId) {
  const q = query(
    collection(db, "companies", companyId, "vehicles"),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Dohvati vozače kompanije */
export async function getDrivers(companyId) {
  const q = query(
    collection(db, "companies", companyId, "drivers"),
    orderBy("lastName", "asc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Dohvati aktivna zaduženja kompanije */
export async function getActiveAssignments(companyId) {
  const q = query(
    collection(db, "companies", companyId, "assignments"),
    where("status", "==", "active")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Generički add dokument u sub-kolekciju kompanije */
export async function addCompanyDoc(companyId, subcollection, data) {
  return addDoc(collection(db, "companies", companyId, subcollection), {
    ...data,
    createdAt: serverTimestamp(),
  });
}

/** Generički update dokument u sub-kolekciju kompanije */
export async function updateCompanyDoc(companyId, subcollection, docId, data) {
  const ref = doc(db, "companies", companyId, subcollection, docId);
  return updateDoc(ref, { ...data, updatedAt: serverTimestamp() });
}

/** Generički delete dokument */
export async function deleteCompanyDoc(companyId, subcollection, docId) {
  return deleteDoc(doc(db, "companies", companyId, subcollection, docId));
}

/** Real-time listener na sub-kolekciju */
export function listenToCollection(companyId, subcollection, callback) {
  const q = query(
    collection(db, "companies", companyId, subcollection),
    orderBy("createdAt", "desc")
  );
  return onSnapshot(q, (snap) => {
    const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    callback(data);
  });
}

export {
  serverTimestamp,
  onAuthStateChanged,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  getDocs,
  addDoc,
  onSnapshot,
};
