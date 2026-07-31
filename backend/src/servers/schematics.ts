import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { sendCommand, isServerRunning } from "./process-manager";
import { resolveSafePath } from "../files/safe-path";
import type { ServerEntry } from "../types";

const gunzip = promisify(zlib.gunzip);

/**
 * Schematic library.
 *
 * Files live where WorldEdit already looks for them, so anything uploaded here
 * is immediately usable with //schem load, and anything saved in game shows up
 * here without an import step. Pasting is done by issuing the WorldEdit
 * commands rather than by writing blocks ourselves - the format is WorldEdit's
 * and it is the thing that knows how to read it.
 */

export class SchematicError extends Error {}

const NAME_RE = /^[A-Za-z0-9._-]{1,80}\.(schem|schematic)$/;

export interface Schematic {
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Block dimensions, read from the NBT header; null when unreadable. */
  size: { x: number; y: number; z: number } | null;
}

/** WorldEdit's own folder, so the library and the plugin share one directory. */
function schematicDir(entry: ServerEntry): string {
  return path.join(entry.folder, "plugins", "WorldEdit", "schematics");
}

export function hasWorldEdit(entry: ServerEntry): boolean {
  const dir = path.join(entry.folder, "plugins");
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).some((f) => /^(fast-?async)?worldedit.*\.jar$/i.test(f));
  } catch {
    return false;
  }
}

/**
 * Reads the Width/Height/Length shorts out of a sponge schematic.
 *
 * A deliberately shallow parse: the file is gzipped NBT, and rather than
 * implementing a full reader just to show dimensions, this finds the three
 * named tags directly. Anything unexpected yields null and the UI omits the
 * size instead of failing the listing.
 */
async function readDimensions(file: string): Promise<Schematic["size"]> {
  try {
    const raw = await fsp.readFile(file);
    // Both .schem and .schematic are gzipped; a plain file is also accepted.
    const nbt = raw[0] === 0x1f && raw[1] === 0x8b ? await gunzip(raw) : raw;
    const readShortAfter = (tag: string): number | null => {
      const index = nbt.indexOf(Buffer.from(tag, "utf-8"));
      if (index < 0) return null;
      const at = index + tag.length;
      if (at + 2 > nbt.length) return null;
      return nbt.readUInt16BE(at);
    };
    const x = readShortAfter("Width");
    const y = readShortAfter("Height");
    const z = readShortAfter("Length");
    return x !== null && y !== null && z !== null ? { x, y, z } : null;
  } catch {
    return null;
  }
}

export async function listSchematics(entry: ServerEntry): Promise<Schematic[]> {
  const dir = schematicDir(entry);
  if (!fs.existsSync(dir)) return [];
  const files = (await fsp.readdir(dir)).filter((f) => /\.(schem|schematic)$/i.test(f));
  const out = await Promise.all(
    files.map(async (filename) => {
      const full = path.join(dir, filename);
      const stat = await fsp.stat(full);
      return {
        filename,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        size: await readDimensions(full),
      };
    })
  );
  return out.sort((a, b) => a.filename.localeCompare(b.filename, "hu"));
}

export async function saveSchematic(entry: ServerEntry, filename: string, data: Buffer): Promise<Schematic> {
  // A path separator in an upload name is refused rather than quietly reduced
  // to its basename. Reducing it is safe - resolveSafePath below would catch
  // any escape anyway - but it silently stores the file under a different name
  // than the caller asked for, which is confusing when it later cannot be
  // found.
  if (/[\\/]/.test(filename)) {
    throw new SchematicError("A fájlnév nem tartalmazhat útvonalat.");
  }
  const base = path.basename(filename);
  if (!NAME_RE.test(base)) {
    throw new SchematicError("Csak .schem vagy .schematic fájl tölthető fel, egyszerű névvel.");
  }
  const dir = schematicDir(entry);
  await fsp.mkdir(dir, { recursive: true });
  const target = resolveSafePath(dir, base);
  await fsp.writeFile(target, data);
  const stat = await fsp.stat(target);
  return {
    filename: base,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    size: await readDimensions(target),
  };
}

export async function deleteSchematic(entry: ServerEntry, filename: string): Promise<void> {
  if (!NAME_RE.test(filename)) throw new SchematicError("Érvénytelen fájlnév.");
  await fsp.rm(resolveSafePath(schematicDir(entry), filename), { force: true });
}

export function resolveSchematicPath(entry: ServerEntry, filename: string): string {
  if (!NAME_RE.test(filename)) throw new SchematicError("Érvénytelen fájlnév.");
  return resolveSafePath(schematicDir(entry), filename);
}

const COORD_RE = /^-?\d{1,7}$/;

export interface PasteOptions {
  filename: string;
  /** Player whose session runs the paste, or coordinates for a console paste. */
  player?: string;
  x?: string;
  y?: string;
  z?: string;
  world?: string;
  ignoreAir?: boolean;
}

const PLAYER_RE = /^[A-Za-z0-9_]{1,16}$/;
const WORLD_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Pastes a schematic by driving WorldEdit from the console.
 *
 * WorldEdit is session-based: `//schem load` and `//paste` act on whoever runs
 * them, so a console paste has to borrow a player's session via `/execute` -
 * hence requiring either an online player or explicit coordinates.
 */
export async function pasteSchematic(entry: ServerEntry, options: PasteOptions): Promise<string[]> {
  if (!hasWorldEdit(entry)) {
    throw new SchematicError("Ehhez a szerverhez nincs telepítve a WorldEdit.");
  }
  if (!(await isServerRunning(entry))) {
    throw new SchematicError("A bepakoláshoz futnia kell a szervernek.");
  }
  if (!NAME_RE.test(options.filename)) throw new SchematicError("Érvénytelen fájlnév.");

  const name = options.filename.replace(/\.(schem|schematic)$/i, "");
  const commands: string[] = [];

  if (options.player) {
    if (!PLAYER_RE.test(options.player)) throw new SchematicError("Érvénytelen játékosnév.");
    // Runs in the player's own session and at their position - the same thing
    // they would get by typing it themselves.
    commands.push(`execute as ${options.player} run /schem load ${name}`);
    commands.push(`execute as ${options.player} run /paste${options.ignoreAir ? " -a" : ""}`);
  } else {
    for (const value of [options.x, options.y, options.z]) {
      if (!value || !COORD_RE.test(value)) {
        throw new SchematicError("Adj meg egy online játékost, vagy három egész koordinátát.");
      }
    }
    if (options.world && !WORLD_RE.test(options.world)) throw new SchematicError("Érvénytelen világnév.");
    const world = options.world ?? "world";
    commands.push(`/world ${world}`);
    commands.push(`/schem load ${name}`);
    commands.push(`/pos1 ${options.x},${options.y},${options.z}`);
    commands.push(`/paste${options.ignoreAir ? " -a" : ""}`);
  }

  for (const command of commands) {
    await sendCommand(entry, command);
    await new Promise((r) => setTimeout(r, 500));
  }
  return commands;
}
