import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import { listRegions, readSpawn } from "./anvil";
import { regionSurface, REGION_BLOCKS, EMPTY } from "./map-surface";
import { renderSurfacePng, colourOf } from "./map-render";
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

  const surface = await regionSurface(entry, dim, dir, x, z);
  if (!surface) throw new MapError("Nincs ilyen régió.");
  const png = renderSurfacePng(surface);
  await fsp.mkdir(path.dirname(cache), { recursive: true });
  await fsp.writeFile(cache, png);
  return { png, cached: false };
}

export async function clearMapCache(entry: ServerEntry): Promise<void> {
  await fsp.rm(path.join(env.dataDir, "map-cache", entry.id), { recursive: true, force: true });
}

export interface SurfaceView {
  /** Block coordinates of the view's north-west corner. */
  x: number;
  z: number;
  size: number;
  /** "#rrggbb" per palette entry; index 0 is reserved for an empty column. */
  palette: string[];
  /** size*size palette indices, one byte each, base64. */
  colours: string;
  /** size*size heights as signed 16-bit little-endian, base64. */
  heights: string;
}

/** Largest square the 3D view may ask for, in blocks. */
export const MAX_VIEW_SIZE = 256;

/**
 * A square of surface data for the 3D view.
 *
 * Bounded and sent as two flat arrays rather than a mesh: the browser builds
 * the geometry, so panning the 3D camera costs nothing server-side, and the
 * payload for the largest allowed square stays around 200 KB before gzip.
 */
export async function surfaceView(
  entry: ServerEntry,
  dim: Dimension,
  originX: number,
  originZ: number,
  size: number
): Promise<SurfaceView> {
  const dir = regionDirFor(entry, dim);
  if (!dir) throw new MapError("Ehhez a dimenzióhoz nincs világadat.");
  if (!Number.isInteger(size) || size < 16 || size > MAX_VIEW_SIZE) {
    throw new MapError("Érvénytelen nézetméret.");
  }

  const colours = Buffer.alloc(size * size);
  const heights = Buffer.alloc(size * size * 2);
  const palette: string[] = ["#000000"];
  const paletteIndex = new Map<string, number>();

  // Walk region by region rather than column by column: each region is one
  // cache lookup, and a 256-block square touches at most four of them.
  const firstRegionX = Math.floor(originX / REGION_BLOCKS);
  const lastRegionX = Math.floor((originX + size - 1) / REGION_BLOCKS);
  const firstRegionZ = Math.floor(originZ / REGION_BLOCKS);
  const lastRegionZ = Math.floor((originZ + size - 1) / REGION_BLOCKS);

  for (let rz = firstRegionZ; rz <= lastRegionZ; rz++) {
    for (let rx = firstRegionX; rx <= lastRegionX; rx++) {
      const surface = await regionSurface(entry, dim, dir, rx, rz);
      if (!surface) continue;
      const regionOriginX = rx * REGION_BLOCKS;
      const regionOriginZ = rz * REGION_BLOCKS;

      const fromX = Math.max(originX, regionOriginX);
      const toX = Math.min(originX + size, regionOriginX + REGION_BLOCKS);
      const fromZ = Math.max(originZ, regionOriginZ);
      const toZ = Math.min(originZ + size, regionOriginZ + REGION_BLOCKS);

      for (let z = fromZ; z < toZ; z++) {
        for (let x = fromX; x < toX; x++) {
          const block =
            surface.blocks[(z - regionOriginZ) * REGION_BLOCKS + (x - regionOriginX)];
          if (block === EMPTY) continue;
          const name = surface.palette[block];
          let id = paletteIndex.get(name);
          if (id === undefined) {
            if (palette.length > 255) {
              // Past 255 distinct blocks an index no longer fits in a byte;
              // the remainder share the last slot rather than widening every
              // entry in the payload for a case that needs a very busy build.
              id = 255;
            } else {
              const [r, g, b] = colourOf(name);
              id = palette.length;
              palette.push(`#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`);
            }
            paletteIndex.set(name, id);
          }
          const at = (z - originZ) * size + (x - originX);
          colours[at] = id;
          heights.writeInt16LE(
            surface.heights[(z - regionOriginZ) * REGION_BLOCKS + (x - regionOriginX)],
            at * 2
          );
        }
      }
    }
  }

  return {
    x: originX,
    z: originZ,
    size,
    palette,
    colours: colours.toString("base64"),
    heights: heights.toString("base64"),
  };
}
