import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "../config/env";
import { serverRegistry } from "./registry";
import { isServerRunning, sendCommand } from "./process-manager";
import type { ServerEntry } from "../types";

/**
 * Minute-by-minute world snapshots you can scrub back through.
 *
 * Not a backup: a full copy every minute would fill the disk in under an hour.
 * Instead the world is stored content-addressed - each region file is written
 * once under its own hash, and a snapshot is just a manifest mapping paths to
 * hashes. A minute in which nothing changed costs one small JSON file, and a
 * region that has not been touched since the first snapshot is stored once no
 * matter how many snapshots reference it.
 *
 * Off by default for exactly that reason: even diffed, an active world can
 * churn tens of megabytes a minute, and this project's VM is small.
 */

const WORLD_FILE_RE = /\.(mca|mcr|dat)$/i;
// Only the world folders; plugin data and jars are not what a rewind is for.
const WORLD_DIR_RE = /^(world|world_nether|world_the_end|[A-Za-z0-9_-]*world[A-Za-z0-9_-]*)$/i;

export interface TimelineSnapshot {
  id: string;
  at: string;
  fileCount: number;
  /** Bytes this snapshot added that no earlier snapshot already held. */
  addedBytes: number;
}

interface Manifest {
  at: string;
  files: Record<string, { hash: string; size: number }>;
}

function timelineDir(entry: ServerEntry): string {
  return path.join(env.dataDir, "timeline", entry.id);
}

function objectsDir(entry: ServerEntry): string {
  return path.join(timelineDir(entry), "objects");
}

function snapshotsDir(entry: ServerEntry): string {
  return path.join(timelineDir(entry), "snapshots");
}

