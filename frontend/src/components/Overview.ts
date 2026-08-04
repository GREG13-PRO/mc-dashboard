import { api, ApiError } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { icon } from "../lib/icons";
import { sparklineSvg } from "./Sparkline";
import { countUp } from "../lib/motion";
import type { ServerOverview } from "../types";

/**
 * How this server is doing, on one screen.
 *
 * All of it existed already, scattered: the CPU graph on the console tab, the
 * version in the security report, the seed under Worlds, the disk nowhere at
 * all. Finding out whether anything was wrong meant a tour of six tabs.
 *
 * Refreshed on a timer while it is open, and the disposer stops that - the
 * server view had no polling of its own, so a tab left open used to go stale
 * without saying so.
 */

const REFRESH_MS = 5000;

function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} ${t("nap_rovid")} ${h} ${t("ora_rovid")}`;
  if (h > 0) return `${h} ${t("ora_rovid")} ${m} ${t("perc_rovid")}`;
  return `${m} ${t("perc_rovid")}`;
}

function bytes(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} MB`;
  return `${(value / 1024).toFixed(0)} kB`;
}

function mb(value: number | null): string {
  if (value === null) return "—";
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value} MB`;
}

function yesNo(value: boolean | null): string {
  if (value === null) return "—";
  return value ? t("igen") : t("nem");
}

function rows(pairs: [string, string][]): string {
  return pairs
    .map(
      ([label, value]) =>
        `<div class="ov-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
    )
    .join("");
}

function card(iconName: string, title: string, body: string, extraClass = ""): string {
  return `
    <div class="ov-card ${extraClass}">
      <div class="ov-head">
        <span class="ov-icon">${icon(iconName, 15)}</span>
        <h4>${escapeHtml(title)}</h4>
      </div>
      ${body}
    </div>`;
}

