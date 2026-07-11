// ============================================================
//  register.js  —  Fleet Manager
//  Self-registration forma za nove fleet adminove
// ============================================================

import { db, auth } from "./firebase.js";
import {
  collection, query, where, getDocs,
  doc, setDoc, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t } from "./i18n.js";
import { S, showToast } from "./app.js";

// ── GLAVNI RENDER ─────────────────────────────────────────────
export function renderRegister(container) {
  container.innerHTML = `
    <div class="register-wrap">
      <div class="register-card">
        <div class="register-card__header">
          <span class="register-card__icon">🚛</span>
          <h2 class="register-card__title">${t("reg_welcome_title")}</h2>
          <p class="register-card__sub">${t("reg_welcome_sub")}</p>
        </div>

        <!-- STEPPER -->
        <div class="stepper" id="stepper">
          <div class="stepper__step stepper__step--active" data-step="1">
            <div class="stepper__dot">1</div>
            <span>${t("reg_step1_label")}</span>
          </div>
          <div class="stepper__line"></div>
          <div class="stepper__step" data-step="2">
            <div class="stepper__dot">2</div>
            <span>${t("reg_step2_label")}</span>
          </div>
          <div class="stepper__line"></div>
          <div class="stepper__step" data-step="3">
            <div class="stepper__dot">3</div>
            <span>${t("reg_step3_label")}</span>
          </div>
        </div>

        <div id="register-step-content"></div>
      </div>
    </div>
  `;

  renderStep(1);
}

// ── STATE ─────────────────────────────────────────────────────
const R = {
  personal: {},
  company: null,       // null = nova firma, objekat = postojeća
  companyData: {},
  joinExisting: false,
};

// ── STEPPER ───────────────────────────────────────────────────
function setStep(n) {
  document.querySelectorAll(".stepper__step").forEach(s => {
    const sn = Number(s.dataset.step);
    s.classList.toggle("stepper__step--active", sn === n);
    s.classList.toggle("stepper__step--done", sn < n);
  });
  renderStep(n);
}

function renderStep(n) {
  const content = document.getElementById("register-step-content");
  if (!content) return;
  switch (n) {
    case 1: content.innerHTML = step1HTML(); bindStep1(); break;
    case 2: content.innerHTML = step2HTML(); bindStep2(); break;
    case 3: content.innerHTML = step3HTML(); bindStep3(); break;
  }
}

// ── KORAK 1 — LIČNI PODACI ────────────────────────────────────
function step1HTML() {
  const p = R.personal;
  return `
    <div class="register-step">
      <h3 class="register-step__title">${t("reg_step1_title")}</h3>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${t("profile_first_name")} *</label>
          <input id="r-firstName" class="form-input" type="text" value="${p.firstName || ""}" />
        </div>
        <div class="form-group">
          <label class="form-label">${t("profile_last_name")} *</label>
          <input id="r-lastName" class="form-input" type="text" value="${p.lastName || ""}" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${t("driver_phone")}</label>
          <input id="r-phone" class="form-input" type="tel" value="${p.phone || ""}" />
        </div>
        <div class="form-group">
          <label class="form-label">${t("driver_email")}</label>
          <input id="r-email" class="form-input" type="email" value="${p.email || S.user?.email || ""}" />
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${t("driver_home_address")}</label>
        <input id="r-homeAddress" class="form-input" type="text" value="${p.homeAddress || ""}" />
      </div>
      <div class="form-group">
        <label class="form-label">${t("driver_work_address")}</label>
        <input id="r-workAddress" class="form-input" type="text" value="${p.workAddress || ""}" />
      </div>
      <p id="step1-error" class="login-error hidden"></p>
      <div class="register-step__actions">
        <button id="btn-step1-next" class="btn btn--primary">${t("reg_next")}</button>
      </div>
    </div>
  `;
}

