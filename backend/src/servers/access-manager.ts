import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { writeProperties } from "./properties";
import type { ServerEntry } from "../types";

export interface AccessEntry {
  name: string;
  uuid: string | null;
  reason: string | null;
  created: string | null;
}

export interface AccessLists {
  whitelist: AccessEntry[];
  bannedPlayers: AccessEntry[];
  bannedIps: AccessEntry[];
  /** Reflects `white-list` in server.properties, not whether the file is empty. */
  whitelistEnforced: boolean;
}

interface RawEntry {
  uuid?: string;
  name?: string;
  ip?: string;
  reason?: string;
  created?: string;
}

/**
 * Minecraft owns these files and rewrites them on save, so they are read
 * rather than cached. Reading them directly (instead of asking the server over
 * RCON) is deliberate: it means the lists are still visible and editable while
 * the server is stopped, which is exactly when someone is most likely to be
 * fixing a bad ban.
 */
async function readJsonList(folder: string, filename: string): Promise<AccessEntry[]> {
  const file = path.join(folder, filename);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = await fsp.readFile(file, "utf-8");
    const parsed = raw.trim() ? (JSON.parse(raw) as RawEntry[]) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((e) => ({
      name: e.name ?? e.ip ?? "(ismeretlen)",
      uuid: e.uuid ?? null,
      reason: e.reason ?? null,
      created: e.created ?? null,
    }));
  } catch {
    // A half-written file during a server save shouldn't blank the whole view.
    return [];
  }
}

function readWhitelistEnforced(folder: string): boolean {
  const file = path.join(folder, "server.properties");
  if (!fs.existsSync(file)) return false;
  try {
    return /^white-list\s*=\s*true\s*$/m.test(fs.readFileSync(file, "utf-8"));
  } catch {
    return false;
  }
}

export async function readAccessLists(entry: ServerEntry): Promise<AccessLists> {
  const [whitelist, bannedPlayers, bannedIps] = await Promise.all([
    readJsonList(entry.folder, "whitelist.json"),
    readJsonList(entry.folder, "banned-players.json"),
    readJsonList(entry.folder, "banned-ips.json"),
  ]);
  return { whitelist, bannedPlayers, bannedIps, whitelistEnforced: readWhitelistEnforced(entry.folder) };
}

/**
 * Persists the whitelist on/off switch into server.properties. The console
 * command alone only changes the running server's in-memory state on some
 * versions, and the dashboard has already been bitten once by its own config
 * drifting away from the server's real one (see rcon-sync).
 */
export function setWhitelistEnforced(entry: ServerEntry, enabled: boolean): void {
  const file = path.join(entry.folder, "server.properties");
  if (!fs.existsSync(file)) {
    throw new Error("Ennek a szervernek nincs server.properties fájlja (proxy?), a whitelist itt nem értelmezhető.");
  }
  writeProperties(file, { "white-list": String(enabled) });
}

export function setPropertiesFileExists(entry: ServerEntry): boolean {
  return fs.existsSync(path.join(entry.folder, "server.properties"));
}
