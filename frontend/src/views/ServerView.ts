import { api, ApiError } from "../api";
import { ConsoleSocket } from "../ws-client";
import { ConsoleLogView } from "../components/ConsoleLog";
import { FileBrowser } from "../components/FileBrowser";
import { openPluginBrowser } from "../components/PluginBrowser";
import { sparklineSvg } from "../components/Sparkline";
import { confirmModal, openModal } from "../components/Modal";
import { showToast } from "../components/Toast";
import { escapeHtml } from "../lib/escape";
import { ansiLineToHtml } from "../lib/ansi";
import { openAddServerModal } from "./AddServerModal";
import { isAdmin, permissionsFor } from "../auth-state";
import { PLAYER_ACTIONS, type PlayerAction, type ServerWithStatus } from "../types";

type Tab = "console" | "files" | "plugins" | "players" | "access" | "luckperms" | "settings";
const ALL_TABS: Tab[] = ["console", "files", "plugins", "players", "access", "luckperms", "settings"];

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
  const capabilityFor = (tab: Tab) =>
    tab === "plugins" ? "files" : tab === "access" ? "players" : tab === "luckperms" ? "settings" : tab;
  const permittedTabs = ALL_TABS.filter((tab) => perms[capabilityFor(tab) as keyof typeof perms]);
  const visibleTabs = () => permittedTabs.filter((tab) => tab !== "luckperms" || luckPermsInstalled);
  const availableTabs = permittedTabs;
  let activeTab: Tab = availableTabs[0] ?? "console";
  let server: ServerWithStatus | null = null;
  let disposed = false;

  let terminal: ConsoleLogView | null = null;
  let socket: ConsoleSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  const consoleHistory: string[] = [];

  root.innerHTML = `<div class="empty-state">Betöltés…</div>`;

  async function load() {
    try {
      server = await api.getServer(serverId);
      if (permittedTabs.includes("luckperms")) {
        luckPermsInstalled = await api.getLuckPermsStatus(serverId).catch(() => false);
      }
      renderShell();
    } catch (err) {
      root.innerHTML = `<div class="empty-state">${
        err instanceof ApiError ? err.message : "Szerver betöltése sikertelen"
      }</div>`;
    }
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
      <div class="tabs">
        ${visibleTabs()
          .map(
            (tab) =>
              `<div class="tab ${tab === activeTab ? "active" : ""}" data-tab="${tab}">${labelFor(tab)}</div>`
          )
          .join("")}
      </div>
      <div id="resource-charts"></div>
      <div class="tab-content" id="tab-content"></div>
    `;

    root.querySelectorAll<HTMLDivElement>(".tab").forEach((tabEl) => {
      tabEl.onclick = () => {
        if (tabEl.dataset.tab === activeTab) return;
        teardownConsole();
        activeTab = tabEl.dataset.tab as Tab;
        renderShell();
      };
    });

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
      console: "Konzol",
      files: "Fájlok",
      plugins: "Bővítmények",
      players: "Játékosok",
      access: "Whitelist / Ban",
      luckperms: "LuckPerms",
      settings: "Beállítások",
    }[tab];
  }

  async function runAction(fn: () => Promise<void>) {
    try {
      await fn();
      await load();
      callbacks.onChanged();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Művelet sikertelen", "error");
    }
  }

  function renderTabContent() {
    const content = root.querySelector<HTMLDivElement>("#tab-content")!;
    if (activeTab === "console") {
      content.innerHTML = `
        <div class="console-container">
          <div class="terminal-wrap" id="terminal-wrap"></div>
          <div class="console-input-row">
            <input id="console-input" placeholder="Parancs a szerver konzoljába…" />
            <button class="btn btn-primary" id="console-send">Küldés</button>
            <button class="btn" id="console-history" title="Korábbi futások naplói">Előzmények</button>
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
    } else if (activeTab === "settings") {
      renderSettings(content);
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
    wrap.innerHTML = `<h3>Korábbi futások naplói</h3><p style="color:var(--text-dim);">Betöltés…</p>`;
    const close = openModal(wrap);

    async function render() {
      let logs;
      try {
        logs = await api.listConsoleLogs(serverId);
      } catch (err) {
        wrap.innerHTML = `<h3>Korábbi futások naplói</h3><p class="error-text">${escapeHtml(
          err instanceof ApiError ? err.message : "Nem sikerült betölteni"
        )}</p><div class="modal-actions"><button class="btn" id="la-close">Bezárás</button></div>`;
        wrap.querySelector<HTMLButtonElement>("#la-close")!.onclick = () => close();
        return;
      }

      wrap.innerHTML = `
        <h3>Korábbi futások naplói</h3>
        <p style="color:var(--text-dim);font-size:12px;margin:0 0 16px;">
          A dashboard az utolsó 14 futás konzolnaplóját őrzi meg.
        </p>
        ${
          logs.length === 0
            ? `<div class="empty-state" style="padding:16px;">Még nincs archivált napló.</div>`
            : logs
                .map(
                  (l) => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:0.5px solid var(--border);">
            <div>
              <div style="font-size:13px;">${new Date(l.endedAt).toLocaleString("hu-HU")}</div>
              <div style="color:var(--text-dim);font-size:11px;">${(l.sizeBytes / 1024).toFixed(0)} kB</div>
            </div>
            <div style="display:flex;gap:6px;">
              <button class="btn" data-view="${escapeHtml(l.filename)}">Megnyitás</button>
              <button class="btn btn-danger" data-del="${escapeHtml(l.filename)}">Törlés</button>
            </div>
          </div>`
                )
                .join("")
        }
        <div class="modal-actions"><button class="btn" id="la-close">Bezárás</button></div>
      `;
      wrap.querySelector<HTMLButtonElement>("#la-close")!.onclick = () => close();

      wrap.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((btn) => {
        btn.onclick = () => void viewLog(btn.dataset.view!);
      });
      wrap.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((btn) => {
        btn.onclick = async () => {
          try {
            await api.deleteConsoleLog(serverId, btn.dataset.del!);
            showToast("Napló törölve");
            await render();
          } catch (err) {
            showToast(err instanceof ApiError ? err.message : "Törlés sikertelen", "error");
          }
        };
      });
    }

    async function viewLog(filename: string) {
      wrap.innerHTML = `<h3>Napló</h3><p style="color:var(--text-dim);">Betöltés…</p>`;
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
            <button class="btn" id="la-back">Vissza</button>
            <button class="btn" id="la-close2">Bezárás</button>
          </div>`;
        wrap.querySelector<HTMLButtonElement>("#la-back")!.onclick = () => void render();
        wrap.querySelector<HTMLButtonElement>("#la-close2")!.onclick = () => close();
        // Crashes are at the end, so that is where the view should start.
        const log = wrap.querySelector<HTMLDivElement>(".console-log");
        if (log) log.scrollTop = log.scrollHeight;
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : "Nem sikerült megnyitni", "error");
        void render();
      }
    }

    await render();
  }

  function renderLuckPerms(content: HTMLElement) {
    const running = server?.running ?? false;
    content.innerHTML = `
      <p style="max-width:560px;color:var(--text-dim);font-size:12px;">
        A LuckPerms saját webes szerkesztőjét nyitja meg — ugyanaz, mint amikor a játékban
        kiadod az <code>/lp editor</code> parancsot. A gomb megnyomásakor a szerver feltölt egy
        pillanatképet a jogosultságokról, és egy egyszer használatos linket ad vissza.
      </p>
      <div style="display:flex;gap:8px;align-items:center;margin-top:16px;">
        <button class="btn btn-primary" id="lp-open" ${running ? "" : "disabled"}>Szerkesztő megnyitása</button>
        ${running ? "" : `<span style="color:var(--text-dim);font-size:12px;">A szervernek futnia kell.</span>`}
      </div>
      <div id="lp-result" style="margin-top:16px;"></div>
    `;

    const resultEl = content.querySelector<HTMLDivElement>("#lp-result")!;
    content.querySelector<HTMLButtonElement>("#lp-open")!.onclick = async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Link kérése…";
      resultEl.innerHTML = "";
      try {
        const url = await api.createLuckPermsEditor(serverId);
        // Opened rather than embedded: the editor sets its own headers and is
        // meant to run on its own origin.
        window.open(url, "_blank", "noopener,noreferrer");
        resultEl.innerHTML = `
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:4px;">
            Ha nem nyílt meg magától, itt a link (egyszer használatos):
          </div>
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
      } catch (err) {
        resultEl.innerHTML = `<div class="error-text">${escapeHtml(
          err instanceof ApiError ? err.message : "Nem sikerült megnyitni a szerkesztőt"
        )}</div>`;
      } finally {
        btn.disabled = !(server?.running ?? false);
        btn.textContent = "Szerkesztő megnyitása";
      }
    };
  }

  async function renderAccess(content: HTMLElement) {
    content.innerHTML = `<div class="empty-state" style="padding:1rem;">Betöltés…</div>`;
    let access;
    try {
      access = await api.getAccessLists(serverId);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:1rem;">${escapeHtml(
        err instanceof ApiError ? err.message : "A listák betöltése sikertelen"
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
          }>Eltávolítás</button>
        </div>`
            )
            .join("");

    content.innerHTML = `
      <div class="field checkbox-row">
        <input id="wl-mode" type="checkbox" ${access.whitelistEnforced ? "checked" : ""} />
        <label for="wl-mode" style="margin:0">Whitelist bekapcsolva (csak a listán szereplők léphetnek be)</label>
      </div>

      <h4 style="margin:1.2rem 0 0.4rem;">Whitelist (${access.whitelist.length})</h4>
      <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;flex-wrap:wrap;">
        <input id="wl-name" placeholder="Játékosnév" style="max-width:200px;" ${running ? "" : "disabled"} />
        <button class="btn btn-primary" id="wl-add" ${running ? "" : "disabled"}>Hozzáadás</button>
      </div>
      <div id="wl-list">${listHtml(access.whitelist, "whitelist_remove", "A whitelist üres.")}</div>

      <h4 style="margin:1.5rem 0 0.4rem;">Kitiltott játékosok (${access.bannedPlayers.length})</h4>
      <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;flex-wrap:wrap;">
        <input id="ban-name" placeholder="Játékosnév" style="max-width:200px;" ${running ? "" : "disabled"} />
        <button class="btn btn-danger" id="ban-add" ${running ? "" : "disabled"}>Kitiltás</button>
      </div>
      <div id="ban-list">${listHtml(access.bannedPlayers, "pardon", "Senki nincs kitiltva.")}</div>

      <h4 style="margin:1.5rem 0 0.4rem;">Kitiltott IP-címek (${access.bannedIps.length})</h4>
      <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;flex-wrap:wrap;">
        <input id="ip-value" placeholder="pl. 192.168.1.10" style="max-width:200px;" ${running ? "" : "disabled"} />
        <button class="btn btn-danger" id="ip-add" ${running ? "" : "disabled"}>IP kitiltása</button>
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
        showToast(err instanceof ApiError ? err.message : "Nem sikerült állítani", "error");
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
        showToast(err instanceof ApiError ? err.message : "Művelet sikertelen", "error");
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
        <div style="color:var(--text-dim);font-size:0.85rem;">Telepített bővítmények</div>
        <div style="display:flex;gap:0.4rem;">
          <button class="btn" id="plugins-refresh">Frissítések keresése</button>
          <button class="btn btn-primary" id="plugins-add">+ Bővítmény telepítése</button>
        </div>
      </div>
      <div id="plugins-list"><div class="empty-state" style="padding:1rem;">Betöltés…</div></div>
      <p style="color:var(--text-dim);font-size:0.8rem;margin-top:0.9rem;">
        A módosítások a szerver következő újraindításakor lépnek életbe.
      </p>
    `;

    const listEl = content.querySelector<HTMLDivElement>("#plugins-list")!;

    async function reload(checkUpdates = false) {
      listEl.innerHTML = `<div class="empty-state" style="padding:1rem;">${
        checkUpdates ? "Frissítések keresése…" : "Betöltés…"
      }</div>`;
      try {
        const plugins = await api.listPlugins(serverId, checkUpdates);
        if (disposed) return;
        if (plugins.length === 0) {
          listEl.innerHTML = `<div class="empty-state" style="padding:1rem;">Nincs telepített bővítmény.</div>`;
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
                  p.source ? ` · ${escapeHtml(p.source)}` : " · kézzel telepítve"
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
            <button class="btn btn-danger" data-del-plugin="${escapeHtml(p.filename)}">Törlés</button>
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
              showToast("Bővítmény törölve");
              await reload();
            } catch (err) {
              showToast(err instanceof ApiError ? err.message : "Törlés sikertelen", "error");
            }
          };
        });
      } catch (err) {
        listEl.innerHTML = `<div class="empty-state" style="padding:1rem;">${escapeHtml(
          err instanceof ApiError ? err.message : "A bővítmények betöltése sikertelen"
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
      showToast(err instanceof ApiError ? err.message : "Művelet sikertelen", "error");
    }
  }

  function renderPlayers(content: HTMLElement) {
    if (!server) return;
    const running = server.running;
    const players = server.rcon.enabled ? server.players : null;

    const listSection = !server.rcon.enabled
      ? `<div class="empty-state" style="padding:1rem 0;">Ehhez a szerverhez nincs RCON beállítva, így a játékoslista nem tölthető be automatikusan (a lenti gyorsparancsok RCON nélkül is működnek).</div>`
      : !players
        ? `<div class="empty-state" style="padding:1rem 0;">Nincs adat (a szerver áll, vagy még nem érkezett RCON válasz).</div>`
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
                .join("") || "<em>Senki nincs bent.</em>"
            }
          </div>
          <p style="color:var(--text-dim);font-size:0.8rem;margin-top:0.5rem;">Frissítve: ${new Date(players.fetchedAt).toLocaleTimeString()}</p>
        `;

    content.innerHTML = `
      ${listSection}
      <div style="margin-top:1.2rem;padding-top:1rem;border-top:1px solid var(--border);">
        <label for="manual-player-name">Gyorsparancs játékosnévvel</label>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">
          <input id="manual-player-name" placeholder="Játékosnév" style="max-width:200px;" ${running ? "" : "disabled"} />
          ${actionButtonsHtml("manual")}
        </div>
        ${running ? "" : `<p style="color:var(--text-dim);font-size:0.8rem;margin-top:0.4rem;">A szervernek futnia kell a parancsok küldéséhez.</p>`}
      </div>
    `;

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
      <div class="field"><label>Mappa</label><div>${server.folder}</div></div>
      <div class="field"><label>Start script</label><div>${server.startScript}</div></div>
      <div class="field"><label>Stop parancs</label><div>${server.stopCommand}</div></div>
      <div class="field"><label>Screen session</label><div>${server.screenName}</div></div>
      <div class="field"><label>RCON</label><div>${server.rcon.enabled ? `${server.rcon.host}:${server.rcon.port}` : "kikapcsolva"}</div></div>
      <div class="field"><label>Ütemezett újraindítás</label><div>${
        server.scheduledRestart.enabled ? `minden nap ${server.scheduledRestart.time}-kor` : "kikapcsolva"
      }</div></div>
      <div class="field"><label>Újraindítás összeomlás után</label><div>${
        server.crashRestart?.enabled
          ? `bekapcsolva (max ${server.crashRestart.maxAttempts} próbálkozás 10 percen belül)`
          : "kikapcsolva"
      }</div></div>
      <div style="display:flex;gap:0.5rem;margin-top:1rem;">
        <button class="btn" id="edit-btn">Szerkesztés</button>
        ${
          isAdmin()
            ? `<button class="btn btn-danger" id="delete-btn" ${server.running ? "disabled title='Állítsd le előbb'" : ""}>Törlés</button>`
            : ""
        }
      </div>
      <div style="margin-top:2rem;padding-top:1.2rem;border-top:1px solid var(--border);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.8rem;">
          <h3 style="margin:0;font-size:1rem;">Mentések</h3>
          <button class="btn btn-primary" id="create-backup-btn">+ Mentés készítése</button>
        </div>
        <div id="backups-list"><div class="empty-state" style="padding:0.5rem 0;">Betöltés…</div></div>
      </div>
    `;
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
          showToast(err instanceof ApiError ? err.message : "Törlés sikertelen", "error");
        }
      }
    });
    content.querySelector<HTMLButtonElement>("#create-backup-btn")!.onclick = async () => {
      const btn = content.querySelector<HTMLButtonElement>("#create-backup-btn")!;
      btn.disabled = true;
      try {
        await api.createBackup(serverId);
        showToast("Mentés elkészült");
        await renderBackupsList(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : "Mentés sikertelen", "error");
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
        listEl.innerHTML = `<div class="empty-state" style="padding:0.5rem 0;">Még nincs mentés.</div>`;
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
            <a class="btn" href="${api.backupDownloadUrl(serverId, b.filename)}">Letöltés</a>
            <button class="btn" data-restore="${b.filename}" ${server?.running ? "disabled title='Állítsd le előbb'" : ""}>Visszaállítás</button>
            <button class="btn btn-danger" data-delete-backup="${b.filename}">Törlés</button>
          </div>
        </div>`
        )
        .join("");

      listEl.querySelectorAll<HTMLButtonElement>("[data-restore]").forEach((btn) => {
        btn.onclick = async () => {
          const filename = btn.dataset.restore!;
          if (
            await confirmModal(
              `Biztosan visszaállítod ezt a mentést? Ez <strong>felülírja</strong> a jelenlegi szerver-mappa tartalmát.`
            )
          ) {
            try {
              await api.restoreBackup(serverId, filename);
              showToast("Visszaállítva");
            } catch (err) {
              showToast(err instanceof ApiError ? err.message : "Visszaállítás sikertelen", "error");
            }
          }
        };
      });
      listEl.querySelectorAll<HTMLButtonElement>("[data-delete-backup]").forEach((btn) => {
        btn.onclick = async () => {
          const filename = btn.dataset.deleteBackup!;
          if (await confirmModal("Biztosan törlöd ezt a mentést?")) {
            try {
              await api.deleteBackup(serverId, filename);
              await renderBackupsList(content);
            } catch (err) {
              showToast(err instanceof ApiError ? err.message : "Törlés sikertelen", "error");
            }
          }
        };
      });
    } catch (err) {
      listEl.innerHTML = `<div class="empty-state" style="padding:0.5rem 0;">${
        err instanceof ApiError ? err.message : "Mentések betöltése sikertelen"
      }</div>`;
    }
  }

  void load().then(startStatsLoop);

  return () => {
    disposed = true;
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
    teardownConsole();
  };
}
