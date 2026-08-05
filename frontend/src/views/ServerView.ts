import { api, ApiError } from "../api";
import { t } from "../lib/i18n";
import { ConsoleSocket } from "../ws-client";
import { ConsoleLogView } from "../components/ConsoleLog";
import { FileBrowser } from "../components/FileBrowser";
import { openPluginBrowser } from "../components/PluginBrowser";
import { createWorldMap, type WorldMapHandle } from "../components/WorldMap";
import { ratioBarSvg, sparklineSvg } from "../components/Sparkline";
import { confirmModal, openModal } from "../components/Modal";
import { showToast } from "../components/Toast";
import { escapeHtml } from "../lib/escape";
import { ansiLineToHtml } from "../lib/ansi";
import { openAddServerModal } from "./AddServerModal";
import { isAdmin, permissionsFor } from "../auth-state";
import type { AntiCheatStatus, ConfigSnapshot, NetworkReport } from "../types";
import { PLAYER_ACTIONS, type MacroStep, type PlayerAction, type ServerWithStatus } from "../types";
import { renderPropertiesEditor } from "../components/PropertiesEditor";
import { renderMotdEditor } from "../components/MotdEditor";
import { renderGameRules } from "../components/GameRules";
import { renderSchedules } from "../components/Schedules";
import { renderOverview } from "../components/Overview";
import { openLuckPermsEditor } from "../components/LuckPermsEditor";
import { getSimpleMode, setSimpleMode } from "../lib/display";
import { onJump, takeJump } from "../lib/navigate";

type Tab =
  | "console"
  | "files"
  | "plugins"
  | "players"
  | "access"
  | "luckperms"
  | "timeline"
  | "performance"
  | "content"
  | "macros"
  | "stats"
  | "schematics"
  | "map"
  | "worlds"
  | "security"
  | "settings"
  | "properties"
  | "motd"
  | "gamerules"
  | "schedules"
  | "overview";
/**
 * The tabs, grouped by what you are trying to do.
 *
 * Sixteen of them in one scrolling strip meant the last few were only
 * reachable by dragging, so they were grouped - but grouped by where the data
 * happened to live rather than by what anyone came to do. "Content" ended up
 * holding files, plugins, schematics, packs, worlds and the map: six things
 * with nothing in common except that none of them fitted anywhere else. The
 * three world tabs were the worst of it, filed next to the file browser while
 * a person looking for their map had no reason to look under "Content" at all.
 *
 * So: the world and everything you do to it in one place, and the things you
 * install in another. Groups of one show no second row, so Console and
 * Security stay a single click.
 */
const TAB_GROUPS: { id: string; label: () => string; tabs: Tab[] }[] = [
  { id: "overview", label: () => t("attekintes"), tabs: ["overview"] },
  { id: "console", label: () => t("konzol"), tabs: ["console"] },
  { id: "players", label: () => t("jatekosok"), tabs: ["players", "access", "luckperms"] },
  { id: "world", label: () => t("vilag"), tabs: ["map", "worlds", "schematics"] },
  { id: "content", label: () => t("tartalom"), tabs: ["plugins", "content", "files"] },
  {
    id: "maintenance",
    label: () => t("karbantartas"),
    tabs: ["schedules", "macros", "timeline", "performance", "stats"],
  },
  { id: "security", label: () => t("biztonsag"), tabs: ["security"] },
  { id: "settings", label: () => t("beallitasok"), tabs: ["settings", "properties", "motd", "gamerules"] },
];

/**
 * What a first server actually needs.
 *
 * Twenty-one tabs is the right answer for someone running four servers and the
 * wrong one for someone who has just made their first. Beginner mode is not a
 * different application - every tab here is the same tab - it just stops
 * showing the nineteen things that only matter once something has gone wrong.
 */
const BEGINNER_TABS: Tab[] = ["overview", "console", "players", "map", "settings", "properties"];

const ALL_TABS: Tab[] = [
  "overview",
  "console",
  "files",
  "plugins",
  "players",
  "access",
  "luckperms",
  "timeline",
  "performance",
  "content",
  "macros",
  "stats",
  "schematics",
  "map",
  "worlds",
  "security",
  "settings",
  "properties",
  "motd",
  "gamerules",
  "schedules",
];

