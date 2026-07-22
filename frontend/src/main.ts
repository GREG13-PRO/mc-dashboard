import { api } from "./api";
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
  try {
    const { authenticated } = await api.authStatus();
    if (authenticated) {
      showDashboard();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

void boot();
