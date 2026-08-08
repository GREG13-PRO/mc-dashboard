import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { env } from "../config/env";
import { readRegionSurface, NETHER_VIEW } from "./anvil";
import type { Dimension } from "./map-service";
import type { ServerEntry } from "../types";

/**
 * Cached surface data for a region: which block tops every column, and at what
 * height.
 *
 * Both the 2D tiles and the 3D view are derived from this, so a region is
 * parsed once rather than once per representation - and parsing one region
 * means decompressing up to 1024 chunks, which measured at a bit over two
 * seconds on the VM.
 */

export const REGION_BLOCKS = 512;
const COLUMNS = REGION_BLOCKS * REGION_BLOCKS;
/** Column with no block at all (a void world, or an ungenerated chunk). */
export const EMPTY = 0xffff;

export interface RegionSurface {
  /** Block names, indexed by the values in `blocks`. */
  palette: string[];
  blocks: Uint16Array;
  heights: Int16Array;
}

const MAGIC = "MCS1";

function encode(surface: RegionSurface): Buffer {
  const names = Buffer.concat(
    surface.palette.map((name) => {
      const bytes = Buffer.from(name, "utf-8");
      const len = Buffer.alloc(1);
      // Block ids are far shorter than this; the cache is rewritten from the
      // world if it ever fails to load, so a truncated name is not fatal.
      len.writeUInt8(Math.min(bytes.length, 255));
      return Buffer.concat([len, bytes.subarray(0, 255)]);
    })
  );
  const header = Buffer.alloc(6);
  header.write(MAGIC, 0, "ascii");
  header.writeUInt16LE(surface.palette.length, 4);
  return zlib.deflateSync(
    Buffer.concat([
      header,
      names,
      Buffer.from(surface.blocks.buffer, surface.blocks.byteOffset, surface.blocks.byteLength),
      Buffer.from(surface.heights.buffer, surface.heights.byteOffset, surface.heights.byteLength),
    ]),
    { level: 6 }
  );
}

function decode(raw: Buffer): RegionSurface | null {
  try {
    const buf = zlib.inflateSync(raw);
    if (buf.toString("ascii", 0, 4) !== MAGIC) return null;
    const count = buf.readUInt16LE(4);
    const palette: string[] = [];
    let at = 6;
    for (let i = 0; i < count; i++) {
      const len = buf.readUInt8(at);
      palette.push(buf.toString("utf-8", at + 1, at + 1 + len));
      at += 1 + len;
    }
    const blocks = new Uint16Array(COLUMNS);
    const heights = new Int16Array(COLUMNS);
    for (let i = 0; i < COLUMNS; i++) blocks[i] = buf.readUInt16LE(at + i * 2);
    at += COLUMNS * 2;
    for (let i = 0; i < COLUMNS; i++) heights[i] = buf.readInt16LE(at + i * 2);
    return { palette, blocks, heights };
  } catch {
    return null;
  }
}

function build(chunks: Awaited<ReturnType<typeof readRegionSurface>>): RegionSurface {
  const palette: string[] = [];
  const index = new Map<string, number>();
  const blocks = new Uint16Array(COLUMNS).fill(EMPTY);
  const heights = new Int16Array(COLUMNS);

  for (const chunk of chunks) {
    const baseX = chunk.x * 16;
    const baseZ = chunk.z * 16;
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const column = chunk.columns[z * 16 + x];
        if (!column?.block) continue;
        let id = index.get(column.block);
        if (id === undefined) {
          id = palette.length;
          palette.push(column.block);
          index.set(column.block, id);
        }
        const at = (baseZ + z) * REGION_BLOCKS + (baseX + x);
        blocks[at] = id;
        heights[at] = column.y;
      }
    }
  }
  return { palette, blocks, heights };
}

/**
 * Where a region's decoded surface is kept.
 *
 * `scope` exists because the same server, dimension and coordinates can now
 * mean two different sets of blocks: the world as it is, and the world as some
 * snapshot has it. Without it a rewind would either be answered from the live
 * cache - showing the present and calling it the past - or would overwrite the
 * live cache with the past, which is worse. The mtime check below would hide
 * both most of the time, which is the kind of bug that surfaces once and is
 * never reproducible.
 */
function cacheFile(
  entry: ServerEntry,
  dim: Dimension,
  x: number,
  z: number,
  scope: string
): string {
  return path.join(env.dataDir, "map-cache", entry.id, scope, `${dim}.${x}.${z}.surface`);
}

export async function regionSurface(
  entry: ServerEntry,
  dim: Dimension,
  regionDir: string,
  x: number,
  z: number,
  /** Which reading of this world - "live", or a snapshot id. */
  scope = "live"
): Promise<RegionSurface | null> {
  const source = path.join(regionDir, `r.${x}.${z}.mca`);
  if (!fs.existsSync(source)) return null;

  const cache = cacheFile(entry, dim, x, z, scope);
  const sourceStat = await fsp.stat(source);
  if (fs.existsSync(cache)) {
    const cacheStat = await fsp.stat(cache);
    // A region rewritten by the server invalidates its cached surface.
    if (cacheStat.mtimeMs >= sourceStat.mtimeMs) {
      const decoded = decode(await fsp.readFile(cache));
      if (decoded) return decoded;
    }
  }

  const surface = build(await readRegionSurface(source, dim === "nether" ? NETHER_VIEW : {}));
  await fsp.mkdir(path.dirname(cache), { recursive: true });
  await fsp.writeFile(cache, encode(surface));
  return surface;
}
