// ============================================================
//  pending-requests.js  —  Fleet Manager
//  Deljena komponenta: baner "Zahtevi za pristup" — novi fleet
//  adminovi (self-registration) koji čekaju odobrenje master
//  admina. Koriste ga:
//    - companies.js  → pun prikaz (svi zahtevi)
//    - dashboard.js  → kompaktan prikaz (prva 2 + link "Prikaži sve")
// ============================================================

import { db } from "./firebase.js";
import {
  collection, query, where, orderBy, getDocs,
  doc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { t } from "./i18n.js";
import { S, showToast, navigateTo } from "./app.js";

// ── DOHVATI ZAHTEVE ────────────────────────────────────────────
export async function getPendingRequests() {
  const snap = await getDocs(
    query(collection(db, "adminNotifications"),
      where("type", "==", "pending_fleet_admin"),
      where("status", "==", "unread"),
      orderBy("createdAt", "desc")
    )
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── MONTIRAJ BANER ──────────────────────────────────────────────
/**
 * @param {HTMLElement} container   - element u koji se baner renderuje
 * @param {Object} opts
 * @param {boolean} [opts.compact]  - prikaži samo prva 2 zahteva + link "Prikaži sve"
 * @param {Function} [opts.onChange] - poziva se posle approve/reject (npr. refresh liste firmi)
 */
export async function mountPendingBanner(container, { compact = false, onChange } = {}) {
  if (!container) return;

  async function refresh() {
    let pending;
    try {
      pending = await getPendingRequests();
    } catch (e) {
      console.error("Pending load error:", e);
      container.innerHTML = "";
      return;
    }

    if (pending.length === 0) {
      container.innerHTML = "";
      return;
    }

    const items = compact ? pending.slice(0, 2) : pending;

    container.innerHTML = `
      <div class="pending-banner">
        <div class="pending-banner__title" style="${compact ? "display:flex;align-items:center;justify-content:space-between;" : ""}">
          <span>🔔 ${t("company_pending_title")} (${pending.length})</span>
          ${compact ? `<button class="btn btn--ghost btn--sm" id="btn-pending-showall" style="color:var(--color-warning)">${t("company_pending_show_all")} →</button>` : ""}
        </div>
        <div class="pending-list" id="pending-list">
          ${items.map(p => pendingItem(p)).join("")}
        </div>
      </div>
    `;

    container.querySelectorAll(".btn-approve").forEach(btn => {
      btn.addEventListener("click", () => approveUser(btn.dataset.uid, btn.dataset.notifId, refresh, onChange));
    });
    container.querySelectorAll(".btn-reject").forEach(btn => {
      btn.addEventListener("click", () => rejectUser(btn.dataset.uid, btn.dataset.notifId, refresh, onChange));
    });

    if (compact) {
      document.getElementById("btn-pending-showall")?.addEventListener("click", () => navigateTo("companies"));
    }
  }

  await refresh();
}

function pendingItem(p) {
  return `
    <div class="pending-item" id="pending-${p.id}">
      <div class="pending-item__info">
        <strong>${p.userName}</strong>
        <span class="pending-item__company">
          🏢 ${p.companyName}
          ${p.joinExisting
            ? `<span class="badge badge--info" style="margin-left:6px">${t("company_join_badge")}</span>`
            : `<span class="badge badge--active" style="margin-left:6px">${t("company_new_badge")}</span>`}
        </span>
      </div>
      <div class="pending-item__actions">
        <button class="btn btn--primary btn--sm btn-approve"
          data-uid="${p.userUid}" data-notif-id="${p.id}">
          ${t("approve")}
        </button>
        <button class="btn btn--danger btn--sm btn-reject"
          data-uid="${p.userUid}" data-notif-id="${p.id}">
          ${t("reject")}
        </button>
      </div>
    </div>
  `;
}

// ── AKCIJE ──────────────────────────────────────────────────────
async function approveUser(uid, notifId, refresh, onChange) {
  try {
    await updateDoc(doc(db, "users", uid), {
      status: "active", approvedAt: serverTimestamp(), approvedBy: S.user.uid
    });
    await updateDoc(doc(db, "adminNotifications", notifId), { status: "resolved" });
    showToast(t("company_approved_msg"), "success");
    await refresh();
    onChange?.();
  } catch (e) {
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}

async function rejectUser(uid, notifId, refresh, onChange) {
  if (!confirm(t("confirm_delete"))) return;
  try {
    await updateDoc(doc(db, "users", uid), { status: "rejected" });
    await updateDoc(doc(db, "adminNotifications", notifId), { status: "resolved" });
    showToast(t("company_rejected_msg"), "warning");
    await refresh();
    onChange?.();
  } catch (e) {
    showToast(`${t("error")}: ${e.message}`, "error");
  }
}