// Tabs map onto the four server capabilities; the plugin browser writes jars
// into the server folder, so it rides on "files" rather than adding a fifth
// permission that would have to be migrated into every existing user record.
export function renderServerView(
  root: HTMLElement,
  serverId: string,
  callbacks: { onDeleted: () => void; onChanged: () => void }
): () => void {
  const perms = permissionsFor(serverId);
  // The LuckPerms tab is additionally hidden unless the plugin is actually
  // installed, which is only known after the first load - see refreshLuckPerms.
  let luckPermsInstalled = false;
  /** Set by goToTab, read once by the render that follows it. */
  let tabDirection: "fwd" | "back" | null = null;
  const capabilityFor = (tab: Tab) =>
    tab === "plugins" || tab === "content" || tab === "schematics"
      ? "files"
      : tab === "map" || tab === "security" || tab === "worlds"
        ? "settings"
      : tab === "macros"
        ? "console"
        : tab === "stats" || tab === "properties" || tab === "motd" || tab === "gamerules"
          ? "settings"
      : tab === "access"
        ? "players"
        : tab === "overview"
        ? "console"
      : tab === "luckperms" || tab === "timeline" || tab === "performance" || tab === "schedules"
          ? "settings"
          : tab;
  const permittedTabs = ALL_TABS.filter((tab) => perms[capabilityFor(tab) as keyof typeof perms]);
  const visibleTabs = () =>
    permittedTabs.filter(
      (tab) =>
        (tab !== "luckperms" || luckPermsInstalled) &&
        // A tab you are already looking at is never hidden underneath you: the
        // switch can be thrown while an advanced tab is open, and dropping the
        // content out from under the cursor is worse than one extra tab.
        (!getSimpleMode() || BEGINNER_TABS.includes(tab) || tab === activeTab)
    );

  /** Groups that still have something in them after permissions are applied. */
  const groupsWithTabs = (): [(typeof TAB_GROUPS)[number], Tab[]][] => {
    const visible = visibleTabs();
    return TAB_GROUPS.map(
      (group) => [group, group.tabs.filter((tab) => visible.includes(tab))] as const
    ).filter(([, tabs]) => tabs.length > 0) as [(typeof TAB_GROUPS)[number], Tab[]][];
  };

  const currentGroupTabs = (): Tab[] =>
    groupsWithTabs().find(([, tabs]) => tabs.includes(activeTab))?.[1] ?? [];
  const availableTabs = permittedTabs;
  let activeTab: Tab = availableTabs[0] ?? "console";
  let server: ServerWithStatus | null = null;
  let disposed = false;

  /**
   * A control the search box asked to land on, waiting for its tab to draw.
   *
   * Read once and cleared: the tab that consumes it is redrawn on every refresh
   * of the server list, and a focus that stuck would re-filter the properties
   * screen every five seconds under the reader's hands.
   */
  let pendingFocus: string | null = null;
  const takeFocus = (): string | undefined => {
    const focus = pendingFocus ?? undefined;
    pendingFocus = null;
    return focus;
  };

  let terminal: ConsoleLogView | null = null;
  let socket: ConsoleSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  let mapHandle: WorldMapHandle | null = null;
  const consoleHistory: string[] = [];

  root.innerHTML = `<div class="empty-state">${t("betoltes")}</div>`;

  async function load() {
    try {
      server = await api.getServer(serverId);
      if (permittedTabs.includes("luckperms")) {
        luckPermsInstalled = await api.getLuckPermsStatus(serverId).catch(() => false);
      }
      renderShell();
    } catch (err) {
      root.innerHTML = `<div class="empty-state">${
        err instanceof ApiError ? err.message : t("szerver_betoltese_sikertelen")
      }</div>`;
    }
  }

  /**
   * Puts the sliding indicator under the active item of a strip.
   *
   * Read from the element's own box rather than tracked in state: the strips
   * scroll horizontally and their items are sized by their text, so the only
   * reliable source for where the marker belongs is where the item actually
   * is.
   */
  /** Set by renderShell; bindSubtabs is defined outside its scope and needs it. */
  let goToTab: (tab: Tab) => void = () => {};

  function moveIndicator(strip: HTMLElement | null, activeSelector: string, indicatorClass: string) {
    if (!strip) return;
    const active = strip.querySelector<HTMLElement>(activeSelector);
    const indicator = strip.querySelector<HTMLElement>(`.${indicatorClass}`);
    if (!active || !indicator) return;
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.transform = `translateX(${active.offsetLeft}px)`;
    indicator.style.opacity = "1";
  }

  function moveIndicators() {
    moveIndicator(root.querySelector(".tabs"), ".tab.active", "tab-indicator");
    moveIndicator(root.querySelector(".subtabs"), ".subtab.active", "subtab-indicator");
  }

  /** Rebuilds the second row when the group changes, and rebinds it. */
  function renderSubtabs() {
    const existing = root.querySelector<HTMLElement>(".subtabs");
    const tabs = currentGroupTabs();
    if (tabs.length <= 1) {
      existing?.remove();
      return;
    }
    const markup =
      tabs
        .map(
          (tab) =>
            `<div class="subtab ${tab === activeTab ? "active" : ""}" data-tab="${tab}"
                  role="tab" tabindex="${tab === activeTab ? "0" : "-1"}"
                  aria-selected="${tab === activeTab}">${labelFor(tab)}</div>`
        )
        .join("") + `<span class="subtab-indicator" aria-hidden="true"></span>`;

    if (existing) {
      existing.innerHTML = markup;
    } else {
      const row = document.createElement("div");
      row.className = "subtabs";
      row.setAttribute("role", "tablist");
      row.innerHTML = markup;
      root.querySelector(".tabs")?.after(row);
    }
    bindSubtabs();
  }

  /** Bound as its own function because the second row is rebuilt on group change. */
  function bindSubtabs() {
    const subEls = [...root.querySelectorAll<HTMLDivElement>(".subtab")];
    subEls.forEach((subEl, index) => {
      const select = () => goToTab(subEl.dataset.tab as Tab);
      subEl.onclick = select;
      subEl.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select();
        } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const step = e.key === "ArrowRight" ? 1 : -1;
          subEls[(index + step + subEls.length) % subEls.length]?.focus();
        }
      };
    });
  }

  function renderShell() {
    if (!server) return;
    const resourceText =
      server.running && server.resources
        ? `<span class="resource-usage">${server.resources.cpuPercent.toFixed(0)}% CPU · ${server.resources.memoryMb} MB RAM</span>`
        : "";
    root.innerHTML = `
      <div class="server-view-header">
        <h2><span class="status-dot ${server.running ? "running" : "stopped"}" id="status-dot"></span>${server.name}${resourceText}</h2>
        ${
          perms.console
            ? `<div class="server-actions">
          <button class="btn btn-primary" id="start-btn" ${server.running ? "disabled" : ""}>Start</button>
          <button class="btn" id="restart-btn" ${!server.running ? "disabled" : ""}>Restart</button>
          <button class="btn btn-danger" id="stop-btn" ${!server.running ? "disabled" : ""}>Stop</button>
          <button class="btn btn-danger" id="kill-btn" ${!server.running ? "disabled" : ""} title="Azonnali leállítás mentés/várakozás nélkül">Kill</button>
        </div>`
            : ""
        }
      </div>
      <div class="tabs" role="tablist">
        ${groupsWithTabs()
          .map(([group, tabs]) => {
            const active = tabs.includes(activeTab);
            return `<div class="tab ${active ? "active" : ""}" data-group="${group.id}" role="tab"
                    tabindex="${active ? "0" : "-1"}"
                    aria-selected="${active}">${group.label()}</div>`;
          })
          .join("")}
        <span class="tab-indicator" aria-hidden="true"></span>
        <button class="mode-toggle ${getSimpleMode() ? "simple" : ""}" id="mode-toggle"
                title="${escapeHtml(getSimpleMode() ? t("egyszeru_mod_ki_hint") : t("egyszeru_mod_be_hint"))}">
          ${escapeHtml(getSimpleMode() ? t("egyszeru_mod") : t("teljes_mod"))}
        </button>
      </div>
      ${
        currentGroupTabs().length > 1
          ? `<div class="subtabs" role="tablist">
              ${currentGroupTabs()
                .map(
                  (tab) =>
                    `<div class="subtab ${tab === activeTab ? "active" : ""}" data-tab="${tab}"
                          role="tab" tabindex="${tab === activeTab ? "0" : "-1"}"
                          aria-selected="${tab === activeTab}">${labelFor(tab)}</div>`
                )
                .join("")}
              <span class="subtab-indicator" aria-hidden="true"></span>
            </div>`
          : ""
      }
      <div id="resource-charts"></div>
      <div class="tab-content" id="tab-content"></div>
    `;

    /**
     * Switches tab without rebuilding the strips.
     *
     * The whole point of the sliding indicator is that it travels from where
     * it was, and a strip that is thrown away and rebuilt has nowhere to
     * travel from - the indicator would simply appear in its new place. So a
     * tab change updates the classes, moves the indicators and re-renders only
     * the content; renderShell stays for the initial paint and for changes to
     * the server itself.
     */
    goToTab = (tab: Tab) => {
      if (tab === activeTab) return;
      // Which way the content should come in from. ALL_TABS is the order the
      // tabs are laid out in, so its indices are the direction the eye moved.
      tabDirection = ALL_TABS.indexOf(tab) > ALL_TABS.indexOf(activeTab) ? "fwd" : "back";
      const previousGroup = currentGroupTabs();
      teardownConsole();
      mapHandle?.destroy();
      mapHandle = null;
      activeTab = tab;

      groupEls.forEach((el) => {
        const group = groupsWithTabs().find(([g]) => g.id === el.dataset.group);
        const active = Boolean(group?.[1].includes(activeTab));
        el.classList.toggle("active", active);
        el.setAttribute("aria-selected", String(active));
        el.tabIndex = active ? 0 : -1;
      });

      // A different group means a different second row, which has to be
      // rebuilt - but the row above it stays, so its indicator still slides.
      if (previousGroup.join() !== currentGroupTabs().join()) {
        renderSubtabs();
      } else {
        root.querySelectorAll<HTMLDivElement>(".subtab").forEach((el) => {
          const active = el.dataset.tab === activeTab;
          el.classList.toggle("active", active);
          el.setAttribute("aria-selected", String(active));
          el.tabIndex = active ? 0 : -1;
        });
      }

      moveIndicators();
      renderTabContent();
    };

    const groupEls = [...root.querySelectorAll<HTMLDivElement>(".tab[data-group]")];
    groupEls.forEach((groupEl, index) => {
      // Picking a group lands on its first tab; the sub-row then shows where
      // else that group can go.
      const open = () => {
        const group = groupsWithTabs().find(([g]) => g.id === groupEl.dataset.group);
        if (group && !group[1].includes(activeTab)) goToTab(group[1][0]);
      };
      groupEl.onclick = open;
      groupEl.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const step = e.key === "ArrowRight" ? 1 : -1;
          groupEls[(index + step + groupEls.length) % groupEls.length]?.focus();
        }
      };
    });

    root.querySelector<HTMLButtonElement>("#mode-toggle")?.addEventListener("click", () => {
      setSimpleMode(!getSimpleMode());
      // Redrawn whole rather than just re-labelled: the tab strip, the sub-row
      // and the properties list all read the mode, and re-deriving them by hand
      // is three chances to leave one behind.
      renderShell();
      renderTabContent();
      showToast(getSimpleMode() ? t("egyszeru_mod_bekapcsolva") : t("teljes_mod_bekapcsolva"));
    });

    bindSubtabs();
    // The strips have no geometry until they are laid out, so the first
    // placement waits a frame; it is also the reason the indicator starts at
    // opacity 0 rather than flashing at the left edge.
    requestAnimationFrame(moveIndicators);

    root.querySelector<HTMLButtonElement>("#start-btn")?.addEventListener("click", () =>
      runAction(() => api.startServer(serverId))
    );
    root.querySelector<HTMLButtonElement>("#restart-btn")?.addEventListener("click", () =>
      runAction(() => api.restartServer(serverId))
    );
    root.querySelector<HTMLButtonElement>("#stop-btn")?.addEventListener("click", () =>
      runAction(() => api.stopServer(serverId))
    );
    root.querySelector<HTMLButtonElement>("#kill-btn")?.addEventListener("click", async () => {
      if (
        await confirmModal(
          `Biztosan <strong>kill</strong>-eled a(z) <strong>${server!.name}</strong> szervert? Ez azonnal leállítja mentés és várakozás nélkül - csak akkor használd, ha a normál Stop nem reagál.`
        )
      ) {
        void runAction(() => api.killServer(serverId));
      }
    });

    renderTabContent();
    void refreshCharts();
  }

  /**
   * The detail view otherwise only reloads on a start/stop action, so the
   * chart (and the CPU/RAM figure beside the title) would freeze at whatever
   * it was when the page opened. This polls just the series.
   */
  async function refreshCharts() {
    const holder = root.querySelector<HTMLDivElement>("#resource-charts");
    if (!holder || !server) return;
    if (!server.running) {
      holder.innerHTML = "";
      return;
    }
    let samples;
    try {
      samples = await api.getResourceHistory(serverId);
    } catch {
      return;
    }
    if (disposed) return;
    const target = root.querySelector<HTMLDivElement>("#resource-charts");
    if (!target) return;
    if (samples.length === 0) {
      target.innerHTML = "";
      return;
    }
    const cpu = samples.map((x) => x.cpuPercent);
    const mem = samples.map((x) => x.memoryMb);
    const last = samples[samples.length - 1];
    const peakMem = Math.max(...mem);
    target.innerHTML = `
      <div style="display:flex;gap:1.2rem;padding:0.9rem 1.5rem 0.2rem;flex-wrap:wrap;">
        <div style="flex:1;min-width:220px;">
          <div style="display:flex;justify-content:space-between;font-size:0.78rem;color:var(--text-dim);">
            <span>CPU</span><span>${last.cpuPercent.toFixed(0)}%</span>
          </div>
          ${sparklineSvg({ values: cpu, color: "var(--accent)" })}
        </div>
        <div style="flex:1;min-width:220px;">
          <div style="display:flex;justify-content:space-between;font-size:0.78rem;color:var(--text-dim);">
            <span>RAM</span><span>${last.memoryMb} MB</span>
          </div>
          ${sparklineSvg({ values: mem, color: "var(--yellow)", max: peakMem * 1.15 })}
        </div>
      </div>
      <div style="padding:0 1.5rem;font-size:0.72rem;color:var(--text-dim);">utolsó ${Math.round(
        (samples.length * 5) / 60
      )} perc</div>`;
  }

  function labelFor(tab: Tab): string {
    return {
      console: t("konzol"),
      files: t("fajlok"),
      plugins: t("bovitmenyek"),
      players: t("jatekosok"),
      access: "Whitelist / Ban",
      luckperms: "LuckPerms",
      timeline: "Time Machine",
      performance: t("teljesitmeny"),
      content: t("csomagok"),
      macros: t("makrok"),
      stats: t("statisztika"),
      schematics: t("schematicek"),
      map: t("terkep"),
      security: t("biztonsag"),
      worlds: t("vilagok"),
      settings: t("beallitasok"),
      properties: "server.properties",
      motd: "MOTD",
      gamerules: t("jatekszabalyok"),
      schedules: t("utemezesek"),
      overview: t("attekintes"),
    }[tab];
  }

  async function runAction(fn: () => Promise<void>) {
    try {
      await fn();
      await load();
      callbacks.onChanged();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : t("muvelet_sikertelen"), "error");
    }
  }

  /**
   * Cleanup for whichever tab is showing, if it needs any.
   *
   * The console had its own teardown and everything else was fire-and-forget,
   * which was fine until a tab started polling: without this, leaving the
   * overview would leave its timer running for as long as the page was open.
   */
  let disposeTab: (() => void) | null = null;

  function renderTabContent() {
    disposeTab?.();
    disposeTab = null;

    const content0 = root.querySelector<HTMLDivElement>("#tab-content");
    if (content0) {
      if (tabDirection) content0.dataset.dir = tabDirection;
      else delete content0.dataset.dir;
      tabDirection = null;
    }

    const content = root.querySelector<HTMLDivElement>("#tab-content")!;
    if (activeTab === "console") {
      content.innerHTML = `
        <div class="console-container">
          <div class="terminal-wrap" id="terminal-wrap"></div>
          <div class="console-input-row">
            <input id="console-input" placeholder="${t("parancs_a_szerver_konzoljaba")}" />
            <button class="btn btn-primary" id="console-send">${t("kuldes")}</button>
            <button class="btn" id="console-history" title="${t("korabbi_futasok_naploi")}">${t("elozmenyek")}</button>
          </div>
        </div>
      `;
      setupConsole();
      content.querySelector<HTMLButtonElement>("#console-history")!.onclick = () => void openLogArchive();
    } else if (activeTab === "files") {
      new FileBrowser(content, serverId);
    } else if (activeTab === "plugins") {
      void renderPlugins(content);
    } else if (activeTab === "players") {
      renderPlayers(content);
    } else if (activeTab === "access") {
      void renderAccess(content);
    } else if (activeTab === "luckperms") {
      renderLuckPerms(content);
    } else if (activeTab === "timeline") {
      void renderTimeline(content);
    } else if (activeTab === "performance") {
      void renderPerformance(content);
    } else if (activeTab === "content") {
      void renderContent(content);
    } else if (activeTab === "macros") {
      void renderMacros(content);
    } else if (activeTab === "stats") {
      void renderStats(content);
    } else if (activeTab === "schematics") {
      void renderSchematics(content);
    } else if (activeTab === "map") {
      void renderMap(content);
    } else if (activeTab === "security") {
      void renderSecurity(content);
    } else if (activeTab === "worlds") {
      void renderWorlds(content);
    } else if (activeTab === "settings") {
      renderSettings(content);
    } else if (activeTab === "properties") {
      renderPropertiesEditor(content, serverId, takeFocus());
    } else if (activeTab === "overview") {
      disposeTab = renderOverview(content, serverId);
    } else if (activeTab === "schedules") {
      renderSchedules(content, serverId);
    } else if (activeTab === "gamerules") {
      renderGameRules(content, serverId, takeFocus());
    } else if (activeTab === "motd") {
      // The preview draws the server list row, and the row's first line is the
      // server's name - so the editor needs it, not just the id.
      renderMotdEditor(content, serverId, server?.name ?? serverId);
    }
  }

  function setupConsole() {
    const wrap = root.querySelector<HTMLDivElement>("#terminal-wrap");
    if (!wrap) return;
    terminal = new ConsoleLogView(wrap);
    connectSocket();

    const input = root.querySelector<HTMLInputElement>("#console-input")!;
    // Shell-like history: Up/Down cycle through previously sent commands for
    // this tab session (not persisted - resets on reload, that's fine).
    let draft = "";
    let historyIndex = consoleHistory.length;

    const send = () => {
      const value = input.value;
      if (!value) return;
      socket?.sendInput(value);
      if (consoleHistory[consoleHistory.length - 1] !== value) {
        consoleHistory.push(value);
      }
      historyIndex = consoleHistory.length;
      input.value = "";
    };
    root.querySelector<HTMLButtonElement>("#console-send")!.onclick = send;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        send();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (historyIndex === consoleHistory.length) draft = input.value;
        if (historyIndex > 0) {
          historyIndex--;
          input.value = consoleHistory[historyIndex];
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (historyIndex < consoleHistory.length) {
          historyIndex++;
          input.value = historyIndex === consoleHistory.length ? draft : consoleHistory[historyIndex];
        }
      }
    });
  }

  function connectSocket() {
    if (disposed) return;
    socket = new ConsoleSocket(serverId, {
      onOutput: (text) => terminal?.write(text),
      onStatus: (running) => {
        const dot = root.querySelector<HTMLSpanElement>("#status-dot");
        dot?.classList.toggle("running", running);
        dot?.classList.toggle("stopped", !running);
        const startBtn = root.querySelector<HTMLButtonElement>("#start-btn");
        const stopBtn = root.querySelector<HTMLButtonElement>("#stop-btn");
        const restartBtn = root.querySelector<HTMLButtonElement>("#restart-btn");
        const killBtn = root.querySelector<HTMLButtonElement>("#kill-btn");
        if (startBtn) startBtn.disabled = running;
        if (stopBtn) stopBtn.disabled = !running;
        if (restartBtn) restartBtn.disabled = !running;
        if (killBtn) killBtn.disabled = !running;
      },
      onError: (message) => showToast(message, "error"),
      onClose: () => {
        if (disposed || activeTab !== "console") return;
        reconnectTimer = setTimeout(connectSocket, 3000);
      },
    });
  }

  function startStatsLoop() {
    if (statsTimer) return;
    statsTimer = setInterval(() => {
      if (disposed) return;
      void refreshCharts();
    }, 5000);
  }

  function teardownConsole() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
    terminal?.dispose();
    terminal = null;
  }

  /** Console output of previous runs, kept because starting a server clears
   * the live log - including the restart you do to recover from a crash. */
  async function openLogArchive() {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<h3>${t("korabbi_futasok_naploi")}</h3><p style="color:var(--text-dim);">${t("betoltes")}</p>`;
    const close = openModal(wrap);

    async function render() {
      let logs;
      try {
        logs = await api.listConsoleLogs(serverId);
      } catch (err) {
        wrap.innerHTML = `<h3>${t("korabbi_futasok_naploi")}</h3><p class="error-text">${escapeHtml(
          err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
        )}</p><div class="modal-actions"><button class="btn" id="la-close">${t("bezaras")}</button></div>`;
        wrap.querySelector<HTMLButtonElement>("#la-close")!.onclick = () => close();
        return;
      }

      wrap.innerHTML = `
        <h3>${t("korabbi_futasok_naploi")}</h3>
        <p style="color:var(--text-dim);font-size:12px;margin:0 0 16px;">${t("a_dashboard_az_utolso_14_futas_konzolnaplojat_or")}</p>
        ${
          logs.length === 0
            ? `<div class="empty-state" style="padding:16px;">${t("meg_nincs_archivalt_naplo")}</div>`
            : logs
                .map(
                  (l) => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:0.5px solid var(--border);">
            <div>
              <div style="font-size:13px;">${new Date(l.endedAt).toLocaleString("hu-HU")}</div>
              <div style="color:var(--text-dim);font-size:11px;">${(l.sizeBytes / 1024).toFixed(0)} kB</div>
            </div>
            <div style="display:flex;gap:6px;">
              <button class="btn" data-view="${escapeHtml(l.filename)}">${t("megnyitas")}</button>
              <button class="btn btn-danger" data-del="${escapeHtml(l.filename)}">${t("torles")}</button>
            </div>
          </div>`
                )
                .join("")
        }
        <div class="modal-actions"><button class="btn" id="la-close">${t("bezaras")}</button></div>
      `;
      wrap.querySelector<HTMLButtonElement>("#la-close")!.onclick = () => close();

      wrap.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((btn) => {
        btn.onclick = () => void viewLog(btn.dataset.view!);
      });
      wrap.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((btn) => {
        btn.onclick = async () => {
          try {
            await api.deleteConsoleLog(serverId, btn.dataset.del!);
            showToast(t("naplo_torolve"));
            await render();
          } catch (err) {
            showToast(err instanceof ApiError ? err.message : t("torles_sikertelen"), "error");
          }
        };
      });
    }

    async function viewLog(filename: string) {
      wrap.innerHTML = `<h3>${t("naplo")}</h3><p style="color:var(--text-dim);">${t("betoltes")}</p>`;
      try {
        const content = await api.readConsoleLog(serverId, filename);
        wrap.innerHTML = `
          <h3>${escapeHtml(filename)}</h3>
          <div class="console-log-outer" style="height:50vh;margin-bottom:8px;">
            <div class="console-log">${content
              .split("\n")
              .map((line) => `<div class="console-line">${ansiLineToHtml(line) || "&nbsp;"}</div>`)
              .join("")}</div>
          </div>
          <div class="modal-actions">
            <button class="btn" id="la-back">${t("vissza")}</button>
            <button class="btn" id="la-close2">${t("bezaras")}</button>
          </div>`;
        wrap.querySelector<HTMLButtonElement>("#la-back")!.onclick = () => void render();
        wrap.querySelector<HTMLButtonElement>("#la-close2")!.onclick = () => close();
        // Crashes are at the end, so that is where the view should start.
        const log = wrap.querySelector<HTMLDivElement>(".console-log");
        if (log) log.scrollTop = log.scrollHeight;
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("nem_sikerult_megnyitni"), "error");
        void render();
      }
    }

    await render();
  }

  function renderConfigHistorySection(): string {
    return `
      <div class="section" style="margin-top:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;font-size:13px;">${t("konfig_tortenet")}</h3>
          <button class="btn" id="cfg-snap">${t("pillanatkep_keszitese")}</button>
        </div>
        <p class="finding-advice" style="margin:4px 0 10px;">${t("konfig_tortenet_leiras")}</p>
        <div id="cfg-list"><div class="empty-state" style="padding:0.5rem 0;">${t(
          "betoltes"
        )}</div></div>
      </div>
    `;
  }

  function bindConfigHistory(scope: HTMLElement) {
    const list = scope.querySelector<HTMLDivElement>("#cfg-list");
    if (!list) return;

    const paint = (snapshots: ConfigSnapshot[]) => {
      if (snapshots.length === 0) {
        list.innerHTML = `<div class="empty-state" style="padding:0.5rem 0;">${t(
          "nincs_pillanatkep"
        )}</div>`;
        return;
      }
      list.innerHTML = snapshots
        .map(
          (snap) => `
          <div class="finding" data-snap="${escapeHtml(snap.id)}">
            <div class="finding-head">
              <span class="finding-badge">${snap.files.length}</span>
              <strong>${new Date(snap.at).toLocaleString()}</strong>
            </div>
            <p class="finding-detail">${escapeHtml(snap.reason)}${
              snap.actor ? ` · ${escapeHtml(snap.actor)}` : ""
            }</p>
            <div style="display:flex;gap:8px;margin-top:6px;">
              <button class="btn" data-diff="${escapeHtml(snap.id)}">${t("elteresek")}</button>
              <button class="btn btn-danger" data-restore="${escapeHtml(snap.id)}">${t(
                "visszaallitas"
              )}</button>
            </div>
            <div class="cfg-diff" id="diff-${escapeHtml(snap.id)}"></div>
          </div>`
        )
        .join("");
      bindRows();
    };

    const bindRows = () => {
      list.querySelectorAll<HTMLButtonElement>("[data-diff]").forEach((button) => {
        button.onclick = async () => {
          const id = button.dataset.diff!;
          const target = list.querySelector<HTMLDivElement>(`#diff-${CSS.escape(id)}`)!;
          if (target.innerHTML) {
            target.innerHTML = "";
            return;
          }
          target.innerHTML = `<p class="finding-detail">${t("betoltes")}</p>`;
          try {
            const diffs = (await api.diffConfigSnapshot(serverId, id)).filter((d) => d.changed);
            target.innerHTML =
              diffs.length === 0
                ? `<p class="finding-detail">${t("nincs_elteres")}</p>`
                : diffs
                    .map(
                      (d) => `
                  <div class="cfg-file">
                    <div class="cfg-file-name">${escapeHtml(d.path)}</div>
                    <pre class="cfg-diff-body">${d.lines
                      // Unchanged runs are collapsed: a diff of
                      // paper-global.yml is two thousand identical lines and
                      // three that matter.
                      .map((line, index, all) =>
                        line.kind === "context" &&
                        all[index - 1]?.kind === "context" &&
                        all[index + 1]?.kind === "context"
                          ? ""
                          : `<span class="d-${line.kind}">${
                              line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "
                            } ${escapeHtml(line.text)}</span>`
                      )
                      .filter(Boolean)
                      .join("\n")}</pre>
                  </div>`
                    )
                    .join("");
          } catch (err) {
            target.innerHTML = `<p class="finding-advice">${escapeHtml(
              err instanceof ApiError ? err.message : t("nem_sikerult")
            )}</p>`;
          }
        };
      });

      list.querySelectorAll<HTMLButtonElement>("[data-restore]").forEach((button) => {
        button.onclick = async () => {
          if (!(await confirmModal(t("konfig_visszaallitas_megerosites")))) return;
          try {
            const restored = await api.restoreConfigSnapshot(serverId, button.dataset.restore!);
            showToast(`${t("visszaallitva")}: ${restored.length}`);
            paint(await api.listConfigSnapshots(serverId));
          } catch (err) {
            showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
          }
        };
      });
    };

    scope.querySelector<HTMLButtonElement>("#cfg-snap")?.addEventListener("click", async () => {
      try {
        const result = await api.takeConfigSnapshot(serverId);
        showToast(result.unchanged ? t("nincs_valtozas_pillanatkep") : t("pillanatkep_kesz"));
        paint(result.snapshots);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
      }
    });

    void api
      .listConfigSnapshots(serverId)
      .then(paint)
      .catch(() => {
        list.innerHTML = `<div class="empty-state" style="padding:0.5rem 0;">${t(
          "nem_sikerult_betolteni"
        )}</div>`;
      });
  }

  function renderMigrationSection(): string {
    return `
      <div class="section" style="margin-top:16px;">
        <h3 style="margin:0 0 4px;font-size:13px;">${t("koltoztetes")}</h3>
        <p class="finding-advice" style="margin:0 0 10px;">${t("koltoztetes_leiras")}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <a class="btn" href="${api.bundleDownloadUrl(serverId, true, false)}">${t(
            "csomag_letoltese"
          )}</a>
          <a class="btn" href="${api.bundleDownloadUrl(serverId, false, false)}">${t(
            "csomag_vilag_nelkul"
          )}</a>
          <label class="btn" for="bundle-file">${t("csomag_visszatoltese")}</label>
          <input type="file" id="bundle-file" accept=".zip" hidden />
        </div>
        <div id="bundle-report"></div>
      </div>
    `;
  }

  function bindMigrationSection(scope: HTMLElement) {
    const input = scope.querySelector<HTMLInputElement>("#bundle-file");
    if (!input) return;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      input.value = "";
      if (!(await confirmModal(t("csomag_visszatoltes_megerosites")))) return;

      const report = scope.querySelector<HTMLDivElement>("#bundle-report")!;
      report.innerHTML = `<p class="finding-detail">${t("visszatoltes_folyamatban")}</p>`;
      try {
        const result = await api.restoreBundle(serverId, file);
        report.innerHTML = `
          <div class="finding finding-info" style="margin-top:10px;">
            <p class="finding-detail">${escapeHtml(result.serverName)}</p>
            <p class="finding-detail">${t("dns_fajlok_irva")}: ${result.wroteFiles.length} ·
              ${t("dns_pluginok_telepitve")}: ${result.installedPlugins.length} ·
              ${t("masolt_pluginok")}: ${result.copiedPlugins.length}</p>
            <p class="finding-detail">${
              result.restoredWorld
                ? `${t("visszaallitott_vilag")}: ${escapeHtml(result.restoredWorld)}`
                : t("vilag_nem_volt_a_csomagban")
            }</p>
            ${result.failedPlugins
              .map(
                (f) => `<p class="finding-advice">${escapeHtml(f.filename)}: ${escapeHtml(f.error)}</p>`
              )
              .join("")}
          </div>`;
      } catch (err) {
        report.innerHTML = `<p class="finding-advice">${escapeHtml(
          err instanceof ApiError ? err.message : t("nem_sikerult")
        )}</p>`;
      }
    };
  }

  function renderDnaSection(): string {
    return `
      <div class="section" style="margin-top:16px;">
        <h3 style="margin:0 0 4px;font-size:13px;">${t("szerver_dns")}</h3>
        <p class="finding-advice" style="margin:0 0 10px;">${t("szerver_dns_leiras")}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <a class="btn" href="${api.dnaDownloadUrl(serverId, false)}">${t("dns_export")}</a>
          <a class="btn" href="${api.dnaDownloadUrl(serverId, true)}">${t("dns_export_titkokkal")}</a>
          <label class="btn" for="dna-file">${t("dns_visszatoltes")}</label>
          <input type="file" id="dna-file" accept=".json" hidden />
        </div>
        <div id="dna-report"></div>
      </div>
    `;
  }

  function bindDnaSection(scope: HTMLElement) {
    const input = scope.querySelector<HTMLInputElement>("#dna-file");
    if (!input) return;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      input.value = "";
      let dna: unknown;
      try {
        dna = JSON.parse(await file.text());
      } catch {
        showToast(t("dns_ervenytelen_fajl"), "error");
        return;
      }
      if (!(await confirmModal(t("dns_visszatoltes_megerosites")))) return;

      const report = scope.querySelector<HTMLDivElement>("#dna-report")!;
      report.innerHTML = `<p class="finding-detail">${t("betoltes")}</p>`;
      try {
        const result = await api.importDna(serverId, dna, { plugins: true, access: false });
        report.innerHTML = `
          <div class="finding finding-info" style="margin-top:10px;">
            <p class="finding-detail">${t("dns_fajlok_irva")}: ${result.wroteFiles.length}</p>
            <p class="finding-detail">${t("dns_pluginok_telepitve")}: ${
              result.installedPlugins.length
            }</p>
            ${
              result.manualPlugins.length > 0
                ? `<p class="finding-advice">${t("dns_kezi_pluginok")}: ${escapeHtml(
                    result.manualPlugins.join(", ")
                  )}</p>`
                : ""
            }
            ${result.failedPlugins
              .map(
                (f) =>
                  `<p class="finding-advice">${escapeHtml(f.filename)}: ${escapeHtml(f.error)}</p>`
              )
              .join("")}
          </div>`;
      } catch (err) {
        report.innerHTML = `<p class="finding-advice">${escapeHtml(
          err instanceof ApiError ? err.message : t("nem_sikerult")
        )}</p>`;
      }
    };
  }

  async function renderWorlds(content: HTMLElement) {
    content.innerHTML = `<div class="empty-state" style="padding:16px;">${t("betoltes")}</div>`;
    let data;
    try {
      data = await api.listWorlds(serverId);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
      return;
    }
    if (disposed) return;

    const rows = data.worlds
      .map(
        (w) => `
        <div class="finding ${w.active ? "finding-info" : ""}">
          <div class="finding-head">
            <span class="finding-badge ${w.active ? "finding-info-badge" : ""}">${
              w.active ? t("aktiv") : "—"
            }</span>
            <strong>${escapeHtml(w.name)}</strong>
          </div>
          <p class="finding-detail">
            ${(w.sizeBytes / 1024 / 1024).toFixed(1)} MB
            ${w.seed ? ` · seed ${escapeHtml(w.seed)}` : ""}
            ${w.hasNether ? " · Nether" : ""}${w.hasEnd ? " · End" : ""}
            ${w.lastPlayed ? ` · ${new Date(w.lastPlayed).toLocaleString()}` : ""}
          </p>
          <div style="display:flex;gap:8px;margin-top:8px;">
            ${
              w.active
                ? ""
                : `<button class="btn" data-activate="${escapeHtml(w.name)}" ${
                    data.running ? "disabled" : ""
                  }>${t("aktivalas")}</button>
                   <button class="btn btn-danger" data-delete-world="${escapeHtml(w.name)}" ${
                     data.running ? "disabled" : ""
                   }>${t("torles")}</button>`
            }
          </div>
        </div>`
      )
      .join("");

    content.innerHTML = `
      <div class="section" style="padding:16px;">
        ${
          data.running
            ? `<p class="finding-detail">${t("vilag_szerver_fut")}</p>`
            : `<p class="finding-detail">${t("vilag_magyarazat")}</p>`
        }
        ${data.worlds.length === 0 ? `<div class="empty-state">${t("nincs_vilag")}</div>` : rows}

        <h3 style="margin:20px 0 8px;font-size:13px;">${t("uj_vilag")}</h3>
        <div class="field">
          <label for="w-name">${t("nev")}</label>
          <input id="w-name" type="text" placeholder="world2" ${data.running ? "disabled" : ""} />
        </div>
        <div class="field">
          <label for="w-seed">Seed</label>
          <input id="w-seed" type="text" placeholder="${t("seed_placeholder")}" ${
            data.running ? "disabled" : ""
          } />
        </div>
        <div class="field">
          <label for="w-type">${t("vilagtipus")}</label>
          <select id="w-type" ${data.running ? "disabled" : ""}>
            ${data.types
              .map(
                (ty) =>
                  // Preselects whatever the server is set to, which only
                  // matches now that the reader undoes Java's escaping.
                  `<option value="${escapeHtml(ty)}" ${
                    ty === data.settings.type ? "selected" : ""
                  }>${escapeHtml(ty.replace("minecraft:", ""))}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="field checkbox-row">
          <input id="w-structures" type="checkbox" checked ${data.running ? "disabled" : ""} />
          <label for="w-structures" style="margin:0">${t("epitmenyek_generalasa")}</label>
        </div>
        <button class="btn btn-primary" id="w-create" ${data.running ? "disabled" : ""}>${t(
          "vilag_letrehozasa"
        )}</button>
      </div>
    `;

    content.querySelectorAll<HTMLButtonElement>("[data-activate]").forEach((button) => {
      button.onclick = async () => {
        try {
          await api.activateWorld(serverId, button.dataset.activate!);
          void renderWorlds(content);
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
        }
      };
    });

    content.querySelectorAll<HTMLButtonElement>("[data-delete-world]").forEach((button) => {
      button.onclick = async () => {
        const name = button.dataset.deleteWorld!;
        if (!(await confirmModal(t("biztosan_torlod_a_vilagot").replace("%s", escapeHtml(name)))))
          return;
        try {
          await api.deleteWorld(serverId, name);
          void renderWorlds(content);
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
        }
      };
    });

    content.querySelector<HTMLButtonElement>("#w-create")?.addEventListener("click", async () => {
      const name = content.querySelector<HTMLInputElement>("#w-name")!.value.trim();
      if (!name) {
        showToast(t("adj_meg_nevet"), "error");
        return;
      }
      try {
        await api.createWorld(serverId, {
          name,
          seed: content.querySelector<HTMLInputElement>("#w-seed")!.value.trim(),
          type: content.querySelector<HTMLSelectElement>("#w-type")!.value,
          generateStructures: content.querySelector<HTMLInputElement>("#w-structures")!.checked,
        });
        showToast(t("vilag_beallitva"));
        void renderWorlds(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
      }
    });
  }

  async function renderSecurity(content: HTMLElement) {
    content.innerHTML = `<div class="empty-state" style="padding:16px;">${t("betoltes")}</div>`;
    let report;
    try {
      report = await api.getSecurityReport(serverId);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
      return;
    }
    if (disposed) return;

    // Dismissed findings are not counted and not mixed in with the live ones:
    // the number at the top has to mean "things wanting attention", or it stops
    // being read at all.
    const active = report.findings.filter((f) => f.dismissedUntil === undefined);
    const dismissed = report.findings.filter((f) => f.dismissedUntil !== undefined);

    const counts = { critical: 0, warning: 0, info: 0 };
    for (const f of active) counts[f.severity]++;

    const rows = active
      .map(
        (f) => `
        <div class="finding finding-${f.severity}">
          <div class="finding-head">
            <span class="finding-badge">${t(`sev_${f.severity}`)}</span>
            <strong>${escapeHtml(f.title)}</strong>
          </div>
          <p class="finding-detail">${escapeHtml(f.detail)}</p>
          <p class="finding-advice">${escapeHtml(f.advice)}</p>
          <div class="finding-actions">
            ${
              f.fix
                ? `<button class="btn btn-primary" data-fix="${escapeHtml(f.fix)}">${t("megoldas")}</button>`
                : f.goTo
                  ? `<button class="btn" data-goto="${escapeHtml(f.goTo)}">${t("odavisz")}</button>`
                  : ""
            }
            <button class="btn" data-dismiss="${escapeHtml(f.id)}">${t("figyelmen_kivul_hagyas")}</button>
          </div>
        </div>`
      )
      .join("");

    const dismissedRows = dismissed
      .map(
        (f) => `
        <div class="finding finding-dismissed">
          <div class="finding-head">
            <span class="finding-badge">${t(`sev_${f.severity}`)}</span>
            <strong>${escapeHtml(f.title)}</strong>
          </div>
          <p class="finding-detail">${
            f.dismissedUntil === null
              ? t("veglegesen_mellozve")
              : `${t("mellozve_eddig")}: ${new Date(f.dismissedUntil!).toLocaleDateString()}`
          }</p>
          <div class="finding-actions">
            <button class="btn" data-undismiss="${escapeHtml(f.id)}">${t("visszahozas")}</button>
          </div>
        </div>`
      )
      .join("");

    let guard: AntiCheatStatus | null = null;
    try {
      guard = await api.getAntiCheat(serverId);
    } catch {
      // Same reasoning as the network block below.
    }
    let network: NetworkReport | null = null;
    try {
      network = await api.getNetworkReport(serverId);
    } catch {
      // The network view is extra detail; a failure there must not take the
      // whole security tab with it.
    }
    if (disposed) return;

    content.innerHTML = `
      <div class="section" style="padding:16px;">
        <div class="security-summary">
          ${(["critical", "warning", "info"] as const)
            .map(
              // A zero count is coloured neutrally: a red 0 next to "Critical"
              // reads at a glance as if something were wrong.
              (level) =>
                `<span class="finding-badge ${
                  counts[level] > 0 ? `finding-${level}-badge` : ""
                }">${counts[level]}</span> ${t(`sev_${level}`)}`
            )
            .join("")}
        </div>
        ${active.length === 0 ? `<div class="empty-state">${t("nincs_talalat_biztonsag")}</div>` : rows}
        ${
          dismissed.length === 0
            ? ""
            : `<h3 class="finding-section-title">${t("mellozott_leletek")} (${dismissed.length})</h3>
               ${dismissedRows}`
        }
        ${
          report.loginsChecked
            ? ""
            : `<p class="finding-detail">${t("nincs_log_ellenorzes")}</p>`
        }
        <p class="finding-detail">${t("biztonsag_hatokor")}</p>

        ${guard ? renderAntiCheat(guard) : ""}
        ${network ? renderNetwork(network) : ""}
      </div>
    `;

    /**
     * Shows the change before making it.
     *
     * Read fresh from the server rather than from the finding: the report may
     * be a minute old, and a preview describing a value somebody has since
     * changed by hand would be worse than none.
     */
    content.querySelectorAll<HTMLButtonElement>("[data-fix]").forEach((button) => {
      button.onclick = async () => {
        const fixId = button.dataset.fix!;
        let preview;
        try {
          preview = await api.previewSecurityFix(serverId, fixId);
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
          return;
        }
        const wrap = document.createElement("div");
        wrap.innerHTML = `
          <h3>${t("megoldas")}</h3>
          <div class="fix-changes">
            ${preview.changes
              .map(
                (c) => `<div class="fix-change">
                  <code>${escapeHtml(c.label)}</code>
                  <span class="fix-from">${escapeHtml(c.from)}</span>
                  <span class="fix-arrow">→</span>
                  <strong>${escapeHtml(c.to)}</strong>
                </div>`
              )
              .join("")}
          </div>
          ${preview.needsRestart ? `<p class="fix-note">${t("ujrainditas_utan_lep_eletbe")}</p>` : ""}
          ${preview.danger ? `<p class="fix-danger">${escapeHtml(preview.danger)}</p>` : ""}
          <div class="modal-actions">
            <button class="btn" id="fix-cancel">${t("megse")}</button>
            <button class="btn btn-primary" id="fix-go">${t("vegrehajtas")}</button>
          </div>`;
        const close = openModal(wrap);
        wrap.querySelector<HTMLButtonElement>("#fix-cancel")!.onclick = () => close();
        wrap.querySelector<HTMLButtonElement>("#fix-go")!.onclick = async () => {
          const go = wrap.querySelector<HTMLButtonElement>("#fix-go")!;
          go.disabled = true;
          go.textContent = t("keszul");
          try {
            const { result } = await api.applySecurityFix(serverId, fixId);
            close();
            showToast(result);
            void renderSecurity(content);
          } catch (err) {
            showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
            go.disabled = false;
            go.textContent = t("vegrehajtas");
          }
        };
      };
    });

    content.querySelectorAll<HTMLButtonElement>("[data-goto]").forEach((button) => {
      button.onclick = () => goToTab(button.dataset.goto as Tab);
    });

    content.querySelectorAll<HTMLButtonElement>("[data-dismiss]").forEach((button) => {
      button.onclick = () => {
        const findingId = button.dataset.dismiss!;
        const wrap = document.createElement("div");
        wrap.innerHTML = `
          <h3>${t("figyelmen_kivul_hagyas")}</h3>
          <p class="fix-note">${t("mellozes_leiras")}</p>
          <div class="field">
            <label for="dis-days">${t("meddig")}</label>
            <select id="dis-days">
              <option value="30">${t("harminc_nap")}</option>
              <option value="90">${t("kilencven_nap")}</option>
              <option value="">${t("veglegesen")}</option>
            </select>
          </div>
          <div class="field">
            <label for="dis-reason">${t("indoklas")}</label>
            <input id="dis-reason" placeholder="${t("pl_szandekos_cracked")}" />
          </div>
          <div class="modal-actions">
            <button class="btn" id="dis-cancel">${t("megse")}</button>
            <button class="btn btn-primary" id="dis-go">${t("figyelmen_kivul_hagyas")}</button>
          </div>`;
        const close = openModal(wrap);
        wrap.querySelector<HTMLButtonElement>("#dis-cancel")!.onclick = () => close();
        wrap.querySelector<HTMLButtonElement>("#dis-go")!.onclick = async () => {
          const raw = wrap.querySelector<HTMLSelectElement>("#dis-days")!.value;
          try {
            await api.dismissFinding(
              serverId,
              findingId,
              raw === "" ? null : Number(raw),
              wrap.querySelector<HTMLInputElement>("#dis-reason")!.value
            );
            close();
            void renderSecurity(content);
          } catch (err) {
            showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
          }
        };
      };
    });

    content.querySelectorAll<HTMLButtonElement>("[data-undismiss]").forEach((button) => {
      button.onclick = async () => {
        try {
          await api.undismissFinding(serverId, button.dataset.undismiss!);
          void renderSecurity(content);
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
        }
      };
    });

    content.querySelector<HTMLButtonElement>("#guard-install")?.addEventListener("click", async () => {
      try {
        await api.installAntiCheat(serverId);
        showToast(t("anticheat_telepitve"));
        void renderSecurity(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
      }
    });
    content.querySelector<HTMLButtonElement>("#guard-remove")?.addEventListener("click", async () => {
      if (!(await confirmModal(t("anticheat_eltavolitas_megerosites")))) return;
      try {
        await api.removeAntiCheat(serverId);
        void renderSecurity(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
      }
    });
  }

  function renderAntiCheat(guard: AntiCheatStatus): string {
    const flagged = guard.players.filter((p) => p.flags.length > 0);
    const controls = guard.installed
      ? `<button class="btn btn-danger" id="guard-remove" ${
          guard.running ? "disabled" : ""
        }>${t("anticheat_eltavolitasa")}</button>`
      : `<button class="btn btn-primary" id="guard-install" ${
          guard.running || !guard.availableVersion ? "disabled" : ""
        }>${t("anticheat_telepitese")}</button>`;

    return `
      <h3 style="margin:24px 0 4px;font-size:13px;">${t("anticheat")}</h3>
      <p class="finding-advice" style="margin:0 0 10px;">${t("anticheat_leiras")}</p>
      <p class="finding-detail">
        ${
          guard.installed
            ? `${t("telepitve")}: <strong>${escapeHtml(guard.installedVersion ?? "?")}</strong>`
            : t("nincs_telepitve")
        }
        ${
          guard.availableVersion
            ? ` · ${t("elerheto")}: ${escapeHtml(guard.availableVersion)}`
            : ` · ${t("nincs_kozzeteve_plugin")}`
        }
        ${
          guard.generatedAt
            ? ` · ${t("utolso_jelentes")}: ${new Date(guard.generatedAt).toLocaleString()}`
            : ""
        }
      </p>
      <div style="display:flex;gap:8px;margin:8px 0 12px;">${controls}</div>
      ${
        !guard.installed
          ? ""
          : guard.players.length === 0
            ? `<p class="finding-advice">${t("anticheat_nincs_adat")}</p>`
            : `${flagged
                .map(
                  (p) => `<div class="finding finding-warning">
                    <div class="finding-head">
                      <span class="finding-badge">${p.flags.length}</span>
                      <strong>${escapeHtml(p.name)}</strong>
                    </div>
                    ${p.flags
                      .map(
                        (f) =>
                          `<p class="finding-detail">${escapeHtml(f.kind)}: ${escapeHtml(
                            f.detail
                          )} (${new Date(f.at).toLocaleString()})</p>`
                      )
                      .join("")}
                  </div>`
                )
                .join("")}
              <table class="file-table" style="margin-top:8px;">
                <thead><tr>
                  <th>${t("jatekos")}</th><th>${t("ercek")}</th>
                  <th>${t("rejtett_ercek")}</th><th>${t("ertekes_ercek")}</th>
                  <th>${t("max_sebesseg")}</th>
                </tr></thead>
                <tbody>
                  ${guard.players
                    .map((p) => {
                      const ratio = p.oresMined > 0 ? p.hiddenOres / p.oresMined : 0;
                      const valuable =
                        p.valuableOres > 0 ? p.hiddenValuableOres / p.valuableOres : 0;
                      return `<tr>
                        <td>${escapeHtml(p.name)}</td>
                        <td>${p.oresMined}</td>
                        <td style="white-space:nowrap;">
                          ${ratioBarSvg({
                            ratio,
                            label: `${p.hiddenOres}/${p.oresMined}`,
                            width: 120,
                          })}
                          <span style="margin-left:6px;">${p.hiddenOres}/${p.oresMined} · ${Math.round(
                            ratio * 100
                          )}%</span>
                        </td>
                        <td style="white-space:nowrap;">
                          ${
                            p.valuableOres > 0
                              ? `${ratioBarSvg({
                                  ratio: valuable,
                                  label: `${p.hiddenValuableOres}/${p.valuableOres}`,
                                  warnAbove: 0.9,
                                  width: 80,
                                })} <span style="margin-left:6px;">${p.hiddenValuableOres}/${
                                  p.valuableOres
                                }</span>`
                              : "—"
                          }
                        </td>
                        <td>${p.maxSpeed.toFixed(1)}</td>
                      </tr>`;
                    })
                    .join("")}
                </tbody>
              </table>`
      }
    `;
  }

  function renderNetwork(network: NetworkReport): string {
    const latest = network.history[network.history.length - 1];
    const peak = network.history.reduce((max, s) => Math.max(max, s.total), 0);
    const busiest = network.ips.ips.filter((ip) => ip.players.length > 1).slice(0, 8);

    return `
      <h3 style="margin:24px 0 4px;font-size:13px;">${t("halozat")}</h3>
      <p class="finding-advice" style="margin:0 0 10px;">${t("halozat_leiras")}</p>
      <p class="finding-detail">
        ${t("jelenlegi_kapcsolatok")}: <strong>${latest?.total ?? 0}</strong>
        (${latest?.distinctIps ?? 0} ${t("kulonbozo_cim")}) ·
        ${t("csucs_egy_oraban")}: <strong>${peak}</strong>
      </p>
      ${
        network.alerts.length === 0
          ? `<p class="finding-advice">${t("nincs_halozati_riasztas")}</p>`
          : network.alerts
              .slice(0, 6)
              .map(
                (a) => `<div class="finding finding-warning">
                  <div class="finding-head">
                    <span class="finding-badge">${new Date(a.at).toLocaleTimeString()}</span>
                    <strong>${escapeHtml(a.message)}</strong>
                  </div>
                </div>`
              )
              .join("")
      }

      <h3 style="margin:20px 0 4px;font-size:13px;">${t("ip_elemzes")}</h3>
      <p class="finding-advice" style="margin:0 0 10px;">
        ${network.ips.logsRead} ${t("logfajl_alapjan")}. ${t("vpn_korlat")}
      </p>
      ${
        busiest.length === 0
          ? `<p class="finding-advice">${t("nincs_tobbfiokos_cim")}</p>`
          : busiest
              .map(
                (ip) => `<div class="finding">
                  <div class="finding-head">
                    <span class="finding-badge">${ip.players.length}</span>
                    <strong>${escapeHtml(ip.ip)}</strong>
                  </div>
                  <p class="finding-detail">${ip.players
                    .map(
                      (p) => `${escapeHtml(p.player)} (${p.logins}×, ${escapeHtml(p.last)})`
                    )
                    .join(" · ")}</p>
                </div>`
              )
              .join("")
      }
    `;
  }

  async function renderMap(content: HTMLElement) {
    content.innerHTML = `<div class="empty-state" style="padding:16px;">${t("betoltes")}</div>`;
    let info;
    try {
      info = await api.getMapInfo(serverId);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
      return;
    }
    if (disposed) return;

    if (info.dimensions.length === 0) {
      content.innerHTML = `<div class="empty-state" style="padding:16px;">${t("nincs_vilagadat")}</div>`;
      return;
    }

    content.innerHTML = "";
    // Torn down explicitly: the map installs pointer and wheel listeners on
    // its own viewport that would otherwise outlive the tab.
    mapHandle?.destroy();
    mapHandle = createWorldMap(serverId, info, info.dimensions[0].id);
    content.appendChild(mapHandle.element);
  }

  async function renderSchematics(content: HTMLElement) {
    content.innerHTML = `<div class="empty-state" style="padding:16px;">${t("betoltes")}</div>`;
    let data;
    try {
      data = await api.listSchematics(serverId);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
      return;
    }
    if (disposed) return;
    const running = server?.running ?? false;

    content.innerHTML = `
      <p style="max-width:640px;color:var(--text-dim);font-size:12px;margin-top:0;">
        A fájlok a WorldEdit saját schematics mappájába kerülnek, tehát amit ide feltöltesz,
        azonnal használható a játékban is — és amit a játékban mentesz, itt megjelenik.
        ${
          data.worldEdit
            ? ""
            : `<strong style="color:var(--yellow);">${t("nincs_worldedit")}</strong>`
        }
      </p>

      <div id="schem-drop" style="border:1.5px dashed var(--border-strong);border-radius:var(--radius-md);
           padding:20px;text-align:center;color:var(--text-dim);font-size:12px;margin:16px 0;">${t("huzd_ide_a_schem_fajlt_vagy")}<label style="display:inline;color:var(--accent);cursor:pointer;text-decoration:underline;">${t("valassz_fajlt")}<input type="file" id="schem-file" accept=".schem,.schematic" style="display:none;" />
        </label>
      </div>

      <div id="schem-list"></div>
    `;

    const listEl = content.querySelector<HTMLDivElement>("#schem-list")!;
    listEl.innerHTML =
      data.schematics.length === 0
        ? `<div class="empty-state" style="padding:16px;">${t("meg_nincs_schematic")}</div>`
        : data.schematics
            .map(
              (sc) => `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:0.5px solid var(--border);">
        <div style="min-width:0;">
          <div>${escapeHtml(sc.filename)}</div>
          <div style="color:var(--text-dim);font-size:11px;">
            ${(sc.sizeBytes / 1024).toFixed(0)} kB${
              sc.size ? ` · ${sc.size.x}×${sc.size.y}×${sc.size.z} blokk` : ""
            } · ${new Date(sc.modifiedAt).toLocaleDateString("hu-HU")}
          </div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-primary" data-paste="${escapeHtml(sc.filename)}" ${
            running && data.worldEdit ? "" : "disabled"
          }>${t("bepakolas")}</button>
          <a class="btn" href="${api.schematicDownloadUrl(serverId, sc.filename)}">${t("letoltes")}</a>
          <button class="btn btn-danger" data-del-schem="${escapeHtml(sc.filename)}">${t("torles")}</button>
        </div>
      </div>`
            )
            .join("");

    const upload = async (file: File) => {
      try {
        await api.uploadSchematic(serverId, file);
        showToast(t("feltoltve"));
        await renderSchematics(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("feltoltes_sikertelen"), "error");
      }
    };

    const drop = content.querySelector<HTMLDivElement>("#schem-drop")!;
    content.querySelector<HTMLInputElement>("#schem-file")!.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) void upload(file);
    };
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.style.borderColor = "var(--accent)";
    };
    drop.ondragleave = () => {
      drop.style.borderColor = "var(--border-strong)";
    };
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.style.borderColor = "var(--border-strong)";
      const file = e.dataTransfer?.files?.[0];
      if (file) void upload(file);
    };

    listEl.querySelectorAll<HTMLButtonElement>("[data-del-schem]").forEach((btn) => {
      btn.onclick = async () => {
        const filename = btn.dataset.delSchem!;
        if (!(await confirmModal(`Törlöd? <strong>${escapeHtml(filename)}</strong>`))) return;
        try {
          await api.deleteSchematic(serverId, filename);
          showToast(t("torolve"));
          await renderSchematics(content);
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("torles_sikertelen"), "error");
        }
      };
    });

    listEl.querySelectorAll<HTMLButtonElement>("[data-paste]").forEach((btn) => {
      btn.onclick = () => openPasteDialog(btn.dataset.paste!);
    });

    function openPasteDialog(filename: string) {
      const wrap = document.createElement("div");
      // WorldEdit is session-based, so a paste needs either a player whose
      // session it can borrow or explicit coordinates.
      wrap.innerHTML = `
        <h3>${t("bepakolas")}</h3>
        <p style="color:var(--text-dim);font-size:12px;">${escapeHtml(filename)}</p>
        <div class="field">
          <label for="ps-player">${t("jatekos_az_o_poziciojaba_kerul")}</label>
          <input id="ps-player" placeholder="pl. Bumimaci" />
        </div>
        <p style="color:var(--text-dim);font-size:12px;margin:-8px 0 12px;">${t("vagy_hagyd_uresen_es_adj_meg_koordinatakat")}</p>
        <div style="display:flex;gap:8px;">
          <div class="field" style="flex:1;"><label for="ps-x">X</label><input id="ps-x" type="number" /></div>
          <div class="field" style="flex:1;"><label for="ps-y">Y</label><input id="ps-y" type="number" /></div>
          <div class="field" style="flex:1;"><label for="ps-z">Z</label><input id="ps-z" type="number" /></div>
        </div>
        <div class="field">
          <label for="ps-world">${t("vilag")}</label>
          <input id="ps-world" value="world" />
        </div>
        <div class="field checkbox-row">
          <input id="ps-air" type="checkbox" />
          <label for="ps-air" style="margin:0">${t("levego_blokkok_kihagyasa")}</label>
        </div>
        <div id="form-error" class="error-text"></div>
        <div class="modal-actions">
          <button class="btn" id="ps-cancel">${t("megse")}</button>
          <button class="btn btn-primary" id="ps-go">${t("bepakolas")}</button>
        </div>`;
      const close = openModal(wrap);
      wrap.querySelector<HTMLButtonElement>("#ps-cancel")!.onclick = () => close();
      wrap.querySelector<HTMLButtonElement>("#ps-go")!.onclick = async (e) => {
        const btn = e.currentTarget as HTMLButtonElement;
        const errorEl = wrap.querySelector<HTMLDivElement>("#form-error")!;
        btn.disabled = true;
        try {
          await api.pasteSchematic(serverId, filename, {
            player: wrap.querySelector<HTMLInputElement>("#ps-player")!.value.trim() || undefined,
            x: wrap.querySelector<HTMLInputElement>("#ps-x")!.value.trim() || undefined,
            y: wrap.querySelector<HTMLInputElement>("#ps-y")!.value.trim() || undefined,
            z: wrap.querySelector<HTMLInputElement>("#ps-z")!.value.trim() || undefined,
            world: wrap.querySelector<HTMLInputElement>("#ps-world")!.value.trim() || undefined,
            ignoreAir: wrap.querySelector<HTMLInputElement>("#ps-air")!.checked,
          });
          showToast(t("parancsok_elkuldve_nezd_meg_a_konzolt_az_eredmen"));
          close();
        } catch (err) {
          errorEl.textContent = err instanceof ApiError ? err.message : t("nem_sikerult");
          btn.disabled = false;
        }
      };
    }
  }

  async function renderStats(content: HTMLElement) {
    content.innerHTML = `<div class="empty-state" style="padding:16px;">${t("betoltes")}</div>`;
    let c;
    try {
      c = await api.getWeeklyStats(serverId);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
      return;
    }
    if (disposed) return;

    // A change is only meaningful once last week has something in it; before
    // that the panel says so rather than showing a percentage from nothing.
    const delta = (value: number | null) => {
      if (value === null) return `<span style="color:var(--text-dim);">${t("nincs_viszonyitas")}</span>`;
      const colour = value > 0 ? "var(--green)" : value < 0 ? "var(--red)" : "var(--text-dim)";
      const sign = value > 0 ? "+" : "";
      return `<span style="color:${colour};">${sign}${value}%</span>`;
    };

    const hours = (minutes: number) =>
      minutes >= 60 ? `${(minutes / 60).toFixed(1)} óra` : `${Math.round(minutes)} perc`;

    const maxPeak = Math.max(1, ...c.daily.map((d) => d.peak));

    content.innerHTML = `
      <p style="max-width:640px;color:var(--text-dim);font-size:12px;margin-top:0;">${t("a_dashboard_5_percenkent_mintat_vesz_a_futo_szer")}</p>

      <div style="display:flex;gap:16px;flex-wrap:wrap;margin:20px 0;">
        ${[
          { label: t("csucs_egyideju_jatekos"), now: c.thisWeek.peak, before: c.lastWeek.peak, change: c.peakChange },
          {
            label: t("atlagos_online"),
            now: c.thisWeek.averageOnline,
            before: c.lastWeek.averageOnline,
            change: c.averageChange,
          },
        ]
          .map(
            (m) => `
        <div style="flex:1;min-width:190px;padding:12px;border:0.5px solid var(--border);border-radius:var(--radius-md);">
          <div style="color:var(--text-dim);font-size:11px;">${m.label}</div>
          <div style="font-size:22px;font-weight:600;">${m.now}</div>
          <div style="font-size:12px;">${delta(m.change)} <span style="color:var(--text-dim);">múlt hét: ${
            m.before
          }</span></div>
        </div>`
          )
          .join("")}
        <div style="flex:1;min-width:190px;padding:12px;border:0.5px solid var(--border);border-radius:var(--radius-md);">
          <div style="color:var(--text-dim);font-size:11px;">${t("becsult_jatekido")}</div>
          <div style="font-size:22px;font-weight:600;">${hours(c.thisWeek.playtimeMinutes)}</div>
          <div style="font-size:12px;">${delta(c.playtimeChange)} <span style="color:var(--text-dim);">múlt hét: ${hours(
            c.lastWeek.playtimeMinutes
          )}</span></div>
        </div>
        <div style="flex:1;min-width:190px;padding:12px;border:0.5px solid var(--border);border-radius:var(--radius-md);">
          <div style="color:var(--text-dim);font-size:11px;">${t("uzemido_ezen_a_heten")}</div>
          <div style="font-size:22px;font-weight:600;">${hours(c.thisWeek.upMinutes)}</div>
          <div style="font-size:12px;color:var(--text-dim);">múlt hét: ${hours(c.lastWeek.upMinutes)}</div>
        </div>
      </div>

      <h4 style="margin-bottom:8px;">${t("napi_csucs_utolso_14_nap")}</h4>
      <div style="display:flex;align-items:flex-end;gap:4px;height:120px;">
        ${c.daily
          .map(
            (d) => `
          <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;"
               title="${escapeHtml(d.date)}: ${d.peak} játékos">
            <div style="width:100%;background:var(--accent);border-radius:3px 3px 0 0;height:${
              (d.peak / maxPeak) * 100
            }%;min-height:${d.peak > 0 ? 3 : 1}px;opacity:${d.peak > 0 ? 1 : 0.25};"></div>
          </div>`
          )
          .join("")}
      </div>
      <div style="display:flex;justify-content:space-between;color:var(--text-dim);font-size:11px;margin-top:4px;">
        <span>${escapeHtml(c.daily[0]?.date ?? "")}</span>
        <span>${escapeHtml(c.daily[c.daily.length - 1]?.date ?? "")}</span>
      </div>

      ${
        c.thisWeek.samples === 0
          ? `<p style="color:var(--text-dim);font-size:12px;margin-top:16px;">
               Még nincs adat — a gyűjtés a szerver futása közben, 5 percenként történik.
             </p>`
          : ""
      }
    `;
  }

  async function renderMacros(content: HTMLElement) {
    content.innerHTML = `<div class="empty-state" style="padding:16px;">${t("betoltes")}</div>`;
    let data;
    try {
      data = await api.listMacros(serverId);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
      return;
    }
    if (disposed) return;
    const running = server?.running ?? false;

    content.innerHTML = `
      <p style="max-width:640px;color:var(--text-dim);font-size:12px;margin-top:0;">${t("a_makro_parancsok_sorozata_egy_gombra_kotve_a_fe")}</p>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;">
        <button class="btn ${data.recording ? "btn-danger" : ""}" id="mac-record">
          ${data.recording ? t("felvetel_leallitasa") : t("felvetel_inditasa")}
        </button>
        <button class="btn btn-primary" id="mac-new">${t("uj_makro")}</button>
      </div>

      <div id="mac-list"></div>
    `;

    const list = content.querySelector<HTMLDivElement>("#mac-list")!;
    list.innerHTML =
      data.macros.length === 0
        ? `<div class="empty-state" style="padding:16px;">${t("meg_nincs_makro")}</div>`
        : data.macros
            .map(
              (m) => `
      <div style="padding:10px 0;border-bottom:0.5px solid var(--border);">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div style="min-width:0;">
            <div style="font-weight:600;">${escapeHtml(m.name)}</div>
            <div style="color:var(--text-dim);font-size:12px;">
              ${m.steps.length} lépés${m.description ? ` · ${escapeHtml(m.description)}` : ""}
            </div>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-primary" data-run="${m.id}" ${running ? "" : "disabled"}>${t("futtatas")}</button>
            <button class="btn" data-edit-macro="${m.id}">${t("szerkesztes")}</button>
            <button class="btn btn-danger" data-del-macro="${m.id}">${t("torles")}</button>
          </div>
        </div>
        <div style="color:var(--text-dim);font-size:11px;font-family:'SF Mono',ui-monospace,monospace;margin-top:6px;">
          ${m.steps.slice(0, 4).map((st) => escapeHtml(st.command)).join(" → ")}${
            m.steps.length > 4 ? " → …" : ""
          }
        </div>
      </div>`
            )
            .join("");

    content.querySelector<HTMLButtonElement>("#mac-record")!.onclick = async () => {
      try {
        if (data.recording) {
          const res = await api.setMacroRecording(serverId, "stop");
          const steps = res.steps ?? [];
          if (steps.length === 0) {
            showToast(t("nem_rogzult_parancs"));
            await renderMacros(content);
            return;
          }
          openMacroEditor(null, steps);
        } else {
          await api.setMacroRecording(serverId, "start");
          showToast(t("felvetel_elindult_irj_parancsokat_a_konzolba"));
          await renderMacros(content);
        }
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
      }
    };

    content.querySelector<HTMLButtonElement>("#mac-new")!.onclick = () =>
      openMacroEditor(null, [{ command: "", delayMs: 0 }]);

    list.querySelectorAll<HTMLButtonElement>("[data-run]").forEach((btn) => {
      btn.onclick = async () => {
        try {
          const r = await api.runMacro(serverId, btn.dataset.run!);
          showToast(
            r.skipped.length > 0
              ? `${r.executed} parancs lefutott, ${r.skipped.length} kihagyva`
              : `${r.executed} parancs lefutott`
          );
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
        }
      };
    });

    list.querySelectorAll<HTMLButtonElement>("[data-edit-macro]").forEach((btn) => {
      btn.onclick = () => {
        const macro = data!.macros.find((m) => m.id === btn.dataset.editMacro);
        if (macro) openMacroEditor(macro, macro.steps);
      };
    });

    list.querySelectorAll<HTMLButtonElement>("[data-del-macro]").forEach((btn) => {
      btn.onclick = async () => {
        if (!(await confirmModal(t("torlod_ezt_a_makrot")))) return;
        try {
          await api.deleteMacro(serverId, btn.dataset.delMacro!);
          showToast(t("torolve"));
          await renderMacros(content);
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("torles_sikertelen"), "error");
        }
      };
    });

    function openMacroEditor(macro: { id: string; name: string; description: string } | null, steps: MacroStep[]) {
      const wrap = document.createElement("div");
      let working: MacroStep[] = steps.map((s) => ({ ...s }));

      const draw = () => {
        wrap.innerHTML = `
          <h3>${macro ? t("makro_szerkesztese") : t("uj_makro_2")}</h3>
          <div class="field">
            <label for="mac-name">${t("nev")}</label>
            <input id="mac-name" value="${escapeHtml(macro?.name ?? "")}" placeholder="${t("pl_esemeny_inditas")}" />
          </div>
          <div class="field">
            <label for="mac-desc">${t("leiras")}</label>
            <input id="mac-desc" value="${escapeHtml(macro?.description ?? "")}" />
          </div>
          <label>${t("lepesek")}</label>
          <div id="mac-steps">
            ${working
              .map(
                (st, i) => `
              <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
                <span style="color:var(--text-dim);font-size:11px;width:16px;">${i + 1}</span>
                <input data-cmd="${i}" value="${escapeHtml(st.command)}" placeholder="parancs" style="flex:1;" />
                <input data-delay="${i}" type="number" min="0" max="30000" value="${st.delayMs}"
                       title="Várakozás utána (ms)" style="width:96px;" />
                <button class="btn btn-danger" data-rm="${i}">✕</button>
              </div>`
              )
              .join("")}
          </div>
          <button class="btn" id="mac-add-step" style="margin-top:4px;">${t("lepes")}</button>
          <div id="form-error" class="error-text"></div>
          <div class="modal-actions">
            <button class="btn" id="mac-cancel">${t("megse")}</button>
            <button class="btn btn-primary" id="mac-save">${t("mentes")}</button>
          </div>`;

        const sync = () => {
          wrap.querySelectorAll<HTMLInputElement>("[data-cmd]").forEach((el) => {
            working[Number(el.dataset.cmd)].command = el.value;
          });
          wrap.querySelectorAll<HTMLInputElement>("[data-delay]").forEach((el) => {
            working[Number(el.dataset.delay)].delayMs = Number(el.value) || 0;
          });
        };

        wrap.querySelector<HTMLButtonElement>("#mac-add-step")!.onclick = () => {
          sync();
          working.push({ command: "", delayMs: 0 });
          draw();
        };
        wrap.querySelectorAll<HTMLButtonElement>("[data-rm]").forEach((btn) => {
          btn.onclick = () => {
            sync();
            working.splice(Number(btn.dataset.rm), 1);
            if (working.length === 0) working.push({ command: "", delayMs: 0 });
            draw();
          };
        });
        wrap.querySelector<HTMLButtonElement>("#mac-cancel")!.onclick = () => close();
        wrap.querySelector<HTMLButtonElement>("#mac-save")!.onclick = async () => {
          sync();
          const errorEl = wrap.querySelector<HTMLDivElement>("#form-error")!;
          const name = wrap.querySelector<HTMLInputElement>("#mac-name")!.value.trim();
          if (!name) {
            errorEl.textContent = t("adj_nevet_a_makronak");
            return;
          }
          const cleaned = working.filter((st) => st.command.trim());
          if (cleaned.length === 0) {
            errorEl.textContent = t("legalabb_egy_parancs_kell");
            return;
          }
          try {
            await api.saveMacro(serverId, {
              id: macro?.id,
              name,
              description: wrap.querySelector<HTMLInputElement>("#mac-desc")!.value.trim(),
              steps: cleaned,
            });
            showToast(t("makro_mentve"));
            close();
            await renderMacros(content);
          } catch (err) {
            errorEl.textContent = err instanceof ApiError ? err.message : t("mentes_sikertelen");
          }
        };
      };

      const close = openModal(wrap);
      draw();
    }
  }

  async function renderContent(content: HTMLElement) {
    content.innerHTML = `<div class="empty-state" style="padding:16px;">${t("betoltes")}</div>`;
    let rp;
    let dp;
    try {
      [rp, dp] = await Promise.all([api.listPacks(serverId, "resourcepack"), api.listPacks(serverId, "datapack")]);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
      return;
    }
    if (disposed) return;

    // The client downloads the pack itself, so the URL has to be reachable
    // from the players' machines - the dashboard cannot know its own public
    // address, so it is offered as a prefilled guess.
    const suggestedBase = `${location.protocol}//${location.host}/packs/${serverId}`;

    const packRows = (packs: typeof rp.packs, kind: "resourcepack" | "datapack") =>
      packs.length === 0
        ? `<div style="color:var(--text-dim);font-size:12px;padding:8px 0;">${t("nincs_feltoltve")}</div>`
        : packs
            .map(
              (p) => `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:0.5px solid var(--border);">
        <div style="min-width:0;">
          <div>${escapeHtml(p.filename)}${
            p.active ? ` <span class="pb-badge" style="color:var(--green);">${t("aktiv")}</span>` : ""
          }</div>
          <div style="color:var(--text-dim);font-size:11px;">
            ${(p.sizeBytes / 1024 / 1024).toFixed(1)} MB · SHA-1 ${escapeHtml(p.sha1.slice(0, 12))}…
          </div>
        </div>
        <div style="display:flex;gap:6px;">
          ${
            kind === "resourcepack"
              ? `<button class="btn" data-activate="${escapeHtml(p.filename)}">${t("kiosztas")}</button>`
              : ""
          }
          <button class="btn btn-danger" data-del-pack="${kind}|${escapeHtml(p.filename)}">${t("torles")}</button>
        </div>
      </div>`
            )
            .join("");

    content.innerHTML = `
      <h4 style="margin-bottom:4px;">Resource pack</h4>
      <p style="max-width:640px;color:var(--text-dim);font-size:12px;margin-top:0;">${t("a_resource_packet_nem_a_szerver_kuldi_el_csak_eg")}<strong>${t("jatekosok_geperol")}</strong>${t("kell_elerhetonek_lennie")}</p>

      <div class="field" style="max-width:520px;">
        <label for="pack-base">${t("nyilvanos_alapcim")}</label>
        <input id="pack-base" value="${escapeHtml(suggestedBase)}" />
      </div>

      <div class="field checkbox-row">
        <input id="pack-required" type="checkbox" ${rp.status?.required ? "checked" : ""} />
        <label for="pack-required" style="margin:0">${t("kotelezo_aki_nem_fogadja_el_nem_tud_belepni")}</label>
      </div>

      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0;">
        <input type="file" id="rp-file" accept=".zip" style="max-width:280px;" />
        <button class="btn btn-primary" id="rp-upload">${t("feltoltes")}</button>
        ${rp.status?.url ? `<button class="btn" id="rp-clear">${t("kiosztas_visszavonasa")}</button>` : ""}
      </div>
      ${
        rp.status?.url
          ? `<div style="color:var(--text-dim);font-size:11px;margin-bottom:8px;">Jelenlegi: ${escapeHtml(
              rp.status.url
            )}</div>`
          : ""
      }
      <div>${packRows(rp.packs, "resourcepack")}</div>

      <h4 style="margin:28px 0 4px;">${t("datapackek")}</h4>
      <p style="max-width:640px;color:var(--text-dim);font-size:12px;margin-top:0;">${t("a_datapackek_a_vilag")}<code>datapacks</code>${t("mappajaba_kerulnek_es_a_szerver_maga_tolti_be_ok")}<code>/datapack enable</code>${t("utan_lepnek_eletbe")}</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0;">
        <input type="file" id="dp-file" accept=".zip" style="max-width:280px;" />
        <button class="btn btn-primary" id="dp-upload">${t("feltoltes")}</button>
      </div>
      <div>${packRows(dp.packs, "datapack")}</div>
    `;

    const upload = async (inputId: string, kind: "resourcepack" | "datapack") => {
      const input = content.querySelector<HTMLInputElement>(`#${inputId}`)!;
      const file = input.files?.[0];
      if (!file) {
        showToast(t("valassz_egy_zip_fajlt"), "error");
        return;
      }
      try {
        await api.uploadPack(serverId, kind, file);
        showToast(t("feltoltve"));
        await renderContent(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("feltoltes_sikertelen"), "error");
      }
    };

    content.querySelector<HTMLButtonElement>("#rp-upload")!.onclick = () => void upload("rp-file", "resourcepack");
    content.querySelector<HTMLButtonElement>("#dp-upload")!.onclick = () => void upload("dp-file", "datapack");

    content.querySelector<HTMLInputElement>("#pack-required")!.onchange = async (e) => {
      const el = e.target as HTMLInputElement;
      try {
        await api.setRequireResourcePack(serverId, el.checked);
        showToast(el.checked ? t("kotelezove_teve") : t("mar_nem_kotelezo"));
      } catch (err) {
        el.checked = !el.checked;
        showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
      }
    };

    content.querySelector<HTMLButtonElement>("#rp-clear")?.addEventListener("click", async () => {
      try {
        await api.clearResourcePack(serverId);
        showToast(t("kiosztas_visszavonva"));
        await renderContent(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
      }
    });

    content.querySelectorAll<HTMLButtonElement>("[data-activate]").forEach((btn) => {
      btn.onclick = async () => {
        const base = content.querySelector<HTMLInputElement>("#pack-base")!.value.trim();
        try {
          const { sha1 } = await api.activateResourcePack(serverId, btn.dataset.activate!, base);
          showToast(`Kiosztva (SHA-1 ${sha1.slice(0, 8)}…)`);
          await renderContent(content);
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
        }
      };
    });

    content.querySelectorAll<HTMLButtonElement>("[data-del-pack]").forEach((btn) => {
      btn.onclick = async () => {
        const [kind, filename] = btn.dataset.delPack!.split("|");
        if (!(await confirmModal(`Törlöd ezt a csomagot? <strong>${escapeHtml(filename)}</strong>`))) return;
        try {
          await api.deletePack(serverId, kind as "resourcepack" | "datapack", filename);
          showToast(t("torolve"));
          await renderContent(content);
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("torles_sikertelen"), "error");
        }
      };
    });
  }

  async function renderPerformance(content: HTMLElement) {
    const running = server?.running ?? false;
    content.innerHTML = `
      <h4 style="margin-bottom:8px;">${t("bovitmeny_utkozesek")}</h4>
      <div id="perf-conflicts"><div style="color:var(--text-dim);font-size:12px;">${t("ellenorzes")}</div></div>

      <h4 style="margin:24px 0 8px;">Lag doctor</h4>
      <p style="max-width:620px;color:var(--text-dim);font-size:12px;margin-top:0;">${t("lefuttatja_a_diagnosztikai_parancsokat_es_osszes")}</p>
      <button class="btn" id="perf-lag" ${running ? "" : "disabled"}>${t("diagnosztika_futtatasa")}</button>
      ${running ? "" : `<span style="color:var(--text-dim);font-size:12px;margin-left:8px;">${t("futnia_kell_a_szervernek")}</span>`}
      <div id="perf-lag-out" style="margin-top:12px;"></div>

      <h4 style="margin:24px 0 8px;">${t("jvm_parameterek")}</h4>
      <div id="perf-jvm"><div style="color:var(--text-dim);font-size:12px;">${t("betoltes")}</div></div>

      <h4 style="margin:24px 0 8px;">${t("terhelesteszt")}</h4>
      <p style="max-width:620px;color:var(--text-dim);font-size:12px;margin-top:0;">${t(
        "terhelesteszt_leiras"
      )}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <label style="font-size:12px;">${t("parhuzamos_kapcsolatok")}
          <input id="lt-conns" type="number" min="1" max="500" value="25" style="width:80px;" />
        </label>
        <label style="font-size:12px;">${t("hossz_mp")}
          <input id="lt-secs" type="number" min="1" max="60" value="10" style="width:70px;" />
        </label>
        <button class="btn" id="lt-run" ${running ? "" : "disabled"}>${t("teszt_inditasa")}</button>
        ${
          running
            ? ""
            : `<span style="color:var(--text-dim);font-size:12px;">${t(
                "futnia_kell_a_szervernek"
              )}</span>`
        }
      </div>
      <div id="lt-out" style="margin-top:12px;"></div>
    `;

    content.querySelector<HTMLButtonElement>("#lt-run")?.addEventListener("click", async () => {
      const button = content.querySelector<HTMLButtonElement>("#lt-run")!;
      const out = content.querySelector<HTMLDivElement>("#lt-out")!;
      const connections = Number(content.querySelector<HTMLInputElement>("#lt-conns")!.value);
      const seconds = Number(content.querySelector<HTMLInputElement>("#lt-secs")!.value);
      button.disabled = true;
      // The request blocks for the whole run, so the button has to say so or
      // it reads as a dead click for ten seconds.
      out.innerHTML = `<div style="color:var(--text-dim);font-size:12px;">${t(
        "teszt_folyamatban"
      )}</div>`;
      try {
        const report = await api.runLoadTest(serverId, connections, seconds);
        const errors = Object.entries(report.errors);
        out.innerHTML = `
          <div class="finding ${report.failed > 0 ? "finding-warning" : "finding-info"}">
            <div class="finding-head">
              <span class="finding-badge">${report.succeeded}/${report.attempted}</span>
              <strong>${escapeHtml(report.host)}:${report.port}</strong>
            </div>
            <p class="finding-detail">
              ${report.connections} ${t("parhuzamos_kapcsolat_kisbetu")}, ${
                report.durationSeconds
              } ${t("masodperc")} ·
              ${
                report.latencyMs
                  ? `${t("valaszido")}: ${report.latencyMs.min}/${report.latencyMs.median}/${
                      report.latencyMs.p95
                    }/${report.latencyMs.max} ms (min/median/p95/max)`
                  : t("nem_erkezett_valasz")
              }
            </p>
            ${
              errors.length === 0
                ? ""
                : `<p class="finding-advice">${errors
                    .map(([message, count]) => `${escapeHtml(message)} ×${count}`)
                    .join(" · ")}</p>`
            }
          </div>`;
      } catch (err) {
        out.innerHTML = `<div class="finding finding-warning"><p class="finding-detail">${escapeHtml(
          err instanceof ApiError ? err.message : String(err)
        )}</p></div>`;
      } finally {
        button.disabled = !running;
      }
    });

    void (async () => {
      const box = content.querySelector<HTMLDivElement>("#perf-conflicts")!;
      try {
        const conflicts = await api.getPluginConflicts(serverId);
        box.innerHTML =
          conflicts.length === 0
            ? `<div style="color:var(--green);font-size:12px;">${t("nem_talaltam_ismert_utkozest")}</div>`
            : conflicts
                .map(
                  (c) => `
          <div style="padding:8px 0;border-bottom:0.5px solid var(--border);">
            <div style="color:${c.severity === "conflict" ? "var(--red)" : "var(--yellow)"};font-size:13px;">
              ${c.severity === "conflict" ? t("utkozes") : t("figyelmeztetes")}: ${escapeHtml(c.plugins.join(" + "))}
            </div>
            <div style="color:var(--text-dim);font-size:12px;">${escapeHtml(c.message)}</div>
          </div>`
                )
                .join("");
      } catch (err) {
        box.innerHTML = `<div class="error-text">${escapeHtml(
          err instanceof ApiError ? err.message : t("nem_sikerult_ellenorizni")
        )}</div>`;
      }
    })();

    content.querySelector<HTMLButtonElement>("#perf-lag")!.onclick = async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      const out = content.querySelector<HTMLDivElement>("#perf-lag-out")!;
      btn.disabled = true;
      btn.textContent = "Fut…";
      out.innerHTML = "";
      try {
        const report = await api.diagnoseLag(serverId);
        out.innerHTML = `
          ${report.tps ? `<div style="font-size:14px;font-weight:600;">TPS: ${escapeHtml(report.tps)}</div>` : ""}
          <ul style="margin:8px 0;padding-left:18px;color:var(--text-dim);font-size:12px;">
            ${report.findings.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}
          </ul>`;
      } catch (err) {
        out.innerHTML = `<div class="error-text">${escapeHtml(
          err instanceof ApiError ? err.message : t("nem_sikerult")
        )}</div>`;
      } finally {
        btn.disabled = !(server?.running ?? false);
        btn.textContent = t("diagnosztika_futtatasa");
      }
    };

    void (async () => {
      const box = content.querySelector<HTMLDivElement>("#perf-jvm")!;
      try {
        const rec = await api.getJvmRecommendation(serverId);
        box.innerHTML = `
          <div style="color:var(--text-dim);font-size:12px;margin-bottom:8px;">
            A gépben ${(rec.hostMemoryMb / 1024).toFixed(1)} GB RAM van.
            Ajánlott heap: <strong>${(rec.recommendedHeapMb / 1024).toFixed(1)} GB</strong>.
          </div>
          <ul style="margin:0 0 12px;padding-left:18px;color:var(--text-dim);font-size:12px;">
            ${rec.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}
          </ul>
          <label>${t("jelenlegi_start_script")}</label>
          <pre class="pb-body" style="max-height:90px;">${escapeHtml(rec.currentScript.trim())}</pre>
          <label style="margin-top:12px;">${t("ajanlott_start_script")}</label>
          <pre class="pb-body" style="max-height:150px;">${escapeHtml(rec.script.trim())}</pre>
          <button class="btn btn-primary" id="perf-apply" style="margin-top:8px;" ${
            running ? t("disabled_title_allitsd_le_elobb_a_szervert") : ""
          }>${t("alkalmazas_a_start_scriptre")}</button>
          <div style="color:var(--text-dim);font-size:11px;margin-top:6px;">${t("a_regi_script_bak_kiterjesztessel_megmarad")}</div>`;

        box.querySelector<HTMLButtonElement>("#perf-apply")?.addEventListener("click", async () => {
          if (!(await confirmModal(t("felulirod_a_start_scriptet_az_ajanlott_parameter")))) return;
          try {
            await api.applyJvmScript(serverId, rec.script);
            showToast(t("start_script_frissitve"));
          } catch (err) {
            showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
          }
        });
      } catch (err) {
        box.innerHTML = `<div class="error-text">${escapeHtml(
          err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
        )}</div>`;
      }
    })();
  }

  async function renderTimeline(content: HTMLElement) {
    content.innerHTML = `<div class="empty-state" style="padding:16px;">${t("betoltes")}</div>`;
    let data;
    try {
      data = await api.getTimeline(serverId);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
      return;
    }
    if (disposed) return;

    const { config, snapshots, sizeBytes } = data;
    const running = server?.running ?? false;
    const mb = (sizeBytes / 1024 / 1024).toFixed(1);

    content.innerHTML = `
      <div class="field checkbox-row">
        <input id="tm-enabled" type="checkbox" ${config.enabled ? "checked" : ""} />
        <label for="tm-enabled" style="margin:0">${t("time_machine_bekapcsolva")}</label>
      </div>
      <p style="max-width:620px;color:var(--text-dim);font-size:12px;margin-top:0;">${t("bekapcsolva_a_dashboard_percenkent_pillanatkepet")}</p>

      <div style="display:flex;gap:16px;flex-wrap:wrap;margin:16px 0;">
        <div class="field" style="max-width:170px;">
          <label for="tm-interval">${t("gyakorisag_perc")}</label>
          <input id="tm-interval" type="number" min="1" max="60" value="${config.intervalMinutes}" />
        </div>
        <div class="field" style="max-width:190px;">
          <label for="tm-max">${t("megorzott_pillanatkepek")}</label>
          <input id="tm-max" type="number" min="5" max="500" value="${config.maxSnapshots}" />
        </div>
        <div class="field" style="align-self:flex-end;">
          <button class="btn" id="tm-save">${t("mentes")}</button>
        </div>
      </div>

      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:16px;">
        <button class="btn" id="tm-now" ${running ? "" : "disabled"}>${t("pillanatkep_most")}</button>
        <button class="btn btn-danger" id="tm-clear">${t("elozmenyek_torlese")}</button>
        <span style="color:var(--text-dim);font-size:12px;">${snapshots.length} pillanatkép · ${mb} MB</span>
      </div>

      ${
        snapshots.length === 0
          ? `<div class="empty-state" style="padding:16px;">${t("meg_nincs_pillanatkep")}</div>`
          : `
        <label for="tm-slider">${t("idopont")}</label>
        <input type="range" id="tm-slider" min="0" max="${snapshots.length - 1}" value="${
          snapshots.length - 1
        }" style="width:100%;" />
        <div style="display:flex;justify-content:space-between;color:var(--text-dim);font-size:11px;">
          <span>${new Date(snapshots[0].at).toLocaleString("hu-HU")}</span>
          <span>${new Date(snapshots[snapshots.length - 1].at).toLocaleString("hu-HU")}</span>
        </div>
        <div style="margin-top:16px;padding:12px;border:0.5px solid var(--border);border-radius:var(--radius-md);">
          <div id="tm-selected" style="font-size:14px;font-weight:600;"></div>
          <div id="tm-selected-meta" style="color:var(--text-dim);font-size:12px;margin-top:2px;"></div>
          <button class="btn btn-primary" id="tm-restore" style="margin-top:12px;" ${
            running ? t("disabled_title_allitsd_le_elobb_a_szervert") : ""
          }>${t("visszaallitas_erre_az_idopontra")}</button>
        </div>`
      }
    `;

    content.querySelector<HTMLInputElement>("#tm-enabled")!.onchange = async (e) => {
      const el = e.target as HTMLInputElement;
      try {
        await api.updateServer(serverId, { timeMachine: { ...config, enabled: el.checked } });
        showToast(el.checked ? "Time Machine bekapcsolva" : "Time Machine kikapcsolva");
        callbacks.onChanged();
      } catch (err) {
        el.checked = !el.checked;
        showToast(err instanceof ApiError ? err.message : t("nem_sikerult_allitani"), "error");
      }
    };

    content.querySelector<HTMLButtonElement>("#tm-save")!.onclick = async () => {
      try {
        await api.updateServer(serverId, {
          timeMachine: {
            enabled: content.querySelector<HTMLInputElement>("#tm-enabled")!.checked,
            intervalMinutes: Number(content.querySelector<HTMLInputElement>("#tm-interval")!.value),
            maxSnapshots: Number(content.querySelector<HTMLInputElement>("#tm-max")!.value),
          },
        });
        showToast(t("beallitas_mentve"));
        await renderTimeline(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("mentes_sikertelen"), "error");
      }
    };

    content.querySelector<HTMLButtonElement>("#tm-now")!.onclick = async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = t("keszul");
      try {
        await api.takeSnapshot(serverId);
        showToast(t("pillanatkep_elkeszult"));
        await renderTimeline(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
        btn.disabled = false;
        btn.textContent = t("pillanatkep_most");
      }
    };

    content.querySelector<HTMLButtonElement>("#tm-clear")!.onclick = async () => {
      if (!(await confirmModal(t("biztosan_torlod_az_osszes_pillanatkepet_ez_stron"))))
        return;
      try {
        await api.clearTimeline(serverId);
        showToast(t("elozmenyek_torolve"));
        await renderTimeline(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("torles_sikertelen"), "error");
      }
    };

    const slider = content.querySelector<HTMLInputElement>("#tm-slider");
    if (slider) {
      const label = content.querySelector<HTMLDivElement>("#tm-selected")!;
      const meta = content.querySelector<HTMLDivElement>("#tm-selected-meta")!;
      const paint = () => {
        const snap = snapshots[Number(slider.value)];
        label.textContent = new Date(snap.at).toLocaleString("hu-HU");
        meta.textContent = `${snap.fileCount} világfájl`;
      };
      slider.oninput = paint;
      paint();

      content.querySelector<HTMLButtonElement>("#tm-restore")!.onclick = async () => {
        const snap = snapshots[Number(slider.value)];
        if (
          !(await confirmModal(
            `Visszatekered a világot erre: <strong>${escapeHtml(
              new Date(snap.at).toLocaleString("hu-HU")
            )}</strong>? Az azóta történt változások elvesznek.`
          ))
        ) {
          return;
        }
        try {
          const restored = await api.restoreSnapshot(serverId, snap.id);
          showToast(`Visszaállítva: ${restored} fájl`);
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("visszaallitas_sikertelen"), "error");
        }
      };
    }
  }

  /** The editor overlay lives on <body>, so it outlives this view unless closed. */
  let disposeLuckPerms: (() => void) | null = null;

  function renderLuckPerms(content: HTMLElement) {
    const running = server?.running ?? false;
    content.innerHTML = `
      <p style="max-width:560px;color:var(--text-dim);font-size:12px;">${t("a_luckperms_sajat_webes_szerkesztojet_nyitja_meg")}<code>/lp editor</code>${t("parancsot_a_gomb_megnyomasakor_a_szerver_feltolt")}</p>
      <div style="display:flex;gap:8px;align-items:center;margin-top:16px;">
        <button class="btn btn-primary" id="lp-open" ${running ? "" : "disabled"}>${t("szerkeszto_megnyitasa")}</button>
        ${running ? "" : `<span style="color:var(--text-dim);font-size:12px;">${t("a_szervernek_futnia_kell")}</span>`}
      </div>
      <div id="lp-result" style="margin-top:16px;"></div>
    `;

    const resultEl = content.querySelector<HTMLDivElement>("#lp-result")!;
    content.querySelector<HTMLButtonElement>("#lp-open")!.onclick = async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = t("link_kerese");
      resultEl.innerHTML = "";
      try {
        const { url, embeddable } = await api.createLuckPermsEditor(serverId);
        // Opened inside the dashboard rather than in a new tab. The overlay
        // owns the fallback to a real tab if the frame will not load.
        disposeLuckPerms?.();
        disposeLuckPerms = openLuckPermsEditor(serverId, url, embeddable);
        resultEl.innerHTML = "";
      } catch (err) {
        resultEl.innerHTML = `<div class="error-text">${escapeHtml(
          err instanceof ApiError ? err.message : t("nem_sikerult_megnyitni_a_szerkesztot")
        )}</div>`;
      } finally {
        btn.disabled = !(server?.running ?? false);
        btn.textContent = t("szerkeszto_megnyitasa");
      }
    };
  }

  async function renderAccess(content: HTMLElement) {
    content.innerHTML = `<div class="empty-state" style="padding:1rem;">${t("betoltes")}</div>`;
    let access;
    try {
      access = await api.getAccessLists(serverId);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:1rem;">${escapeHtml(
        err instanceof ApiError ? err.message : t("a_listak_betoltese_sikertelen")
      )}</div>`;
      return;
    }
    if (disposed) return;
    const running = server?.running ?? false;

    // The lists are read from the server's own json files, so they show even
    // while it is stopped; changing them goes through console commands, which
    // do need it running.
    const listHtml = (entries: typeof access.whitelist, removeAction: string, emptyText: string) =>
      entries.length === 0
        ? `<div style="color:var(--text-dim);font-size:0.85rem;padding:0.4rem 0;">${emptyText}</div>`
        : entries
            .map(
              (e) => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.6rem;padding:0.4rem 0;border-bottom:1px solid var(--border);">
          <div style="min-width:0;">
            <div>${escapeHtml(e.name)}</div>
            ${
              e.reason || e.created
                ? `<div style="color:var(--text-dim);font-size:0.78rem;">${escapeHtml(
                    [e.reason, e.created ? new Date(e.created).toLocaleDateString("hu-HU") : null]
                      .filter(Boolean)
                      .join(" · ")
                  )}</div>`
                : ""
            }
          </div>
          <button class="btn" data-remove="${removeAction}" data-name="${escapeHtml(e.name)}" ${
            running ? "" : "disabled title='A szervernek futnia kell'"
          }>${t("eltavolitas")}</button>
        </div>`
            )
            .join("");

    content.innerHTML = `
      <div class="field checkbox-row">
        <input id="wl-mode" type="checkbox" ${access.whitelistEnforced ? "checked" : ""} />
        <label for="wl-mode" style="margin:0">${t("whitelist_bekapcsolva_csak_a_listan_szereplok_le")}</label>
      </div>

      <h4 style="margin:1.2rem 0 0.4rem;">Whitelist (${access.whitelist.length})</h4>
      <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;flex-wrap:wrap;">
        <input id="wl-name" placeholder="${t("jatekosnev")}" style="max-width:200px;" ${running ? "" : "disabled"} />
        <button class="btn btn-primary" id="wl-add" ${running ? "" : "disabled"}>${t("hozzaadas")}</button>
      </div>
      <div id="wl-list">${listHtml(access.whitelist, "whitelist_remove", t("a_whitelist_ures"))}</div>

      <h4 style="margin:1.5rem 0 0.4rem;">Kitiltott játékosok (${access.bannedPlayers.length})</h4>
      <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;flex-wrap:wrap;">
        <input id="ban-name" placeholder="${t("jatekosnev")}" style="max-width:200px;" ${running ? "" : "disabled"} />
        <button class="btn btn-danger" id="ban-add" ${running ? "" : "disabled"}>${t("kitiltas")}</button>
      </div>
      <div id="ban-list">${listHtml(access.bannedPlayers, "pardon", "Senki nincs kitiltva.")}</div>

      <h4 style="margin:1.5rem 0 0.4rem;">Kitiltott IP-címek (${access.bannedIps.length})</h4>
      <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;flex-wrap:wrap;">
        <input id="ip-value" placeholder="pl. 192.168.1.10" style="max-width:200px;" ${running ? "" : "disabled"} />
        <button class="btn btn-danger" id="ip-add" ${running ? "" : "disabled"}>${t("ip_kitiltasa")}</button>
      </div>
      <div id="ip-list">${listHtml(access.bannedIps, "pardon_ip", "Nincs kitiltott IP.")}</div>

      ${
        running
          ? ""
          : `<p style="color:var(--text-dim);font-size:0.8rem;margin-top:1rem;">A listák szerkesztéséhez futnia kell a szervernek (a whitelist kapcsoló állóban is működik).</p>`
      }
    `;

    content.querySelector<HTMLInputElement>("#wl-mode")!.onchange = async (e) => {
      const el = e.target as HTMLInputElement;
      try {
        await api.setWhitelistMode(serverId, el.checked);
        showToast(el.checked ? "Whitelist bekapcsolva" : "Whitelist kikapcsolva");
      } catch (err) {
        el.checked = !el.checked;
        showToast(err instanceof ApiError ? err.message : t("nem_sikerult_allitani"), "error");
      }
    };

    const run = async (fn: () => Promise<void>, okMessage: string) => {
      try {
        await fn();
        showToast(okMessage);
        // Minecraft writes the json files a moment after the command lands.
        await new Promise((r) => setTimeout(r, 700));
        await renderAccess(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("muvelet_sikertelen"), "error");
      }
    };

    content.querySelector<HTMLButtonElement>("#wl-add")!.onclick = () => {
      const name = content.querySelector<HTMLInputElement>("#wl-name")!.value.trim();
      if (!name) return;
      void run(() => api.playerAction(serverId, name, "whitelist_add"), `${name} felkerült a whitelistre`);
    };
    content.querySelector<HTMLButtonElement>("#ban-add")!.onclick = async () => {
      const name = content.querySelector<HTMLInputElement>("#ban-name")!.value.trim();
      if (!name) return;
      if (!(await confirmModal(`Biztosan kitiltod: <strong>${escapeHtml(name)}</strong>?`))) return;
      void run(() => api.playerAction(serverId, name, "ban"), `${name} kitiltva`);
    };
    content.querySelector<HTMLButtonElement>("#ip-add")!.onclick = async () => {
      const ip = content.querySelector<HTMLInputElement>("#ip-value")!.value.trim();
      if (!ip) return;
      if (!(await confirmModal(`Biztosan kitiltod ezt az IP-t: <strong>${escapeHtml(ip)}</strong>?`))) return;
      void run(() => api.ipAction(serverId, ip, "ban"), `${ip} kitiltva`);
    };

    content.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((btn) => {
      btn.onclick = () => {
        const name = btn.dataset.name!;
        const kind = btn.dataset.remove!;
        if (kind === "pardon_ip") {
          void run(() => api.ipAction(serverId, name, "pardon"), `${name} feloldva`);
        } else {
          void run(() => api.playerAction(serverId, name, kind as PlayerAction), `${name} eltávolítva`);
        }
      };
    });
  }

  async function renderPlugins(content: HTMLElement) {
    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.6rem;margin-bottom:0.9rem;flex-wrap:wrap;">
        <div style="color:var(--text-dim);font-size:0.85rem;">${t("telepitett_bovitmenyek")}</div>
        <div style="display:flex;gap:0.4rem;">
          <button class="btn" id="plugins-refresh">${t("frissitesek_keresese")}</button>
          <button class="btn btn-primary" id="plugins-add">${t("bovitmeny_telepitese")}</button>
        </div>
      </div>
      <div id="plugins-list"><div class="empty-state" style="padding:1rem;">${t("betoltes")}</div></div>
      <p style="color:var(--text-dim);font-size:0.8rem;margin-top:0.9rem;">${t("a_modositasok_a_szerver_kovetkezo_ujrainditasako")}</p>
    `;

    const listEl = content.querySelector<HTMLDivElement>("#plugins-list")!;

    async function reload(checkUpdates = false) {
      listEl.innerHTML = `<div class="empty-state" style="padding:1rem;">${
        checkUpdates ? t("frissitesek_keresese_2") : t("betoltes")
      }</div>`;
      try {
        const plugins = await api.listPlugins(serverId, checkUpdates);
        if (disposed) return;
        if (plugins.length === 0) {
          listEl.innerHTML = `<div class="empty-state" style="padding:1rem;">${t("nincs_telepitett_bovitmeny")}</div>`;
          return;
        }
        listEl.innerHTML = plugins
          .map(
            (p) => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:0.6rem;padding:0.55rem 0;border-bottom:1px solid var(--border);">
            <div style="min-width:0;">
              <div>${escapeHtml(p.name ?? p.filename)}${
                p.version ? ` <span style="color:var(--text-dim);font-size:0.82rem;">v${escapeHtml(p.version)}</span>` : ""
              }</div>
              <div style="color:var(--text-dim);font-size:0.78rem;">
                ${escapeHtml(p.filename)} · ${(p.sizeBytes / 1024 / 1024).toFixed(1)} MB${
                  p.source ? ` · ${escapeHtml(p.source)}` : t("kezzel_telepitve")
                }
              </div>
              ${
                p.updateAvailable
                  ? `<div style="color:var(--yellow);font-size:0.8rem;margin-top:0.2rem;">Elérhető frissítés: ${escapeHtml(
                      p.latestVersion ?? ""
                    )}</div>`
                  : ""
              }
            </div>
            <button class="btn btn-danger" data-del-plugin="${escapeHtml(p.filename)}">${t("torles")}</button>
          </div>`
          )
          .join("");

        listEl.querySelectorAll<HTMLButtonElement>("[data-del-plugin]").forEach((btn) => {
          btn.onclick = async () => {
            const filename = btn.dataset.delPlugin!;
            if (!(await confirmModal(`Biztosan törlöd ezt a bővítményt? <strong>${escapeHtml(filename)}</strong>`))) {
              return;
            }
            try {
              await api.deletePlugin(serverId, filename);
              showToast(t("bovitmeny_torolve"));
              await reload();
            } catch (err) {
              showToast(err instanceof ApiError ? err.message : t("torles_sikertelen"), "error");
            }
          };
        });
      } catch (err) {
        listEl.innerHTML = `<div class="empty-state" style="padding:1rem;">${escapeHtml(
          err instanceof ApiError ? err.message : t("a_bovitmenyek_betoltese_sikertelen")
        )}</div>`;
      }
    }

    content.querySelector<HTMLButtonElement>("#plugins-refresh")!.onclick = () => void reload(true);
    content.querySelector<HTMLButtonElement>("#plugins-add")!.onclick = () => {
      openPluginBrowser(serverId, () => void reload());
    };

    await reload();
  }

  function actionButtonsHtml(prefix: string): string {
    return PLAYER_ACTIONS.map(
      ({ action, label }) => `<button class="btn" data-${prefix}-action="${action}">${label}</button>`
    ).join("");
  }

  async function runPlayerAction(name: string, action: PlayerAction) {
    if (!name) return;
    try {
      await api.playerAction(serverId, name, action);
      showToast(`${action} elküldve: ${name}`);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : t("muvelet_sikertelen"), "error");
    }
  }

  function renderPlayers(content: HTMLElement) {
    if (!server) return;
    const running = server.running;
    const players = server.rcon.enabled ? server.players : null;

    const listSection = !server.rcon.enabled
      ? `<div class="empty-state" style="padding:1rem 0;">${t("ehhez_a_szerverhez_nincs_rcon_beallitva_igy_a_ja")}</div>`
      : !players
        ? `<div class="empty-state" style="padding:1rem 0;">${t("nincs_adat_a_szerver_all_vagy_meg_nem_erkezett_r")}</div>`
        : `
          <p>${players.online} / ${players.max} játékos online</p>
          <div id="player-chips">
            ${
              players.names
                .map(
                  (n) => `
              <div class="player-chip" style="display:flex;align-items:center;gap:0.4rem;margin:0.3rem 0;">
                <span style="min-width:120px;">${n}</span>
                ${actionButtonsHtml("chip")}
              </div>`
                )
                .join("") || `<em>${t("senki_nincs_bent")}</em>`
            }
          </div>
          <p style="color:var(--text-dim);font-size:0.8rem;margin-top:0.5rem;">Frissítve: ${new Date(players.fetchedAt).toLocaleTimeString()}</p>
        `;

    // Time and weather sit with the player tools: both are live moderation of
    // a running world.
    const worldButtons = [
      { action: "day", label: "Nappal" },
      { action: "night", label: t("ejszaka") },
      { action: "clear", label: t("napos_ido") },
      { action: "rain", label: t("eso") },
      { action: "thunder", label: "Vihar" },
      { action: "freeze_time", label: t("ido_megallitasa") },
      { action: "resume_time", label: t("ido_inditasa") },
    ];

    content.innerHTML = `
      ${listSection}
      <div style="margin-top:1.2rem;padding-top:1rem;border-top:1px solid var(--border);">
        <label>${t("vilag_gyorsvezerles")}</label>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;" id="world-buttons">
          ${worldButtons
            .map(
              (b) =>
                `<button class="btn" data-world="${b.action}" ${running ? "" : "disabled"}>${b.label}</button>`
            )
            .join("")}
        </div>
      </div>
      <div style="margin-top:1.2rem;padding-top:1rem;border-top:1px solid var(--border);">
        <label for="manual-player-name">${t("gyorsparancs_jatekosnevvel")}</label>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">
          <input id="manual-player-name" placeholder="${t("jatekosnev")}" style="max-width:200px;" ${running ? "" : "disabled"} />
          ${actionButtonsHtml("manual")}
        </div>
        ${running ? "" : `<p style="color:var(--text-dim);font-size:0.8rem;margin-top:0.4rem;">${t("futnia_kell_parancsokhoz")}</p>`}
      </div>
    `;

    content.querySelectorAll<HTMLButtonElement>("[data-world]").forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api.worldAction(serverId, btn.dataset.world!);
          showToast(`${btn.textContent} elküldve`);
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("muvelet_sikertelen"), "error");
        }
      };
    });

    content.querySelectorAll<HTMLButtonElement>("[data-chip-action]").forEach((btn) => {
      btn.disabled = !running;
      btn.onclick = () => {
        const name = btn.closest(".player-chip")?.querySelector("span")?.textContent ?? "";
        void runPlayerAction(name, btn.dataset.chipAction as PlayerAction);
      };
    });

    content.querySelectorAll<HTMLButtonElement>("[data-manual-action]").forEach((btn) => {
      btn.disabled = !running;
      btn.onclick = () => {
        const name = content.querySelector<HTMLInputElement>("#manual-player-name")!.value.trim();
        void runPlayerAction(name, btn.dataset.manualAction as PlayerAction);
      };
    });
  }

  function renderSettings(content: HTMLElement) {
    if (!server) return;
    content.innerHTML = `
      <div class="field"><label>${t("mappa")}</label><div>${server.folder}</div></div>
      <div class="field"><label>Start script</label><div>${server.startScript}</div></div>
      <div class="field"><label>${t("stop_parancs")}</label><div>${server.stopCommand}</div></div>
      <div class="field"><label>Screen session</label><div>${server.screenName}</div></div>
      <div class="field"><label>RCON</label><div>${server.rcon.enabled ? `${server.rcon.host}:${server.rcon.port}` : "kikapcsolva"}</div></div>
      <div class="field"><label>${t("utemezett_ujrainditas")}</label><div>${
        server.scheduledRestart.enabled ? `minden nap ${server.scheduledRestart.time}-kor` : "kikapcsolva"
      }</div></div>
      <div class="field"><label>${t("ujrainditas_osszeomlas_utan")}</label><div>${
        server.crashRestart?.enabled
          ? `bekapcsolva (max ${server.crashRestart.maxAttempts} próbálkozás 10 percen belül)`
          : "kikapcsolva"
      }</div></div>
      <div style="display:flex;gap:0.5rem;margin-top:1rem;">
        <button class="btn" id="edit-btn">${t("szerkesztes")}</button>
        ${
          isAdmin()
            ? `<button class="btn btn-danger" id="delete-btn" ${server.running ? t("disabled_title_allitsd_le_elobb") : ""}>${t("torles")}</button>`
            : ""
        }
      </div>
      <div style="margin-top:2rem;padding-top:1.2rem;border-top:1px solid var(--border);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.8rem;">
          <h3 style="margin:0;font-size:1rem;">${t("mentesek")}</h3>
          <button class="btn btn-primary" id="create-backup-btn">${t("mentes_keszitese")}</button>
        </div>
        <div id="backups-list"><div class="empty-state" style="padding:0.5rem 0;">${t("betoltes")}</div></div>
      </div>
      ${renderConfigHistorySection()}
      ${renderDnaSection()}
      ${renderMigrationSection()}
    `;
    bindConfigHistory(content);
    bindDnaSection(content);
    bindMigrationSection(content);
    content.querySelector<HTMLButtonElement>("#edit-btn")!.onclick = () => {
      openAddServerModal(async () => {
        await load();
        callbacks.onChanged();
      }, server!);
    };
    content.querySelector<HTMLButtonElement>("#delete-btn")?.addEventListener("click", async () => {
      if (await confirmModal(`Biztosan törlöd a(z) <strong>${server!.name}</strong> szervert a listából?`)) {
        try {
          await api.deleteServer(serverId);
          callbacks.onDeleted();
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("torles_sikertelen"), "error");
        }
      }
    });
    content.querySelector<HTMLButtonElement>("#create-backup-btn")!.onclick = async () => {
      const btn = content.querySelector<HTMLButtonElement>("#create-backup-btn")!;
      btn.disabled = true;
      try {
        await api.createBackup(serverId);
        showToast(t("mentes_elkeszult"));
        await renderBackupsList(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("mentes_sikertelen"), "error");
      } finally {
        btn.disabled = false;
      }
    };
    void renderBackupsList(content);
  }

  async function renderBackupsList(content: HTMLElement) {
    const listEl = content.querySelector<HTMLDivElement>("#backups-list");
    if (!listEl) return;
    try {
      const backups = await api.listBackups(serverId);
      if (backups.length === 0) {
        listEl.innerHTML = `<div class="empty-state" style="padding:0.5rem 0;">${t("meg_nincs_mentes")}</div>`;
        return;
      }
      listEl.innerHTML = backups
        .map(
          (b) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid var(--border);">
          <div>
            <div>${new Date(b.createdAt).toLocaleString()}</div>
            <div style="color:var(--text-dim);font-size:0.8rem;">${(b.size / 1024 / 1024).toFixed(1)} MB</div>
          </div>
          <div style="display:flex;gap:0.4rem;">
            <a class="btn" href="${api.backupDownloadUrl(serverId, b.filename)}">${t("letoltes")}</a>
            <button class="btn" data-restore="${b.filename}" ${server?.running ? t("disabled_title_allitsd_le_elobb") : ""}>${t("visszaallitas")}</button>
            <button class="btn btn-danger" data-delete-backup="${b.filename}">${t("torles")}</button>
          </div>
        </div>`
        )
        .join("");

      listEl.querySelectorAll<HTMLButtonElement>("[data-restore]").forEach((btn) => {
        btn.onclick = async () => {
          const filename = btn.dataset.restore!;
          if (
            await confirmModal(
              `Biztosan visszaállítod ezt a mentést? Ez <strong>${t("felulirja")}</strong> a jelenlegi szerver-mappa tartalmát.`
            )
          ) {
            try {
              await api.restoreBackup(serverId, filename);
              showToast(t("visszaallitva"));
            } catch (err) {
              showToast(err instanceof ApiError ? err.message : t("visszaallitas_sikertelen"), "error");
            }
          }
        };
      });
      listEl.querySelectorAll<HTMLButtonElement>("[data-delete-backup]").forEach((btn) => {
        btn.onclick = async () => {
          const filename = btn.dataset.deleteBackup!;
          if (await confirmModal(t("biztosan_torlod_ezt_a_mentest"))) {
            try {
              await api.deleteBackup(serverId, filename);
              await renderBackupsList(content);
            } catch (err) {
              showToast(err instanceof ApiError ? err.message : t("torles_sikertelen"), "error");
            }
          }
        };
      });
    } catch (err) {
      listEl.innerHTML = `<div class="empty-state" style="padding:0.5rem 0;">${
        err instanceof ApiError ? err.message : t("mentesek_betoltese_sikertelen")
      }</div>`;
    }
  }

  void load().then(startStatsLoop);

  /**
   * Takes a jump from the search box when it names this server.
   *
   * Handled here rather than through the hash so a jump within the server you
   * are already looking at swaps the tab instead of tearing the whole view down
   * and building it again.
   */
  const stopListening = onJump((jump) => {
    if (disposed || jump.serverId !== serverId) return false;
    pendingFocus = jump.focus ?? null;
    // Beginner mode hides most tabs, and a search result that silently did
    // nothing would be worse than one that shows the tab it promised.
    if (getSimpleMode() && !BEGINNER_TABS.includes(jump.tab as Tab)) {
      setSimpleMode(false);
      renderShell();
    }
    if (jump.tab === activeTab) renderTabContent();
    else goToTab(jump.tab as Tab);
    return true;
  });

  // A jump parked while another server was on screen; this view is the one it
  // was waiting for.
  const parked = takeJump(serverId);
  if (parked) {
    pendingFocus = parked.focus ?? null;
    queueMicrotask(() => {
      if (!disposed) goToTab(parked.tab as Tab);
    });
  }

  return () => {
    disposed = true;
    stopListening();
    mapHandle?.destroy();
    mapHandle = null;
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
    disposeLuckPerms?.();
    disposeTab?.();
    teardownConsole();
  };
}