function bindStep1() {
  document.getElementById("btn-step1-next")?.addEventListener("click", () => {
    const firstName = document.getElementById("r-firstName")?.value.trim();
    const lastName  = document.getElementById("r-lastName")?.value.trim();
    if (!firstName || !lastName) {
      showStepError("step1-error", t("required_field"));
      return;
    }
    R.personal = {
      firstName,
      lastName,
      phone:       document.getElementById("r-phone")?.value.trim() || null,
      email:       document.getElementById("r-email")?.value.trim() || S.user?.email,
      homeAddress: document.getElementById("r-homeAddress")?.value.trim() || null,
      workAddress: document.getElementById("r-workAddress")?.value.trim() || null,
    };
    setStep(2);
  });
}

// ── KORAK 2 — FIRMA ───────────────────────────────────────────
function step2HTML() {
  const c = R.companyData;
  return `
    <div class="register-step">
      <h3 class="register-step__title">${t("reg_step2_title")}</h3>

      <div class="pib-lookup">
        <div class="form-group">
          <label class="form-label">${t("reg_pib_label")}</label>
          <div class="pib-lookup__row">
            <input id="r-pib" class="form-input" type="text" maxlength="9"
              placeholder="123456789" value="${c.pib || ""}" />
            <button id="btn-check-pib" class="btn btn--secondary">${t("reg_pib_check")}</button>
          </div>
        </div>
        <div id="pib-result"></div>
      </div>

      <div id="company-form" class="${R.joinExisting ? 'hidden' : ''}">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">${t("company_name")} *</label>
            <input id="r-companyName" class="form-input" type="text" value="${c.name || ""}" />
          </div>
          <div class="form-group">
            <label class="form-label">${t("company_mbr")}</label>
            <input id="r-mbr" class="form-input" type="text" maxlength="8" value="${c.mbr || ""}" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Vlasnik</label>
            <input id="r-owner" class="form-input" type="text" value="${c.owner || ""}" />
          </div>
          <div class="form-group">
            <label class="form-label">${t("company_director")}</label>
            <input id="r-director" class="form-input" type="text" value="${c.director || ""}" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Adresa</label>
          <input id="r-companyAddress" class="form-input" type="text" value="${c.address || ""}" />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Telefon</label>
            <input id="r-companyPhone" class="form-input" type="tel" value="${c.phone || ""}" />
          </div>
          <div class="form-group">
            <label class="form-label">Email</label>
            <input id="r-companyEmail" class="form-input" type="email" value="${c.email || ""}" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">${t("company_instagram")}</label>
            <input id="r-instagram" class="form-input" type="text" placeholder="@naziv" value="${c.instagram || ""}" />
          </div>
          <div class="form-group">
            <label class="form-label">${t("company_facebook")}</label>
            <input id="r-facebook" class="form-input" type="text" value="${c.facebook || ""}" />
          </div>
        </div>
      </div>

      <p id="step2-error" class="login-error hidden"></p>
      <div class="register-step__actions">
        <button id="btn-step2-back" class="btn btn--ghost">${t("reg_back")}</button>
        <button id="btn-step2-next" class="btn btn--primary">${t("reg_next")}</button>
      </div>
    </div>
  `;
}

function bindStep2() {
  document.getElementById("btn-step2-back")?.addEventListener("click", () => setStep(1));
  document.getElementById("btn-check-pib")?.addEventListener("click", checkPib);
  document.getElementById("r-pib")?.addEventListener("keydown", e => { if (e.key === "Enter") checkPib(); });
  document.getElementById("btn-step2-next")?.addEventListener("click", proceedStep2);
}