async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** World files under the server folder, relative to it. */
async function worldFiles(entry: ServerEntry): Promise<string[]> {
  const out: string[] = [];
  let roots: string[];
  try {
    roots = (await fsp.readdir(entry.folder, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && WORLD_DIR_RE.test(d.name))
      .map((d) => d.name);
  } catch {
    return out;
  }

  async function walk(rel: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(path.join(entry.folder, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = path.join(rel, e.name);
      if (e.isDirectory()) await walk(childRel);
      else if (e.isFile() && WORLD_FILE_RE.test(e.name)) out.push(childRel);
    }
  }

  for (const root of roots) await walk(root);
  return out;
}

/**
 * Takes one snapshot. A running server is asked to flush first, otherwise the
 * region files on disk lag behind the world by up to several minutes and the
 * timeline records stale state.
 */
export async function takeSnapshot(entry: ServerEntry): Promise<TimelineSnapshot> {
  const running = await isServerRunning(entry);
  if (running) {
    await sendCommand(entry, "save-all flush").catch(() => undefined);
    // Give the flush a moment to land before reading the files.
    await new Promise((r) => setTimeout(r, 3000));
  }

  await fsp.mkdir(objectsDir(entry), { recursive: true });
  await fsp.mkdir(snapshotsDir(entry), { recursive: true });

  const files: Manifest["files"] = {};
  let addedBytes = 0;

  for (const rel of await worldFiles(entry)) {
    const abs = path.join(entry.folder, rel);
    let hash: string;
    let size: number;
    try {
      size = (await fsp.stat(abs)).size;
      hash = await hashFile(abs);
    } catch {
      // A file being rewritten mid-read is skipped rather than failing the run.
      continue;
    }
    files[rel] = { hash, size };

    const objectPath = path.join(objectsDir(entry), hash);
    if (!fs.existsSync(objectPath)) {
      await fsp.copyFile(abs, objectPath);
      addedBytes += size;
    }
  }

  const at = new Date().toISOString();
  const id = at.replace(/[:.]/g, "-");
  const manifest: Manifest = { at, files };
  await fsp.writeFile(path.join(snapshotsDir(entry), `${id}.json`), JSON.stringify(manifest), "utf-8");

  await prune(entry);
  return { id, at, fileCount: Object.keys(files).length, addedBytes };
}

/** Drops the oldest snapshots past the configured cap, then any stored object
 * no surviving snapshot still references. */
async function prune(entry: ServerEntry): Promise<void> {
  const max = entry.timeMachine?.maxSnapshots ?? 60;
  const dir = snapshotsDir(entry);
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  for (const stale of files.slice(0, Math.max(0, files.length - max))) {
    await fsp.rm(path.join(dir, stale), { force: true });
  }

  const kept = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
  const referenced = new Set<string>();
  for (const f of kept) {
    try {
      const manifest = JSON.parse(await fsp.readFile(path.join(dir, f), "utf-8")) as Manifest;
      for (const { hash } of Object.values(manifest.files)) referenced.add(hash);
    } catch {
      continue;
    }
  }

  for (const object of await fsp.readdir(objectsDir(entry))) {
    if (!referenced.has(object)) await fsp.rm(path.join(objectsDir(entry), object), { force: true });
  }
}

export async function listSnapshots(entry: ServerEntry): Promise<TimelineSnapshot[]> {
  const dir = snapshotsDir(entry);
  if (!fs.existsSync(dir)) return [];
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const out: TimelineSnapshot[] = [];
  for (const f of files) {
    try {
      const manifest = JSON.parse(await fsp.readFile(path.join(dir, f), "utf-8")) as Manifest;
      out.push({
        id: f.replace(/\.json$/, ""),
        at: manifest.at,
        fileCount: Object.keys(manifest.files).length,
        addedBytes: 0,
      });
    } catch {
      continue;
    }
  }
  return out;
}

export async function timelineSize(entry: ServerEntry): Promise<number> {
  const dir = objectsDir(entry);
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const f of await fsp.readdir(dir)) {
    try {
      total += (await fsp.stat(path.join(dir, f))).size;
    } catch {
      continue;
    }
  }
  return total;
}

export class TimelineError extends Error {}

/**
 * Rewinds the world to a snapshot. Requires the server stopped: a running
 * server holds region files open and would write its in-memory chunks straight
 * back over whatever was restored.
 */
export async function restoreSnapshot(entry: ServerEntry, id: string): Promise<number> {
  if (!/^[\d-]+T[\d-]+Z?$/.test(id)) throw new TimelineError("Invalid snapshot id");
  if (await isServerRunning(entry)) {
    throw new TimelineError("A visszaállításhoz le kell állítani a szervert.");
  }
  const file = path.join(snapshotsDir(entry), `${id}.json`);
  if (!fs.existsSync(file)) throw new TimelineError("Nincs ilyen pillanatkép.");

  const manifest = JSON.parse(await fsp.readFile(file, "utf-8")) as Manifest;
  let restored = 0;
  for (const [rel, { hash }] of Object.entries(manifest.files)) {
    const object = path.join(objectsDir(entry), hash);
    if (!fs.existsSync(object)) continue;
    const target = path.join(entry.folder, rel);
    // The manifest's paths came from walking this folder, but they are read
    // back off disk, so containment is re-checked before writing.
    if (!target.startsWith(entry.folder + path.sep)) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(object, target);
    restored++;
  }
  return restored;
}


// ------------------------------------------------------------------- rewinding

/**
 * The relative region folders each dimension can live in.
 *
 * The same list map-service uses, kept here rather than imported because
 * importing it the other way round would make the map depend on the time
 * machine - and the map has to work with the time machine switched off.
 */
const DIMENSION_REGION_DIRS: Record<string, string[]> = {
  overworld: ["world/region"],
  nether: ["world_nether/DIM-1/region", "world/DIM-1/region"],
  end: ["world_the_end/DIM1/region", "world/DIM1/region"],
};

async function readManifest(entry: ServerEntry, id: string): Promise<Manifest> {
  if (!/^[\d-]+T[\d-]+Z?$/.test(id)) throw new TimelineError("Invalid snapshot id");
  const file = path.join(snapshotsDir(entry), `${id}.json`);
  if (!fs.existsSync(file)) throw new TimelineError("Nincs ilyen pillanatkép.");
  return JSON.parse(await fsp.readFile(file, "utf-8")) as Manifest;
}

/**
 * Lays a snapshot's region files out as a folder the map can read.
 *
 * The object store holds each file once under its hash, which is the whole
 * reason a snapshot is cheap - but nothing can read a world out of it, because
 * the names are gone. Rather than teach the map reader about the store, the
 * files are linked back into a folder with their real names. Hard links, so a
 * rewind of a 40 MB world costs directory entries rather than 40 MB, and the
 * store's copy stays the only one.
 *
 * Kept between calls: scrubbing back and forth through snapshots would
 * otherwise rebuild the same folder every time. Cleared with the timeline.
 */
export async function materialiseRegions(
  entry: ServerEntry,
  id: string,
  dim: string
): Promise<string | null> {
  const manifest = await readManifest(entry, id);
  const prefixes = DIMENSION_REGION_DIRS[dim] ?? [];
  const wanted = Object.entries(manifest.files).filter(([rel]) =>
    prefixes.some((p) => rel.startsWith(`${p}/`)) && rel.endsWith(".mca")
  );
  if (wanted.length === 0) return null;

  const out = path.join(timelineDir(entry), "materialised", id, dim);
  await fsp.mkdir(out, { recursive: true });
  for (const [rel, { hash }] of wanted) {
    const object = path.join(objectsDir(entry), hash);
    if (!fs.existsSync(object)) continue;
    const target = path.join(out, path.basename(rel));
    if (fs.existsSync(target)) continue;
    try {
      await fsp.link(object, target);
    } catch {
      // Different filesystem, or a hard link limit: a copy still works, it
      // just costs the bytes.
      await fsp.copyFile(object, target);
    }
  }
  return out;
}

export interface ChangedFile {
  path: string;
  /** Absent from the world now, present in the snapshot. */
  missingNow: boolean;
  bytes: number;
}

/**
 * Which world files a rewind would actually change.
 *
 * Compared by hash, so a region the server rewrote without changing anything
 * inside it - which happens on every save - does not appear. Answering "what
 * would this do" before doing it is the difference between a rewind and a
 * gamble.
 */
export async function changedFiles(entry: ServerEntry, id: string): Promise<ChangedFile[]> {
  const manifest = await readManifest(entry, id);
  const out: ChangedFile[] = [];
  for (const [rel, { hash, size }] of Object.entries(manifest.files)) {
    const live = path.join(entry.folder, rel);
    if (!live.startsWith(entry.folder + path.sep)) continue;
    if (!fs.existsSync(live)) {
      out.push({ path: rel, missingNow: true, bytes: size });
      continue;
    }
    if ((await hashFile(live)) !== hash) out.push({ path: rel, missingNow: false, bytes: size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Restores only the named files.
 *
 * The whole-world restore is still there and is the right answer for "undo the
 * afternoon". This is for the other case: one region got griefed and the rest
 * of the world has a day's building in it that nobody wants to lose.
 */
export async function restoreFiles(
  entry: ServerEntry,
  id: string,
  paths: string[]
): Promise<number> {
  if (await isServerRunning(entry)) {
    throw new TimelineError("A visszaállításhoz le kell állítani a szervert.");
  }
  const manifest = await readManifest(entry, id);
  const wanted = new Set(paths);
  let restored = 0;
  for (const [rel, { hash }] of Object.entries(manifest.files)) {
    if (!wanted.has(rel)) continue;
    const object = path.join(objectsDir(entry), hash);
    if (!fs.existsSync(object)) continue;
    const target = path.join(entry.folder, rel);
    // The manifest's paths came from walking this folder, but they are read
    // back off disk, so containment is re-checked before writing.
    if (!target.startsWith(entry.folder + path.sep)) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(object, target);
    restored++;
  }
  return restored;
}

export async function deleteTimeline(entry: ServerEntry): Promise<void> {
  await fsp.rm(timelineDir(entry), { recursive: true, force: true });
}

// ------------------------------------------------------------------ scheduler

let timer: NodeJS.Timeout | null = null;
const lastRun = new Map<string, number>();

export function startTimeMachine(intervalMs = 30_000): void {
  if (timer) return;
  timer = setInterval(() => void tick(), intervalMs);
}

export function stopTimeMachine(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  for (const entry of serverRegistry.list()) {
    const config = entry.timeMachine;
    if (!config?.enabled) continue;
    // Only running servers: a stopped world is not changing, and snapshotting
    // it would just push real history out of the retention window.
    if (!(await isServerRunning(entry))) continue;

    const intervalMs = Math.max(1, config.intervalMinutes) * 60_000;
    const previous = lastRun.get(entry.id) ?? 0;
    if (Date.now() - previous < intervalMs) continue;
    lastRun.set(entry.id, Date.now());

    await takeSnapshot(entry).catch((err) =>
      console.error(`[time-machine] Snapshot failed for "${entry.name}":`, err)
    );
  }
}
