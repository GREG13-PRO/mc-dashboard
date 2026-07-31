import { api } from "./api";
import { applyDisplayPreferences } from "./lib/display";
import { setCurrentUser } from "./auth-state";
import { renderLoginView } from "./views/LoginView";
import { renderDashboard } from "./views/DashboardView";

const app = document.getElementById("app")!;
let disposeCurrent: (() => void) | null = null;

function showLogin() {
  disposeCurrent?.();
  disposeCurrent = null;
  location.hash = "";
  renderLoginView(app, showDashboard);
}

function showDashboard() {
  disposeCurrent?.();
  disposeCurrent = renderDashboard(app, showLogin);
}

async function boot() {
  // Before the first render so nothing paints at the wrong size.
  applyDisplayPreferences();
  try {
    const { authenticated, user } = await api.authStatus();
    if (authenticated && user) {
      setCurrentUser(user);
      showDashboard();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

void boot();
