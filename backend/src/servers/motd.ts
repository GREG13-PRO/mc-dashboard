import fs from "node:fs";
import path from "node:path";
import { readProperties, writeProperties } from "./properties";
import type { ServerEntry } from "../types";

/**
 * The two things a player sees before they ever join: the line under the server
 * name, and the little square beside it.
 *
 * Both are already editable in the crudest possible way - the MOTD is a
 * server.properties key and the icon is a file you could upload through the
 * file browser - which is exactly why they are worth a screen. Nobody types
 * `§6` into a text box on purpose, and nobody discovers on their own that
 * the icon has to be a 64x64 PNG called server-icon.png or the server ignores
 * it without a word.
 */

export class MotdError extends Error {}

const ICON_NAME = "server-icon.png";

/**
 * Minecraft truncates the server list line at 59 characters. Colour codes count
 * towards that, which is the part that surprises people, so the limit is
 * enforced on the raw string rather than on what it renders to.
 */
export const MAX_MOTD_LENGTH = 118; // 59 per line, two lines.

export function propertiesPath(entry: ServerEntry): string {
  return path.join(entry.folder, "server.properties");
}

export function hasProperties(entry: ServerEntry): boolean {
  return fs.existsSync(propertiesPath(entry));
}

export function readMotd(entry: ServerEntry): string {
  return readProperties(propertiesPath(entry)).motd ?? "";
}

export function writeMotd(entry: ServerEntry, motd: string): void {
  if (motd.length > MAX_MOTD_LENGTH) {
    throw new MotdError(`A MOTD legfeljebb ${MAX_MOTD_LENGTH} karakter lehet.`);
  }
  const lines = motd.split("\n");
  if (lines.length > 2) {
    throw new MotdError("A MOTD legfeljebb két sor lehet.");
  }
  // A trailing code with nothing after it does nothing and usually means the
  // user stopped mid-thought; a dangling section sign is worth saying out loud
  // rather than silently writing a line that renders one character short.
  if (/§$/.test(motd)) {
    throw new MotdError("A MOTD nem végződhet befejezetlen színkóddal.");
  }
  writeProperties(propertiesPath(entry), { motd });
}

export function iconPath(entry: ServerEntry): string {
  return path.join(entry.folder, ICON_NAME);
}

export function hasIcon(entry: ServerEntry): boolean {
  return fs.existsSync(iconPath(entry));
}

/**
 * Reads a PNG's declared size out of its header.
 *
 * The signature is eight fixed bytes and IHDR is always the first chunk, with
 * width and height as the first two big-endian 32-bit fields of its payload.
 * That is the whole check: a file that is not a PNG fails at the signature, and
 * a PNG of the wrong size fails here - both before anything is written.
 */
function pngSize(buffer: Buffer): { width: number; height: number } | null {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(SIGNATURE)) return null;
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function saveIcon(entry: ServerEntry, buffer: Buffer): void {
  const size = pngSize(buffer);
  if (!size) {
    throw new MotdError("Ez nem PNG fájl.");
  }
  if (size.width !== 64 || size.height !== 64) {
    throw new MotdError(
      `A szerverikonnak pontosan 64x64 pixelesnek kell lennie (ez ${size.width}x${size.height}).`
    );
  }
  fs.writeFileSync(iconPath(entry), buffer);
}

export function removeIcon(entry: ServerEntry): void {
  if (hasIcon(entry)) fs.rmSync(iconPath(entry));
}
