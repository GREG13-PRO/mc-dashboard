import fs from "node:fs";
import path from "node:path";
import { rconCommands, RconError } from "./rcon";
import { readGameRules as readGameRulesNbt, type RawGameRule } from "./anvil";
import { readProperties } from "./properties";
import { isServerRunning } from "./process-manager";
import type { ServerEntry } from "../types";

/**
 * Game rules, taken from the server rather than from a list in this file.
 *
 * The obvious design - a hardcoded table of the rules Minecraft has - is wrong,
 * and testing against a real 1.21.11 server is what showed it. Every rule was
 * renamed in 1.21.9: `keepInventory` became `minecraft:keep_inventory`,
 * `doInsomnia` became `spawn_phantoms`, `doFireTick` was replaced outright by
 * `fire_spread_radius_around_player`. A fixed list would have been wrong on one
 * side of that line or the other, and would invent rules a server does not have.
 *
 * So level.dat is the catalogue: it names the rules that server actually has,
 * with their types. This file only adds what the file cannot say - which
 * heading a rule belongs under.
 *
 * Values come from RCON while the server is up, because level.dat is only
 * rewritten on autosave and a screen showing a four-minute-old value as current
 * is worse than no screen. Which source was used is reported, not hidden.
 */

export class GameRuleError extends Error {}

export interface GameRuleDef extends RawGameRule {
  category: GameRuleCategory;
}

export type GameRuleCategory = "world" | "players" | "mobs" | "drops" | "messages" | "misc";

/**
 * Headings, by rule name.
 *
 * Both spellings are listed for the rules that were renamed, so the grouping
 * survives on an old server and a new one. A name that is not here lands in
 * "misc", which is how a rule added in a future version still shows up.
 */
const CATEGORY: Record<string, GameRuleCategory> = {
  // World and time.
  advance_time: "world",
  doDaylightCycle: "world",
  advance_weather: "world",
  doWeatherCycle: "world",
  fire_spread_radius_around_player: "world",
  doFireTick: "world",
  mob_griefing: "world",
  mobGriefing: "world",
  random_tick_speed: "world",
  randomTickSpeed: "world",
  spread_vines: "world",
  doVinesSpread: "world",
  lava_source_conversion: "world",
  lavaSourceConversion: "world",
  water_source_conversion: "world",
  waterSourceConversion: "world",
  max_snow_accumulation_height: "world",
  snowAccumulationHeight: "world",
  max_entity_cramming: "world",
  maxEntityCramming: "world",
  tnt_explodes: "world",
  projectiles_can_break_blocks: "world",
  spawner_blocks_work: "world",
  command_blocks_work: "world",
  spectators_generate_chunks: "world",
  spectatorsGenerateChunks: "world",
  allow_entering_nether_using_portals: "world",
  locator_bar: "world",

  // Players.
  keep_inventory: "players",
  keepInventory: "players",
  immediate_respawn: "players",
  doImmediateRespawn: "players",
  natural_health_regeneration: "players",
  naturalRegeneration: "players",
  fall_damage: "players",
  fallDamage: "players",
  fire_damage: "players",
  fireDamage: "players",
  drowning_damage: "players",
  drowningDamage: "players",
  freeze_damage: "players",
  freezeDamage: "players",
  respawn_radius: "players",
  spawnRadius: "players",
  players_sleeping_percentage: "players",
  playersSleepingPercentage: "players",
  players_nether_portal_default_delay: "players",
  playersNetherPortalDefaultDelay: "players",
  players_nether_portal_creative_delay: "players",
  playersNetherPortalCreativeDelay: "players",
  ender_pearls_vanish_on_death: "players",
  enderPearlsVanishOnDeath: "players",
  forgive_dead_players: "players",
  forgiveDeadPlayers: "players",
  universal_anger: "players",
  universalAnger: "players",
  pvp: "players",
  raids: "players",
  disableRaids: "players",
  player_movement_check: "players",
  elytra_movement_check: "players",
  disableElytraMovementCheck: "players",

  // Mobs.
  spawn_mobs: "mobs",
  doMobSpawning: "mobs",
  spawn_monsters: "mobs",
  spawn_phantoms: "mobs",
  doInsomnia: "mobs",
  spawn_patrols: "mobs",
  doPatrolSpawning: "mobs",
  spawn_wandering_traders: "mobs",
  doTraderSpawning: "mobs",
  spawn_wardens: "mobs",
  doWardenSpawning: "mobs",

  // Drops.
  block_drops: "drops",
  doTileDrops: "drops",
  mob_drops: "drops",
  doMobLoot: "drops",
  entity_drops: "drops",
  doEntityDrops: "drops",
  block_explosion_drop_decay: "drops",
  blockExplosionDropDecay: "drops",
  mob_explosion_drop_decay: "drops",
  mobExplosionDropDecay: "drops",
  tnt_explosion_drop_decay: "drops",
  tntExplosionDropDecay: "drops",
  limited_crafting: "drops",
  doLimitedCrafting: "drops",

  // Messages.
  show_advancement_messages: "messages",
  announceAdvancements: "messages",
  show_death_messages: "messages",
  showDeathMessages: "messages",
  send_command_feedback: "messages",
  sendCommandFeedback: "messages",
  command_block_output: "messages",
  commandBlockOutput: "messages",
  log_admin_commands: "messages",
  logAdminCommands: "messages",
  reduced_debug_info: "messages",
  reducedDebugInfo: "messages",
  global_sound_events: "messages",
  globalSoundEvents: "messages",
};