async function checkPib() {
  const pib = document.getElementById("r-pib")?.value.trim();
  const result = document.getElementById("pib-result");
  if (!pib || pib.length < 8) {
    result.innerHTML = `<p class="login-error">${t('reg_pib_error')}</p>`;
    return;
  }

  const btn = document.getElementById("btn-check-pib");
  btn.disabled = true;
  btn.textContent = "...";

  try {
    const snap = await getDocs(query(collection(db, "companies"), where("pib", "==", pib)));

    if (!snap.empty) {
      // Firma postoji
      const existing = { id: snap.docs[0].id, ...snap.docs[0].data() };
      R.company = existing;
      R.joinExisting = true;
      document.getElementById("company-form").classList.add("hidden");
      result.innerHTML = `
        <div class="pib-found">
          <div class="pib-found__icon">🏢</div>
          <div class="pib-found__info">
            <strong>${existing.name}</strong>
            <span>${existing.address || ""}</span>
            <span>PIB: ${existing.pib} ${existing.mbr ? "| MBR: " + existing.mbr : ""}</span>
          </div>
          <div class="pib-found__msg">
            Firma je već u sistemu. Klikom na "Dalje" zatražićete pridruživanje ovoj firmi.
          </div>
        </div>
      `;
    } else {
      // Nova firma
      R.company = null;
      R.joinExisting = false;
      document.getElementById("company-form").classList.remove("hidden");
      result.innerHTML = `
        <div class="pib-new">
          ✅ Firma sa ovim PIB-om nije pronađena. Popunite podatke ispod.
        </div>
      `;
      // Prefill PIB u formu
      R.companyData.pib = pib;
    }
  } catch (e) {
    result.innerHTML = `<p class="login-error">${t("error")}: ${e.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = t("reg_pib_check");
  }
}

async function proceedStep2() {
  const pib = document.getElementById("r-pib")?.value.trim();
  if (!pib) { showStepError("step2-error", t("reg_pib_required")); return; }

  const btn = document.getElementById("btn-step2-next");
  if (btn) { btn.disabled = true; btn.textContent = "..."; }

  try {
    // UVEK ponovo proveri PIB na serveru — ne oslanjaj se na to da li je
    // korisnik ranije kliknuo "Proveri PIB". Ovo sprečava da neko
    // zaobiđe proveru i kreira duplikat firme sa istim PIB-om.
    const snap = await getDocs(query(collection(db, "companies"), where("pib", "==", pib)));

    if (!snap.empty) {
      const existing = { id: snap.docs[0].id, ...snap.docs[0].data() };
      R.company = existing;
      R.joinExisting = true;
      setStep(3);
      return;
    }

    // PIB ne postoji — nastavi kao nova firma
    R.joinExisting = false;
    const name = document.getElementById("r-companyName")?.value.trim();
    if (!name) { showStepError("step2-error", t("required_field") + ": " + t("company_name")); return; }

    R.companyData = {
      pib,
      name,
      mbr:      document.getElementById("r-mbr")?.value.trim() || null,
      owner:    document.getElementById("r-owner")?.value.trim() || null,
      director: document.getElementById("r-director")?.value.trim() || null,
      address:  document.getElementById("r-companyAddress")?.value.trim() || null,
      phone:    document.getElementById("r-companyPhone")?.value.trim() || null,
      email:    document.getElementById("r-companyEmail")?.value.trim() || null,
      instagram:document.getElementById("r-instagram")?.value.trim() || null,
      facebook: document.getElementById("r-facebook")?.value.trim() || null,
    };

    setStep(3);
  } catch (e) {
    showStepError("step2-error", `${t("error")}: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t("reg_next"); }
  }
}

// ── KORAK 3 — PREGLED I SUBMIT ────────────────────────────────
function step3HTML() {
  const p = R.personal;
  const c = R.joinExisting ? R.company : R.companyData;

  return `
    <div class="register-step">
      <h3 class="register-step__title">${t("reg_step3_title")}</h3>

      <div class="review-section">
        <div class="review-section__title">${t("reg_your_data_title")}</div>
        <div class="review-grid">
          <span class="review-label">${t("reg_full_name")}</span><span>${p.firstName} ${p.lastName}</span>
          ${p.phone ? `<span class="review-label">${t("driver_phone")}</span><span>${p.phone}</span>` : ""}
          ${p.email ? `<span class="review-label">${t("driver_email")}</span><span>${p.email}</span>` : ""}
          ${p.homeAddress ? `<span class="review-label">${t("driver_home_address")}</span><span>${p.homeAddress}</span>` : ""}
          ${p.workAddress ? `<span class="review-label">${t("driver_work_address")}</span><span>${p.workAddress}</span>` : ""}
        </div>
      </div>

      <div class="review-section">
        <div class="review-section__title">${t("reg_company_title")}</div>
        ${R.joinExisting
          ? `<div class="pib-found pib-found--compact">
               <strong>${c.name}</strong> — PIB: ${c.pib}
               <span class="badge badge--info" style="margin-left:8px">${t("reg_join_badge")}</span>
             </div>`
          : `<div class="review-grid">
               <span class="review-label">Naziv</span><span>${c.name}</span>
               <span class="review-label">PIB</span><span>${c.pib}</span>
               ${c.mbr ? `<span class="review-label">MBR</span><span>${c.mbr}</span>` : ""}
               ${c.address ? `<span class="review-label">Adresa</span><span>${c.address}</span>` : ""}
             </div>`
        }
      </div>

      <div class="review-notice">
        ${t("reg_notice")}
      </div>

      <p id="step3-error" class="login-error hidden"></p>
      <div class="register-step__actions">
        <button id="btn-step3-back" class="btn btn--ghost">${t("reg_back")}</button>
        <button id="btn-submit-reg" class="btn btn--primary">${t("reg_submit")} ✓</button>
      </div>
    </div>
  `;
}

