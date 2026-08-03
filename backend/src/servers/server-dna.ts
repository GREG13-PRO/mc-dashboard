import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { readPluginManifest, installPlugin, type PluginSource } from "./plugin-manager";
import { readProperties } from "./properties";
import { detectMinecraftVersion } from "./version-check";
import { isServerRunning } from "./process-manager";
import { resolveSafePath } from "../files/safe-path";
import type { ServerEntry } from "../types";

/**
 * A server's identity in one file: what it runs, how it is configured, and
 * which plugins it has, so the same server can be rebuilt on another machine.
 *
 * Deliberately not the world. A world is gigabytes and is what backups are
 * for; what is hard to reproduce by hand is the hundred settings and the exact
 * set of plugin versions, and that is what this carries. The seed is included
 * so a fresh generation can at least match.
 *
 * Secrets are left out unless asked for. An export is a file that gets emailed
 * and dropped in chat, and this project has already been through one
 * compromise - an RCON password riding along by default is not a risk worth
 * taking for convenience.
 */

export class DnaError extends Error {}

export const DNA_VERSION = 1;

// The files worth carrying: everything that changes how a server behaves and
// that someone would otherwise have to reproduce by hand. Deliberately not
// every yml in the folder - plugin configs can be megabytes and are often
// full of per-install state.
const CONFIG_FILES = [
  "server.properties",
  "bukkit.yml",
  "spigot.yml",
  "config/paper-global.yml",
  "config/paper-world-defaults.yml",
  "config/velocity-global.yml",
  "config.yml",
];

const ACCESS_FILES = ["ops.json", "whitelist.json", "banned-players.json", "banned-ips.json"];

// Keys whose values are secrets. They are dropped from the exported
// server.properties unless secrets were explicitly requested.
const SECRET_KEYS = ["rcon.password"];

export interface DnaPlugin {
  filename: string;
  sizeBytes: number;
  sha256: string;
  /** Present only for plugins the dashboard installed, and the only ones that
   *  can be reinstalled automatically. */
  source: PluginSource | null;
  projectId: string | null;
  versionId: string | null;
  versionName: string | null;
}

export interface ServerDna {
  dnaVersion: number;
  exportedAt: string;
  includesSecrets: boolean;
  server: {
    name: string;
    startScript: string;
    stopCommand: string;
    scheduledRestart: ServerEntry["scheduledRestart"];
    crashRestart: ServerEntry["crashRestart"];
    timeMachine: ServerEntry["timeMachine"];
    rcon: { enabled: boolean; host: string; port: number; password?: string };
  };
  minecraftVersion: string | null;
  world: { levelName: string; seed: string; type: string; generateStructures: boolean };
  /** Relative path to file contents, as text. */
  files: Record<string, string>;
  access: Record<string, string>;
  startScriptContents: string | null;
  plugins: DnaPlugin[];
}

async function sha256(file: string): Promise<string> {
  return crypto.createHash("sha256").update(await fsp.readFile(file)).digest("hex");
}

async function readIfPresent(folder: string, rel: string): Promise<string | null> {
  const file = path.join(folder, rel);
  if (!fs.existsSync(file)) return null;
  const stat = await fsp.stat(file);
  // A config that big is not a config; it is a log or a database someone
  // dropped in the folder, and it has no business in an export.
  if (stat.size > 2 * 1024 * 1024) return null;
  return fsp.readFile(file, "utf-8");
}

function stripSecrets(properties: string): string {
  return properties
    .split("\n")
    .map((line) => {
      const key = line.split("=")[0]?.trim();
      return key && SECRET_KEYS.includes(key) ? `${key}=` : line;
    })
    .join("\n");
}