/** The world folder the server is actually loading, not an assumed "world". */
function worldDir(entry: ServerEntry): string {
  const props = readProperties(path.join(entry.folder, "server.properties"));
  return path.join(entry.folder, props["level-name"] || "world");
}

export interface GameRuleState {
  rules: GameRuleDef[];
  /** Whether the values are live or the last ones written to disk. */
  source: "rcon" | "level.dat";
  running: boolean;
  /** Set when RCON was expected to answer and did not. */
  warning?: string;
}

function catalogue(entry: ServerEntry): GameRuleDef[] {
  const levelDat = path.join(worldDir(entry), "level.dat");
  if (!fs.existsSync(levelDat)) return [];
  return readGameRulesNbt(levelDat)
    .map((rule) => ({ ...rule, category: CATEGORY[rule.name] ?? ("misc" as const) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The reply is "Gamerule x is currently set to: y", or an error for a rule the server does not have. */
function parseReply(reply: string): string | null {
  const match = /is currently set to:\s*(.+)$/i.exec(reply.trim());
  return match ? match[1].trim() : null;
}

export async function readGameRules(entry: ServerEntry): Promise<GameRuleState> {
  const rules = catalogue(entry);
  const running = await isServerRunning(entry);

  if (rules.length === 0 || !running || !entry.rcon.enabled) {
    return { rules, source: "level.dat", running };
  }

  try {
    // One connection for all of them: the handshake is the slow part, so fifty
    // connections would be fifty handshakes.
    const replies = await rconCommands(
      entry,
      rules.map((rule) => `gamerule ${rule.name}`)
    );
    const live = rules.map((rule, index) => {
      const value = parseReply(replies[index]);
      return value === null ? rule : { ...rule, value };
    });
    const answered = live.filter((rule, index) => parseReply(replies[index]) !== null).length;
    if (answered === 0) {
      // Every single query failed, which is not fifty unknown rules - it is the
      // command itself not working on this server. Saying "these are from disk"
      // is honest; silently showing disk values as live is not.
      return {
        rules,
        source: "level.dat",
        running,
        warning: "A szerver nem válaszolt a gamerule lekérdezésekre, ezek a level.dat értékei.",
      };
    }
    return { rules: live, source: "rcon", running };
  } catch (err) {
    return {
      rules,
      source: "level.dat",
      running,
      warning: err instanceof RconError ? err.message : "Az RCON nem válaszolt.",
    };
  }
}

/**
 * Sets one rule, and confirms it by reading it back.
 *
 * `/gamerule` answers "is now set to: x" whether or not anything happened, so
 * the read-back is what distinguishes a rule that changed from one the server
 * ignored.
 */
export async function setGameRule(
  entry: ServerEntry,
  name: string,
  value: string
): Promise<string> {
  // Checked against this server's own rules rather than a list of rules that
  // exist somewhere, which also keeps the name out of the command unless the
  // server itself put it there.
  const def = catalogue(entry).find((rule) => rule.name === name);
  if (!def) throw new GameRuleError(`Ez a szerver nem ismeri a(z) ${name} szabályt.`);

  if (def.type === "bool") {
    if (value !== "true" && value !== "false") {
      throw new GameRuleError(`${name}: csak true vagy false lehet`);
    }
  } else if (!/^-?\d+$/.test(value)) {
    throw new GameRuleError(`${name}: egész szám kell`);
  }

  if (!(await isServerRunning(entry))) {
    throw new GameRuleError("A szabályok módosításához futnia kell a szervernek.");
  }
  if (!entry.rcon.enabled) {
    throw new GameRuleError("Ehhez a szerverhez nincs bekapcsolva az RCON.");
  }

  const [, confirm] = await rconCommands(entry, [
    `gamerule ${name} ${value}`,
    `gamerule ${name}`,
  ]);
  const actual = parseReply(confirm);
  if (actual === null) {
    throw new GameRuleError(`A szerver nem fogadta el a(z) ${name} módosítását.`);
  }
  if (actual !== value) {
    throw new GameRuleError(`${name}: a szerver ${actual} értéket tartott meg.`);
  }
  return actual;
}
