import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import { readRegionSurface, listRegions, readSpawn, NETHER_VIEW } from "./anvil";
import { renderRegionPng } from "./map-render";
import type { ServerEntry } from "../types";

/**
 * Serves world map tiles, one PNG per region.
 *
 * Rendering a region means decompressing and parsing up to 1024 chunks, so the
 * result is cached on disk and only redone when the region file itself has
 * changed. Without that a pan across the map would re-parse tens of megabytes
 * per drag.
 */

export type Dimension = "overworld" | "nether" | "end";

const DIMENSION_DIRS: Record<Dimension, string[]> = {
  // Bukkit-family servers split dimensions into sibling folders; vanilla keeps
  // them inside the world folder. Both layouts are checked.
  overworld: ["world/region"],
  nether: ["world_nether/DIM-1/region", "world/DIM-1/region"],
  end: ["world_the_end/DIM1/region", "world/DIM1/region"],
};

export class MapError extends Error {}

export function regionDirFor(entry: ServerEntry, dim: Dimension): string | null {
  for (const rel of DIMENSION_DIRS[dim]) {
    const dir = path.join(entry.folder, rel);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

export interface MapInfo {
  dimensions: {
    id: Dimension;
    regions: { x: number; z: number }[];
    /** Where the map opens, in block coordinates. */
    spawn: { x: number; z: number };
  }[];
}

/** The overworld spawn translated into each dimension's own coordinates. */
function spawnFor(dim: Dimension, overworld: { x: number; z: number }): { x: number; z: number } {
  if (dim === "nether") return { x: Math.round(overworld.x / 8), z: Math.round(overworld.z / 8) };
  // Arriving in the End always puts you on the obsidian platform, not at the
  // overworld spawn's coordinates.
  if (dim === "end") return { x: 100, z: 0 };
  return overworld;
}

export async function mapInfo(entry: ServerEntry): Promise<MapInfo> {
  const overworldSpawn =
    (await readSpawn(path.join(entry.folder, "world", "level.dat"))) ?? { x: 0, z: 0 };
  const dimensions: MapInfo["dimensions"] = [];
  for (const dim of ["overworld", "nether", "end"] as Dimension[]) {
    const dir = regionDirFor(entry, dim);
    if (!dir) continue;
    const regions = await listRegions(dir);
    if (regions.length > 0) {
      dimensions.push({ id: dim, regions, spawn: spawnFor(dim, overworldSpawn) });
    }
  }
  return { dimensions };
}

function cacheFile(entry: ServerEntry, dim: Dimension, x: number, z: number): string {
  return path.join(env.dataDir, "map-cache", entry.id, `${dim}.${x}.${z}.png`);
}

export async function regionTile(
  entry: ServerEntry,
  dim: Dimension,
  x: number,
  z: number
): Promise<{ png: Buffer; cached: boolean }> {
  const dir = regionDirFor(entry, dim);
  if (!dir) throw new MapError("Ehhez a dimenzióhoz nincs világadat.");

  const source = path.join(dir, `r.${x}.${z}.mca`);
  if (!fs.existsSync(source)) throw new MapError("Nincs ilyen régió.");

  const cache = cacheFile(entry, dim, x, z);
  const sourceStat = await fsp.stat(source);
  if (fs.existsSync(cache)) {
    const cacheStat = await fsp.stat(cache);
    // A region rewritten by the server invalidates its tile.
    if (cacheStat.mtimeMs >= sourceStat.mtimeMs) {
      return { png: await fsp.readFile(cache), cached: true };
    }
  }

  const png = renderRegionPng(await readRegionSurface(source, dim === "nether" ? NETHER_VIEW : {}));
  await fsp.mkdir(path.dirname(cache), { recursive: true });
  await fsp.writeFile(cache, png);
  return { png, cached: false };
}

export async function clearMapCache(entry: ServerEntry): Promise<void> {
  await fsp.rm(path.join(env.dataDir, "map-cache", entry.id), { recursive: true, force: true });
}
