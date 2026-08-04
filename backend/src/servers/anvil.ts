import fs from "node:fs";
import fsp from "node:fs/promises";
import zlib from "node:zlib";

/**
 * Minimal reader for Minecraft's Anvil world format.
 *
 * Only what a top-down map needs: for every column in a chunk, the height of
 * the surface and the block sitting there. Deliberately not a general NBT
 * library - it parses the tags it meets and skips the rest, because the goal
 * is a map, not round-tripping world data.
 */

type NbtValue =
  | number
  | bigint
  | string
  | Uint8Array
  | Int32Array
  | BigInt64Array
  | NbtValue[]
  | { [key: string]: NbtValue };

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

class NbtReader {
  private offset = 0;
  /** Name of a compound whose children's tag ids should be recorded, if any. */
  private capture: string | null = null;
  private captureDepth = 0;
  private capturedTypes = new Map<string, number>();

  constructor(private readonly buf: Buffer, capture?: string) {
    this.capture = capture ?? null;
  }

  /** Only meaningful after read(), and only for the captured compound. */
  typesOf(): Map<string, number> {
    return this.capturedTypes;
  }

  private u8(): number {
    return this.buf.readUInt8(this.offset++);
  }
  private i16(): number {
    const v = this.buf.readInt16BE(this.offset);
    this.offset += 2;
    return v;
  }
  private i32(): number {
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }
  private i64(): bigint {
    const v = this.buf.readBigInt64BE(this.offset);
    this.offset += 8;
    return v;
  }
  private str(): string {
    const len = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    const s = this.buf.toString("utf-8", this.offset, this.offset + len);
    this.offset += len;
    return s;
  }

  private payload(type: number): NbtValue {
    switch (type) {
      case TAG_BYTE:
        return this.buf.readInt8(this.offset++);
      case TAG_SHORT:
        return this.i16();
      case TAG_INT:
        return this.i32();
      case TAG_LONG:
        return this.i64();
      case TAG_FLOAT: {
        const v = this.buf.readFloatBE(this.offset);
        this.offset += 4;
        return v;
      }
      case TAG_DOUBLE: {
        const v = this.buf.readDoubleBE(this.offset);
        this.offset += 8;
        return v;
      }
      case TAG_BYTE_ARRAY: {
        const len = this.i32();
        const v = this.buf.subarray(this.offset, this.offset + len);
        this.offset += len;
        return new Uint8Array(v);
      }
      case TAG_STRING:
        return this.str();
      case TAG_LIST: {
        const itemType = this.u8();
        const len = this.i32();
        const out: NbtValue[] = [];
        for (let i = 0; i < len; i++) out.push(this.payload(itemType));
        return out;
      }
      case TAG_COMPOUND: {
        const out: { [key: string]: NbtValue } = {};
        for (;;) {
          const t = this.u8();
          if (t === TAG_END) break;
          const name = this.str();
          // Inside the captured compound, remember each child's tag id. The
          // values on their own cannot tell a boolean from a number: a game
          // rule stored as byte 0 and one stored as int 0 both arrive as 0,
          // and the difference decides whether it gets a switch or a field.
          if (this.captureDepth > 0) this.capturedTypes.set(name, t);
          const entering = name === this.capture && t === TAG_COMPOUND;
          if (entering) this.captureDepth++;
          out[name] = this.payload(t);
          if (entering) this.captureDepth--;
        }
        return out;
      }
      case TAG_INT_ARRAY: {
        const len = this.i32();
        const arr = new Int32Array(len);
        for (let i = 0; i < len; i++) arr[i] = this.i32();
        return arr;
      }
      case TAG_LONG_ARRAY: {
        const len = this.i32();
        const arr = new BigInt64Array(len);
        for (let i = 0; i < len; i++) arr[i] = this.i64();
        return arr;
      }
      default:
        throw new Error(`Unknown NBT tag type ${type}`);
    }
  }

  read(): { [key: string]: NbtValue } {
    const type = this.u8();
    if (type !== TAG_COMPOUND) throw new Error("NBT root is not a compound");
    this.str();
    return this.payload(TAG_COMPOUND) as { [key: string]: NbtValue };
  }
}

