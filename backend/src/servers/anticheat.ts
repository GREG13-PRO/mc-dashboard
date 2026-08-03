import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { publishedFor, buildPath } from "../app-dist/app-dist";
import { isServerRunning } from "./process-manager";
import type { ServerEntry } from "../types";

/**
 * Reads what the McDashGuard plugin saw.
 *
 * The plugin exists because these two signals cannot be had from outside the
 * server: whether a broken ore had been visible, and how fast someone was
 * actually moving. Everything else in the security tab is read off disk; this
 * is the part that needs code running inside Minecraft.
 *
 * The dashboard only ever reads the file. It does not talk to the plugin and
 * the plugin does not talk back - there is no port and no protocol to keep
 * compatible, just a JSON file that is rewritten every half minute.
 */

export class AntiCheatError extends Error {}

const PLUGIN_DIR = "McDashGuard";
const REPORT = "report.json";

export interface AntiCheatFlag {
  kind: string;
  detail: string;
  at: string;
}

export interface AntiCheatPlayer {
  name: string;
  blocksBroken: number;
  oresMined: number;
  hiddenOres: number;
  valuableOres: number;
  hiddenValuableOres: number;
  maxSpeed: number;
  flags: AntiCheatFlag[];
}

export interface AntiCheatStatus {
  installed: boolean;
  /** Version of the jar sitting in the plugins folder, from its filename. */
  installedVersion: string | null;
  /** Version the dashboard could install, if one has been published. */
  availableVersion: string | null;
  running: boolean;
  /** Null when the plugin has never written a report - a server that has not
   *  started since it was installed. */
  generatedAt: string | null;
  players: AntiCheatPlayer[];
}

function pluginsDir(entry: ServerEntry): string {
  return path.join(entry.folder, "plugins");
}

function installedJar(entry: ServerEntry): string | null {
  const dir = pluginsDir(entry);
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).find((f) => /^McDashGuard-.*\.jar$/i.test(f)) ?? null;
}

interface RawReport {
  generatedAt?: number;
  players?: AntiCheatPlayer[];
}

export async function antiCheatStatus(entry: ServerEntry): Promise<AntiCheatStatus> {
  const jar = installedJar(entry);
  const published = await publishedFor("plugin");

  let generatedAt: string | null = null;
  let players: AntiCheatPlayer[] = [];
  const report = path.join(pluginsDir(entry), PLUGIN_DIR, REPORT);
  if (fs.existsSync(report)) {
    try {
      const raw = JSON.parse(await fsp.readFile(report, "utf-8")) as RawReport;
      if (typeof raw.generatedAt === "number") {
        generatedAt = new Date(raw.generatedAt).toISOString();
      }
      players = (raw.players ?? []).map((p) => ({
        ...p,
        flags: (p.flags ?? []).map((f) => ({
          ...f,
          at: new Date(Number(f.at)).toISOString(),
        })),
      }));
    } catch {
      // A half-written report is not an error worth surfacing; the plugin
      // writes atomically, so the next read is a third of a minute away.
    }
  }

  return {
    installed: jar !== null,
    installedVersion: jar ? (/^McDashGuard-(.+)\.jar$/i.exec(jar)?.[1] ?? null) : null,
    availableVersion: published?.version ?? null,
    running: await isServerRunning(entry),
    generatedAt,
    // Most flags first, then the busiest miners: the point of the screen is
    // what to look at, not an alphabetical list.
    players: players.sort(
      (a, b) => b.flags.length - a.flags.length || b.oresMined - a.oresMined
    ),
  };
}

/**
 * Copies the published plugin jar into the server's plugins folder.
 *
 * Requires the server to be stopped: Paper reads the folder at startup, and a
 * jar dropped in beside a running server is either ignored until the next
 * restart or picked up half-loaded by a plugin manager.
 */
export async function installAntiCheat(entry: ServerEntry): Promise<string> {
  if (await isServerRunning(entry)) {
    throw new AntiCheatError("Ehhez le kell állítani a szervert.");
  }
  const published = await publishedFor("plugin");
  if (!published) {
    throw new AntiCheatError(
      "Nincs közzétett anti-cheat plugin. Töltsd fel az Alkalmazások képernyőn."
    );
  }

  const dir = pluginsDir(entry);
  await fsp.mkdir(dir, { recursive: true });
  // An older jar left beside the new one would have Paper load both and refuse
  // the second as a duplicate plugin name.
  for (const name of await fsp.readdir(dir)) {
    if (/^McDashGuard-.*\.jar$/i.test(name)) {
      await fsp.rm(path.join(dir, name), { force: true });
    }
  }
  await fsp.copyFile(buildPath(published.filename), path.join(dir, published.filename));
  return published.filename;
}

export async function removeAntiCheat(entry: ServerEntry): Promise<void> {
  if (await isServerRunning(entry)) {
    throw new AntiCheatError("Ehhez le kell állítani a szervert.");
  }
  const jar = installedJar(entry);
  if (jar) await fsp.rm(path.join(pluginsDir(entry), jar), { force: true });
}
