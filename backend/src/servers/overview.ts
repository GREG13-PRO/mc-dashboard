import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readProperties } from "./properties";
import { definitionFor as propertyDefinition } from "./properties-schema";
import { readWorldInfo } from "./anvil";
import { detectMinecraftVersion } from "./version-check";
import { isServerRunning, getResourceUsageMap } from "./process-manager";
import { getCachedPlayers } from "./rcon-poller";
import { getResourceHistory } from "./resource-history";
import { listSchedules, type Schedule } from "./schedules";
import type { ServerEntry, ResourceUsage } from "../types";

const execFileAsync = promisify(execFile);

/**
 * One screen that answers "how is this server doing".
 *
 * Everything here already existed somewhere - the CPU graph on the console
 * tab, the version in the security report, the seed under Worlds, the disk in
 * nobody's reach at all - which is the problem. Opening a server meant a tour
 * of six tabs to find out whether anything was wrong.
 *
 * Assembled server-side in one response rather than six requests from the
 * browser: this is polled while the page is open, and six round trips per tick
 * is how a dashboard becomes the thing slowing the machine down.
 */

export interface ServerInfoCard {
  version: string | null;
  port: number | null;
  ip: string | null;
  maxPlayers: number | null;
  onlineMode: boolean | null;
  motd: string | null;
}

export interface WorldInfoCard {
  name: string;
  seed: string | null;
  sizeBytes: number | null;
  lastPlayed: string | null;
  type: string | null;
}

export interface SystemInfoCard {
  hostname: string;
  platform: string;
  release: string;
  cpuModel: string | null;
  cpuCount: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
  loadAverage: number[];
  uptimeSeconds: number;
  diskTotalMb: number | null;
  diskFreeMb: number | null;
}

export interface GameSettingsCard {
  difficulty: string | null;
  gamemode: string | null;
  pvp: boolean | null;
  whitelist: boolean | null;
  hardcore: boolean | null;
  viewDistance: number | null;
  simulationDistance: number | null;
}

export interface ServerOverview {
  running: boolean;
  resources: ResourceUsage | null;
  players: { online: number; max: number } | null;
  history: { at: string; cpuPercent: number; memoryMb: number; playersOnline: number | null }[];
  server: ServerInfoCard;
  world: WorldInfoCard | null;
  system: SystemInfoCard;
  game: GameSettingsCard;
  /** The soonest enabled schedule, with `when` as an ISO instant. */
  nextSchedule: { name: string; action: string; when: string } | null;
}

/**
 * Reads a property, falling back to Minecraft's own default when the file does
 * not mention it.
 *
 * The same schema the properties editor uses, deliberately: that screen shows a
 * missing `pvp` as Minecraft's `true` with a "default" badge, and this one
 * showing a dash for the same setting would be two screens disagreeing about
 * one server.
 */
function effective(props: Record<string, string>, key: string): string | undefined {
  return props[key] ?? propertyDefinition(key)?.fallback;
}

function boolOf(value: string | undefined): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function intOf(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Size of a directory tree.
 *
 * Capped by time rather than by depth: a world with a few hundred thousand
 * region files would otherwise make this endpoint the slowest thing on the
 * page. Past the budget it reports what it has counted and says so by
 * returning null instead of a number that is quietly too small.
 */
async function directorySize(dir: string, budgetMs = 1500): Promise<number | null> {
  const deadline = Date.now() + budgetMs;
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    if (Date.now() > deadline) return null;
    const current = stack.pop()!;
    let items;
    try {
      items = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        stack.push(full);
      } else if (item.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          // Vanished between listing and stat; a running server rotates files.
        }
      }
    }
  }
  return total;
}

async function diskFor(dir: string): Promise<{ totalMb: number | null; freeMb: number | null }> {
  try {
    // -k for kibibytes, -P for the one-line POSIX format that does not wrap a
    // long device name onto its own line.
    const { stdout } = await execFileAsync("df", ["-kP", dir]);
    const line = stdout.trim().split("\n").pop() ?? "";
    const parts = line.split(/\s+/);
    const total = Number(parts[1]);
    const available = Number(parts[3]);
    return {
      totalMb: Number.isFinite(total) ? Math.round(total / 1024) : null,
      freeMb: Number.isFinite(available) ? Math.round(available / 1024) : null,
    };
  } catch {
    return { totalMb: null, freeMb: null };
  }
}