export interface SurfaceColumn {
  /** Block name without the minecraft: prefix, or null for an empty column. */
  block: string | null;
  y: number;
}

export interface ChunkSurface {
  /** Chunk coordinates within the region, 0..31. */
  x: number;
  z: number;
  /** 16x16, row-major by z then x. */
  columns: SurfaceColumn[];
}

/**
 * Unpacks a bit-packed long array.
 *
 * Since 1.16 entries never straddle a long: each long holds
 * floor(64 / bits) entries and the remaining high bits are padding. Earlier
 * worlds packed them densely, which this does not handle - those chunks are
 * skipped rather than drawn wrongly.
 */
function unpack(data: BigInt64Array, bits: number, count: number): number[] {
  const perLong = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;
  const out: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const longIndex = Math.floor(i / perLong);
    if (longIndex >= data.length) {
      out[i] = 0;
      continue;
    }
    const shift = BigInt((i % perLong) * bits);
    out[i] = Number((BigInt.asUintN(64, data[longIndex]) >> shift) & mask);
  }
  return out;
}

interface Section {
  y: number;
  palette: string[];
  indices: number[] | null;
}

function readSections(chunk: { [key: string]: NbtValue }): Section[] {
  const raw = chunk.sections;
  if (!Array.isArray(raw)) return [];
  const out: Section[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) continue;
    const section = s as { [key: string]: NbtValue };
    const states = section.block_states as { [key: string]: NbtValue } | undefined;
    if (!states) continue;
    const paletteRaw = states.palette;
    if (!Array.isArray(paletteRaw)) continue;

    const palette = paletteRaw.map((entry) => {
      const name = (entry as { [key: string]: NbtValue })?.Name;
      return typeof name === "string" ? name.replace(/^minecraft:/, "") : "air";
    });

    let indices: number[] | null = null;
    const data = states.data;
    if (palette.length === 1) {
      // A uniform section stores no data at all.
      indices = null;
    } else if (data instanceof BigInt64Array) {
      const bits = Math.max(4, 32 - Math.clz32(palette.length - 1));
      indices = unpack(data, bits, 4096);
    } else {
      continue;
    }
    out.push({ y: Number(section.Y ?? 0), palette, indices });
  }
  return out;
}

const AIR = new Set(["air", "cave_air", "void_air"]);

/**
 * Finds the topmost non-air block in every column.
 *
 * Walking down from the top rather than trusting the stored heightmap: the
 * heightmap points at the first free space above terrain, which for a lobby
 * full of glass and leaves is not the block anyone wants to see on a map.
 */
function surfaceOf(sections: Section[], options: SurfaceOptions): SurfaceColumn[] {
  const ceiling = options.ceiling ?? Number.MAX_SAFE_INTEGER;
  const columns: SurfaceColumn[] = new Array(256);
  for (let i = 0; i < 256; i++) columns[i] = { block: null, y: 0 };
  // In a roofed dimension a column only counts once open space has been seen
  // above it. Otherwise the scan stops on the first solid block below the
  // ceiling, which in the Nether is metres of untouched rock over the tunnels
  // anyone actually walks through.
  const open = new Array<boolean>(256).fill(!options.roofed);

  const ordered = [...sections].sort((a, b) => b.y - a.y);
  let remaining = 256;

  for (const section of ordered) {
    if (remaining === 0) break;
    if (section.y * 16 > ceiling) continue;

    if (section.indices === null && AIR.has(section.palette[0])) {
      // An all-air section contributes no blocks, but it is exactly what opens
      // the columns beneath it.
      if (options.roofed) open.fill(true);
      continue;
    }

    for (let y = 15; y >= 0 && remaining > 0; y--) {
      if (section.y * 16 + y > ceiling) continue;
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const column = z * 16 + x;
          if (columns[column].block !== null) continue;
          const index = section.indices === null ? 0 : section.indices[y * 256 + z * 16 + x];
          const name = section.palette[index] ?? "air";
          if (AIR.has(name)) {
            open[column] = true;
            continue;
          }
          if (!open[column]) continue;
          columns[column] = { block: name, y: section.y * 16 + y };
          remaining--;
        }
      }
    }
  }
  return columns;
}

