// ============================================================
//  login.js  —  Fleet Manager
//  Login ekran: Google + Username/Password
// ============================================================

import { loginWithGoogle, loginWithUsername } from "./firebase.js";
import { t } from "./i18n.js";
import { showToast } from "./app.js";

export function renderLogin() {
  const screen = document.getElementById("login-screen");
  screen.innerHTML = `
    <div class="login-card">
      <div class="login-card__logo">
        <span class="login-card__logo-icon">🚛</span>
        <h1 class="login-card__title">${t("app_name")}</h1>
      </div>

      <button id="btn-google" class="btn btn--google">
        <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
          <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/>
          <path d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.55 0 9s.348 2.825.957 4.039l3.007-2.332z" fill="#FBBC05"/>
          <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" fill="#EA4335"/>
        </svg>
        <span data-i18n="login_google">${t("login_google")}</span>
      </button>

      <div class="login-divider">
        <span data-i18n="login_or">${t("login_or")}</span>
      </div>

      <div class="login-form">
        <div class="form-group">
          <label class="form-label" data-i18n="login_username">${t("login_username")}</label>
          <input
            id="input-username"
            type="text"
            class="form-input"
            autocomplete="username"
            data-i18n-placeholder="login_username"
          />
        </div>
        <div class="form-group">
          <label class="form-label" data-i18n="login_password">${t("login_password")}</label>
          <input
            id="input-password"
            type="password"
            class="form-input"
            autocomplete="current-password"
            data-i18n-placeholder="login_password"
          />
        </div>
        <button id="btn-login" class="btn btn--primary btn--full">
          <span data-i18n="login_btn">${t("login_btn")}</span>
        </button>
        <p id="login-error" class="login-error hidden"></p>
      </div>
    </div>
  `;

  // Google login
  document.getElementById("btn-google").addEventListener("click", async () => {
    try {
      await loginWithGoogle();
      // onAuthStateChanged u app.js preuzima kontrolu
    } catch (err) {
      console.error("Google login error:", err);
      showLoginError(t("login_error"));
    }
  });

  // Username/password login
  document.getElementById("btn-login").addEventListener("click", handleUsernameLogin);
  document.getElementById("input-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleUsernameLogin();
  });
}

async function handleUsernameLogin() {
  const username = document.getElementById("input-username").value.trim();
  const password = document.getElementById("input-password").value;

  if (!username || !password) {
    showLoginError(t("required_field"));
    return;
  }

  const btn = document.getElementById("btn-login");
  btn.disabled = true;
  btn.textContent = t("loading");

  try {
    await loginWithUsername(username, password);
    // onAuthStateChanged preuzima kontrolu
  } catch (err) {
    console.error("Username login error:", err);
    showLoginError(t("login_error"));
    btn.disabled = false;
    btn.innerHTML = `<span data-i18n="login_btn">${t("login_btn")}</span>`;
  }
}

function showLoginError(msg) {
  const el = document.getElementById("login-error");
  if (el) {
    el.textContent = msg;
    el.classList.remove("hidden");
  }
}
