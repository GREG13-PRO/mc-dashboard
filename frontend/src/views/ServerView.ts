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
import { PLAYER_ACTIONS, type MacroStep, type PlayerAction, type ServerWithStatus } from "../types";

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
  | "settings";
const ALL_TABS: Tab[] = [
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
  "settings",
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
  const capabilityFor = (tab: Tab) =>
    tab === "plugins" || tab === "content" || tab === "schematics"
      ? "files"
      : tab === "macros"
        ? "console"
        : tab === "stats"
          ? "settings"
      : tab === "access"
        ? "players"
        : tab === "luckperms" || tab === "timeline" || tab === "performance"
          ? "settings"
          : tab;
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
      <div class="tabs" role="tablist">
        ${visibleTabs()
          .map(
            (tab) =>
              `<div class="tab ${tab === activeTab ? "active" : ""}" data-tab="${tab}" role="tab"
                    tabindex="${tab === activeTab ? "0" : "-1"}"
                    aria-selected="${tab === activeTab}">${labelFor(tab)}</div>`
          )
          .join("")}
      </div>
      <div id="resource-charts"></div>
      <div class="tab-content" id="tab-content"></div>
    `;

    const tabEls = [...root.querySelectorAll<HTMLDivElement>(".tab")];
    tabEls.forEach((tabEl, index) => {
      const select = () => {
        if (tabEl.dataset.tab === activeTab) return;
        teardownConsole();
        activeTab = tabEl.dataset.tab as Tab;
        renderShell();
      };
      tabEl.onclick = select;
      // Standard tablist keyboard behaviour: arrows move, Enter/Space selects.
      tabEl.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select();
        } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const step = e.key === "ArrowRight" ? 1 : -1;
          tabEls[(index + step + tabEls.length) % tabEls.length]?.focus();
        }
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
      timeline: "Time Machine",
      performance: "Teljesítmény",
      content: "Csomagok",
      macros: "Makrók",
      stats: "Statisztika",
      schematics: "Schematicek",
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

  async function renderSchematics(content: HTMLElement) {
    content.innerHTML = `<div class="empty-state" style="padding:16px;">Betöltés…</div>`;
    let data;
    try {
      data = await api.listSchematics(serverId);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : "Nem sikerült betölteni"
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
            : `<strong style="color:var(--yellow);">Ezen a szerveren nincs WorldEdit, a bepakolás nem fog működni.</strong>`
        }
      </p>

      <div id="schem-drop" style="border:1.5px dashed var(--border-strong);border-radius:var(--radius-md);
           padding:20px;text-align:center;color:var(--text-dim);font-size:12px;margin:16px 0;">
        Húzd ide a .schem fájlt, vagy
        <label style="display:inline;color:var(--accent);cursor:pointer;text-decoration:underline;">
          válassz fájlt<input type="file" id="schem-file" accept=".schem,.schematic" style="display:none;" />
        </label>
      </div>

      <div id="schem-list"></div>
    `;

    const listEl = content.querySelector<HTMLDivElement>("#schem-list")!;
    listEl.innerHTML =
      data.schematics.length === 0
        ? `<div class="empty-state" style="padding:16px;">Még nincs schematic.</div>`
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
          }>Bepakolás</button>
          <a class="btn" href="${api.schematicDownloadUrl(serverId, sc.filename)}">Letöltés</a>
          <button class="btn btn-danger" data-del-schem="${escapeHtml(sc.filename)}">Törlés</button>
        </div>
      </div>`
            )
            .join("");

    const upload = async (file: File) => {
      try {
        await api.uploadSchematic(serverId, file);
        showToast("Feltöltve");
        await renderSchematics(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : "Feltöltés sikertelen", "error");
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
          showToast("Törölve");
          await renderSchematics(content);
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : "Törlés sikertelen", "error");
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
        <h3>Bepakolás</h3>
        <p style="color:var(--text-dim);font-size:12px;">${escapeHtml(filename)}</p>
        <div class="field">
          <label for="ps-player">Játékos (az ő pozíciójába kerül)</label>
          <input id="ps-player" placeholder="pl. Bumimaci" />
        </div>
        <p style="color:var(--text-dim);font-size:12px;margin:-8px 0 12px;">
          Vagy hagyd üresen, és adj meg koordinátákat:
        </p>
        <div style="display:flex;gap:8px;">
          <div class="field" style="flex:1;"><label for="ps-x">X</label><input id="ps-x" type="number" /></div>
          <div class="field" style="flex:1;"><label for="ps-y">Y</label><input id="ps-y" type="number" /></div>
          <div class="field" style="flex:1;"><label for="ps-z">Z</label><input id="ps-z" type="number" /></div>
        </div>
        <div class="field">
          <label for="ps-world">Világ</label>
          <input id="ps-world" value="world" />
        </div>
        <div class="field checkbox-row">
          <input id="ps-air" type="checkbox" />
          <label for="ps-air" style="margin:0">Levegő blokkok kihagyása</label>
        </div>
        <div id="form-error" class="error-text"></div>
        <div class="modal-actions">
          <button class="btn" id="ps-cancel">Mégse</button>
          <button class="btn btn-primary" id="ps-go">Bepakolás</button>
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
          showToast("Parancsok elküldve — nézd meg a konzolt az eredményért");
          close();
        } catch (err) {
          errorEl.textContent = err instanceof ApiError ? err.message : "Nem sikerült";
          btn.disabled = false;
        }
      };
    }
  }

  async function renderStats(content: HTMLElement) {
    content.innerHTML = `<div class="empty-state" style="padding:16px;">Betöltés…</div>`;
    let c;
    try {
      c = await api.getWeeklyStats(serverId);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : "Nem sikerült betölteni"
      )}</div>`;
      return;
    }
    if (disposed) return;

    // A change is only meaningful once last week has something in it; before
    // that the panel says so rather than showing a percentage from nothing.
    const delta = (value: number | null) => {
      if (value === null) return `<span style="color:var(--text-dim);">nincs viszonyítás</span>`;
      const colour = value > 0 ? "var(--green)" : value < 0 ? "var(--red)" : "var(--text-dim)";
      const sign = value > 0 ? "+" : "";
      return `<span style="color:${colour};">${sign}${value}%</span>`;
    };

    const hours = (minutes: number) =>
      minutes >= 60 ? `${(minutes / 60).toFixed(1)} óra` : `${Math.round(minutes)} perc`;

    const maxPeak = Math.max(1, ...c.daily.map((d) => d.peak));

    content.innerHTML = `
      <p style="max-width:640px;color:var(--text-dim);font-size:12px;margin-top:0;">
        A dashboard 5 percenként mintát vesz a futó szerverek játékosszámából, és óránként
        összesíti. A játékidő ezekből becsült játékos-perc, nem a szerver saját statisztikája.
      </p>

      <div style="display:flex;gap:16px;flex-wrap:wrap;margin:20px 0;">
        ${[
          { label: "Csúcs egyidejű játékos", now: c.thisWeek.peak, before: c.lastWeek.peak, change: c.peakChange },
          {
            label: "Átlagos online",
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
          <div style="color:var(--text-dim);font-size:11px;">Becsült játékidő</div>
          <div style="font-size:22px;font-weight:600;">${hours(c.thisWeek.playtimeMinutes)}</div>
          <div style="font-size:12px;">${delta(c.playtimeChange)} <span style="color:var(--text-dim);">múlt hét: ${hours(
            c.lastWeek.playtimeMinutes
          )}</span></div>
        </div>
        <div style="flex:1;min-width:190px;padding:12px;border:0.5px solid var(--border);border-radius:var(--radius-md);">
          <div style="color:var(--text-dim);font-size:11px;">Üzemidő ezen a héten</div>
          <div style="font-size:22px;font-weight:600;">${hours(c.thisWeek.upMinutes)}</div>
          <div style="font-size:12px;color:var(--text-dim);">múlt hét: ${hours(c.lastWeek.upMinutes)}</div>
        </div>
      </div>

      <h4 style="margin-bottom:8px;">Napi csúcs, utolsó 14 nap</h4>
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
    content.innerHTML = `<div class="empty-state" style="padding:16px;">Betöltés…</div>`;
    let data;
    try {
      data = await api.listMacros(serverId);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : "Nem sikerült betölteni"
      )}</div>`;
      return;
    }
    if (disposed) return;
    const running = server?.running ?? false;

    content.innerHTML = `
      <p style="max-width:640px;color:var(--text-dim);font-size:12px;margin-top:0;">
        A makró parancsok sorozata, egy gombra kötve. A felvétel közben a konzolba írt
        parancsok automatikusan lépésekké válnak, a köztük eltelt idő pedig várakozássá.
      </p>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;">
        <button class="btn ${data.recording ? "btn-danger" : ""}" id="mac-record">
          ${data.recording ? "Felvétel leállítása" : "Felvétel indítása"}
        </button>
        <button class="btn btn-primary" id="mac-new">+ Új makró</button>
      </div>

      <div id="mac-list"></div>
    `;

    const list = content.querySelector<HTMLDivElement>("#mac-list")!;
    list.innerHTML =
      data.macros.length === 0
        ? `<div class="empty-state" style="padding:16px;">Még nincs makró.</div>`
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
            <button class="btn btn-primary" data-run="${m.id}" ${running ? "" : "disabled"}>Futtatás</button>
            <button class="btn" data-edit-macro="${m.id}">Szerkesztés</button>
            <button class="btn btn-danger" data-del-macro="${m.id}">Törlés</button>
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
            showToast("Nem rögzült parancs.");
            await renderMacros(content);
            return;
          }
          openMacroEditor(null, steps);
        } else {
          await api.setMacroRecording(serverId, "start");
          showToast("Felvétel elindult — írj parancsokat a konzolba.");
          await renderMacros(content);
        }
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : "Nem sikerült", "error");
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
          showToast(err instanceof ApiError ? err.message : "Nem sikerült", "error");
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
        if (!(await confirmModal("Törlöd ezt a makrót?"))) return;
        try {
          await api.deleteMacro(serverId, btn.dataset.delMacro!);
          showToast("Törölve");
          await renderMacros(content);
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : "Törlés sikertelen", "error");
        }
      };
    });

    function openMacroEditor(macro: { id: string; name: string; description: string } | null, steps: MacroStep[]) {
      const wrap = document.createElement("div");
      let working: MacroStep[] = steps.map((s) => ({ ...s }));

      const draw = () => {
        wrap.innerHTML = `
          <h3>${macro ? "Makró szerkesztése" : "Új makró"}</h3>
          <div class="field">
            <label for="mac-name">Név</label>
            <input id="mac-name" value="${escapeHtml(macro?.name ?? "")}" placeholder="pl. Esemény indítás" />
          </div>
          <div class="field">
            <label for="mac-desc">Leírás</label>
            <input id="mac-desc" value="${escapeHtml(macro?.description ?? "")}" />
          </div>
          <label>Lépések</label>
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
          <button class="btn" id="mac-add-step" style="margin-top:4px;">+ Lépés</button>
          <div id="form-error" class="error-text"></div>
          <div class="modal-actions">
            <button class="btn" id="mac-cancel">Mégse</button>
            <button class="btn btn-primary" id="mac-save">Mentés</button>
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
            errorEl.textContent = "Adj nevet a makrónak.";
            return;
          }
          const cleaned = working.filter((st) => st.command.trim());
          if (cleaned.length === 0) {
            errorEl.textContent = "Legalább egy parancs kell.";
            return;
          }
          try {
            await api.saveMacro(serverId, {
              id: macro?.id,
              name,
              description: wrap.querySelector<HTMLInputElement>("#mac-desc")!.value.trim(),
              steps: cleaned,
            });
            showToast("Makró mentve");
            close();
            await renderMacros(content);
          } catch (err) {
            errorEl.textContent = err instanceof ApiError ? err.message : "Mentés sikertelen";
          }
        };
      };

      const close = openModal(wrap);
      draw();
    }
  }

  async function renderContent(content: HTMLElement) {
    content.innerHTML = `<div class="empty-state" style="padding:16px;">Betöltés…</div>`;
    let rp;
    let dp;
    try {
      [rp, dp] = await Promise.all([api.listPacks(serverId, "resourcepack"), api.listPacks(serverId, "datapack")]);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : "Nem sikerült betölteni"
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
        ? `<div style="color:var(--text-dim);font-size:12px;padding:8px 0;">Nincs feltöltve.</div>`
        : packs
            .map(
              (p) => `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:0.5px solid var(--border);">
        <div style="min-width:0;">
          <div>${escapeHtml(p.filename)}${
            p.active ? ` <span class="pb-badge" style="color:var(--green);">aktív</span>` : ""
          }</div>
          <div style="color:var(--text-dim);font-size:11px;">
            ${(p.sizeBytes / 1024 / 1024).toFixed(1)} MB · SHA-1 ${escapeHtml(p.sha1.slice(0, 12))}…
          </div>
        </div>
        <div style="display:flex;gap:6px;">
          ${
            kind === "resourcepack"
              ? `<button class="btn" data-activate="${escapeHtml(p.filename)}">Kiosztás</button>`
              : ""
          }
          <button class="btn btn-danger" data-del-pack="${kind}|${escapeHtml(p.filename)}">Törlés</button>
        </div>
      </div>`
            )
            .join("");

    content.innerHTML = `
      <h4 style="margin-bottom:4px;">Resource pack</h4>
      <p style="max-width:640px;color:var(--text-dim);font-size:12px;margin-top:0;">
        A resource packet nem a szerver küldi el: csak egy linket és egy SHA-1 ellenőrzőösszeget
        ad a kliensnek, ami maga tölti le. A „Kiosztás” ezt írja be a server.properties-be —
        a címnek a <strong>játékosok gépéről</strong> kell elérhetőnek lennie.
      </p>

      <div class="field" style="max-width:520px;">
        <label for="pack-base">Nyilvános alapcím</label>
        <input id="pack-base" value="${escapeHtml(suggestedBase)}" />
      </div>

      <div class="field checkbox-row">
        <input id="pack-required" type="checkbox" ${rp.status?.required ? "checked" : ""} />
        <label for="pack-required" style="margin:0">Kötelező (aki nem fogadja el, nem tud belépni)</label>
      </div>

      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0;">
        <input type="file" id="rp-file" accept=".zip" style="max-width:280px;" />
        <button class="btn btn-primary" id="rp-upload">Feltöltés</button>
        ${rp.status?.url ? `<button class="btn" id="rp-clear">Kiosztás visszavonása</button>` : ""}
      </div>
      ${
        rp.status?.url
          ? `<div style="color:var(--text-dim);font-size:11px;margin-bottom:8px;">Jelenlegi: ${escapeHtml(
              rp.status.url
            )}</div>`
          : ""
      }
      <div>${packRows(rp.packs, "resourcepack")}</div>

      <h4 style="margin:28px 0 4px;">Datapackek</h4>
      <p style="max-width:640px;color:var(--text-dim);font-size:12px;margin-top:0;">
        A datapackek a világ <code>datapacks</code> mappájába kerülnek, és a szerver maga tölti be
        őket — újraindítás vagy <code>/datapack enable</code> után lépnek életbe.
      </p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0;">
        <input type="file" id="dp-file" accept=".zip" style="max-width:280px;" />
        <button class="btn btn-primary" id="dp-upload">Feltöltés</button>
      </div>
      <div>${packRows(dp.packs, "datapack")}</div>
    `;

    const upload = async (inputId: string, kind: "resourcepack" | "datapack") => {
      const input = content.querySelector<HTMLInputElement>(`#${inputId}`)!;
      const file = input.files?.[0];
      if (!file) {
        showToast("Válassz egy .zip fájlt", "error");
        return;
      }
      try {
        await api.uploadPack(serverId, kind, file);
        showToast("Feltöltve");
        await renderContent(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : "Feltöltés sikertelen", "error");
      }
    };

    content.querySelector<HTMLButtonElement>("#rp-upload")!.onclick = () => void upload("rp-file", "resourcepack");
    content.querySelector<HTMLButtonElement>("#dp-upload")!.onclick = () => void upload("dp-file", "datapack");

    content.querySelector<HTMLInputElement>("#pack-required")!.onchange = async (e) => {
      const el = e.target as HTMLInputElement;
      try {
        await api.setRequireResourcePack(serverId, el.checked);
        showToast(el.checked ? "Kötelezővé téve" : "Már nem kötelező");
      } catch (err) {
        el.checked = !el.checked;
        showToast(err instanceof ApiError ? err.message : "Nem sikerült", "error");
      }
    };

    content.querySelector<HTMLButtonElement>("#rp-clear")?.addEventListener("click", async () => {
      try {
        await api.clearResourcePack(serverId);
        showToast("Kiosztás visszavonva");
        await renderContent(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : "Nem sikerült", "error");
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
          showToast(err instanceof ApiError ? err.message : "Nem sikerült", "error");
        }
      };
    });

    content.querySelectorAll<HTMLButtonElement>("[data-del-pack]").forEach((btn) => {
      btn.onclick = async () => {
        const [kind, filename] = btn.dataset.delPack!.split("|");
        if (!(await confirmModal(`Törlöd ezt a csomagot? <strong>${escapeHtml(filename)}</strong>`))) return;
        try {
          await api.deletePack(serverId, kind as "resourcepack" | "datapack", filename);
          showToast("Törölve");
          await renderContent(content);
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : "Törlés sikertelen", "error");
        }
      };
    });
  }

  async function renderPerformance(content: HTMLElement) {
    const running = server?.running ?? false;
    content.innerHTML = `
      <h4 style="margin-bottom:8px;">Bővítmény-ütközések</h4>
      <div id="perf-conflicts"><div style="color:var(--text-dim);font-size:12px;">Ellenőrzés…</div></div>

      <h4 style="margin:24px 0 8px;">Lag doctor</h4>
      <p style="max-width:620px;color:var(--text-dim);font-size:12px;margin-top:0;">
        Lefuttatja a diagnosztikai parancsokat, és összeszedi, mi tűnik fel. Pontos okhoz
        (melyik entity vagy chunk) a Spark plugin kell — ezt a dashboard nem tudja kiváltani.
      </p>
      <button class="btn" id="perf-lag" ${running ? "" : "disabled"}>Diagnosztika futtatása</button>
      ${running ? "" : `<span style="color:var(--text-dim);font-size:12px;margin-left:8px;">Futnia kell a szervernek.</span>`}
      <div id="perf-lag-out" style="margin-top:12px;"></div>

      <h4 style="margin:24px 0 8px;">JVM paraméterek</h4>
      <div id="perf-jvm"><div style="color:var(--text-dim);font-size:12px;">Betöltés…</div></div>
    `;

    void (async () => {
      const box = content.querySelector<HTMLDivElement>("#perf-conflicts")!;
      try {
        const conflicts = await api.getPluginConflicts(serverId);
        box.innerHTML =
          conflicts.length === 0
            ? `<div style="color:var(--green);font-size:12px;">Nem találtam ismert ütközést.</div>`
            : conflicts
                .map(
                  (c) => `
          <div style="padding:8px 0;border-bottom:0.5px solid var(--border);">
            <div style="color:${c.severity === "conflict" ? "var(--red)" : "var(--yellow)"};font-size:13px;">
              ${c.severity === "conflict" ? "Ütközés" : "Figyelmeztetés"}: ${escapeHtml(c.plugins.join(" + "))}
            </div>
            <div style="color:var(--text-dim);font-size:12px;">${escapeHtml(c.message)}</div>
          </div>`
                )
                .join("");
      } catch (err) {
        box.innerHTML = `<div class="error-text">${escapeHtml(
          err instanceof ApiError ? err.message : "Nem sikerült ellenőrizni"
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
          err instanceof ApiError ? err.message : "Nem sikerült"
        )}</div>`;
      } finally {
        btn.disabled = !(server?.running ?? false);
        btn.textContent = "Diagnosztika futtatása";
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
          <label>Jelenlegi start script</label>
          <pre class="pb-body" style="max-height:90px;">${escapeHtml(rec.currentScript.trim())}</pre>
          <label style="margin-top:12px;">Ajánlott start script</label>
          <pre class="pb-body" style="max-height:150px;">${escapeHtml(rec.script.trim())}</pre>
          <button class="btn btn-primary" id="perf-apply" style="margin-top:8px;" ${
            running ? "disabled title='Állítsd le előbb a szervert'" : ""
          }>Alkalmazás a start scriptre</button>
          <div style="color:var(--text-dim);font-size:11px;margin-top:6px;">
            A régi script .bak kiterjesztéssel megmarad.
          </div>`;

        box.querySelector<HTMLButtonElement>("#perf-apply")?.addEventListener("click", async () => {
          if (!(await confirmModal("Felülírod a start scriptet az ajánlott paraméterekkel?"))) return;
          try {
            await api.applyJvmScript(serverId, rec.script);
            showToast("Start script frissítve");
          } catch (err) {
            showToast(err instanceof ApiError ? err.message : "Nem sikerült", "error");
          }
        });
      } catch (err) {
        box.innerHTML = `<div class="error-text">${escapeHtml(
          err instanceof ApiError ? err.message : "Nem sikerült betölteni"
        )}</div>`;
      }
    })();
  }

  async function renderTimeline(content: HTMLElement) {
    content.innerHTML = `<div class="empty-state" style="padding:16px;">Betöltés…</div>`;
    let data;
    try {
      data = await api.getTimeline(serverId);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : "Nem sikerült betölteni"
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
        <label for="tm-enabled" style="margin:0">Time Machine bekapcsolva</label>
      </div>
      <p style="max-width:620px;color:var(--text-dim);font-size:12px;margin-top:0;">
        Bekapcsolva a dashboard percenként pillanatképet készít a világról, és csak a
        megváltozott régiófájlokat tárolja el. Alapból ki van kapcsolva, mert egy aktív
        világ így is sok helyet tud enni.
      </p>

      <div style="display:flex;gap:16px;flex-wrap:wrap;margin:16px 0;">
        <div class="field" style="max-width:170px;">
          <label for="tm-interval">Gyakoriság (perc)</label>
          <input id="tm-interval" type="number" min="1" max="60" value="${config.intervalMinutes}" />
        </div>
        <div class="field" style="max-width:190px;">
          <label for="tm-max">Megőrzött pillanatképek</label>
          <input id="tm-max" type="number" min="5" max="500" value="${config.maxSnapshots}" />
        </div>
        <div class="field" style="align-self:flex-end;">
          <button class="btn" id="tm-save">Mentés</button>
        </div>
      </div>

      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:16px;">
        <button class="btn" id="tm-now" ${running ? "" : "disabled"}>Pillanatkép most</button>
        <button class="btn btn-danger" id="tm-clear">Előzmények törlése</button>
        <span style="color:var(--text-dim);font-size:12px;">${snapshots.length} pillanatkép · ${mb} MB</span>
      </div>

      ${
        snapshots.length === 0
          ? `<div class="empty-state" style="padding:16px;">Még nincs pillanatkép.</div>`
          : `
        <label for="tm-slider">Időpont</label>
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
            running ? "disabled title='Állítsd le előbb a szervert'" : ""
          }>Visszaállítás erre az időpontra</button>
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
        showToast(err instanceof ApiError ? err.message : "Nem sikerült állítani", "error");
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
        showToast("Beállítás mentve");
        await renderTimeline(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : "Mentés sikertelen", "error");
      }
    };

    content.querySelector<HTMLButtonElement>("#tm-now")!.onclick = async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Készül…";
      try {
        await api.takeSnapshot(serverId);
        showToast("Pillanatkép elkészült");
        await renderTimeline(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : "Nem sikerült", "error");
        btn.disabled = false;
        btn.textContent = "Pillanatkép most";
      }
    };

    content.querySelector<HTMLButtonElement>("#tm-clear")!.onclick = async () => {
      if (!(await confirmModal("Biztosan törlöd az összes pillanatképet? Ez <strong>nem</strong> vonható vissza.")))
        return;
      try {
        await api.clearTimeline(serverId);
        showToast("Előzmények törölve");
        await renderTimeline(content);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : "Törlés sikertelen", "error");
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
          showToast(err instanceof ApiError ? err.message : "Visszaállítás sikertelen", "error");
        }
      };
    }
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

    // Time and weather sit with the player tools: both are live moderation of
    // a running world.
    const worldButtons = [
      { action: "day", label: "Nappal" },
      { action: "night", label: "Éjszaka" },
      { action: "clear", label: "Napos idő" },
      { action: "rain", label: "Eső" },
      { action: "thunder", label: "Vihar" },
      { action: "freeze_time", label: "Idő megállítása" },
      { action: "resume_time", label: "Idő indítása" },
    ];

    content.innerHTML = `
      ${listSection}
      <div style="margin-top:1.2rem;padding-top:1rem;border-top:1px solid var(--border);">
        <label>Világ gyorsvezérlés</label>
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
        <label for="manual-player-name">Gyorsparancs játékosnévvel</label>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">
          <input id="manual-player-name" placeholder="Játékosnév" style="max-width:200px;" ${running ? "" : "disabled"} />
          ${actionButtonsHtml("manual")}
        </div>
        ${running ? "" : `<p style="color:var(--text-dim);font-size:0.8rem;margin-top:0.4rem;">A szervernek futnia kell a parancsok küldéséhez.</p>`}
      </div>
    `;

    content.querySelectorAll<HTMLButtonElement>("[data-world]").forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api.worldAction(serverId, btn.dataset.world!);
          showToast(`${btn.textContent} elküldve`);
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : "Művelet sikertelen", "error");
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
