import { api, ApiError } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { icon } from "../lib/icons";
import { showToast } from "../components/Toast";
import type { PropertyCategory, PropertyDef, ServerProperties } from "../types";
import { getSimpleMode } from "../lib/display";

/**
 * server.properties as a form rather than a text file.
 *
 * Until now the only way to change `view-distance` through this dashboard was
 * to open the raw file in the editor, find the line, and not make a typo -
 * which is how a server ends up refusing to start over a stray character. Every
 * key the schema knows gets the control its type deserves, and the server
 * validates the range again on save, because a client is not a place to enforce
 * anything.
 *
 * Keys the schema has never seen are not hidden: they land in Advanced as text,
 * and they round-trip. A mod's property disappearing on first save would be
 * this screen quietly eating somebody's configuration.
 */

const CATEGORY_ORDER: PropertyCategory[] = [
  "info",
  "gameplay",
  "world",
  "players",
  "network",
  "performance",
  "security",
  "rcon",
  "resourcepack",
  "advanced",
];

const CATEGORY_ICON: Record<PropertyCategory, string> = {
  info: "server",
  gameplay: "star",
  world: "globe",
  players: "users",
  network: "globe",
  performance: "gauge",
  security: "shield",
  rcon: "terminal",
  resourcepack: "download",
  advanced: "sliders",
};

function categoryLabel(category: PropertyCategory): string {
  return t(
    (
      {
        info: "kat_info",
        gameplay: "kat_jatekmenet",
        world: "kat_vilag",
        players: "kat_jatekosok",
        network: "kat_halozat",
        performance: "kat_teljesitmeny",
        security: "kat_biztonsag",
        rcon: "kat_rcon",
        resourcepack: "kat_resourcepack",
        advanced: "kat_halado",
      } as const
    )[category]
  );
}

/**
 * The one-line explanation under a key, when there is one.
 *
 * Looked up by key rather than declared per property so an unlabelled key is a
 * missing sentence, not a missing screen: the control still works, it just has
 * nothing under it.
 */
function describe(key: string): string {
  const label = `prop_${key.replace(/[.-]/g, "_")}`;
  const text = t(label as Parameters<typeof t>[0]);
  // t() falls back to the key itself when there is no translation, which is the
  // signal that this property has no description yet.
  return text === label ? "" : text;
}

function control(def: PropertyDef, value: string): string {
  const id = `prop-${def.key}`;
  const name = escapeHtml(def.key);
  if (def.type === "bool") {
    return `<label class="switch">
      <input type="checkbox" id="${id}" data-prop="${name}" ${value === "true" ? "checked" : ""} />
      <span class="switch-track"><span class="switch-thumb"></span></span>
    </label>`;
  }
  if (def.type === "enum") {
    return `<select id="${id}" data-prop="${name}">
      ${def
        .options!.map(
          (option) =>
            `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(
              option
            )}</option>`
        )
        .join("")}
    </select>`;
  }
  if (def.type === "int") {
    return `<input type="number" id="${id}" data-prop="${name}" value="${escapeHtml(value)}"
      ${def.min !== undefined ? `min="${def.min}"` : ""} ${def.max !== undefined ? `max="${def.max}"` : ""} />`;
  }
  return `<input type="${def.secret ? "password" : "text"}" id="${id}" data-prop="${name}"
    value="${escapeHtml(value)}" ${def.secret ? `placeholder="${t("valtozatlan")}"` : ""} />`;
}

/**
 * The keys a first server is actually set up with.
 *
 * Chosen by what a beginner has a reason to change on day one, not by which
 * are most interesting: difficulty and gamemode because that is what the
 * server feels like, the player limit and whitelist because that is who gets
 * in, PvP and the MOTD because people ask for them by name, view distance
 * because it is the one performance dial worth touching. The other fifty-odd
 * are one switch away and searchable from anywhere.
 */
const BEGINNER_KEYS = new Set([
  "motd",
  "difficulty",
  "gamemode",
  "pvp",
  "max-players",
  "white-list",
  "online-mode",
  "spawn-protection",
  "view-distance",
  "server-port",
  "hardcore",
  "allow-nether",
]);

