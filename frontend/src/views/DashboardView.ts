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
import { openCommandPalette } from "../components/CommandPalette";
import { adoptSimpleForNewcomers, getSimpleMode, setSimpleMode } from "../lib/display";
import { groupsWithTabs, tabLabel, type Tab, type TabVisibility } from "../lib/server-tabs";
import { jumpTo } from "../lib/navigate";
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
  /**
   * What the server view is currently showing.
   *
   * The sidebar draws the menu but the view owns which tab is open, so this is
   * the view's answer, cached. Reset when leaving a server so a stale active
   * tab cannot light a row on the next one.
   */
  let serverTabState: TabVisibility = { luckPermsInstalled: false, activeTab: null };
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

        <div class="sidebar-scroll" id="sidebar-scroll">
          <!--
            Two panels, one shown at a time. The menu is where you are: the
            servers when you are choosing one, that server's screens once you
            are inside it. Kept as two panels rather than one rebuilt list so
            the server list keeps its own polling and its entrance animation.
          -->
          <div id="sidebar-server" hidden></div>
          <div id="sidebar-home">
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
        <header class="topbar">
          <nav class="crumbs" id="crumbs" aria-label="${t("hol_vagyok")}"></nav>
          <button class="topbar-search" id="open-palette" aria-label="${t("kereses")}">
            ${icon("search", 15)}
            <span>${t("kereses_hely")}</span>
            <kbd>${navigator.platform.toLowerCase().includes("mac") ? "\u2318" : "Ctrl"} K</kbd>
          </button>
        </header>
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
  /**
   * The menu for the server you are inside, drawn in the sidebar.
   *
   * This is the whole point of the 3.0 layout: the two horizontal strips that
   * used to sit above the content are gone, and their ~74px goes to the thing
   * you came to look at. The left column was already there and already mostly
   * empty below the server list.
   *
   * Groups and their tabs are one tree rather than two rows. Only the open
   * group shows its children - twenty-one rows at once is a wall, and the tab
   * you want is nearly always in the group you are already in.
   */
  function renderServerMenu() {
    const panel = root.querySelector<HTMLElement>("#sidebar-server");
    const home = root.querySelector<HTMLElement>("#sidebar-home");
    const serverId = parseServerIdFromHash();
    if (!panel || !home) return;

    if (!serverId) {
      panel.hidden = true;
      panel.innerHTML = "";
      home.hidden = false;
      return;
    }

    const server = servers.find((s) => s.id === serverId);
    const groups = groupsWithTabs(serverId, serverTabState);
    const openGroup = groups.find(({ tabs }) => tabs.includes(serverTabState.activeTab as Tab));

    panel.innerHTML = `
      <a class="nav-item sidebar-back" href="#">
        <span class="nav-icon">${icon("chevronLeft", 16)}</span>
        <span class="nav-text">${escapeHtml(t("vissza_a_szerverekhez"))}</span>
      </a>
      <div class="sidebar-server-name" title="${escapeHtml(server?.name ?? "")}">
        <span class="status-dot ${server?.running ? "running" : "stopped"}"></span>
        <strong>${escapeHtml(server?.name ?? "")}</strong>
      </div>
      <div class="sidebar-tabs" role="tablist" aria-orientation="vertical">
        ${groups
          .map(({ group, tabs }) => {
            const isOpen = group.id === openGroup?.group.id;
            const single = tabs.length === 1;
            const active = tabs.includes(serverTabState.activeTab as Tab);
            const head = `
              <button class="sidebar-tab ${active && single ? "active" : ""} ${isOpen && !single ? "open" : ""}"
                      data-group="${group.id}" data-tab="${single ? tabs[0] : ""}"
                      role="tab" aria-selected="${active}" title="${escapeHtml(group.label())}">
                <span class="nav-icon">${icon(group.icon, 16)}</span>
                <span class="nav-text">${escapeHtml(group.label())}</span>
                ${single ? "" : `<span class="sidebar-caret">${icon("chevronDown", 13)}</span>`}
              </button>`;
            const children =
              single || !isOpen
                ? ""
                : `<div class="sidebar-subtabs">
                     ${tabs
                       .map(
                         (tab) =>
                           `<button class="sidebar-subtab ${tab === serverTabState.activeTab ? "active" : ""}"
                                    data-tab="${tab}" role="tab"
                                    aria-selected="${tab === serverTabState.activeTab}">${escapeHtml(
                             tabLabel(tab)
                           )}</button>`
                       )
                       .join("")}
                   </div>`;
            return head + children;
          })
          .join("")}
      </div>
      <button class="sidebar-mode ${getSimpleMode() ? "simple" : ""}" id="sidebar-mode"
              title="${escapeHtml(getSimpleMode() ? t("egyszeru_mod_ki_hint") : t("egyszeru_mod_be_hint"))}">
        ${escapeHtml(getSimpleMode() ? t("egyszeru_mod") : t("teljes_mod"))}
      </button>
    `;
    panel.hidden = false;
    home.hidden = true;

    const go = (tab: string) => {
      jumpTo({ serverId, tab });
      // On a phone the sidebar is a drawer over the content; leaving it open
      // after a choice hides the thing that was just chosen.
      if (window.matchMedia("(max-width: 620px)").matches) setDrawer(false);
    };

    panel.querySelectorAll<HTMLButtonElement>(".sidebar-tab").forEach((el) => {
      el.onclick = () => {
        const single = el.dataset.tab;
        if (single) {
          go(single);
          return;
        }
        // A group with children opens onto its first tab, which is also what
        // makes it the open group - one click, not two.
        const group = groups.find(({ group: g }) => g.id === el.dataset.group);
        if (group) go(group.tabs[0]);
      };
    });
    panel.querySelectorAll<HTMLButtonElement>(".sidebar-subtab").forEach((el) => {
      el.onclick = () => go(el.dataset.tab!);
    });

    // Up and Down, because the menu is a column now. The old strip used Left
    // and Right, which on a vertical list is a keyboard trap of its own.
    const rows = [...panel.querySelectorAll<HTMLButtonElement>(".sidebar-tab, .sidebar-subtab")];
    rows.forEach((el, index) => {
      el.tabIndex = el.classList.contains("active") ? 0 : -1;
      el.onkeydown = (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        rows[(index + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
      };
    });
    if (rows.length > 0 && !rows.some((el) => el.tabIndex === 0)) rows[0].tabIndex = 0;

    panel.querySelector<HTMLButtonElement>("#sidebar-mode")!.onclick = () => {
      setSimpleMode(!getSimpleMode());
      renderServerMenu();
      showToast(getSimpleMode() ? t("egyszeru_mod_bekapcsolva") : t("teljes_mod_bekapcsolva"));
    };
  }

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

  /** Only the first list decides; after that the switch is the user's. */
  let modeDecided = false;

  async function refreshList() {
    try {
      servers = await api.listServers();
      if (!modeDecided) {
        modeDecided = true;
        // An installation with no servers has nobody to surprise, so it starts
        // in simple mode. One that already has servers keeps every tab it had.
        adoptSimpleForNewcomers(servers.length);
      }
      renderList();
      renderServerMenu();
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

    serverTabState = { luckPermsInstalled: false, activeTab: null };
    disposeServerView = renderServerView(mainContent, serverId, {
      onDeleted: () => {
        location.hash = "";
        void refreshList();
      },
      onChanged: () => void refreshList(),
      onTabsChanged: (state) => {
        serverTabState = state;
        renderServerMenu();
      },
    });
    renderList();
    renderServerMenu();
  }

  // The chrome is updated here rather than inside renderMainContent, which
  // returns early on several routes - the breadcrumb going stale on exactly the
  // screens that need it most is how it stops being trusted.
  const hashHandler = () => {
    renderMainContent();
    renderNav();
    renderCrumbs();
    renderServerMenu();
  };
  window.addEventListener("hashchange", hashHandler);

  const openPalette = () => openCommandPalette(servers, parseServerIdFromHash());
  root.querySelector<HTMLButtonElement>("#open-palette")?.addEventListener("click", openPalette);

  /**
   * Ctrl+K, and plain "/" when nothing is being typed into.
   *
   * The slash is what people press in a list without thinking about it, and it
   * costs nothing here because the guard already excludes every field it could
   * have been meant for.
   */
  const paletteKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target?.isContentEditable === true;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openPalette();
    } else if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      openPalette();
    }
  };
  document.addEventListener("keydown", paletteKey);

  renderNav();
  renderCrumbs();
  void refreshList().then(renderMainContent);
  pollTimer = setInterval(() => void refreshList(), 5000);

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    window.removeEventListener("hashchange", hashHandler);
    document.removeEventListener("keydown", paletteKey);
    disposeServerView?.();
  };
}
