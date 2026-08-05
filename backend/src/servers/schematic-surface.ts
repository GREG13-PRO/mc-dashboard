import fsp from "node:fs/promises";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { NbtReader, type NbtValue } from "./anvil";
import { colourOf } from "./block-colours";

const gunzip = promisify(zlib.gunzip);

/**
 * What a schematic looks like from above.
 *
 * The library could already list schematics and paste them, but pasting was a
 * leap of faith: you picked a file by name, typed three coordinates, and found
 * out what you had done by walking there in game. This reads the blocks so the
 * map can show the building standing on the terrain before anything is written
 * to the world.
 *
 * Only the surface is extracted, not the volume. The 3D map draws a heightmap -
 * one block per column - so carrying the interior of a build across the wire
 * would be a hundred times the bytes for pixels nobody can see. It also means
 * the result is the same shape as a world surface and goes through the same
 * mesh builder in the browser.
 *
 * Two formats exist in the wild. Sponge (`.schem`, WorldEdit 7+) carries a
 * block palette and a varint array, and is what anything current writes.
 * MCEdit (`.schematic`, pre-1.13) carries numeric block ids, which stopped
 * being meaningful when the flattening removed them; that one is reported as
 * unreadable rather than guessed at, because a wrong preview is worse than no
 * preview when the next click writes it into the world.
 */

export class SchematicReadError extends Error {}

export interface SchematicSurface {
  width: number;
  length: number;
  height: number;
  /**
   * Where the build sits relative to the paste position, in blocks.
   *
   * WorldEdit stores this so a schematic copied around a player lands the same
   * way round it again. The preview has to apply it or the ghost sits offset
   * from where the paste will actually put the blocks.
   */
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  /** "#rrggbb" per palette entry; index 0 is the empty column. */
  palette: string[];
  /** width*length palette indices, one byte each, base64. */
  colours: string;
  /** width*length heights as signed 16-bit little-endian, base64. */
  heights: string;
  /** Distinct block names in the build, most common first, for the summary. */
  blockCounts: { name: string; count: number }[];
}

/** Larger than this and the preview is not worth the wire time or the memory. */
const MAX_AREA = 512 * 512;

function asRecord(value: NbtValue | undefined): { [key: string]: NbtValue } | null {
  return value && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value)
    ? (value as { [key: string]: NbtValue })
    : null;
}

function asNumber(value: NbtValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

/**
 * Sponge stores block ids as LEB128 varints packed into a byte array, one per
 * block in y,z,x order. Decoding is sequential - there is no index - so this
 * walks the whole array once and keeps only the topmost solid block per column.
 */
function decodeVarints(data: Uint8Array, expected: number): Int32Array {
  const out = new Int32Array(expected);
  let at = 0;
  for (let i = 0; i < expected; i++) {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= data.length) {
        throw new SchematicReadError("A schematic blokkadatai hiányosak.");
      }
      const byte = data[at++];
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 31) throw new SchematicReadError("A schematic blokkadatai sérültek.");
    }
    out[i] = value;
  }
  return out;
}

/**
 * Blocks that are present but should not become the visible surface.
 *
 * Air is obvious. The others are what a build is wrapped in while it is being
 * moved: a schematic copied with a selection full of water, or one saved with
 * barrier walls, would otherwise render as a solid blue or invisible slab and
 * hide the building underneath it.
 */
const NOT_SURFACE = new Set([
  "minecraft:air",
  "minecraft:cave_air",
  "minecraft:void_air",
  "minecraft:barrier",
  "minecraft:light",
  "minecraft:structure_void",
]);

function isSkippable(name: string): boolean {
  // Block states arrive as `minecraft:oak_stairs[facing=north]`; the state says
  // nothing about the colour, and leaving it on would defeat the name rules.
  const bare = name.includes("[") ? name.slice(0, name.indexOf("[")) : name;
  return NOT_SURFACE.has(bare.includes(":") ? bare : `minecraft:${bare}`);
}

function bareName(name: string): string {
  return name.includes("[") ? name.slice(0, name.indexOf("[")) : name;
}

