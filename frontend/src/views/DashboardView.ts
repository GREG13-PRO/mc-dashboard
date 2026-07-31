import { api, ApiError } from "../api";
import { t, LANGUAGES, getLanguage, setLanguage } from "../lib/i18n";
import { showToast } from "../components/Toast";
import { openModal } from "../components/Modal";
import { openAddServerModal } from "./AddServerModal";
import { renderServerView } from "./ServerView";
import { renderUsersView } from "./UsersView";
import { renderAuditView } from "./AuditView";
import { renderXpView } from "./XpView";
import { isAdmin, setCurrentUser } from "../auth-state";
import { getThemeChoice, setThemeChoice, nextTheme, themeIcon, themeLabel, notifyThemeChanged } from "../lib/theme";
import {
  getTextSize,
  setTextSize,
  getHighContrast,
  setHighContrast,
} from "../lib/display";
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
    <a href="#main-content" class="skip-link">${t("ugras_a_tartalomhoz")}</a>
    <div class="app-shell">
      <nav class="sidebar" aria-label="Szerverek">
        <div class="sidebar-header">
          <h1>Dashboard</h1>
          <div style="display:flex;gap:6px;">
            <button class="btn" id="theme-btn" title="${t("megjelenes")}">${themeIcon(getThemeChoice())}</button>
            <button class="btn" id="a11y-btn" title="${t("megjelenitesi_beallitasok")}" aria-label="${t("megjelenitesi_beallitasok")}">A</button>
            <button class="btn" id="logout-btn">${t("kilepes")}</button>
          </div>
        </div>
        ${isAdmin() ? `<button class="btn btn-primary add-server-btn" id="add-server-btn" style="width:100%;">${t("plus_uj_szerver")}</button>` : ""}
        ${isAdmin() ? `<button class="btn users-nav-btn" id="users-nav-btn" style="width:100%;">${t("felhasznalok")}</button>` : ""}
        ${isAdmin() ? `<button class="btn users-nav-btn" id="audit-nav-btn" style="width:100%;">${t("auditnaplo")}</button>` : ""}
        <button class="btn users-nav-btn" id="xp-nav-btn" style="width:100%;">${t("admin_szintek")}</button>
        <div class="server-list" id="server-list" role="list"></div>
      </nav>
      <main class="main-content" id="main-content" tabindex="-1">
        <div class="empty-state">${t("valassz_egy_szervert_a_bal_oldalon")}</div>
      </main>
    </div>
  `;

  const themeBtn = root.querySelector<HTMLButtonElement>("#theme-btn")!;
  themeBtn.title = `Megjelenés: ${themeLabel(getThemeChoice())}`;
  themeBtn.onclick = () => {
    const choice = nextTheme(getThemeChoice());
    setThemeChoice(choice);
    themeBtn.textContent = themeIcon(choice);
    themeBtn.title = `Megjelenés: ${themeLabel(choice)}`;
    // Lets anything that picks colours in JS re-read the effective theme.
    notifyThemeChanged();
  };

  root.querySelector<HTMLButtonElement>("#a11y-btn")!.onclick = () => {
    const wrap = document.createElement("div");
    const draw = () => {
      wrap.innerHTML = `
        <h3>${t("megjelenites")}</h3>
        <div class="field">
          <label for="a11y-size">${t("szovegmeret")}</label>
          <select id="a11y-size">
            <option value="normal" ${getTextSize() === "normal" ? "selected" : ""}>${t("normal")}</option>
            <option value="large" ${getTextSize() === "large" ? "selected" : ""}>${t("nagy_meret")}</option>
            <option value="xlarge" ${getTextSize() === "xlarge" ? "selected" : ""}>${t("extra_nagy")}</option>
          </select>
        </div>
        <div class="field">
          <label for="a11y-lang">${t("nyelv")}</label>
          <select id="a11y-lang">
            ${LANGUAGES.map(
              (l) => `<option value="${l.code}" ${l.code === getLanguage() ? "selected" : ""}>${l.label}</option>`
            ).join("")}
          </select>
        </div>
        <div class="field checkbox-row">
          <input id="a11y-contrast" type="checkbox" ${getHighContrast() ? "checked" : ""} />
          <label for="a11y-contrast" style="margin:0">${t("nagy_kontrasztu_mod")}</label>
        </div>
        <p style="color:var(--text-dim);font-size:12px;">${t("tab_bal_leptethetsz_escape_pel_zarhatsz_ablakot_")}</p>
        <div class="modal-actions"><button class="btn" id="a11y-close">${t("bezaras")}</button></div>`;
      wrap.querySelector<HTMLSelectElement>("#a11y-size")!.onchange = (e) => {
        setTextSize((e.target as HTMLSelectElement).value as ReturnType<typeof getTextSize>);
      };
      wrap.querySelector<HTMLInputElement>("#a11y-contrast")!.onchange = (e) => {
        setHighContrast((e.target as HTMLInputElement).checked);
      };
      // Every label is rendered at call time, so switching language means
      // re-rendering rather than reloading.
      wrap.querySelector<HTMLSelectElement>("#a11y-lang")!.onchange = (e) => {
        setLanguage((e.target as HTMLSelectElement).value as ReturnType<typeof getLanguage>);
        location.reload();
      };
      wrap.querySelector<HTMLButtonElement>("#a11y-close")!.onclick = () => close();
    };
    const close = openModal(wrap);
    draw();
  };

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
  // Optional chaining because the button is only emitted for admins.
  root.querySelector<HTMLButtonElement>("#audit-nav-btn")?.addEventListener("click", () => {
    location.hash = "#/audit";
  });
  root.querySelector<HTMLButtonElement>("#xp-nav-btn")?.addEventListener("click", () => {
    location.hash = "#/xp";
  });

  async function refreshList() {
    try {
      servers = await api.listServers();
      renderList();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : t("szerverlista_betoltese_sikertelen"), "error");
    }
  }

  function renderList() {
    const listEl = root.querySelector<HTMLDivElement>("#server-list")!;
    const selectedId = parseServerIdFromHash();

    if (servers.length === 0) {
      listEl.innerHTML = `<div class="empty-state" style="padding:1rem;">${t("meg_nincs_hozzaadott_szerver")}</div>`;
      return;
    }

    listEl.innerHTML = servers
      .map(
        (s) => `
      <div class="server-card ${s.id === selectedId ? "active" : ""}" data-id="${s.id}"
           role="listitem" tabindex="0" aria-current="${s.id === selectedId ? "true" : "false"}">
        <div class="server-card-top">
          <span class="server-name"><span class="status-dot ${s.running ? "running" : "stopped"}"></span>${s.name}</span>
        </div>
        <div class="server-meta">${
          s.rcon.enabled && s.players ? `${s.players.online}/${s.players.max} játékos` : s.running ? "fut" : t("leallitva")
        }${s.running && s.resources ? ` · ${s.resources.cpuPercent.toFixed(0)}% CPU · ${s.resources.memoryMb} MB` : ""}</div>
      </div>`
      )
      .join("");

    const cards = [...listEl.querySelectorAll<HTMLDivElement>(".server-card")];
    cards.forEach((card, index) => {
      const open = () => {
        location.hash = `#/server/${encodeURIComponent(card.dataset.id!)}`;
      };
      card.onclick = open;
      // A list you can only reach with a mouse is a list some people cannot
      // reach at all: arrows move, Enter/Space opens.
      card.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const next = cards[index + (e.key === "ArrowDown" ? 1 : -1)];
          next?.focus();
        }
      };
    });
  }

  function renderMainContent() {
    disposeServerView?.();
    disposeServerView = null;

    const mainContent = root.querySelector<HTMLDivElement>("#main-content")!;

    if (location.hash === "#/xp") {
      disposeServerView = renderXpView(mainContent);
      renderList();
      return;
    }

    if (location.hash === "#/audit") {
      if (!isAdmin()) {
        location.hash = "";
        return;
      }
      disposeServerView = renderAuditView(mainContent);
      renderList();
      return;
    }

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
      mainContent.innerHTML = `<div class="empty-state">${t("valassz_egy_szervert_a_bal_oldalon")}</div>`;
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
