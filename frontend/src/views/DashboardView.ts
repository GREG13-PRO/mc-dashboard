import { api, ApiError } from "../api";
import { t, LANGUAGES, getLanguage, setLanguage } from "../lib/i18n";
import { showToast } from "../components/Toast";
import { openModal } from "../components/Modal";
import { openAddServerModal } from "./AddServerModal";
import { renderServerView } from "./ServerView";
import { renderUsersView } from "./UsersView";
import { renderAuditView } from "./AuditView";
import { renderXpView } from "./XpView";
import { renderAppDistView } from "./AppDistView";
import { renderLabView } from "./LabView";
import { renderWebhooksView } from "./WebhooksView";
import { renderAdminHubView } from "./AdminHubView";
import { isAdmin, setCurrentUser, currentUsername } from "../auth-state";
import { getThemeChoice, setThemeChoice, THEME_CHOICES, themeLabel, notifyThemeChanged } from "../lib/theme";
import {
  getTextSize,
  setTextSize,
  getHighContrast,
  setHighContrast,
  getGlass,
  setGlass,
} from "../lib/display";
import { icon } from "../lib/icons";
import { logoMark } from "../lib/logo";
import { escapeHtml } from "../lib/escape";
import { staggerIn } from "../lib/motion";
import type { LocaleKey } from "../lib/i18n";
import type { ServerWithStatus } from "../types";

/**
 * Every screen in one table: what it is called, what it looks like, and what it
 * sits under.
 *
 * The sidebar, the breadcrumb and the route guard all used to answer these
 * questions separately, which is how a screen ends up admin-only in one place
 * and not the other. Adding a screen is now one row.
 */
interface Route {
  hash: string;
  label: LocaleKey;
  icon: string;
  adminOnly?: boolean;
  /** Shown in the sidebar; the rest are reachable through the Manage hub. */
  inNav?: boolean;
  parent?: string;
}

const ROUTES: Route[] = [
  { hash: "#", label: "kezdolap", icon: "home", inNav: true },
  { hash: "#/admin", label: "kezeles", icon: "sliders", adminOnly: true, inNav: true },
  { hash: "#/xp", label: "admin_szintek", icon: "star", inNav: true },
  { hash: "#/users", label: "felhasznalok", icon: "users", adminOnly: true, parent: "#/admin" },
  { hash: "#/audit", label: "auditnaplo", icon: "clipboard", adminOnly: true, parent: "#/admin" },
  { hash: "#/app", label: "alkalmazasok", icon: "download", adminOnly: true, parent: "#/admin" },
  { hash: "#/lab", label: "plugin_labor", icon: "flask", adminOnly: true, parent: "#/admin" },
  { hash: "#/webhooks", label: "webhookok", icon: "bell", adminOnly: true, parent: "#/admin" },
];

const NAV_ITEMS = ROUTES.filter((r) => r.inNav);

const RAIL_KEY = "mc-dashboard-sidebar-collapsed";

