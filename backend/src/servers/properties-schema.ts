/**
 * What each server.properties key is, so the dashboard can offer a control
 * instead of a text box.
 *
 * The file is sixty-odd lines of `key=value` with no types in it: `pvp=true`
 * and `motd=true` look identical to a parser, and today the only way to change
 * either through this dashboard is to open the raw file in the editor and hope.
 * A checkbox for a boolean and a bounded number for view-distance is the whole
 * point of the screen.
 *
 * This lives on the server because it is also the validation. A client that
 * says `view-distance=9999` or `difficulty=banana` is not a client this file
 * trusts - Minecraft would refuse to start, and a dashboard that can put a
 * server into a state where it will not boot is worse than no editor.
 *
 * Keys not listed here are still shown and still editable, as free text under
 * "Advanced". Minecraft gains properties every few versions and mods add their
 * own; silently dropping what it does not recognise would eat somebody's
 * configuration on the first save.
 */

export const CATEGORIES = [
  "gameplay",
  "world",
  "players",
  "network",
  "performance",
  "security",
  "rcon",
  "resourcepack",
  "info",
  "advanced",
] as const;

export type PropertyCategory = (typeof CATEGORIES)[number];

export interface PropertyDef {
  key: string;
  category: PropertyCategory;
  type: "bool" | "int" | "string" | "enum";
  options?: string[];
  min?: number;
  max?: number;
  /** Never sent to the browser, and only written when a new value is given. */
  secret?: boolean;
  /** Takes effect only on the next start, which the UI says out loud. */
  restart?: boolean;
  /**
   * What Minecraft uses when the key is absent from the file.
   *
   * Not cosmetic. A missing `pvp` line means PvP is on, but a checkbox with
   * nothing behind it renders as off - and the first version of this screen
   * then wrote `pvp=false` on save and silently disabled it. Showing the real
   * default is half the fix; only writing keys the user actually touched is
   * the other half.
   */
  fallback: string;
}

