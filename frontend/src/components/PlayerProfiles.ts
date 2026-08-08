import { api, ApiError } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { icon } from "../lib/icons";
import type { PlayerProfile, PlayerProfileSummary } from "../types";

/**
 * Who has been here, and what one of them has been doing.
 *
 * None of this is new data. Minecraft has been writing it to disk since the
 * world was made - play time and distance walked in `world/stats`, first and
 * last login in `world/playerdata`, the names in `usercache.json` - and the
 * dashboard already kept the op, whitelist and ban lists and read addresses out
 * of the logs. It was in five places and on no screen.
 *
 * A list and a detail, in one tab. Selecting a name loads the rest, which keeps
 * the list cheap on a server with a few hundred known players and means the
 * expensive part - reading a stats file and scanning the logs - happens for the
 * one person being looked at.
 */

function duration(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes} ${t("perc_rovid")}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} ${t("ora_rovid")}` : `${hours} ${t("ora_rovid")} ${rest} ${t("perc_rovid")}`;
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function number(value: number | null, suffix = ""): string {
  return value === null ? "—" : `${value.toLocaleString()}${suffix}`;
}

function rows(pairs: [string, string][]): string {
  return pairs
    .map(([label, value]) => `<div class="ov-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");
}

function badges(profile: PlayerProfile): string {
  const marks: string[] = [];
  if (profile.online) marks.push(`<span class="pp-badge pp-online">${escapeHtml(t("online"))}</span>`);
  if (profile.op) marks.push(`<span class="pp-badge pp-op">OP</span>`);
  if (profile.banned) marks.push(`<span class="pp-badge pp-banned">${escapeHtml(t("kitiltva"))}</span>`);
  if (profile.whitelisted) marks.push(`<span class="pp-badge">Whitelist</span>`);
  return marks.join("");
}

