import zlib from "node:zlib";
import { EMPTY, type RegionSurface } from "./map-surface";
import { colourOf, type Rgb } from "./block-colours";

/**
 * Renders a region's surface into a PNG.
 *
 * The PNG is written by hand rather than pulling in an image library: the
 * format is a zlib stream of filtered scanlines wrapped in four chunks, zlib
 * is already in Node, and this avoids a native dependency on a VM where every
 * install has to be justified.
 */

export { colourOf } from "./block-colours";

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
