import zlib from "node:zlib";
import { EMPTY, type RegionSurface } from "./map-surface";

/**
 * Renders a region's surface into a PNG.
 *
 * The PNG is written by hand rather than pulling in an image library: the
 * format is a zlib stream of filtered scanlines wrapped in four chunks, zlib
 * is already in Node, and this avoids a native dependency on a VM where every
 * install has to be justified.
 */

type Rgb = [number, number, number];

// Enough of the palette to make a lobby or a survival world legible. Anything
// unlisted falls back to a hash-derived colour, which keeps unknown blocks
// visually distinct instead of collapsing them all into one grey.
const COLOURS: Record<string, Rgb> = {
  grass_block: [106, 150, 68],
  dirt: [134, 96, 67],
  coarse_dirt: [119, 85, 59],
  podzol: [90, 63, 26],
  stone: [125, 125, 125],
  cobblestone: [122, 122, 122],
  mossy_cobblestone: [104, 122, 96],
  andesite: [136, 136, 136],
  diorite: [188, 188, 188],
  granite: [149, 103, 86],
  deepslate: [80, 80, 84],
  bedrock: [60, 60, 60],
  sand: [219, 207, 163],
  red_sand: [190, 102, 33],
  sandstone: [216, 203, 155],
  gravel: [131, 127, 126],
  water: [63, 118, 228],
  lava: [217, 88, 22],
  snow: [248, 248, 248],
  snow_block: [243, 244, 251],
  ice: [145, 183, 253],
  packed_ice: [141, 180, 250],
  clay: [160, 166, 179],
  oak_log: [102, 81, 50],
  spruce_log: [58, 39, 20],
  birch_log: [216, 213, 203],
  oak_planks: [162, 130, 78],
  spruce_planks: [114, 84, 48],
  birch_planks: [196, 179, 123],
  dark_oak_planks: [66, 43, 20],
  oak_leaves: [60, 143, 42],
  spruce_leaves: [47, 94, 47],
  birch_leaves: [124, 168, 84],
  dark_oak_leaves: [58, 129, 40],
  grass: [95, 148, 60],
  tall_grass: [95, 148, 60],
  fern: [88, 140, 55],
  white_wool: [233, 236, 236],
  light_gray_wool: [142, 142, 134],
  gray_wool: [62, 68, 71],
  black_wool: [20, 21, 25],
  red_wool: [160, 39, 34],
  orange_wool: [240, 118, 19],
  yellow_wool: [248, 197, 39],
  lime_wool: [112, 185, 25],
  green_wool: [84, 109, 27],
  cyan_wool: [21, 137, 145],
  light_blue_wool: [58, 175, 217],
  blue_wool: [44, 46, 143],
  purple_wool: [126, 61, 181],
  magenta_wool: [189, 68, 179],
  pink_wool: [237, 141, 172],
  brown_wool: [114, 71, 40],
  glass: [175, 213, 219],
  white_stained_glass: [225, 231, 231],
  quartz_block: [235, 229, 222],
  smooth_quartz: [235, 229, 222],
  white_concrete: [207, 213, 214],
  gray_concrete: [54, 57, 61],
  black_concrete: [8, 10, 15],
  red_concrete: [142, 32, 32],
  blue_concrete: [44, 46, 143],
  yellow_concrete: [240, 175, 21],
  lime_concrete: [94, 168, 24],
  bricks: [150, 97, 83],
  stone_bricks: [122, 122, 122],
  netherrack: [97, 38, 38],
  end_stone: [219, 222, 158],
  obsidian: [15, 10, 24],
  glowstone: [173, 139, 96],
  sea_lantern: [172, 199, 190],
  prismarine: [99, 156, 151],
  farmland: [95, 62, 35],
  path: [148, 121, 65],
  dirt_path: [148, 121, 65],

  // Nether and End. Without these the two dimensions render almost entirely
  // from the hash fallback, which is stable but arbitrary - and since their
  // terrain is made of a handful of block types, a wrong palette there is far
  // more visible than in the overworld.
  crimson_nylium: [130, 31, 31],
  warped_nylium: [22, 121, 101],
  soul_sand: [81, 62, 50],
  soul_soil: [76, 58, 47],
  nether_bricks: [44, 21, 26],
  red_nether_bricks: [69, 5, 6],
  nether_wart_block: [114, 3, 3],
  warped_wart_block: [20, 139, 141],
  basalt: [80, 80, 87],
  smooth_basalt: [72, 72, 80],
  polished_basalt: [90, 90, 97],
  blackstone: [42, 35, 40],
  gilded_blackstone: [56, 41, 39],
  magma_block: [142, 62, 26],
  crimson_stem: [92, 25, 29],
  warped_stem: [58, 58, 74],
  shroomlight: [240, 146, 70],
  ancient_debris: [67, 46, 42],
  purpur_block: [169, 125, 169],
  purpur_pillar: [172, 129, 172],
  chorus_plant: [93, 60, 93],
  chorus_flower: [149, 128, 149],
  end_stone_bricks: [218, 224, 162],
};

/** Stable pseudo-colour so an unmapped block is at least consistent. */
function fallbackColour(name: string): Rgb {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return [((h >>> 16) & 0x7f) + 80, ((h >>> 8) & 0x7f) + 80, (h & 0x7f) + 80];
}

export function colourOf(block: string): Rgb {
  return COLOURS[block] ?? fallbackColour(block);
}

/** Height shading, so terrain relief is visible rather than a flat colour field. */
function shade([r, g, b]: Rgb, y: number): Rgb {
  // Normalised against the usual build range; clamped so caves and towers do
  // not wash out to black or white.
  const factor = Math.max(0.55, Math.min(1.35, 0.75 + (y + 64) / 320));
  return [
    Math.max(0, Math.min(255, Math.round(r * factor))),
    Math.max(0, Math.min(255, Math.round(g * factor))),
    Math.max(0, Math.min(255, Math.round(b * factor))),
  ];
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes RGBA pixels as a PNG. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Filter type 0 (none) per scanline; the data is already small once deflated
  // and adaptive filtering is not worth the code here.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const REGION_PIXELS = 512;

/**
 * Draws one region as a 512x512 PNG - one pixel per block column. Columns with
 * no block stay fully transparent so the client can tile regions without
 * painting over its background.
 */
export function renderSurfacePng(surface: RegionSurface): Buffer {
  const size = REGION_PIXELS;
  const rgba = Buffer.alloc(size * size * 4);
  // Palette colours are resolved once per region rather than per pixel; a
  // region is a quarter of a million columns and the lookup includes a hash
  // for every block the table does not know.
  const colours = surface.palette.map(colourOf);

  for (let i = 0; i < size * size; i++) {
    const block = surface.blocks[i];
    if (block === EMPTY) continue;
    const [r, g, b] = shade(colours[block] ?? [128, 128, 128], surface.heights[i]);
    const p = i * 4;
    rgba[p] = r;
    rgba[p + 1] = g;
    rgba[p + 2] = b;
    rgba[p + 3] = 255;
  }
  return encodePng(size, size, rgba);
}
