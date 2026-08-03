import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import archiver from "archiver";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exportDna, importDna, type ServerDna } from "./server-dna";
import { readPluginManifest } from "./plugin-manager";
import { isServerRunning } from "./process-manager";
import { snapshotConfigs } from "./config-history";
import { resolveSafePath } from "../files/safe-path";
import type { ServerEntry } from "../types";

const execFileAsync = promisify(execFile);

/**
 * Moving a server to another machine.
 *
 * There is no wizard that reaches into someone else's host, and pretending
 * otherwise would be the dishonest version of this feature: every provider is
 * different - FTP here, SFTP there, a panel API somewhere else, a web upload
 * form at the cheap end - and a transfer step that guesses would fail in a
 * different way for every one of them.
 *
 * So the transport is the browser, which works with all of them. This makes
 * one archive holding everything a server is, you download it, and the
 * dashboard on the other machine takes it back. That is the same two clicks
 * whatever the hosting looks like.
 *
 * The archive carries what the DNA file cannot: the world, and the plugin jars
 * that were not installed through the dashboard and so have no source to be
 * fetched from again.
 */

export class MigrationError extends Error {}

const BUNDLE_MARKER = "mcdash-bundle.json";
const BUNDLE_VERSION = 1;

export interface BundleOptions {
  includeWorld: boolean;
  includeSecrets: boolean;
}

interface BundleManifest {
  bundleVersion: number;
  createdAt: string;
  serverName: string;
  includesWorld: boolean;
  worldName: string | null;
  unmanagedPlugins: string[];
}

/**
 * Streams the bundle into a writable, so a multi-gigabyte world never has to
 * be held in memory or staged on a disk that may not have room for a second
 * copy.
 */
export async function writeBundle(
  entry: ServerEntry,
  options: BundleOptions,
  destination: NodeJS.WritableStream
): Promise<void> {
  const dna = await exportDna(entry, options.includeSecrets);
  const manifest = await readPluginManifest(entry);
  const pluginsDir = path.join(entry.folder, "plugins");

  const unmanaged: string[] = [];
  if (fs.existsSync(pluginsDir)) {
    for (const name of await fsp.readdir(pluginsDir)) {
      if (name.toLowerCase().endsWith(".jar") && !manifest[name]) unmanaged.push(name);
    }
  }

  const worldName = dna.world.levelName;
  const worldDir = path.join(entry.folder, worldName);
  const includesWorld = options.includeWorld && fs.existsSync(worldDir);

  const bundleManifest: BundleManifest = {
    bundleVersion: BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    serverName: entry.name,
    includesWorld,
    worldName: includesWorld ? worldName : null,
    unmanagedPlugins: unmanaged,
  };

  await new Promise<void>((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", reject);
    destination.on("close", resolve);
    destination.on("error", reject);
    archive.pipe(destination);

    archive.append(JSON.stringify(bundleManifest, null, 2), { name: BUNDLE_MARKER });
    archive.append(JSON.stringify(dna, null, 2), { name: "dna.json" });
    for (const name of unmanaged) {
      archive.file(path.join(pluginsDir, name), { name: `plugins/${name}` });
    }
    if (includesWorld) {
      // The nether and end are separate folders next to the overworld on
      // Bukkit-family servers, and a world without them arrives with players
      // standing in a Nether that no longer exists.
      for (const suffix of ["", "_nether", "_the_end"]) {
        const dir = path.join(entry.folder, `${worldName}${suffix}`);
        if (fs.existsSync(dir)) archive.directory(dir, `world/${worldName}${suffix}`);
      }
    }
    void archive.finalize();
  });
}

export interface RestoreReport {
  serverName: string;
  wroteFiles: string[];
  installedPlugins: string[];
  copiedPlugins: string[];
  restoredWorld: string | null;
  failedPlugins: { filename: string; error: string }[];
}

/**
 * Unpacks a bundle onto a server that already exists here.
 *
 * Onto an existing entry rather than creating one: the receiving machine needs
 * a server jar and a start script in place first, and inventing where those
 * come from would be guessing at the very moment someone is trusting this with
 * their whole server.
 */
export async function restoreBundle(entry: ServerEntry, zipPath: string): Promise<RestoreReport> {
  if (await isServerRunning(entry)) {
    throw new MigrationError("Ehhez le kell állítani a szervert.");
  }

  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), "mcdash-bundle-"));
  try {
    await execFileAsync("unzip", ["-o", "-q", zipPath, "-d", staging], {
      maxBuffer: 16 * 1024 * 1024,
    });

    const markerPath = path.join(staging, BUNDLE_MARKER);
    if (!fs.existsSync(markerPath)) {
      throw new MigrationError("Ez nem migrációs csomag.");
    }
    const manifest = JSON.parse(await fsp.readFile(markerPath, "utf-8")) as BundleManifest;
    if (manifest.bundleVersion !== BUNDLE_VERSION) {
      throw new MigrationError(`Ismeretlen csomagformátum (${manifest.bundleVersion}).`);
    }

    await snapshotConfigs(entry, "migrációs visszatöltés előtt");

    const dna = JSON.parse(await fsp.readFile(path.join(staging, "dna.json"), "utf-8")) as ServerDna;
    const dnaReport = await importDna(entry, dna, { plugins: true, access: true });

    const copiedPlugins: string[] = [];
    const stagedPlugins = path.join(staging, "plugins");
    if (fs.existsSync(stagedPlugins)) {
      const target = path.join(entry.folder, "plugins");
      await fsp.mkdir(target, { recursive: true });
      for (const name of await fsp.readdir(stagedPlugins)) {
        // Names come out of an archive someone else made, so they go through
        // the same sandbox check as any other path the dashboard writes.
        await fsp.copyFile(path.join(stagedPlugins, name), resolveSafePath(target, name));
        copiedPlugins.push(name);
      }
    }

    let restoredWorld: string | null = null;
    const stagedWorld = path.join(staging, "world");
    if (fs.existsSync(stagedWorld)) {
      for (const name of await fsp.readdir(stagedWorld)) {
        const destination = resolveSafePath(entry.folder, name);
        await fsp.rm(destination, { recursive: true, force: true });
        await fsp.cp(path.join(stagedWorld, name), destination, { recursive: true });
      }
      restoredWorld = manifest.worldName;
    }

    return {
      serverName: manifest.serverName,
      wroteFiles: dnaReport.wroteFiles,
      installedPlugins: dnaReport.installedPlugins,
      copiedPlugins,
      restoredWorld,
      failedPlugins: dnaReport.failedPlugins,
    };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}
