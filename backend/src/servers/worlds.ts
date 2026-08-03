import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { readWorldInfo } from "./anvil";
import { isServerRunning } from "./process-manager";
import { readProperties, writeProperties } from "./properties";
import { clearMapCache } from "./map-service";
import type { ServerEntry } from "../types";

/**
 * The worlds sitting in a server's folder, and the settings that decide which
 * one it loads.
 *
 * Creating a world does not generate it here. Minecraft generates a world when
 * a server starts and finds no folder for the name it was told to load, so what
 * this writes is the name, seed and type into server.properties - the server
 * itself does the rest on its next start. Pretending otherwise would mean
 * shipping a world generator, and the screen would be lying about what the
 * button did.
 */

export class WorldError extends Error {}

// A world name becomes a folder name and reaches the filesystem, so it gets an
// allowlist rather than a sanitizer. Minecraft is happy with far more than
// this, but nothing here needs it.
const WORLD_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export const WORLD_TYPES = [
  "minecraft:normal",
  "minecraft:flat",
  "minecraft:large_biomes",
  "minecraft:amplified",
  "minecraft:single_biome_surface",
] as const;

export type WorldType = (typeof WORLD_TYPES)[number];

export interface WorldSummary {
  name: string;
  /** The one server.properties currently points at. */
  active: boolean;
  sizeBytes: number;
  seed: string | null;
  lastPlayed: string | null;
  /** Bukkit-family servers keep these in sibling folders. */
  hasNether: boolean;
  hasEnd: boolean;
}

export interface WorldSettings {
  levelName: string;
  seed: string;
  type: string;
  generateStructures: boolean;
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(full);
    } else if (entry.isFile()) {
      total += (await fsp.stat(full).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

/** A folder counts as a world when it holds a level.dat. */
function isWorldFolder(dir: string): boolean {
  return fs.existsSync(path.join(dir, "level.dat"));
}

export async function listWorlds(entry: ServerEntry): Promise<WorldSummary[]> {
  const props = readProperties(path.join(entry.folder, "server.properties"));
  const active = props["level-name"] ?? "world";

  let names: string[];
  try {
    names = (await fsp.readdir(entry.folder, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const worlds: WorldSummary[] = [];
  for (const name of names) {
    const dir = path.join(entry.folder, name);
    if (!isWorldFolder(dir)) continue;
    // The nether and end folders of a Bukkit world are not worlds in their own
    // right; they belong to the overworld that shares their prefix.
    if (/_nether$|_the_end$/.test(name) && isWorldFolder(path.join(entry.folder, name.replace(/_nether$|_the_end$/, "")))) {
      continue;
    }
    const info = await readWorldInfo(path.join(dir, "level.dat"));
    worlds.push({
      name,
      active: name === active,
      sizeBytes: await directorySize(dir),
      seed: info?.seed ?? null,
      lastPlayed: info?.lastPlayed ?? null,
      hasNether: fs.existsSync(path.join(entry.folder, `${name}_nether`)),
      hasEnd: fs.existsSync(path.join(entry.folder, `${name}_the_end`)),
    });
  }
  return worlds.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

export function worldSettings(entry: ServerEntry): WorldSettings {
  const props = readProperties(path.join(entry.folder, "server.properties"));
  return {
    levelName: props["level-name"] ?? "world",
    seed: props["level-seed"] ?? "",
    type: props["level-type"] ?? "minecraft:normal",
    generateStructures: props["generate-structures"] !== "false",
  };
}

async function assertStopped(entry: ServerEntry): Promise<void> {
  if (await isServerRunning(entry)) {
    throw new WorldError("Ehhez le kell állítani a szervert.");
  }
}

export interface CreateWorldInput {
  name: string;
  seed?: string;
  type?: string;
  generateStructures?: boolean;
}

/**
 * Points the server at a new world name, so it generates one on the next start.
 */
export async function createWorld(entry: ServerEntry, input: CreateWorldInput): Promise<void> {
  await assertStopped(entry);
  if (!WORLD_NAME_RE.test(input.name)) {
    throw new WorldError("A világ neve csak betűt, számot, kötőjelet és aláhúzást tartalmazhat.");
  }
  if (fs.existsSync(path.join(entry.folder, input.name))) {
    throw new WorldError("Már van ilyen nevű világ.");
  }
  const type = input.type ?? "minecraft:normal";
  if (!WORLD_TYPES.includes(type as WorldType)) {
    throw new WorldError("Ismeretlen világtípus.");
  }
  // An empty seed is not the same as a zero one: Minecraft reads an empty
  // level-seed as "pick a random seed", which is what someone who left the
  // field alone meant.
  const seed = (input.seed ?? "").trim();
  if (seed && !/^-?\d{1,20}$/.test(seed) && seed.length > 64) {
    throw new WorldError("A seed túl hosszú.");
  }

  writeProperties(path.join(entry.folder, "server.properties"), {
    "level-name": input.name,
    "level-seed": seed,
    "level-type": type,
    "generate-structures": String(input.generateStructures !== false),
  });
}

export async function activateWorld(entry: ServerEntry, name: string): Promise<void> {
  await assertStopped(entry);
  if (!WORLD_NAME_RE.test(name)) throw new WorldError("Érvénytelen világnév.");
  if (!isWorldFolder(path.join(entry.folder, name))) {
    throw new WorldError("Nincs ilyen világ.");
  }
  // The seed is left alone deliberately: it belongs to the world that already
  // exists, and level-seed only matters when generating a new one.
  writeProperties(path.join(entry.folder, "server.properties"), { "level-name": name });
  await clearMapCache(entry);
}

export async function deleteWorld(entry: ServerEntry, name: string): Promise<void> {
  await assertStopped(entry);
  if (!WORLD_NAME_RE.test(name)) throw new WorldError("Érvénytelen világnév.");
  const settings = worldSettings(entry);
  if (settings.levelName === name) {
    throw new WorldError("Az aktív világ nem törölhető. Előbb válts egy másikra.");
  }
  const dir = path.join(entry.folder, name);
  if (!isWorldFolder(dir)) throw new WorldError("Nincs ilyen világ.");

  // The nether and end folders go with it; leaving them behind would have the
  // next world of the same name inherit someone else's Nether.
  for (const suffix of ["", "_nether", "_the_end"]) {
    await fsp.rm(path.join(entry.folder, `${name}${suffix}`), { recursive: true, force: true });
  }
  await clearMapCache(entry);
}