function parseServerIdFromHash(): string | null {
  const match = /^#\/server\/(.+)$/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

export function renderDashboard(root: HTMLElement, onLogout: () => void): () => void {
  let servers: ServerWithStatus[] = [];
  /**
   * Which server rows have already been on screen. The list rewrites itself
   * every five seconds; without this it would replay its entrance animation on
   * a timer, which is unreadable. Only a genuinely new server moves.
   */
  const seenServers = new Set<string>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposeServerView: (() => void) | null = null;

  const username = currentUsername() ?? "";

  root.innerHTML = `
    <a href="#main-content" class="skip-link">${t("ugras_a_tartalomhoz")}</a>
    <div class="app-shell">
      <button class="drawer-toggle" id="drawer-toggle" aria-label="${t("szerverek_menu")}" aria-expanded="false">☰</button>
      <div class="drawer-backdrop" id="drawer-backdrop" hidden></div>
      <nav class="sidebar" id="sidebar" aria-label="${t("navigacio")}">
        <div class="sidebar-brand">
          <span class="brand-mark">${logoMark(26)}</span>
          <span class="brand-name">Dashboard</span>
          <button class="rail-toggle" id="rail-toggle" aria-label="${t("oldalsav_osszecsukasa")}"
                  aria-expanded="true">${icon("chevronLeft", 16)}</button>
        </div>

        <div class="sidebar-scroll">
          <div class="nav-group">
            <div class="nav-label"><span>${t("menu")}</span></div>
            ${NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin())
              .map(
                (item) => `
              <a class="nav-item" href="${item.hash}" data-nav="${item.hash}" title="${t(item.label)}">
                <span class="nav-icon">${icon(item.icon, 16)}</span>
                <span class="nav-text">${t(item.label)}</span>
              </a>`
              )
              .join("")}
          </div>

          <div class="nav-group">
            <div class="nav-label">
              <span>${t("szerverek")}</span>
              ${
                isAdmin()
                  ? `<button class="nav-add" id="add-server-btn" title="${t("plus_uj_szerver")}"
                             aria-label="${t("plus_uj_szerver")}">${icon("plus", 14)}</button>`
                  : ""
              }
            </div>
            <div class="server-list" id="server-list" role="list"></div>
          </div>
        </div>

        <div class="sidebar-foot">
          <button class="user-btn" id="user-btn" aria-haspopup="dialog" title="${t("fiok_kezelese")}">
            <span class="user-avatar">${escapeHtml(username.slice(0, 1) || "?")}</span>
            <span class="user-meta">
              <strong>${escapeHtml(username)}</strong>
              <span>${t("fiok_kezelese")}</span>
            </span>
            <span class="user-caret">${icon("chevronDown", 14)}</span>
          </button>
        </div>
      </nav>
      <main class="main-content" id="main-content" tabindex="-1">
        <header class="topbar"><nav class="crumbs" id="crumbs" aria-label="${t("hol_vagyok")}"></nav></header>
        <div class="view-root" id="view-root">
          <div class="empty-state">${t("valassz_egy_szervert_a_bal_oldalon")}</div>
        </div>
      </main>
    </div>
  `;

  // On a phone the sidebar is an overlay drawer rather than a column: 240px of
  // a 390px screen is most of the viewport, and the server list is only needed
  // when switching servers.
  const sidebar = root.querySelector<HTMLElement>("#sidebar")!;
  const backdrop = root.querySelector<HTMLElement>("#drawer-backdrop")!;
  const drawerToggle = root.querySelector<HTMLButtonElement>("#drawer-toggle")!;

  function setDrawer(open: boolean) {
    sidebar.classList.toggle("open", open);
    backdrop.hidden = !open;
    drawerToggle.setAttribute("aria-expanded", String(open));
    // The button stays put over the open drawer, so it doubles as its close
    // control rather than sitting there still saying "open me".
    drawerToggle.textContent = open ? "✕" : "☰";
    drawerToggle.setAttribute("aria-label", open ? t("bezaras") : t("szerverek_menu"));
  }
  drawerToggle.onclick = () => setDrawer(!sidebar.classList.contains("open"));
  backdrop.onclick = () => setDrawer(false);
  // Anything that navigates closes it - otherwise the drawer stays over the
  // view it just opened.
  sidebar.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".server-card, .nav-item, .nav-add")) {
      setDrawer(false);
    }
  });

  // On a wide screen the sidebar can shrink to a rail of icons. The choice is
  // remembered, because someone who wants the width back wants it every time,
  // not once per page load.
  const railToggle = root.querySelector<HTMLButtonElement>("#rail-toggle")!;

  function setRail(collapsed: boolean) {
    sidebar.classList.toggle("collapsed", collapsed);
    railToggle.innerHTML = icon(collapsed ? "chevronRight" : "chevronLeft", 16);
    railToggle.setAttribute("aria-expanded", String(!collapsed));
    railToggle.setAttribute(
      "aria-label",
      collapsed ? t("oldalsav_kinyitasa") : t("oldalsav_osszecsukasa")
    );
    localStorage.setItem(RAIL_KEY, collapsed ? "1" : "0");
  }
  setRail(localStorage.getItem(RAIL_KEY) === "1");
  railToggle.onclick = () => setRail(!sidebar.classList.contains("collapsed"));

  /**
   * Everything that used to be three buttons in the sidebar header.
   *
   * Appearance, text size, language and signing out are all things you touch
   * once and then leave alone; each one sitting permanently in the sidebar cost
   * width on the only list anyone opens this dashboard to use.
   */
  root.querySelector<HTMLButtonElement>("#user-btn")!.onclick = () => {
    const wrap = document.createElement("div");
    const draw = () => {
      wrap.innerHTML = `
        <h3>${escapeHtml(currentUsername() ?? "")}</h3>
        <div class="field">
          <label>${t("megjelenes")}</label>
          <div class="segmented" id="theme-seg">
            ${THEME_CHOICES.map(
              (choice) => `
              <button type="button" class="segment ${choice === getThemeChoice() ? "active" : ""}"
                      data-theme-choice="${choice}">${themeLabel(choice)}</button>`
            ).join("")}
          </div>
        </div>
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
          <input id="a11y-glass" type="checkbox" ${getGlass() ? "checked" : ""} />
          <label for="a11y-glass" style="margin:0">${t("uveg_hatas")}</label>
        </div>
        <div class="field checkbox-row">
          <input id="a11y-contrast" type="checkbox" ${getHighContrast() ? "checked" : ""} />
          <label for="a11y-contrast" style="margin:0">${t("nagy_kontrasztu_mod")}</label>
        </div>
        <p style="color:var(--text-dim);font-size:12px;">${t("tab_bal_leptethetsz_escape_pel_zarhatsz_ablakot_")}</p>
        <div class="modal-actions">
          <button class="btn btn-danger" id="logout-btn">${t("kilepes")}</button>
          <button class="btn" id="a11y-close">${t("bezaras")}</button>
        </div>`;
      wrap.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach((button) => {
        button.onclick = () => {
          setThemeChoice(button.dataset.themeChoice as ReturnType<typeof getThemeChoice>);
          // Lets anything that picks colours in JS re-read the effective theme.
          notifyThemeChanged();
          draw();
        };
      });
      wrap.querySelector<HTMLSelectElement>("#a11y-size")!.onchange = (e) => {
        setTextSize((e.target as HTMLSelectElement).value as ReturnType<typeof getTextSize>);
      };
      wrap.querySelector<HTMLInputElement>("#a11y-glass")!.onchange = (e) => {
        setGlass((e.target as HTMLInputElement).checked);
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
      wrap.querySelector<HTMLButtonElement>("#logout-btn")!.onclick = async () => {
        close();
        await api.logout().catch(() => undefined);
        setCurrentUser(null);
        onLogout();
      };
      wrap.querySelector<HTMLButtonElement>("#a11y-close")!.onclick = () => close();
    };
    const close = openModal(wrap);
    draw();
  };

  // Optional chaining because the button is only emitted for admins.
  root.querySelector<HTMLButtonElement>("#add-server-btn")?.addEventListener("click", () => {
    openAddServerModal(() => void refreshList());
  });

  /** Marks the sidebar row for wherever the hash currently points. */
  function renderNav() {
    const hash = location.hash || "#";
    root.querySelectorAll<HTMLAnchorElement>(".nav-item").forEach((item) => {
      const target = item.dataset.nav!;
      // A child screen lights its parent's row: there is no sidebar entry for
      // the audit log, and leaving nothing highlighted reads as being nowhere.
      const route = ROUTES.find((r) => r.hash === hash);
      const owner = route?.parent ?? route?.hash ?? (hash.startsWith("#/server/") ? "" : "#");
      item.classList.toggle("active", target === owner);
    });
  }

  /** The path to here, as links. */
  function renderCrumbs() {
    const hash = location.hash || "#";
    const serverId = parseServerIdFromHash();
    const trail: { hash: string; label: string }[] = [{ hash: "#", label: t("kezdolap") }];

    if (serverId) {
      trail.push({
        hash: "#",
        label: t("szerverek"),
      });
      trail.push({
        hash,
        // The list may not have arrived yet on a deep link, and an id is a
        // better answer than an empty crumb.
        label: servers.find((s) => s.id === serverId)?.name ?? serverId,
      });
    } else {
      const route = ROUTES.find((r) => r.hash === hash);
      if (route) {
        const parent = route.parent ? ROUTES.find((r) => r.hash === route.parent) : undefined;
        if (parent) trail.push({ hash: parent.hash, label: t(parent.label) });
        if (route.hash !== "#") trail.push({ hash: route.hash, label: t(route.label) });
      }
    }

    root.querySelector<HTMLElement>("#crumbs")!.innerHTML = trail
      .map((step, index) => {
        const last = index === trail.length - 1;
        const sep = index === 0 ? "" : `<span class="crumb-sep">${icon("chevronRight", 12)}</span>`;
        const body = `${index === 0 ? `${icon("home", 13)}` : ""}<span>${escapeHtml(step.label)}</span>`;
        return last
          ? `${sep}<span class="crumb current" aria-current="page">${body}</span>`
          : `${sep}<a class="crumb" href="${step.hash}">${body}</a>`;
      })
      .join("");
  }

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
    renderNav();
    renderCrumbs();

    if (servers.length === 0) {
      listEl.innerHTML = `<div class="empty-state" style="padding:1rem;">${t("meg_nincs_hozzaadott_szerver")}</div>`;
      return;
    }

    listEl.innerHTML = servers
      .map(
        (s) => `
      <div class="server-card ${s.id === selectedId ? "active" : ""}" data-id="${s.id}"
           role="listitem" tabindex="0" title="${escapeHtml(s.name)}"
           aria-current="${s.id === selectedId ? "true" : "false"}">
        <div class="server-card-top">
          <span class="server-name">
            <span class="status-dot ${s.running ? "running" : "stopped"}"></span>
            <span class="server-initial">${escapeHtml(s.name.slice(0, 1))}</span>
            <span class="server-card-name">${escapeHtml(s.name)}</span>
          </span>
        </div>
        <div class="server-meta">${
          s.rcon.enabled && s.players ? `${s.players.online}/${s.players.max} játékos` : s.running ? "fut" : t("leallitva")
        }${s.running && s.resources ? ` · ${s.resources.cpuPercent.toFixed(0)}% CPU · ${s.resources.memoryMb} MB` : ""}</div>
      </div>`
      )
      .join("");

    const cards = [...listEl.querySelectorAll<HTMLDivElement>(".server-card")];
    staggerIn(cards, seenServers, (el) => el.dataset.id ?? "");
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

    // The breadcrumb bar is a sibling above this, so a view still owns
    // everything it can see and never has to account for the chrome.
    const mainContent = root.querySelector<HTMLDivElement>("#view-root")!;

    if (location.hash === "#/admin") {
      if (!isAdmin()) {
        location.hash = "";
        return;
      }
      disposeServerView = renderAdminHubView(mainContent);
      renderList();
      return;
    }

    if (location.hash === "#/webhooks") {
      if (!isAdmin()) {
        location.hash = "";
        return;
      }
      disposeServerView = renderWebhooksView(mainContent);
      renderList();
      return;
    }

    if (location.hash === "#/lab") {
      if (!isAdmin()) {
        location.hash = "";
        return;
      }
      disposeServerView = renderLabView(mainContent);
      renderList();
      return;
    }

    if (location.hash === "#/app") {
      if (!isAdmin()) {
        location.hash = "";
        return;
      }
      disposeServerView = renderAppDistView(mainContent);
      renderList();
      return;
    }

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

  // The chrome is updated here rather than inside renderMainContent, which
  // returns early on several routes - the breadcrumb going stale on exactly the
  // screens that need it most is how it stops being trusted.
  const hashHandler = () => {
    renderMainContent();
    renderNav();
    renderCrumbs();
  };
  window.addEventListener("hashchange", hashHandler);

  renderNav();
  renderCrumbs();
  void refreshList().then(renderMainContent);
  pollTimer = setInterval(() => void refreshList(), 5000);

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    window.removeEventListener("hashchange", hashHandler);
    disposeServerView?.();
  };
}
