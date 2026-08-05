import { escapeHtml } from "../lib/escape";
import { t, currentLocale } from "../lib/i18n";
import { icon } from "../lib/icons";
import { jumpTo } from "../lib/navigate";
import type { ServerWithStatus } from "../types";

/**
 * One box that finds any setting in the application.
 *
 * The dashboard has twenty-one tabs, sixty-eight server.properties keys in ten
 * collapsible categories, and forty-odd game rules. Every one of them is two to
 * four clicks from the top and none of them is findable unless you already know
 * which tab it lives under - which is the actual complaint: not that the
 * settings are missing, but that finding one takes minutes of opening tabs.
 *
 * Rearranging the tabs helps someone who has learned the new arrangement. This
 * helps someone who has not, and keeps helping afterwards: `pvp` gets you to
 * PvP whether or not you remember that PvP is a server property rather than a
 * game rule, which is a distinction the game invented and nobody should have to
 * hold in their head.
 *
 * The index is derived from the translation keys rather than written out again.
 * Every property with a `prop_<key>` description is a property worth finding,
 * so the list cannot drift from the one the properties screen shows - and it
 * searches the descriptions too, which is how "how far can you see" finds
 * view-distance.
 */

export interface PaletteEntry {
  title: string;
  /** Where it lives, shown under the title as a trail. */
  where: string;
  /** Matched against, but not shown. */
  keywords: string;
  icon: string;
  run: () => void;
}

/** Tabs, in the order the interface lays them out, with the group they sit in. */
const TAB_INDEX: { tab: string; label: () => string; group: () => string; icon: string; keywords?: string }[] = [
  { tab: "overview", label: () => t("attekintes"), group: () => t("attekintes"), icon: "gauge" },
  { tab: "console", label: () => t("konzol"), group: () => t("konzol"), icon: "terminal", keywords: "log parancs command" },
  { tab: "players", label: () => t("jatekosok"), group: () => t("jatekosok"), icon: "users", keywords: "ban kick op" },
  { tab: "access", label: () => t("hozzaferes"), group: () => t("jatekosok"), icon: "shield", keywords: "whitelist ban op" },
  { tab: "luckperms", label: () => "LuckPerms", group: () => t("jatekosok"), icon: "shield", keywords: "rang group permission jog" },
  { tab: "map", label: () => t("terkep"), group: () => t("vilag"), icon: "globe", keywords: "3d map schematic" },
  { tab: "worlds", label: () => t("vilagok"), group: () => t("vilag"), icon: "globe", keywords: "seed nether end backup" },
  { tab: "schematics", label: () => t("schematicek"), group: () => t("vilag"), icon: "package", keywords: "worldedit epulet build" },
  { tab: "plugins", label: () => t("bovitmenyek"), group: () => t("tartalom"), icon: "package", keywords: "plugin jar spigot" },
  { tab: "content", label: () => t("csomagok"), group: () => t("tartalom"), icon: "package", keywords: "datapack resourcepack mod" },
  { tab: "files", label: () => t("fajlok"), group: () => t("tartalom"), icon: "folder", keywords: "file editor szerkeszto" },
  { tab: "schedules", label: () => t("utemezesek"), group: () => t("karbantartas"), icon: "clock", keywords: "restart backup cron idozites" },
  { tab: "macros", label: () => t("makrok"), group: () => t("karbantartas"), icon: "terminal", keywords: "command sorozat" },
  { tab: "timeline", label: () => t("idovonal"), group: () => t("karbantartas"), icon: "clock", keywords: "history elozmeny" },
  { tab: "performance", label: () => t("teljesitmeny"), group: () => t("karbantartas"), icon: "gauge", keywords: "tps lag ram" },
  { tab: "stats", label: () => t("statisztikak"), group: () => t("karbantartas"), icon: "gauge", keywords: "statistics jatekido" },
  { tab: "security", label: () => t("biztonsag"), group: () => t("biztonsag"), icon: "shield", keywords: "security rcon jelszo password" },
  { tab: "settings", label: () => t("beallitasok"), group: () => t("beallitasok"), icon: "sliders", keywords: "nev mappa folder" },
  { tab: "properties", label: () => t("tulajdonsagok"), group: () => t("beallitasok"), icon: "sliders", keywords: "server.properties" },
  { tab: "motd", label: () => "MOTD", group: () => t("beallitasok"), icon: "sliders", keywords: "uzenet message leiras" },
  { tab: "gamerules", label: () => t("jatekszabalyok"), group: () => t("beallitasok"), icon: "star", keywords: "gamerule" },
];

