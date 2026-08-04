import { api, ApiError } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { icon } from "../lib/icons";
import { showToast } from "./Toast";
import type { GameRuleDef, GameRuleState } from "../types";

/**
 * The game rules, as switches.
 *
 * Setting one meant typing `/gamerule mob_griefing false` into the console and
 * knowing the name - fifty-odd names nobody keeps in their head, and the names
 * changed in 1.21.9 so half of what anyone remembers is now wrong. Each rule
 * links to the wiki, because a one-line description would not actually settle
 * what mob griefing covers and pretending otherwise is worse than sending
 * people somewhere that will.
 *
 * The list is whatever the server itself has, not a list this app carries, so
 * an old server shows its rules and a new one shows its own.
 *
 * The screen says where its values came from. While the server is up they are
 * read live over RCON; while it is down they come out of level.dat, which is
 * the last state saved and therefore what the world will boot with. Those are
 * different claims and the banner makes clear which one it is.
 */

const CATEGORY_LABEL: Record<string, string> = {
  world: "kat_gr_vilag",
  players: "kat_gr_jatekosok",
  mobs: "kat_gr_mobok",
  drops: "kat_gr_dropok",
  messages: "kat_gr_uzenetek",
  misc: "kat_gr_egyeb",
};

const ORDER = ["world", "players", "mobs", "drops", "messages", "misc"];

/**
 * A readable label from either naming: `keep_inventory` and `keepInventory`
 * both become "keep inventory", so search works the same on both and neither
 * reads as an identifier.
 */
function humanise(name: string): string {
  return name.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

export function renderGameRules(root: HTMLElement, serverId: string): void {
  let state: GameRuleState | null = null;
  let filter = "";

  function matches(def: GameRuleDef): boolean {
    if (!filter) return true;
    return humanise(def.name).toLowerCase().includes(filter.toLowerCase());
  }

  async function apply(def: GameRuleDef, value: string, control: HTMLElement) {
    control.classList.add("busy");
    try {
      const saved = await api.setGameRule(serverId, def.name, value);
      const row = state!.rules.find((rule) => rule.name === def.name)!;
      row.value = saved.value;
      showToast(`${def.name} → ${saved.value}`);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
      // The server refused, so the switch must go back to what is still true
      // rather than sitting there showing a change that did not happen.
      draw();
      return;
    } finally {
      control.classList.remove("busy");
    }
  }

  function draw() {
    const editable = state!.running && state!.source === "rcon";
    const groups = ORDER.map((category) => {
      const defs = state!.rules.filter((d) => d.category === category && matches(d));
      if (defs.length === 0) return "";
      return `
        <div class="gr-group">
          <h4>${t(CATEGORY_LABEL[category] as Parameters<typeof t>[0])}</h4>
          ${defs
            .map((def) => {
              const value = def.value;
              return `
              <div class="gr-row">
                <div class="gr-label">
                  <span class="gr-name">${escapeHtml(humanise(def.name))}</span>
                  <a class="gr-wiki" target="_blank" rel="noopener noreferrer"
                     href="https://minecraft.wiki/w/Game_rule?search=${encodeURIComponent(def.name)}"
                     title="${t("wiki_megnyitasa")}">${icon("globe", 13)}</a>
                  <code>${escapeHtml(def.name)}</code>
                </div>
                <div class="gr-control">
                  ${
                    def.type === "bool"
                      ? `<label class="switch">
                           <input type="checkbox" data-rule="${escapeHtml(def.name)}"
                                  ${value === "true" ? "checked" : ""} ${editable ? "" : "disabled"} />
                           <span class="switch-track"><span class="switch-thumb"></span></span>
                         </label>`
                      : `<input type="number" data-rule="${escapeHtml(def.name)}"
                                value="${escapeHtml(value)}" ${editable ? "" : "disabled"} />`
                  }
                </div>
              </div>`;
            })
            .join("")}
        </div>`;
    }).join("");

    root.innerHTML = `
      <div class="prop-toolbar">
        <input id="gr-search" class="prop-search" placeholder="${t("kereses_szabalyokban")}"
               value="${escapeHtml(filter)}" />
        <button class="btn" id="gr-refresh">${t("frissites")}</button>
      </div>
      <div class="finding ${editable ? "finding-info" : "finding-warning"}">
        <p class="finding-detail">${
          editable
            ? t("gr_forras_rcon")
            : state!.running
              ? t("gr_forras_fajl_fut")
              : t("gr_forras_fajl_all")
        }</p>
        ${state!.warning ? `<p class="finding-advice">${escapeHtml(state!.warning)}</p>` : ""}
      </div>
      ${groups || `<div class="empty-state">${t("nincs_talalat")}</div>`}
    `;

    const search = root.querySelector<HTMLInputElement>("#gr-search")!;
    search.oninput = () => {
      filter = search.value.trim();
      draw();
      const next = root.querySelector<HTMLInputElement>("#gr-search")!;
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    };

    root.querySelector<HTMLButtonElement>("#gr-refresh")!.onclick = () => void load();

    root.querySelectorAll<HTMLInputElement>("[data-rule]").forEach((input) => {
      const def = state!.rules.find((d) => d.name === input.dataset.rule)!;
      // Applied one at a time on change rather than batched behind a Save: each
      // one is a separate server command anyway, and a rule that failed should
      // not take the others down with it.
      input.onchange = () => {
        const value = input.type === "checkbox" ? String(input.checked) : input.value;
        void apply(def, value, input.closest(".gr-row")!);
      };
    });
  }

  async function load() {
    root.innerHTML = `<div class="empty-state" style="padding:16px;">${t("betoltes")}</div>`;
    try {
      state = await api.getGameRules(serverId);
      draw();
    } catch (err) {
      root.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
    }
  }

  void load();
}
