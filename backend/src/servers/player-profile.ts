import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { NbtReader, type NbtValue } from "./anvil";
import { analyseIps } from "./ip-analysis";
import { readAccessLists } from "./access-manager";
import { recentChat, type ChatMessage } from "./chat";
import { getCachedPlayers } from "./rcon-poller";
import type { ServerEntry } from "../types";

const gunzip = promisify(zlib.gunzip);

/**
 * Everything the server already knows about one person, in one place.
 *
 * Nothing here is collected: Minecraft has been writing all of it to disk since
 * the day the world was made. `world/stats/<uuid>.json` has how long they have
 * played and how far they have walked, `world/playerdata/<uuid>.dat` has where
 * they logged out and when they first joined, `usercache.json` maps the names
 * to the ids, and this dashboard already reads addresses out of the logs and
 * keeps the ban and op lists.
 *
 * It was all there and none of it was on one screen. Answering "who is this
 * and should I be worried" meant four tabs and a text editor.
 */

export interface PlayerStats {
  /** Minutes, from Minecraft's own tick counter. Null when it has no file yet. */
  playTimeMinutes: number | null;
  deaths: number | null;
  mobKills: number | null;
  playerKills: number | null;
  /** Metres. Minecraft counts in centimetres and nobody thinks in those. */
  walked: number | null;
  damageDealt: number | null;
  damageTaken: number | null;
  jumps: number | null;
}

export interface PlayerProfile {
  uuid: string;
  name: string;
  online: boolean;
  firstPlayed: string | null;
  lastPlayed: string | null;
  gamemode: string | null;
  health: number | null;
  food: number | null;
  xpLevel: number | null;
  /** Where they logged out, or where they are now if they are online. */
  position: { x: number; y: number; z: number; dimension: string } | null;
  stats: PlayerStats;
  addresses: string[];
  logins: number;
  /**
   * How many log files the addresses were looked for in.
   *
   * An empty address list means two different things - this person has never
   * logged in, or their logins have rotated out of the logs still on disk -
   * and only this number tells them apart. On the server this was written
   * against, fifteen logs are kept and none of them still holds a login line.
   */
  addressLogsRead: number;
  op: boolean;
  whitelisted: boolean;
  banned: boolean;
  /** Only what this person said, newest last. */
  messages: ChatMessage[];
}

export interface PlayerProfileSummary {
  uuid: string;
  name: string;
  online: boolean;
  lastPlayed: string | null;
  playTimeMinutes: number | null;
  op: boolean;
  banned: boolean;
}

const GAMEMODES = ["survival", "creative", "adventure", "spectator"];

function worldDir(entry: ServerEntry): string {
  return path.join(entry.folder, "world");
}

interface CacheEntry {
  uuid: string;
  name: string;
}

/**
 * The name for every id the server has seen.
 *
 * usercache.json is the server's own answer and it is the only one that works
 * offline - Mojang's API is not reachable from every machine this runs on, and
 * an offline-mode server has names Mojang has never heard of anyway.
 */
async function readUserCache(entry: ServerEntry): Promise<CacheEntry[]> {
  const file = path.join(entry.folder, "usercache.json");
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(await fsp.readFile(file, "utf-8")) as CacheEntry[];
    return Array.isArray(raw) ? raw.filter((e) => e && e.uuid && e.name) : [];
  } catch {
    return [];
  }
}

function asNumber(value: NbtValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function asRecord(value: NbtValue | undefined): { [key: string]: NbtValue } | null {
  return value && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value)
    ? (value as { [key: string]: NbtValue })
    : null;
}

interface PlayerDat {
  firstPlayed: string | null;
  lastPlayed: string | null;
  name: string | null;
  health: number | null;
  food: number | null;
  xpLevel: number | null;
  gamemode: string | null;
  position: PlayerProfile["position"];
}

async function readPlayerDat(entry: ServerEntry, uuid: string): Promise<PlayerDat | null> {
  const file = path.join(worldDir(entry), "playerdata", `${uuid}.dat`);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = await fsp.readFile(file);
    const nbt = raw[0] === 0x1f && raw[1] === 0x8b ? await gunzip(raw) : raw;
    const root = new NbtReader(nbt).read();
    // Bukkit and Paper each keep their own timestamps; Bukkit's are the ones
    // that have been there long enough to rely on.
    const bukkit = asRecord(root.bukkit);
    const first = asNumber(bukkit?.firstPlayed);
    const last = asNumber(bukkit?.lastPlayed);
    const pos = root.Pos;
    const coords = Array.isArray(pos) ? pos.map((v) => Number(v)) : [];
    const mode = asNumber(root.playerGameType);
    return {
      firstPlayed: first ? new Date(first).toISOString() : null,
      lastPlayed: last ? new Date(last).toISOString() : null,
      name: typeof bukkit?.lastKnownName === "string" ? bukkit.lastKnownName : null,
      health: asNumber(root.Health),
      food: asNumber(root.foodLevel),
      xpLevel: asNumber(root.XpLevel),
      gamemode: mode !== null ? (GAMEMODES[mode] ?? String(mode)) : null,
      position:
        coords.length === 3
          ? {
              x: Math.round(coords[0]),
              y: Math.round(coords[1]),
              z: Math.round(coords[2]),
              dimension:
                typeof root.Dimension === "string"
                  ? root.Dimension.replace("minecraft:", "")
                  : "overworld",
            }
          : null,
    };
  } catch {
    return null;
  }
}

