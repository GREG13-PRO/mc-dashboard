import { api, ApiError } from "../api";
import { ConsoleSocket } from "../ws-client";
import { ConsoleLogView } from "../components/ConsoleLog";
import { FileBrowser } from "../components/FileBrowser";
import { confirmModal } from "../components/Modal";
import { showToast } from "../components/Toast";
import { openAddServerModal } from "./AddServerModal";
import { isAdmin, permissionsFor } from "../auth-state";
import { PLAYER_ACTIONS, type PlayerAction, type ServerWithStatus } from "../types";

type Tab = "console" | "files" | "players" | "settings";
const ALL_TABS: Tab[] = ["console", "files", "players", "settings"];

export function renderServerView(
  root: HTMLElement,
  serverId: string,
  callbacks: { onDeleted: () => void; onChanged: () => void }
): () => void {
  const perms = permissionsFor(serverId);
  const availableTabs = ALL_TABS.filter((tab) => perms[tab]);
  let activeTab: Tab = availableTabs[0] ?? "console";
  let server: ServerWithStatus | null = null;
  let disposed = false;

  let terminal: ConsoleLogView | null = null;
  let socket: ConsoleSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const consoleHistory: string[] = [];

  root.innerHTML = `<div class="empty-state">Betöltés…</div>`;

  async function load() {
    try {
      server = await api.getServer(serverId);
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
        ${availableTabs
          .map(
            (tab) =>
              `<div class="tab ${tab === activeTab ? "active" : ""}" data-tab="${tab}">${labelFor(tab)}</div>`
          )
          .join("")}
      </div>
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
  }

  function labelFor(tab: Tab): string {
    return { console: "Konzol", files: "Fájlok", players: "Játékosok", settings: "Beállítások" }[tab];
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
          </div>
        </div>
      `;
      setupConsole();
    } else if (activeTab === "files") {
      new FileBrowser(content, serverId);
    } else if (activeTab === "players") {
      renderPlayers(content);
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

  function teardownConsole() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
    terminal?.dispose();
    terminal = null;
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

  void load();

  return () => {
    disposed = true;
    teardownConsole();
  };
}