/**
 * Reads a sponge schematic into a top-down surface.
 *
 * Sponge v2 keeps the palette and block data at the root; v3 moves them under a
 * `Blocks` compound. Both are handled, because WorldEdit writes v2 and newer
 * builds write v3, and a library on a real server contains both.
 */
export async function readSchematicSurface(file: string): Promise<SchematicSurface> {
  const raw = await fsp.readFile(file);
  let nbt: Buffer;
  try {
    nbt = raw[0] === 0x1f && raw[1] === 0x8b ? await gunzip(raw) : raw;
  } catch {
    throw new SchematicReadError("A fájlt nem sikerült kitömöríteni.");
  }

  let root: { [key: string]: NbtValue };
  try {
    root = new NbtReader(nbt).read();
  } catch {
    throw new SchematicReadError("A fájl nem olvasható NBT.");
  }
  // Sponge v3 wraps everything in a "Schematic" compound; v2 does not.
  const top = asRecord(root.Schematic) ?? root;

  const width = asNumber(top.Width);
  const height = asNumber(top.Height);
  const length = asNumber(top.Length);
  if (width === null || height === null || length === null) {
    throw new SchematicReadError("A schematic mérete nem olvasható.");
  }
  if (width * length > MAX_AREA) {
    throw new SchematicReadError(
      `Ez a schematic túl nagy az előnézethez (${width}×${length} blokk).`
    );
  }

  // v3 nests the palette and the data; v2 has them at the top.
  const blocks = asRecord(top.Blocks);
  const paletteTag = asRecord(blocks?.Palette) ?? asRecord(top.Palette);
  const dataTag = (blocks?.Data ?? top.BlockData) as NbtValue | undefined;

  if (!paletteTag || !ArrayBuffer.isView(dataTag)) {
    // The MCEdit format has `Blocks` as a flat byte array of numeric ids rather
    // than a compound, which is how it is told apart from sponge here.
    throw new SchematicReadError(
      "Ez a régi MCEdit formátum, aminek a blokkazonosítói már nem egyértelműek. " +
        "Mentsd újra a WorldEdit `//schem save` paranccsal."
    );
  }

  // The palette maps name -> id, so it has to be turned round to index by id.
  const names: string[] = [];
  for (const [name, id] of Object.entries(paletteTag)) {
    const index = asNumber(id);
    if (index === null || index < 0) continue;
    names[index] = name;
  }
  if (names.length === 0) throw new SchematicReadError("A schematic palettája üres.");

  const ids = decodeVarints(dataTag as Uint8Array, width * height * length);

  const area = width * length;
  const colourIndex = Buffer.alloc(area);
  const heights = Buffer.alloc(area * 2);
  const outPalette: string[] = ["#000000"];
  const paletteIndex = new Map<string, number>();
  const counts = new Map<string, number>();

  // Walked bottom to top so the last write per column wins - the topmost solid
  // block, which is what a map shows.
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        // Sponge's own ordering: x varies fastest, then z, then y.
        const name = names[ids[y * width * length + z * width + x]];
        if (!name || isSkippable(name)) continue;
        const bare = bareName(name);
        counts.set(bare, (counts.get(bare) ?? 0) + 1);

        let id = paletteIndex.get(bare);
        if (id === undefined) {
          if (outPalette.length > 255) {
            // Past 255 distinct blocks the index no longer fits in a byte; the
            // rest share the last slot rather than widening every entry for a
            // case that needs a very varied build.
            id = 255;
          } else {
            const [r, g, b] = colourOf(bare);
            id = outPalette.length;
            outPalette.push(`#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`);
          }
          paletteIndex.set(bare, id);
        }
        const at = z * width + x;
        colourIndex[at] = id;
        heights.writeInt16LE(y, at * 2);
      }
    }
  }

  const offset = top.Offset;
  const offsets = ArrayBuffer.isView(offset) ? Array.from(offset as Int32Array) : [];

  return {
    width,
    length,
    height,
    offsetX: offsets[0] ?? 0,
    offsetY: offsets[1] ?? 0,
    offsetZ: offsets[2] ?? 0,
    palette: outPalette,
    colours: colourIndex.toString("base64"),
    heights: heights.toString("base64"),
    blockCounts: [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, count]) => ({ name, count })),
  };
}
