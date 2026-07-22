import { api, ApiError } from "../api";
import { setCurrentUser } from "../auth-state";

export function renderLoginView(root: HTMLElement, onSuccess: () => void) {
  root.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <h1>Minecraft Dashboard</h1>
        <div class="field">
          <label for="username">Felhasználónév</label>
          <input id="username" type="text" autocomplete="username" />
        </div>
        <div class="field">
          <label for="password">Jelszó</label>
          <input id="password" type="password" autocomplete="current-password" />
        </div>
        <button id="login-btn" class="btn btn-primary" style="width:100%">Belépés</button>
        <div id="login-error" class="error-text"></div>
      </div>
    </div>
  `;

  const usernameInput = root.querySelector<HTMLInputElement>("#username")!;
  const passwordInput = root.querySelector<HTMLInputElement>("#password")!;
  const loginBtn = root.querySelector<HTMLButtonElement>("#login-btn")!;
  const errorEl = root.querySelector<HTMLDivElement>("#login-error")!;

  usernameInput.focus();

  async function submit() {
    errorEl.textContent = "";
    loginBtn.disabled = true;
    try {
      const { user } = await api.login(usernameInput.value, passwordInput.value);
      setCurrentUser(user);
      onSuccess();
    } catch (err) {
      errorEl.textContent = err instanceof ApiError ? err.message : "Ismeretlen hiba történt";
    } finally {
      loginBtn.disabled = false;
    }
  }

  loginBtn.addEventListener("click", submit);
  [usernameInput, passwordInput].forEach((input) =>
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    })
  );
}