const DEFS: PropertyDef[] = [
  // Gameplay.
  { key: "gamemode", category: "gameplay", type: "enum", options: ["survival", "creative", "adventure", "spectator"], fallback: "survival" },
  { key: "force-gamemode", category: "gameplay", type: "bool", fallback: "false" },
  { key: "difficulty", category: "gameplay", type: "enum", options: ["peaceful", "easy", "normal", "hard"], fallback: "easy" },
  { key: "hardcore", category: "gameplay", type: "bool", restart: true, fallback: "false" },
  { key: "pvp", category: "gameplay", type: "bool", fallback: "true" },
  { key: "allow-flight", category: "gameplay", type: "bool", fallback: "false" },
  { key: "spawn-monsters", category: "gameplay", type: "bool", fallback: "true" },
  { key: "spawn-npcs", category: "gameplay", type: "bool", fallback: "true" },
  { key: "spawn-animals", category: "gameplay", type: "bool", fallback: "true" },
  { key: "enable-command-block", category: "gameplay", type: "bool", restart: true, fallback: "false" },

  // World.
  { key: "level-name", category: "world", type: "string", restart: true, fallback: "world" },
  { key: "level-seed", category: "world", type: "string", restart: true, fallback: "" },
  { key: "level-type", category: "world", type: "string", restart: true, fallback: "minecraft:normal" },
  { key: "generator-settings", category: "world", type: "string", restart: true, fallback: "{}" },
  { key: "generate-structures", category: "world", type: "bool", restart: true, fallback: "true" },
  { key: "allow-nether", category: "world", type: "bool", restart: true, fallback: "true" },
  { key: "max-world-size", category: "world", type: "int", min: 1, max: 29999984, restart: true, fallback: "29999984" },
  { key: "spawn-protection", category: "world", type: "int", min: 0, max: 1000, fallback: "16" },

  // Players.
  { key: "max-players", category: "players", type: "int", min: 1, max: 100000, fallback: "20" },
  { key: "white-list", category: "players", type: "bool", fallback: "false" },
  { key: "enforce-whitelist", category: "players", type: "bool", fallback: "false" },
  { key: "player-idle-timeout", category: "players", type: "int", min: 0, max: 525600, fallback: "0" },
  { key: "op-permission-level", category: "players", type: "int", min: 0, max: 4, fallback: "4" },
  { key: "function-permission-level", category: "players", type: "int", min: 0, max: 4, fallback: "2" },

  // Network.
  { key: "server-ip", category: "network", type: "string", restart: true, fallback: "" },
  { key: "server-port", category: "network", type: "int", min: 1, max: 65535, restart: true, fallback: "25565" },
  { key: "online-mode", category: "network", type: "bool", restart: true, fallback: "true" },
  { key: "prevent-proxy-connections", category: "network", type: "bool", fallback: "false" },
  { key: "network-compression-threshold", category: "network", type: "int", min: -1, max: 65535, fallback: "256" },
  { key: "enable-status", category: "network", type: "bool", fallback: "true" },
  { key: "hide-online-players", category: "network", type: "bool", fallback: "false" },
  { key: "accepts-transfers", category: "network", type: "bool", fallback: "false" },

  // Performance.
  { key: "view-distance", category: "performance", type: "int", min: 2, max: 32, fallback: "10" },
  { key: "simulation-distance", category: "performance", type: "int", min: 2, max: 32, fallback: "10" },
  { key: "entity-broadcast-range-percentage", category: "performance", type: "int", min: 10, max: 1000, fallback: "100" },
  { key: "max-tick-time", category: "performance", type: "int", min: -1, max: 3600000, fallback: "60000" },
  { key: "max-chained-neighbor-updates", category: "performance", type: "int", min: -1, max: 10000000, fallback: "1000000" },
  { key: "sync-chunk-writes", category: "performance", type: "bool", restart: true, fallback: "true" },
  { key: "use-native-transport", category: "performance", type: "bool", restart: true, fallback: "true" },
  { key: "pause-when-empty-seconds", category: "performance", type: "int", min: -1, max: 86400, fallback: "-1" },

  // Security.
  { key: "enforce-secure-profile", category: "security", type: "bool", restart: true, fallback: "true" },
  { key: "broadcast-console-to-ops", category: "security", type: "bool", fallback: "true" },
  { key: "broadcast-rcon-to-ops", category: "security", type: "bool", fallback: "true" },
  { key: "log-ips", category: "security", type: "bool", fallback: "true" },
  { key: "text-filtering-config", category: "security", type: "string", restart: true, fallback: "" },
  // The management server arrived in 1.21.9 and its secret is a real
  // credential. Typed here rather than left to fall through as an unknown key,
  // because unknown keys are shown in full and this one must not be.
  { key: "management-server-enabled", category: "security", type: "bool", restart: true, fallback: "false" },
  { key: "management-server-host", category: "security", type: "string", restart: true, fallback: "localhost" },
  { key: "management-server-port", category: "security", type: "int", min: 0, max: 65535, restart: true, fallback: "0" },
  { key: "management-server-secret", category: "security", type: "string", secret: true, restart: true, fallback: "" },
  { key: "management-server-tls-enabled", category: "security", type: "bool", restart: true, fallback: "true" },

  // RCON and query.
  { key: "enable-rcon", category: "rcon", type: "bool", restart: true, fallback: "false" },
  { key: "rcon.port", category: "rcon", type: "int", min: 1, max: 65535, restart: true, fallback: "25575" },
  { key: "rcon.password", category: "rcon", type: "string", secret: true, restart: true, fallback: "" },
  { key: "enable-query", category: "rcon", type: "bool", restart: true, fallback: "false" },
  { key: "query.port", category: "rcon", type: "int", min: 1, max: 65535, restart: true, fallback: "25565" },

  // Resource pack.
  { key: "resource-pack", category: "resourcepack", type: "string", fallback: "" },
  { key: "resource-pack-sha1", category: "resourcepack", type: "string", fallback: "" },
  { key: "resource-pack-prompt", category: "resourcepack", type: "string", fallback: "" },
  { key: "resource-pack-id", category: "resourcepack", type: "string", fallback: "" },
  { key: "require-resource-pack", category: "resourcepack", type: "bool", fallback: "false" },

  // Server info.
  { key: "motd", category: "info", type: "string", fallback: "A Minecraft Server" },
  { key: "server-name", category: "info", type: "string", fallback: "Unknown Server" },
  { key: "enable-jmx-monitoring", category: "info", type: "bool", restart: true, fallback: "false" },
  { key: "initial-enabled-packs", category: "info", type: "string", restart: true, fallback: "vanilla" },
  { key: "initial-disabled-packs", category: "info", type: "string", restart: true, fallback: "" },
];

const BY_KEY = new Map(DEFS.map((def) => [def.key, def]));

export function definitionFor(key: string): PropertyDef | undefined {
  return BY_KEY.get(key);
}

export function allDefinitions(): PropertyDef[] {
  return DEFS;
}

export class PropertyValidationError extends Error {}

/**
 * Checks one value against its definition and returns what should be written.
 *
 * Unknown keys pass through as text: they are somebody's mod configuration, and
 * this dashboard knowing nothing about a key is not a reason to refuse it. What
 * it will not accept is a newline, which would turn one property into two and
 * could inject any key at all into the file.
 */
export function validate(key: string, raw: string): string {
  if (/[\r\n]/.test(raw)) {
    throw new PropertyValidationError(`${key}: a sortörés nem megengedett`);
  }
  const def = BY_KEY.get(key);
  if (!def) return raw;

  if (def.type === "bool") {
    if (raw !== "true" && raw !== "false") {
      throw new PropertyValidationError(`${key}: csak true vagy false lehet`);
    }
    return raw;
  }

  if (def.type === "int") {
    if (!/^-?\d+$/.test(raw)) {
      throw new PropertyValidationError(`${key}: egész szám kell`);
    }
    const value = Number(raw);
    if (def.min !== undefined && value < def.min) {
      throw new PropertyValidationError(`${key}: legalább ${def.min} legyen`);
    }
    if (def.max !== undefined && value > def.max) {
      throw new PropertyValidationError(`${key}: legfeljebb ${def.max} lehet`);
    }
    return String(value);
  }

  if (def.type === "enum") {
    if (!def.options!.includes(raw)) {
      throw new PropertyValidationError(`${key}: ismeretlen érték (${raw})`);
    }
    return raw;
  }

  return raw;
}