export class AnvilError extends Error {}

export interface SurfaceOptions {
  /** Highest block the scan may consider. */
  ceiling?: number;
  /** Require open space above a block before it counts as the surface. */
  roofed?: boolean;
}

/**
 * How to look at a dimension that has a bedrock roof.
 *
 * The Nether's roof sits at y=127, so a plain top-down scan of it returns a
 * flat grey slab of bedrock and nothing else. Cutting in below the roof and
 * then taking the first solid block under an air pocket is what turns it into
 * a map of the Nether rather than a map of its ceiling.
 */
export const NETHER_VIEW: SurfaceOptions = { ceiling: 121, roofed: true };

/** Reads one region file and returns the surface of every chunk it holds. */
export async function readRegionSurface(
  file: string,
  options: SurfaceOptions = {}
): Promise<ChunkSurface[]> {
  if (!fs.existsSync(file)) throw new AnvilError("Region file not found");
  const buf = await fsp.readFile(file);
  if (buf.length < 8192) return [];

  const out: ChunkSurface[] = [];
  for (let i = 0; i < 1024; i++) {
    // The header is 1024 location entries: 3 bytes sector offset, 1 byte count.
    const offsetSectors = (buf[i * 4] << 16) | (buf[i * 4 + 1] << 8) | buf[i * 4 + 2];
    const sectorCount = buf[i * 4 + 3];
    if (offsetSectors === 0 || sectorCount === 0) continue;

    const start = offsetSectors * 4096;
    if (start + 5 > buf.length) continue;
    const length = buf.readUInt32BE(start);
    const compression = buf.readUInt8(start + 4);
    const payload = buf.subarray(start + 5, start + 4 + length);
    if (payload.length === 0) continue;

    let raw: Buffer;
    try {
      raw = compression === 1 ? zlib.gunzipSync(payload) : compression === 2 ? zlib.inflateSync(payload) : payload;
    } catch {
      continue;
    }

    try {
      const chunk = new NbtReader(raw).read();
      const sections = readSections(chunk);
      if (sections.length === 0) continue;
      out.push({ x: i % 32, z: Math.floor(i / 32), columns: surfaceOf(sections, options) });
    } catch {
      // One unreadable chunk should not lose the whole region.
      continue;
    }
  }
  return out;
}

/** Region files present for a world, as {x, z} pairs. */
/**
 * World spawn from level.dat, used as the map's default view.
 *
 * Fitting the whole region grid instead is close to useless: a world that has
 * ever been walked across keeps region files for every visited chunk, so the
 * built area ends up a few pixels wide in the middle of empty tiles. The spawn
 * is where the interesting part almost always is.
 */
export async function readSpawn(levelDat: string): Promise<{ x: number; z: number } | null> {
  try {
    const raw = await fsp.readFile(levelDat);
    // level.dat is gzipped; a few servers store it uncompressed.
    const nbt = new NbtReader(raw[0] === 0x1f ? zlib.gunzipSync(raw) : raw).read();
    const data = nbt.Data as { [key: string]: NbtValue } | undefined;
    if (!data) return null;

    // 1.21.9 replaced SpawnX/SpawnY/SpawnZ with a `spawn` compound holding an
    // int array. Reading only the old keys meant every modern world opened the
    // map at 0,0 instead of at its spawn.
    const spawn = data.spawn as { [key: string]: NbtValue } | undefined;
    const pos = spawn?.pos;
    if (pos instanceof Int32Array && pos.length >= 3) {
      return { x: pos[0], z: pos[2] };
    }

    const x = data.SpawnX;
    const z = data.SpawnZ;
    if (typeof x !== "number" || typeof z !== "number") return null;
    return { x, z };
  } catch {
    return null;
  }
}

export interface WorldInfo {
  /** Null when the world has not been generated yet. */
  seed: string | null;
  lastPlayed: string | null;
}