export function renderPropertiesEditor(root: HTMLElement, serverId: string, focusKey?: string): void {
  let data: ServerProperties | null = null;
  // A jump from the search box arrives as a filter, which is the honest way to
  // show one property: the box says what is being shown, and clearing it puts
  // the rest of the file back.
  let filter = focusKey ?? "";
  let open: PropertyCategory | null = null;
  /**
   * Keys the user has actually changed, and the value they changed them to.
   *
   * Saving used to send every control on screen, which meant a key absent from
   * the file got written with whatever the control happened to show. For a
   * missing `pvp` that was `false` - and Minecraft's default is `true`, so
   * opening this screen and pressing save turned PvP off on a server nobody
   * had touched. Nothing is written now unless it was either already in the
   * file or deliberately edited here.
   */
  const edited = new Map<string, string>();

  /** Every property, including the ones only the file knows about. */
  function grouped(): Map<PropertyCategory, PropertyDef[]> {
    const out = new Map<PropertyCategory, PropertyDef[]>();
    for (const category of CATEGORY_ORDER) out.set(category, []);
    for (const def of data!.definitions) out.get(def.category)!.push(def);
    for (const key of data!.unknown) {
      out.get("advanced")!.push({ key, category: "advanced", type: "string", fallback: "" });
    }
    return out;
  }

  function matches(def: PropertyDef): boolean {
    // Beginner mode narrows the file to the dozen keys a first server is
    // actually configured with. Searching escapes it on purpose: someone who
    // types a key name has already told you they know it exists, and hiding it
    // from them would be the search lying about the file.
    if (!filter && getSimpleMode() && !BEGINNER_KEYS.has(def.key)) return false;
    if (!filter) return true;
    const needle = filter.toLowerCase();
    return def.key.toLowerCase().includes(needle) || describe(def.key).toLowerCase().includes(needle);
  }

  function draw() {
    const groups = grouped();
    // A search is a question about the whole file, so it opens every section
    // that can answer it rather than making the user hunt through ten headers.
    const sections = CATEGORY_ORDER.map((category) => {
      const defs = groups.get(category)!.filter(matches);
      if (defs.length === 0) return "";
      const expanded = filter !== "" || open === category;
      return `
        <section class="prop-group ${expanded ? "open" : ""}" data-category="${category}">
          <button class="prop-group-head" data-toggle="${category}" aria-expanded="${expanded}">
            <span class="prop-group-icon">${icon(CATEGORY_ICON[category], 16)}</span>
            <span class="prop-group-title">${escapeHtml(categoryLabel(category))}</span>
            <span class="prop-count">${defs.length}</span>
            <span class="prop-chevron">${icon("chevronDown", 14)}</span>
          </button>
          <div class="prop-rows">
            ${defs
              .map((def) => {
                // Edited beats the file, and the file beats Minecraft's default
                // - the last of those is what a key missing from the file
                // actually does, so showing anything else would be a lie.
                const inFile = data!.values[def.key];
                const value = edited.get(def.key) ?? inFile ?? def.fallback ?? "";
                const description = describe(def.key);
                const isDefault = inFile === undefined && !edited.has(def.key);
                return `
                <div class="prop-row">
                  <div class="prop-label">
                    <code>${escapeHtml(def.key)}</code>
                    ${def.restart ? `<span class="prop-badge">${t("ujrainditas_utan")}</span>` : ""}
                    ${isDefault ? `<span class="prop-badge prop-badge-quiet">${t("alapertelmezett")}</span>` : ""}
                    ${description ? `<p>${escapeHtml(description)}</p>` : ""}
                  </div>
                  <div class="prop-control">${control(def, value)}</div>
                </div>`;
              })
              .join("")}
          </div>
        </section>`;
    }).join("");

    root.innerHTML = `
      <div class="prop-toolbar">
        <input id="prop-search" class="prop-search" placeholder="${t("kereses_beallitasokban")}"
               value="${escapeHtml(filter)}" />
        <button class="btn btn-primary" id="prop-save">${t("mentes")}</button>
      </div>
      <p class="finding-advice" style="margin:0 0 12px;">${t("properties_leiras")}</p>
      ${sections || `<div class="empty-state">${t("nincs_talalat")}</div>`}
    `;

    const search = root.querySelector<HTMLInputElement>("#prop-search")!;
    search.oninput = () => {
      filter = search.value.trim();
      draw();
      // Redrawing replaces the input, so the caret has to be put back or
      // typing a second character means clicking the box again.
      const next = root.querySelector<HTMLInputElement>("#prop-search")!;
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    };

    root.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((button) => {
      button.onclick = () => {
        const category = button.dataset.toggle as PropertyCategory;
        open = open === category ? null : category;
        draw();
      };
    });

    const save = root.querySelector<HTMLButtonElement>("#prop-save")!;
    save.disabled = edited.size === 0;

    // Recorded as it happens rather than read off the DOM at save time: a
    // filtered or collapsed view has most controls detached, and a key is only
    // safe to write once somebody has said what it should be.
    root.querySelectorAll<HTMLElement>("[data-prop]").forEach((input) => {
      const record = () => {
        edited.set(
          input.dataset.prop!,
          input instanceof HTMLInputElement && input.type === "checkbox"
            ? String(input.checked)
            : (input as HTMLInputElement | HTMLSelectElement).value
        );
        save.disabled = false;
      };
      input.addEventListener("change", record);
      input.addEventListener("input", record);
    });

    save.onclick = async () => {
      // The file's own keys are rewritten identically, which is harmless and
      // keeps the write a single whole-file pass. What is never sent is a key
      // that is neither in the file nor edited.
      const values: Record<string, string> = { ...data!.values };
      for (const [key, value] of edited) values[key] = value;
      try {
        const saved = await api.saveProperties(serverId, values);
        data = { ...data!, values: { ...saved.values } };
        edited.clear();
        showToast(`${t("mentve")}: ${saved.saved} ${t("beallitas_db")}`);
        draw();
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("mentes_sikertelen"), "error");
      }
    };
  }

  root.innerHTML = `<div class="empty-state" style="padding:16px;">${t("betoltes")}</div>`;
  void api
    .getProperties(serverId)
    .then((loaded) => {
      data = loaded;
      draw();
    })
    .catch((err) => {
      root.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
    });
}