/**
 * Game rules worth finding by name.
 *
 * Not the whole list: the real one comes from the server's own level.dat and
 * differs by version, so it is only knowable with a server loaded. These are
 * the vanilla names people ask for out loud - the ones a search has to answer
 * or it has not earned the box.
 */
const COMMON_GAME_RULES: { rule: string; keywords: string }[] = [
  { rule: "keepInventory", keywords: "halal death itemek megtartas keep inventory" },
  { rule: "doDaylightCycle", keywords: "ido time nappal ejszaka day night" },
  { rule: "doWeatherCycle", keywords: "eso weather rain vihar storm" },
  { rule: "mobGriefing", keywords: "creeper robbanas explosion rombolas" },
  { rule: "doMobSpawning", keywords: "mob spawn szorny monster" },
  { rule: "doFireTick", keywords: "tuz fire terjedes spread" },
  { rule: "naturalRegeneration", keywords: "elet health regen gyogyulas" },
  { rule: "showDeathMessages", keywords: "halal death uzenet message" },
  { rule: "doInsomnia", keywords: "phantom fantom alvas sleep" },
  { rule: "randomTickSpeed", keywords: "noveny crop growth novekedes" },
  { rule: "playersSleepingPercentage", keywords: "alvas sleep szazalek percent" },
  { rule: "commandBlockOutput", keywords: "command block parancsblokk chat" },
];

/** Every property that has a description, which is every one worth searching. */
function propertyEntries(serverId: string): PaletteEntry[] {
  const locale = currentLocale() as Record<string, string>;
  const out: PaletteEntry[] = [];
  for (const [key, description] of Object.entries(locale)) {
    if (!key.startsWith("prop_")) continue;
    // `prop_view_distance` is `view-distance` in the file. Underscores stand in
    // for both separators, so the key cannot be recovered exactly - but the
    // properties screen searches on text, and either spelling matches there.
    const propertyKey = key.slice("prop_".length).replace(/_/g, "-");
    // The description says what a property does; this says what people call it.
    // "difficulty" is described as "damage from mobs, hunger and starvation",
    // which is accurate and contains none of the words anyone would type -
    // least of all in Hungarian, where the thing is called nehézség.
    const aliases = locale[`psearch_${key.slice("prop_".length)}`] ?? "";
    out.push({
      title: propertyKey,
      where: `${t("beallitasok")} › ${t("tulajdonsagok")}`,
      keywords: `${description} ${aliases} ${propertyKey.replace(/-/g, " ")}`,
      icon: "sliders",
      run: () => jumpTo({ serverId, tab: "properties", focus: propertyKey }),
    });
  }
  return out;
}

function gameRuleEntries(serverId: string): PaletteEntry[] {
  return COMMON_GAME_RULES.map(({ rule, keywords }) => ({
    title: rule,
    where: `${t("beallitasok")} › ${t("jatekszabalyok")}`,
    keywords,
    icon: "star",
    run: () => jumpTo({ serverId, tab: "gamerules", focus: rule }),
  }));
}

function tabEntries(serverId: string): PaletteEntry[] {
  return TAB_INDEX.map((entry) => ({
    title: entry.label(),
    where: entry.group() === entry.label() ? t("fulek") : `${t("fulek")} › ${entry.group()}`,
    keywords: `${entry.tab} ${entry.keywords ?? ""}`,
    icon: entry.icon,
    run: () => jumpTo({ serverId, tab: entry.tab }),
  }));
}

function serverEntries(servers: ServerWithStatus[]): PaletteEntry[] {
  return servers.map((server) => ({
    title: server.name,
    where: t("szerverek"),
    keywords: `${server.id} ${server.running ? "fut running" : "leallitva stopped"}`,
    icon: "server",
    run: () => {
      location.hash = `#/server/${encodeURIComponent(server.id)}`;
    },
  }));
}

/**
 * Strips accents, so "nehez" finds "Nehézség".
 *
 * Not a nicety in this application: the interface is Hungarian, where most of
 * the words worth searching carry an accent, and nobody reaches for the
 * long-press keys while typing into a search box. Without this, "terkep" found
 * nothing and "nehez" found nothing - the two most obvious things a Hungarian
 * speaker would type. Decomposing and dropping the combining marks handles
 * Hungarian, and every other Latin alphabet, without a table.
 */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Folding for a key rather than a sentence: separators go too.
 *
 * Minecraft spells it `white-list` and every human being spells it `whitelist`,
 * so without this the exact thing you asked for ranks below `enforce-whitelist`
 * - which contains the letters you typed and is not what you meant. Applied to
 * the needle as well, so `view-dist` still finds `view-distance`.
 */
