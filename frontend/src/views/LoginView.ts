import { api, ApiError } from "../api";

export function renderLoginView(root: HTMLElement, onSuccess: () => void) {
  root.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <h1>Minecraft Dashboard</h1>
        <div class="field">
          <label for="password">Jelszó</label>
          <input id="password" type="password" autocomplete="current-password" />
        </div>
        <button id="login-btn" class="btn btn-primary" style="width:100%">Belépés</button>
        <div id="login-error" class="error-text"></div>
      </div>
    </div>
  `;

  const passwordInput = root.querySelector<HTMLInputElement>("#password")!;
  const loginBtn = root.querySelector<HTMLButtonElement>("#login-btn")!;
  const errorEl = root.querySelector<HTMLDivElement>("#login-error")!;

  passwordInput.focus();

  async function submit() {
    errorEl.textContent = "";
    loginBtn.disabled = true;
    try {
      await api.login(passwordInput.value);
      onSuccess();
    } catch (err) {
      errorEl.textContent = err instanceof ApiError ? err.message : "Ismeretlen hiba történt";
    } finally {
      loginBtn.disabled = false;
    }
  }

  loginBtn.addEventListener("click", submit);
  passwordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}