function bindStep3() {
  document.getElementById("btn-step3-back")?.addEventListener("click", () => setStep(2));
  document.getElementById("btn-submit-reg")?.addEventListener("click", submitRegistration);
}

// ── SUBMIT REGISTRACIJE ───────────────────────────────────────
async function submitRegistration() {
  const btn = document.getElementById("btn-submit-reg");
  btn.disabled = true;
  btn.textContent = t("loading");

  try {
    let companyId;

    if (R.joinExisting) {
      companyId = R.company.id;
    } else {
      // Kreiraj novu firmu
      const companyRef = await addDoc(collection(db, "companies"), {
        ...R.companyData,
        createdAt: serverTimestamp(),
        createdBy: S.user.uid,
      });
      companyId = companyRef.id;
    }

    // Kreiraj user profil sa status: "pending"
    await setDoc(doc(db, "users", S.user.uid), {
      role:        "fleet_admin",
      status:      "pending",
      companyId,
      firstName:   R.personal.firstName,
      lastName:    R.personal.lastName,
      displayName: `${R.personal.firstName} ${R.personal.lastName}`,
      phone:       R.personal.phone || null,
      email:       R.personal.email || S.user.email,
      homeAddress: R.personal.homeAddress || null,
      workAddress: R.personal.workAddress || null,
      googleEmail: S.user.email,
      photoURL:    S.user.photoURL || null,
      createdAt:   serverTimestamp(),
      joinExisting: R.joinExisting,
    });

    // Kreiraj notifikaciju za master admina
    await addDoc(collection(db, "adminNotifications"), {
      type:        "pending_fleet_admin",
      userUid:     S.user.uid,
      userName:    `${R.personal.firstName} ${R.personal.lastName}`,
      companyId,
      companyName: R.joinExisting ? R.company.name : R.companyData.name,
      joinExisting: R.joinExisting,
      status:      "unread",
      createdAt:   serverTimestamp(),
    });

    // Prikaži pending ekran
    showPendingScreen();

  } catch (e) {
    showStepError("step3-error", `${t("error")}: ${e.message}`);
    btn.disabled = false;
    btn.textContent = t("reg_submit") + " ✓";
  }
}

// ── PENDING EKRAN ─────────────────────────────────────────────
export function showPendingScreen() {
  const app = document.getElementById("app");
  if (!app) return;

  app.innerHTML = `
    <div class="pending-screen">
      <div class="pending-screen__card">
        <div class="pending-screen__icon">⏳</div>
        <h2>${t("pending_sent")}</h2>
        <p>${t("pending_wait_msg")}</p>
        <p class="pending-screen__sub">${t("pending_wait_sub")}</p>
        <button class="btn btn--ghost btn--sm" id="btn-pending-logout">${t("pending_logout")}</button>
      </div>
    </div>
  `;
  app.classList.remove("hidden");

  document.getElementById("btn-pending-logout")?.addEventListener("click", async () => {
    const { logout } = await import("./firebase.js");
    await logout();
  });
}

// ── HELPER ────────────────────────────────────────────────────
function showStepError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
}