/**
 * When a schedule will next fire.
 *
 * Computed rather than approximated by taking the first in the list, because
 * the field is called "next" and a card that says the nightly backup is next
 * when a restart is twenty minutes away is worse than no card. Returns null for
 * a weekly with no days, which cannot fire at all.
 */
function nextOccurrence(schedule: Schedule, now: Date): Date | null {
  if (schedule.kind === "interval") {
    const since = new Date(schedule.lastRunAt ?? schedule.createdAt).getTime();
    return new Date(since + schedule.intervalMinutes * 60_000);
  }

  const [hh, mm] = schedule.time.split(":").map(Number);
  const candidate = new Date(now);
  candidate.setHours(hh, mm, 0, 0);
  if (candidate <= now) candidate.setDate(candidate.getDate() + 1);

  if (schedule.kind === "daily") return candidate;

  if (schedule.days.length === 0) return null;
  // At most seven steps: one of them is a day this schedule runs on.
  for (let i = 0; i < 7; i++) {
    if (schedule.days.includes(candidate.getDay())) return candidate;
    candidate.setDate(candidate.getDate() + 1);
  }
  return null;
}

export async function serverOverview(entry: ServerEntry): Promise<ServerOverview> {
  const props = readProperties(path.join(entry.folder, "server.properties"));
  const running = await isServerRunning(entry);
  const usage = running ? (await getResourceUsageMap([entry])).get(entry.id) ?? null : null;

  const levelName = props["level-name"] || "world";
  const worldDir = path.join(entry.folder, levelName);
  const hasWorld = fs.existsSync(path.join(worldDir, "level.dat"));

  const [version, worldInfo, sizeBytes, disk, schedules] = await Promise.all([
    detectMinecraftVersion(entry).catch(() => null),
    hasWorld ? readWorldInfo(path.join(worldDir, "level.dat")) : Promise.resolve(null),
    hasWorld ? directorySize(worldDir) : Promise.resolve(null),
    diskFor(entry.folder),
    listSchedules(entry).catch(() => []),
  ]);

  const now = new Date();
  const upcoming = schedules
    .filter((s) => s.enabled)
    .map((s) => ({ schedule: s, at: nextOccurrence(s, now) }))
    .filter((s): s is { schedule: Schedule; at: Date } => s.at !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const cpus = os.cpus();

  return {
    running,
    resources: usage,
    players: getCachedPlayers(entry.id) ?? null,
    history: getResourceHistory(entry.id),
    server: {
      version,
      port: intOf(props["server-port"]),
      ip: props["server-ip"] || null,
      maxPlayers: intOf(effective(props, "max-players")),
      onlineMode: boolOf(effective(props, "online-mode")),
      motd: props["motd"] ?? null,
    },
    world: hasWorld
      ? {
          name: levelName,
          seed: worldInfo?.seed ?? null,
          sizeBytes,
          lastPlayed: worldInfo?.lastPlayed ?? null,
          type: props["level-type"] ?? null,
        }
      : null,
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      cpuModel: cpus[0]?.model ?? null,
      cpuCount: cpus.length,
      totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
      loadAverage: os.loadavg(),
      uptimeSeconds: Math.round(os.uptime()),
      diskTotalMb: disk.totalMb,
      diskFreeMb: disk.freeMb,
    },
    game: {
      difficulty: effective(props, "difficulty") ?? null,
      gamemode: effective(props, "gamemode") ?? null,
      pvp: boolOf(effective(props, "pvp")),
      whitelist: boolOf(effective(props, "white-list")),
      hardcore: boolOf(effective(props, "hardcore")),
      viewDistance: intOf(effective(props, "view-distance")),
      simulationDistance: intOf(effective(props, "simulation-distance")),
    },
    // Only the next one: a list of every schedule is the Schedules tab's job,
    // and what this screen is for is "is anything about to happen".
    nextSchedule: upcoming[0]
      ? {
          name: upcoming[0].schedule.name,
          action: upcoming[0].schedule.action,
          when: upcoming[0].at.toISOString(),
        }
      : null,
  };
}
