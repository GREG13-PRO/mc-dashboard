import { api, ApiError } from "../api";
import { showToast } from "../components/Toast";
import { openAddServerModal } from "./AddServerModal";
import { renderServerView } from "./ServerView";
import { renderUsersView } from "./UsersView";
import { isAdmin, setCurrentUser } from "../auth-state";
import type { ServerWithStatus } from "../types";

function parseServerIdFromHash(): string | null {
  const match = /^#\/server\/(.+)$/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

export function renderDashboard(root: HTMLElement, onLogout: () => void): () => void {
  let servers: ServerWithStatus[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposeServerView: (() => void) | null = null;

  root.innerHTML = `
    <div class="app-shell">
      <div class="sidebar">
        <div class="sidebar-header">
          <h1>Minecraft Dashboard</h1>
          <button class="btn" id="logout-btn">Kijelentkezés</button>
        </div>
        ${isAdmin() ? `<button class="btn btn-primary add-server-btn" id="add-server-btn">+ Új szerver</button>` : ""}
        ${isAdmin() ? `<button class="btn users-nav-btn" id="users-nav-btn" style="width:100%;margin-bottom:0.6rem;">Felhasználók</button>` : ""}
        <div class="server-list" id="server-list"></div>
      </div>
      <div class="main-content" id="main-content">
        <div class="empty-state">Válassz egy szervert a bal oldalon.</div>
      </div>
    </div>
  `;

  root.querySelector<HTMLButtonElement>("#logout-btn")!.onclick = async () => {
    await api.logout().catch(() => undefined);
    setCurrentUser(null);
    onLogout();
  };
  root.querySelector<HTMLButtonElement>("#add-server-btn")?.addEventListener("click", () => {
    openAddServerModal(() => void refreshList());
  });
  root.querySelector<HTMLButtonElement>("#users-nav-btn")?.addEventListener("click", () => {
    location.hash = "#/users";
  });

  async function refreshList() {
    try {
      servers = await api.listServers();
      renderList();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Szerverlista betöltése sikertelen", "error");
    }
  }

  function renderList() {
    const listEl = root.querySelector<HTMLDivElement>("#server-list")!;
    const selectedId = parseServerIdFromHash();

    if (servers.length === 0) {
      listEl.innerHTML = `<div class="empty-state" style="padding:1rem;">Még nincs hozzáadott szerver.</div>`;
      return;
    }

    listEl.innerHTML = servers
      .map(
        (s) => `
      <div class="server-card ${s.id === selectedId ? "active" : ""}" data-id="${s.id}">
        <div class="server-card-top">
          <span class="server-name"><span class="status-dot ${s.running ? "running" : "stopped"}"></span>${s.name}</span>
        </div>
        <div class="server-meta">${
          s.rcon.enabled && s.players ? `${s.players.online}/${s.players.max} játékos` : s.running ? "fut" : "leállítva"
        }${s.running && s.resources ? ` · ${s.resources.cpuPercent.toFixed(0)}% CPU · ${s.resources.memoryMb} MB` : ""}</div>
      </div>`
      )
      .join("");

    listEl.querySelectorAll<HTMLDivElement>(".server-card").forEach((card) => {
      card.onclick = () => {
        location.hash = `#/server/${encodeURIComponent(card.dataset.id!)}`;
      };
    });
  }

  function renderMainContent() {
    disposeServerView?.();
    disposeServerView = null;

    const mainContent = root.querySelector<HTMLDivElement>("#main-content")!;

    if (location.hash === "#/users") {
      if (!isAdmin()) {
        location.hash = "";
        return;
      }
      disposeServerView = renderUsersView(mainContent);
      renderList();
      return;
    }

    const serverId = parseServerIdFromHash();

    if (!serverId) {
      mainContent.innerHTML = `<div class="empty-state">Válassz egy szervert a bal oldalon.</div>`;
      return;
    }

    disposeServerView = renderServerView(mainContent, serverId, {
      onDeleted: () => {
        location.hash = "";
        void refreshList();
      },
      onChanged: () => void refreshList(),
    });
    renderList();
  }

  const hashHandler = () => renderMainContent();
  window.addEventListener("hashchange", hashHandler);

  void refreshList().then(renderMainContent);
  pollTimer = setInterval(() => void refreshList(), 5000);

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    window.removeEventListener("hashchange", hashHandler);
    disposeServerView?.();
  };
}