/**
 * Seed and last-played time out of level.dat.
 *
 * The seed moved in 1.16: it used to sit at Data.RandomSeed and now lives under
 * Data.WorldGenSettings.seed, so both are checked. It is returned as a string
 * because a Minecraft seed is a 64-bit value and JSON numbers are not.
 */
export async function readWorldInfo(levelDat: string): Promise<WorldInfo | null> {
  try {
    const raw = await fsp.readFile(levelDat);
    const nbt = new NbtReader(raw[0] === 0x1f ? zlib.gunzipSync(raw) : raw).read();
    const data = nbt.Data as { [key: string]: NbtValue } | undefined;
    if (!data) return null;

    const settings = data.WorldGenSettings as { [key: string]: NbtValue } | undefined;
    const seed = settings?.seed ?? data.RandomSeed;
    const lastPlayed = data.LastPlayed;
    return {
      seed: typeof seed === "bigint" ? seed.toString() : null,
      lastPlayed:
        typeof lastPlayed === "bigint" && lastPlayed > 0n
          ? new Date(Number(lastPlayed)).toISOString()
          : null,
    };
  } catch {
    return null;
  }
}

/**
 * Game rules out of level.dat.
 *
 * NBT stores every rule as a string, including the numeric ones - `randomTickSpeed`
 * is "3", not 3 - so they come back as written and the caller decides what each
 * one means. Synchronous because the callers already have the world folder and
 * this is one small gzipped file.
 */
export interface RawGameRule {
  /** Without the minecraft: prefix, which is also how the command takes it. */
  name: string;
  value: string;
  type: "bool" | "int";
}

/**
 * Game rules out of level.dat, as the file itself describes them.
 *
 * The names are read rather than assumed, because Minecraft renamed every one
 * of them: through 1.21.8 they were a `GameRules` compound of camelCase keys
 * with string values (`keepInventory` = "false"), and from 1.21.9 they are a
 * `game_rules` compound of namespaced snake_case keys with typed values
 * (`minecraft:keep_inventory` = byte 0). Some were also split or replaced -
 * `doFireTick` is gone and `spawn_monsters` is new - so a hardcoded list would
 * be wrong on one version or the other, and inventing entries for rules a
 * server does not have is worse than showing fewer.
 */
export function readGameRules(levelDat: string): RawGameRule[] {
  try {
    const raw = fs.readFileSync(levelDat);
    const reader = new NbtReader(raw[0] === 0x1f ? zlib.gunzipSync(raw) : raw, "game_rules");
    const nbt = reader.read();
    const data = nbt.Data as { [key: string]: NbtValue } | undefined;
    if (!data) return [];

    const modern = data.game_rules as { [key: string]: NbtValue } | undefined;
    if (modern) {
      const types = reader.typesOf();
      return Object.entries(modern).map(([key, value]) => {
        const bool = types.get(key) === TAG_BYTE;
        return {
          name: key.replace(/^minecraft:/, ""),
          value: bool ? String(value === 1) : String(value),
          type: bool ? ("bool" as const) : ("int" as const),
        };
      });
    }

    const legacy = data.GameRules as { [key: string]: NbtValue } | undefined;
    if (legacy) {
      // Everything is a string here, so the value is the only clue to the type.
      return Object.entries(legacy)
        .filter((pair): pair is [string, string] => typeof pair[1] === "string")
        .map(([name, value]) => ({
          name,
          value,
          type: value === "true" || value === "false" ? ("bool" as const) : ("int" as const),
        }));
    }
    return [];
  } catch {
    // An unreadable level.dat is a world that has never been started.
    return [];
  }
}

export async function listRegions(regionDir: string): Promise<{ x: number; z: number }[]> {
  if (!fs.existsSync(regionDir)) return [];
  const out: { x: number; z: number }[] = [];
  for (const name of await fsp.readdir(regionDir)) {
    const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(name);
    if (m) out.push({ x: Number(m[1]), z: Number(m[2]) });
  }
  return out.sort((a, b) => a.z - b.z || a.x - b.x);
}