export function renderOverview(root: HTMLElement, serverId: string): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  /**
   * The previous reading of each big figure.
   *
   * The card is redrawn whole every five seconds, so without remembering the
   * old value there is nothing to count from. A CPU number jumping 3 -> 47 -> 5
   * reads as flicker; the same values walked over a third of a second read as a
   * measurement moving.
   */
  const lastBig = new Map<string, number>();

  function draw(data: ServerOverview) {
    const cpuSeries = data.history.map((s) => s.cpuPercent);
    const memSeries = data.history.map((s) => s.memoryMb);
    // Player counts are null while RCON is off; a gap is honest, a zero is not.
    const playerSeries = data.history
      .filter((s) => s.playersOnline !== null)
      .map((s) => s.playersOnline!);

    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    const yellow = getComputedStyle(document.documentElement).getPropertyValue("--yellow").trim();
    const green = getComputedStyle(document.documentElement).getPropertyValue("--green").trim();

    root.innerHTML = `
      <div class="ov-grid">
        ${card(
          "gauge",
          "CPU",
          `<div class="ov-big" data-big="cpu">${data.resources ? `${data.resources.cpuPercent.toFixed(0)}%` : "—"}</div>
           ${sparklineSvg({ values: cpuSeries, color: accent, width: 300, height: 52 })}
           <p class="ov-note">${t("utolso_5_perc")}</p>`
        )}
        ${card(
          "server",
          t("memoria"),
          `<div class="ov-big" data-big="mem">${data.resources ? mb(data.resources.memoryMb) : "—"}</div>
           ${sparklineSvg({ values: memSeries, color: yellow, width: 300, height: 52 })}
           <p class="ov-note">${t("utolso_5_perc")}</p>`
        )}
        ${card(
          "users",
          t("jatekosok"),
          `<div class="ov-big">${
            data.players ? `${data.players.online}/${data.players.max}` : "—"
          }</div>
           ${sparklineSvg({
             values: playerSeries,
             color: green,
             width: 300,
             height: 52,
             max: data.players?.max,
           })}
           <p class="ov-note">${
             playerSeries.length === 0 ? t("rcon_nelkul_nincs_jatekosadat") : t("utolso_5_perc")
           }</p>`
        )}
        ${card(
          "home",
          t("uzemido"),
          `<div class="ov-big">${
            data.running ? duration(data.resources?.uptimeSeconds ?? null) : t("leallitva")
          }</div>
           <p class="ov-note">${
             data.nextSchedule
               ? `${t("kovetkezo")}: ${escapeHtml(data.nextSchedule.name)} — ${new Date(
                   data.nextSchedule.when
                 ).toLocaleString()}`
               : t("nincs_utemezes")
           }</p>`
        )}

        ${card(
          "sliders",
          t("szerver_adatai"),
          rows([
            [t("verzio"), data.server.version ?? "—"],
            [t("port"), data.server.port !== null ? String(data.server.port) : "—"],
            [t("cim"), data.server.ip || t("minden_cim")],
            [t("max_jatekos"), data.server.maxPlayers !== null ? String(data.server.maxPlayers) : "—"],
            ["online-mode", yesNo(data.server.onlineMode)],
          ])
        )}
        ${
          data.world
            ? card(
                "globe",
                t("vilag"),
                rows([
                  [t("nev"), data.world.name],
                  ["seed", data.world.seed ?? "—"],
                  [t("meret"), bytes(data.world.sizeBytes)],
                  [t("tipus"), (data.world.type ?? "—").replace("minecraft:", "")],
                  [
                    t("utoljara_jatszva"),
                    data.world.lastPlayed ? new Date(data.world.lastPlayed).toLocaleString() : "—",
                  ],
                ])
              )
            : card("globe", t("vilag"), `<p class="ov-note">${t("nincs_vilag")}</p>`)
        }
        ${card(
          "star",
          t("jatekbeallitasok"),
          rows([
            [t("nehezseg"), data.game.difficulty ?? "—"],
            [t("jatekmod"), data.game.gamemode ?? "—"],
            ["PvP", yesNo(data.game.pvp)],
            ["Whitelist", yesNo(data.game.whitelist)],
            ["Hardcore", yesNo(data.game.hardcore)],
            [
              t("latotav"),
              data.game.viewDistance !== null
                ? `${data.game.viewDistance} / ${data.game.simulationDistance ?? "—"}`
                : "—",
            ],
          ])
        )}
        ${card(
          "terminal",
          t("gep"),
          rows([
            [t("gepnev"), data.system.hostname],
            [t("rendszer"), `${data.system.platform} ${data.system.release}`],
            ["CPU", `${data.system.cpuCount} × ${data.system.cpuModel ?? "—"}`],
            [
              t("memoria"),
              `${mb(data.system.totalMemoryMb - data.system.freeMemoryMb)} / ${mb(
                data.system.totalMemoryMb
              )}`,
            ],
            [t("terheles"), data.system.loadAverage.map((n) => n.toFixed(2)).join("  ")],
            [
              t("lemez"),
              data.system.diskFreeMb !== null
                ? `${mb(data.system.diskFreeMb)} ${t("szabad")} / ${mb(data.system.diskTotalMb)}`
                : "—",
            ],
            [t("gep_uzemido"), duration(data.system.uptimeSeconds)],
          ])
        )}
      </div>
    `;

    // Walked, not snapped. Only the two that move continuously - the player
    // count steps in whole players and reads better changing outright.
    const walk = (key: string, value: number | null, format: (n: number) => string) => {
      const el = root.querySelector<HTMLElement>(`[data-big="${key}"]`);
      if (!el || value === null) {
        lastBig.delete(key);
        return;
      }
      const from = lastBig.get(key);
      if (from !== undefined) countUp(el, from, value, format);
      lastBig.set(key, value);
    };
    walk("cpu", data.resources?.cpuPercent ?? null, (n) => `${n.toFixed(0)}%`);
    walk("mem", data.resources?.memoryMb ?? null, (n) => mb(Math.round(n)));
  }

  async function load() {
    if (disposed) return;
    try {
      const data = await api.getOverview(serverId);
      if (!disposed) draw(data);
    } catch (err) {
      if (disposed) return;
      root.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
    }
  }

  root.innerHTML = `<div class="empty-state" style="padding:16px;">${t("betoltes")}</div>`;
  void load();
  timer = setInterval(() => void load(), REFRESH_MS);

  return () => {
    disposed = true;
    if (timer) clearInterval(timer);
  };
}
