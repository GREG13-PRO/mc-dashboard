import { t } from "./i18n";
import { getSimpleMode } from "./display";
import { permissionsFor } from "../auth-state";

/**
 * Which tabs a server has, who may see them, and how they are grouped.
 *
 * Lifted out of ServerView because the sidebar now draws the menu and the view
 * only draws what is inside it. Two components deciding separately which tabs
 * exist is two chances to disagree - and they would, the moment a permission or
 * the simple-mode list changed in one place.
 */

export type Tab =
  | "console"
  | "files"
  | "plugins"
  | "players"
  | "chat"
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
 * Grouped by task rather than by where the data happens to live: "Content" once
 * held files, plugins, schematics, packs, worlds and the map - six things with
 * nothing in common except that none of them fitted anywhere else, with the
 * three world tabs filed next to the file browser where nobody looking for
 * their map would think to look.
 *
 * The icon is what the sidebar shows when it is collapsed to a rail, so every
 * group needs one that is recognisable at 16px without its label.
 */
export const TAB_GROUPS: { id: string; label: () => string; icon: string; tabs: Tab[] }[] = [
  { id: "overview", label: () => t("attekintes"), icon: "gauge", tabs: ["overview"] },
  { id: "console", label: () => t("konzol"), icon: "terminal", tabs: ["console"] },
  { id: "players", label: () => t("jatekosok"), icon: "users", tabs: ["players", "chat", "access", "luckperms"] },
  { id: "world", label: () => t("vilag"), icon: "globe", tabs: ["map", "worlds", "schematics"] },
  { id: "content", label: () => t("tartalom"), icon: "package", tabs: ["plugins", "content", "files"] },
  {
    id: "maintenance",
    label: () => t("karbantartas"),
    icon: "clock",
    tabs: ["schedules", "macros", "timeline", "performance", "stats"],
  },
  { id: "security", label: () => t("biztonsag"), icon: "shield", tabs: ["security"] },
  {
    id: "settings",
    label: () => t("beallitasok"),
    icon: "sliders",
    tabs: ["settings", "properties", "motd", "gamerules"],
  },
];

/**
 * What a first server actually needs.
 *
 * Twenty-one tabs is the right answer for someone running four servers and the
 * wrong one for someone who has just made their first. Beginner mode is not a
 * different application - every tab here is the same tab - it just stops
 * showing the fifteen that only matter once something has gone wrong.
 */
export const BEGINNER_TABS: Tab[] = ["overview", "console", "players", "chat", "map", "settings", "properties"];

/** The order the tabs are laid out in, which is also the direction the eye moves. */
export const ALL_TABS: Tab[] = TAB_GROUPS.flatMap((group) => group.tabs);

/**
 * Tabs map onto the four server capabilities; the plugin browser writes jars
 * into the server folder, so it rides on "files" rather than adding a fifth
 * permission that would have to be migrated into every existing user record.
 */
export function capabilityFor(tab: Tab): "console" | "files" | "players" | "settings" {
  switch (tab) {
    case "plugins":
    case "content":
    case "schematics":
    case "files":
      return "files";
    case "macros":
    case "console":
    case "overview":
      return "console";
    case "players":
    case "access":
      return "players";
    // Reading chat needs no more right than seeing the server; sending is
    // guarded on the route, which is where the words actually leave.
    case "chat":
      return "players";
    default:
      return "settings";
  }
}

/** The label shown for a single tab. Groups of one reuse the group's label. */
export function tabLabel(tab: Tab): string {
  const single: Partial<Record<Tab, () => string>> = {
    overview: () => t("attekintes"),
    console: () => t("konzol"),
    players: () => t("jatekosok"),
    chat: () => t("cseveges"),
    access: () => t("hozzaferes"),
    luckperms: () => "LuckPerms",
    map: () => t("terkep"),
    worlds: () => t("vilagok"),
    schematics: () => t("schematicek"),
    plugins: () => t("bovitmenyek"),
    content: () => t("csomagok"),
    files: () => t("fajlok"),
    schedules: () => t("utemezesek"),
    macros: () => t("makrok"),
    timeline: () => t("idovonal"),
    performance: () => t("teljesitmeny"),
    stats: () => t("statisztikak"),
    security: () => t("biztonsag"),
    settings: () => t("beallitasok"),
    properties: () => t("tulajdonsagok"),
    motd: () => "MOTD",
    gamerules: () => t("jatekszabalyok"),
  };
  return single[tab]?.() ?? tab;
}

export interface TabVisibility {
  /** Only known after the LuckPerms tab has had a chance to load. */
  luckPermsInstalled: boolean;
  /** Never hidden, whatever the mode - see below. */
  activeTab: Tab | null;
}

/** Every tab this user may open on this server, before mode filtering. */
export function permittedTabs(serverId: string): Tab[] {
  const perms = permissionsFor(serverId);
  return ALL_TABS.filter((tab) => perms[capabilityFor(tab)]);
}

/**
 * The tabs to actually show.
 *
 * A tab you are already looking at is never hidden underneath you: the simple
 * mode switch can be thrown while an advanced tab is open, and dropping the
 * content out from under the cursor is worse than one extra row.
 */
export function visibleTabs(serverId: string, state: TabVisibility): Tab[] {
  return permittedTabs(serverId).filter(
    (tab) =>
      (tab !== "luckperms" || state.luckPermsInstalled) &&
      (!getSimpleMode() || BEGINNER_TABS.includes(tab) || tab === state.activeTab)
  );
}

/** Groups that still have something in them once permissions and mode are applied. */
export function groupsWithTabs(
  serverId: string,
  state: TabVisibility
): { group: (typeof TAB_GROUPS)[number]; tabs: Tab[] }[] {
  const visible = visibleTabs(serverId, state);
  return TAB_GROUPS.map((group) => ({
    group,
    tabs: group.tabs.filter((tab) => visible.includes(tab)),
  })).filter(({ tabs }) => tabs.length > 0);
}