function foldKey(text: string): string {
  return fold(text).replace(/[-_.]/g, "");
}

/**
 * Scores a match so the obvious answer comes first.
 *
 * Typing "pvp" has to land on PvP, not on the seven descriptions that mention
 * it in passing. So: the title beginning with what you typed beats the title
 * merely containing it, which beats a hit somewhere in the description.
 */
function score(entry: PaletteEntry, needle: string): number {
  const title = foldKey(entry.title);
  const key = foldKey(needle);
  if (title === key) return 0;
  if (title.startsWith(key)) return 1;
  if (title.includes(key)) return 2;
  if (fold(entry.keywords).includes(needle)) return 3;
  if (fold(entry.where).includes(needle)) return 4;
  return Infinity;
}

const MAX_RESULTS = 12;

export function openCommandPalette(servers: ServerWithStatus[], currentServerId: string | null): void {
  if (document.querySelector(".palette-overlay")) return;

  // Settings belong to a server, so with none in context the palette offers the
  // servers themselves rather than pretending a property has somewhere to go.
  const serverId = currentServerId ?? servers[0]?.id ?? null;
  const entries: PaletteEntry[] = [
    ...serverEntries(servers),
    ...(serverId
      ? [...tabEntries(serverId), ...propertyEntries(serverId), ...gameRuleEntries(serverId)]
      : []),
  ];

  const overlay = document.createElement("div");
  overlay.className = "palette-overlay";
  overlay.innerHTML = `
    <div class="palette" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("kereses"))}">
      <div class="palette-head">
        ${icon("search", 16)}
        <input id="palette-input" type="text" autocomplete="off" spellcheck="false"
               placeholder="${escapeHtml(t("kereses_hely"))}" aria-label="${escapeHtml(t("kereses"))}" />
        <kbd>esc</kbd>
      </div>
      <div class="palette-results" id="palette-results" role="listbox"></div>
      <div class="palette-foot">${escapeHtml(t("kereses_labjegyzet"))}</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector<HTMLInputElement>("#palette-input")!;
  const results = overlay.querySelector<HTMLDivElement>("#palette-results")!;
  let shown: PaletteEntry[] = [];
  let selected = 0;

  function draw() {
    const needle = fold(input.value.trim());
    shown = needle
      ? entries
          .map((entry) => ({ entry, rank: score(entry, needle) }))
          .filter(({ rank }) => rank !== Infinity)
          .sort((a, b) => a.rank - b.rank)
          .slice(0, MAX_RESULTS)
          .map(({ entry }) => entry)
      : // With nothing typed, the tabs are the useful thing to show: they are
        // the map of the application, which is what someone who opened a search
        // box without knowing what to type actually needs.
        entries.filter((entry) => entry.where.startsWith(t("fulek"))).slice(0, MAX_RESULTS);
    selected = Math.min(selected, Math.max(0, shown.length - 1));

    results.innerHTML =
      shown.length === 0
        ? `<p class="palette-empty">${escapeHtml(t("nincs_talalat"))}</p>`
        : shown
            .map(
              (entry, index) => `
                <button class="palette-row ${index === selected ? "selected" : ""}"
                        data-index="${index}" role="option" aria-selected="${index === selected}">
                  <span class="palette-icon">${icon(entry.icon, 15)}</span>
                  <span class="palette-text">
                    <strong>${escapeHtml(entry.title)}</strong>
                    <small>${escapeHtml(entry.where)}</small>
                  </span>
                </button>`
            )
            .join("");

    results.querySelectorAll<HTMLButtonElement>(".palette-row").forEach((row) => {
      row.onclick = () => choose(Number(row.dataset.index));
    });
  }

  function choose(index: number) {
    const entry = shown[index];
    if (!entry) return;
    close();
    entry.run();
  }

  function move(step: number) {
    if (shown.length === 0) return;
    selected = (selected + step + shown.length) % shown.length;
    draw();
    results.querySelector(".palette-row.selected")?.scrollIntoView({ block: "nearest" });
  }

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(selected);
    }
  }

  input.addEventListener("input", () => {
    selected = 0;
    draw();
  });
  // Captured, so the arrow keys reach this before the input's own caret
  // movement swallows them.
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  draw();
  input.focus();
}