export function renderPlayerProfiles(root: HTMLElement, serverId: string): () => void {
  let disposed = false;
  let list: PlayerProfileSummary[] = [];
  let selected: string | null = null;
  let filter = "";

  root.innerHTML = `<div class="empty-state" style="padding:16px;">${t("betoltes")}</div>`;

  function drawShell() {
    const needle = filter.trim().toLowerCase();
    const shown = needle ? list.filter((p) => p.name.toLowerCase().includes(needle)) : list;
    root.innerHTML = `
      <div class="pp-root">
        <div class="pp-list">
          <input id="pp-search" type="search" placeholder="${escapeHtml(t("jatekos_kereses"))}"
                 value="${escapeHtml(filter)}" />
          <div class="pp-names" id="pp-names">
            ${
              shown.length === 0
                ? `<p class="empty-state" style="padding:12px;">${escapeHtml(
                    list.length === 0 ? t("nincs_ismert_jatekos") : t("nincs_talalat")
                  )}</p>`
                : shown
                    .map(
                      (p) => `
                      <button class="pp-name ${p.name === selected ? "active" : ""}" data-name="${escapeHtml(p.name)}">
                        <span class="pp-name-top">
                          <span class="status-dot ${p.online ? "running" : "stopped"}"></span>
                          <strong>${escapeHtml(p.name)}</strong>
                          ${p.op ? `<span class="pp-badge pp-op">OP</span>` : ""}
                          ${p.banned ? `<span class="pp-badge pp-banned">${escapeHtml(t("kitiltva"))}</span>` : ""}
                        </span>
                        <small>${escapeHtml(duration(p.playTimeMinutes))} · ${escapeHtml(
                          p.lastPlayed ? new Date(p.lastPlayed).toLocaleDateString() : "—"
                        )}</small>
                      </button>`
                    )
                    .join("")
            }
          </div>
        </div>
        <div class="pp-detail" id="pp-detail">
          <p class="empty-state" style="padding:16px;">${escapeHtml(t("valassz_jatekost"))}</p>
        </div>
      </div>
    `;

    const search = root.querySelector<HTMLInputElement>("#pp-search")!;
    search.oninput = () => {
      filter = search.value;
      const at = search.selectionStart;
      drawShell();
      // Redrawing the list rebuilds the box it was typed into, so the caret has
      // to be put back or every second character lands at the start.
      const again = root.querySelector<HTMLInputElement>("#pp-search")!;
      again.focus();
      if (at !== null) again.setSelectionRange(at, at);
      if (selected) void open(selected);
    };
    root.querySelectorAll<HTMLButtonElement>(".pp-name").forEach((el) => {
      el.onclick = () => void open(el.dataset.name!);
    });
    if (selected) void open(selected);
  }

  function drawDetail(profile: PlayerProfile) {
    const panel = root.querySelector<HTMLDivElement>("#pp-detail");
    if (!panel) return;
    const s = profile.stats;
    panel.innerHTML = `
      <div class="pp-head">
        <h3>${escapeHtml(profile.name)}</h3>
        ${badges(profile)}
      </div>
      <code class="pp-uuid">${escapeHtml(profile.uuid)}</code>

      <div class="ov-grid pp-grid">
        <div class="ov-card">
          <div class="ov-head"><span class="ov-icon">${icon("clock", 15)}</span><h4>${escapeHtml(t("jelenlet"))}</h4></div>
          ${rows([
            [t("jatekido"), duration(s.playTimeMinutes)],
            [t("eloszor_jart_itt"), when(profile.firstPlayed)],
            [t("utoljara_jatszva"), when(profile.lastPlayed)],
          ])}
        </div>
        <div class="ov-card">
          <div class="ov-head"><span class="ov-icon">${icon("users", 15)}</span><h4>${escapeHtml(t("allapot"))}</h4></div>
          ${rows([
            [t("jatekmod"), profile.gamemode ?? "—"],
            [t("elet"), profile.health === null ? "—" : `${profile.health} / 20`],
            [t("ehseg"), profile.food === null ? "—" : `${profile.food} / 20`],
            ["XP", number(profile.xpLevel)],
            [
              t("utolso_helye"),
              profile.position
                ? `${profile.position.x}, ${profile.position.y}, ${profile.position.z} (${profile.position.dimension})`
                : "—",
            ],
          ])}
        </div>
        <div class="ov-card">
          <div class="ov-head"><span class="ov-icon">${icon("gauge", 15)}</span><h4>${escapeHtml(t("statisztikak"))}</h4></div>
          ${rows([
            [t("halalok"), number(s.deaths)],
            [t("megolt_szornyek"), number(s.mobKills)],
            [t("megolt_jatekosok"), number(s.playerKills)],
            [t("megtett_ut"), s.walked === null ? "—" : `${(s.walked / 1000).toFixed(1)} km`],
            [t("okozott_sebzes"), number(s.damageDealt)],
            [t("elszenvedett_sebzes"), number(s.damageTaken)],
            [t("ugrasok"), number(s.jumps)],
          ])}
        </div>
        <div class="ov-card">
          <div class="ov-head"><span class="ov-icon">${icon("shield", 15)}</span><h4>${escapeHtml(t("cimek"))}</h4></div>
          ${
            profile.addresses.length > 0
              ? rows([
                  [t("belepesek"), number(profile.logins)],
                  ...profile.addresses.map((ip) => [t("cim"), ip] as [string, string]),
                ])
              : `<p class="ov-note">${escapeHtml(
                  t("nincs_belepes_a_naplokban").replace("{n}", String(profile.addressLogsRead))
                )}</p>`
          }
        </div>
      </div>

      <div class="ov-card pp-messages">
        <div class="ov-head"><span class="ov-icon">${icon("terminal", 15)}</span><h4>${escapeHtml(t("cseveges"))}</h4></div>
        ${
          profile.messages.length === 0
            ? `<p class="ov-note">${escapeHtml(t("nincs_uzenete"))}</p>`
            : profile.messages
                .map(
                  (m) => `<div class="chat-line chat-${m.kind}">
                            <span class="chat-time">${escapeHtml(m.at)}</span>
                            <span class="chat-body"><span class="chat-text">${escapeHtml(m.text)}</span></span>
                          </div>`
                )
                .join("")
        }
      </div>
    `;
  }

  async function open(name: string) {
    selected = name;
    root.querySelectorAll<HTMLButtonElement>(".pp-name").forEach((el) => {
      el.classList.toggle("active", el.dataset.name === name);
    });
    const panel = root.querySelector<HTMLDivElement>("#pp-detail");
    if (panel) panel.innerHTML = `<p class="empty-state" style="padding:16px;">${t("betoltes")}</p>`;
    try {
      const profile = await api.getPlayerProfile(serverId, name);
      if (!disposed && selected === name) drawDetail(profile);
    } catch (err) {
      if (disposed || !panel) return;
      panel.innerHTML = `<p class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</p>`;
    }
  }

  void (async () => {
    try {
      list = await api.getPlayerProfiles(serverId);
      if (!disposed) drawShell();
    } catch (err) {
      if (disposed) return;
      root.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
    }
  })();

  return () => {
    disposed = true;
  };
}