export async function exportDna(entry: ServerEntry, includeSecrets: boolean): Promise<ServerDna> {
  const props = readProperties(path.join(entry.folder, "server.properties"));

  const files: Record<string, string> = {};
  for (const rel of CONFIG_FILES) {
    const contents = await readIfPresent(entry.folder, rel);
    if (contents === null) continue;
    files[rel] = rel === "server.properties" && !includeSecrets ? stripSecrets(contents) : contents;
  }

  const access: Record<string, string> = {};
  for (const rel of ACCESS_FILES) {
    const contents = await readIfPresent(entry.folder, rel);
    if (contents !== null) access[rel] = contents;
  }

  const manifest = await readPluginManifest(entry);
  const pluginsDir = path.join(entry.folder, "plugins");
  const plugins: DnaPlugin[] = [];
  if (fs.existsSync(pluginsDir)) {
    for (const filename of await fsp.readdir(pluginsDir)) {
      if (!filename.toLowerCase().endsWith(".jar")) continue;
      const file = path.join(pluginsDir, filename);
      const record = manifest[filename];
      plugins.push({
        filename,
        sizeBytes: (await fsp.stat(file)).size,
        sha256: await sha256(file),
        source: record?.source ?? null,
        projectId: record?.projectId ?? null,
        versionId: record?.versionId ?? null,
        versionName: record?.versionName ?? null,
      });
    }
  }

  return {
    dnaVersion: DNA_VERSION,
    exportedAt: new Date().toISOString(),
    includesSecrets: includeSecrets,
    server: {
      name: entry.name,
      startScript: entry.startScript,
      stopCommand: entry.stopCommand,
      scheduledRestart: entry.scheduledRestart,
      crashRestart: entry.crashRestart,
      timeMachine: entry.timeMachine,
      rcon: {
        enabled: entry.rcon.enabled,
        host: entry.rcon.host,
        port: entry.rcon.port,
        ...(includeSecrets ? { password: entry.rcon.password } : {}),
      },
    },
    minecraftVersion: await detectMinecraftVersion(entry).catch(() => null),
    world: {
      levelName: props["level-name"] ?? "world",
      seed: props["level-seed"] ?? "",
      type: props["level-type"] ?? "minecraft:normal",
      generateStructures: props["generate-structures"] !== "false",
    },
    files,
    access,
    startScriptContents: await readIfPresent(entry.folder, entry.startScript),
    plugins,
  };
}

export interface ImportReport {
  wroteFiles: string[];
  installedPlugins: string[];
  /** Plugins the dashboard did not install originally, so it has no source to
   *  fetch them from. Listed so nobody discovers the gap at first start. */
  manualPlugins: string[];
  failedPlugins: { filename: string; error: string }[];
}

function assertDna(dna: unknown): asserts dna is ServerDna {
  const candidate = dna as Partial<ServerDna>;
  if (!candidate || typeof candidate !== "object") throw new DnaError("Üres vagy hibás fájl.");
  if (candidate.dnaVersion !== DNA_VERSION) {
    throw new DnaError(`Ismeretlen DNS-formátum (${String(candidate.dnaVersion)}).`);
  }
  if (!candidate.server || typeof candidate.server.name !== "string") {
    throw new DnaError("A fájlban nincs szerverleírás.");
  }
}

/**
 * Applies a DNA file to an existing server folder.
 *
 * Applied rather than creating the folder: the machine this is restored onto
 * needs a server jar and a start script in place first, and inventing where
 * those come from would be guessing. Everything written goes through the same
 * sandbox check as any other file the dashboard writes.
 */
export async function importDna(
  entry: ServerEntry,
  raw: unknown,
  options: { plugins: boolean; access: boolean }
): Promise<ImportReport> {
  assertDna(raw);
  const dna = raw;
  if (await isServerRunning(entry)) {
    throw new DnaError("Ehhez le kell állítani a szervert.");
  }

  const report: ImportReport = {
    wroteFiles: [],
    installedPlugins: [],
    manualPlugins: [],
    failedPlugins: [],
  };

  const toWrite: Record<string, string> = { ...dna.files, ...(options.access ? dna.access : {}) };
  for (const [rel, contents] of Object.entries(toWrite)) {
    const dest = resolveSafePath(entry.folder, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, contents, "utf-8");
    report.wroteFiles.push(rel);
  }

  if (options.plugins) {
    for (const plugin of dna.plugins) {
      if (!plugin.source || !plugin.projectId || !plugin.versionId) {
        report.manualPlugins.push(plugin.filename);
        continue;
      }
      try {
        await installPlugin(entry, plugin.source, plugin.projectId, plugin.versionId);
        report.installedPlugins.push(plugin.filename);
      } catch (err) {
        report.failedPlugins.push({ filename: plugin.filename, error: (err as Error).message });
      }
    }
  }

  return report;
}