/** Minecraft's own statistics file, which is a nested map of counters. */
async function readStats(entry: ServerEntry, uuid: string): Promise<PlayerStats> {
  const empty: PlayerStats = {
    playTimeMinutes: null,
    deaths: null,
    mobKills: null,
    playerKills: null,
    walked: null,
    damageDealt: null,
    damageTaken: null,
    jumps: null,
  };
  const file = path.join(worldDir(entry), "stats", `${uuid}.json`);
  if (!fs.existsSync(file)) return empty;
  try {
    const raw = JSON.parse(await fsp.readFile(file, "utf-8")) as {
      stats?: Record<string, Record<string, number>>;
    };
    const custom = raw.stats?.["minecraft:custom"] ?? {};
    // Minecraft only writes counters that have moved, so a key that is not
    // there means zero - not unknown. Showing a dash for "mobs killed" on
    // somebody who has never killed one says the server does not know, when it
    // knows perfectly well. Unknown is the case above: no stats file at all.
    const get = (key: string): number =>
      typeof custom[`minecraft:${key}`] === "number" ? custom[`minecraft:${key}`] : 0;
    const ticks = get("play_time");
    const cm = get("walk_one_cm");
    return {
      // 20 ticks a second, 1200 a minute. Rounded to the minute because a
      // profile saying "3 hours 14 minutes and 7 seconds" is answering a
      // question nobody asked.
      playTimeMinutes: Math.round(ticks / 1200),
      deaths: get("deaths"),
      mobKills: get("mob_kills"),
      playerKills: get("player_kills"),
      walked: Math.round(cm / 100),
      // Both are in tenths of a heart, which is not a unit anyone wants.
      damageDealt: Math.round(get("damage_dealt") / 10),
      damageTaken: Math.round(get("damage_taken") / 10),
      jumps: get("jump"),
    };
  } catch {
    return empty;
  }
}

/**
 * The operators, from ops.json.
 *
 * Read here rather than taken from readAccessLists, which covers the whitelist
 * and the two ban lists but not this one - being an operator is not access, it
 * is authority, and the file lives on its own.
 */
async function readOps(entry: ServerEntry): Promise<string[]> {
  const file = path.join(entry.folder, "ops.json");
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(await fsp.readFile(file, "utf-8")) as { name?: string }[];
    return Array.isArray(raw) ? raw.map((e) => e?.name ?? "").filter(Boolean) : [];
  } catch {
    return [];
  }
}

const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

export class ProfileError extends Error {}

/**
 * Everyone the server has a record of.
 *
 * Built from the id cache rather than from the playerdata folder: a player who
 * joined once and never moved has a cache entry and may have no data file yet,
 * and leaving them out would make the list disagree with the ban screen.
 */
export async function listProfiles(entry: ServerEntry): Promise<PlayerProfileSummary[]> {
  const cache = await readUserCache(entry);
  const access = await readAccessLists(entry).catch(() => null);
  const online = new Set(getCachedPlayers(entry.id)?.names ?? []);
  const ops = new Set((await readOps(entry)).map((n) => n.toLowerCase()));
  const bans = new Set((access?.bannedPlayers ?? []).map((o) => o.name.toLowerCase()));

  const out = await Promise.all(
    cache.map(async ({ uuid, name }) => {
      const dat = await readPlayerDat(entry, uuid);
      const stats = await readStats(entry, uuid);
      return {
        uuid,
        name: dat?.name ?? name,
        online: online.has(name),
        lastPlayed: dat?.lastPlayed ?? null,
        playTimeMinutes: stats.playTimeMinutes,
        op: ops.has(name.toLowerCase()),
        banned: bans.has(name.toLowerCase()),
      };
    })
  );
  // Most recently seen first: the person you are looking for is nearly always
  // someone who was here today.
  return out.sort((a, b) => (b.lastPlayed ?? "").localeCompare(a.lastPlayed ?? ""));
}

export async function playerProfile(entry: ServerEntry, name: string): Promise<PlayerProfile> {
  if (!NAME_RE.test(name)) throw new ProfileError("Érvénytelen játékosnév.");
  const cache = await readUserCache(entry);
  const found = cache.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new ProfileError("Ezt a játékost nem látta még ez a szerver.");

  const [dat, stats, ips, access, chat] = await Promise.all([
    readPlayerDat(entry, found.uuid),
    readStats(entry, found.uuid),
    analyseIps(entry).catch(() => null),
    readAccessLists(entry).catch(() => null),
    recentChat(entry, 500).catch(() => [] as ChatMessage[]),
  ]);

  const summary = ips?.players.find((p) => p.player.toLowerCase() === found.name.toLowerCase());
  const has = (list: { name: string }[] | undefined) =>
    (list ?? []).some((e) => e.name.toLowerCase() === found.name.toLowerCase());

  return {
    uuid: found.uuid,
    name: dat?.name ?? found.name,
    online: (getCachedPlayers(entry.id)?.names ?? []).includes(found.name),
    firstPlayed: dat?.firstPlayed ?? null,
    lastPlayed: dat?.lastPlayed ?? null,
    gamemode: dat?.gamemode ?? null,
    health: dat?.health ?? null,
    food: dat?.food ?? null,
    xpLevel: dat?.xpLevel ?? null,
    position: dat?.position ?? null,
    stats,
    addresses: summary?.ips ?? [],
    logins: summary?.logins ?? 0,
    addressLogsRead: ips?.logsRead ?? 0,
    op: (await readOps(entry)).some((n) => n.toLowerCase() === found.name.toLowerCase()),
    whitelisted: has(access?.whitelist),
    banned: has(access?.bannedPlayers),
    messages: chat.filter((m) => m.player?.toLowerCase() === found.name.toLowerCase()).slice(-50),
  };
}
