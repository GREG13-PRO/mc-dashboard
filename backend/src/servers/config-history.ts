import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import { resolveSafePath } from "../files/safe-path";
import type { ServerEntry } from "../types";

/**
 * Snapshots of a server's configuration, with a diff and a way back.
 *
 * A wrong line in server.properties or a mangled paper-global.yml is the kind
 * of mistake that shows up minutes later as a server that will not start, by
 * which point nobody remembers what the line used to say. The world already
 * has the Time Machine; this is the same idea for the files.
 *
 * Whole copies rather than the content-addressed store the world snapshots
 * use: these files are kilobytes, and a plain directory per snapshot is one
 * that can be read with `cat` when the dashboard itself is the thing that
 * broke.
 */

export class ConfigHistoryError extends Error {}

/** The files worth tracking: what changes how a server behaves. */
export const TRACKED_FILES = [
  "server.properties",
  "bukkit.yml",
  "spigot.yml",
  "config/paper-global.yml",
  "config/paper-world-defaults.yml",
  "config/velocity-global.yml",
  "config.yml",
  "ops.json",
  "whitelist.json",
  "banned-players.json",
  "banned-ips.json",
];

const MAX_SNAPSHOTS = 40;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface SnapshotFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ConfigSnapshot {
  id: string;
  at: string;
  reason: string;
  actor: string | null;
  files: SnapshotFile[];
}

function historyDir(entry: ServerEntry): string {
  return path.join(env.dataDir, "config-history", entry.id);
}

function snapshotDir(entry: ServerEntry, id: string): string {
  if (!/^\d{8}T\d{6}\d{3}Z$/.test(id)) throw new ConfigHistoryError("Érvénytelen pillanatkép.");
  return path.join(historyDir(entry), id);
}

async function pruneOldest(entry: ServerEntry): Promise<void> {
  const dir = historyDir(entry);
  let ids: string[];
  try {
    ids = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return;
  }
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SNAPSHOTS))) {
    await fsp.rm(path.join(dir, id), { recursive: true, force: true });
  }
}

/**
 * Takes a snapshot, unless nothing has changed since the last one.
 *
 * The skip matters because this is called before every config write the
 * dashboard makes: without it, saving the same settings twice would bury the
 * one snapshot anyone wants under identical copies.
 */
export async function snapshotConfigs(
  entry: ServerEntry,
  reason: string,
  actor?: string | null
): Promise<ConfigSnapshot | null> {
  const files: { rel: string; contents: Buffer }[] = [];
  for (const rel of TRACKED_FILES) {
    const file = path.join(entry.folder, rel);
    if (!fs.existsSync(file)) continue;
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    files.push({ rel, contents: await fsp.readFile(file) });
  }
  if (files.length === 0) return null;

  const describe = (list: { rel: string; contents: Buffer }[]): SnapshotFile[] =>
    list.map((f) => ({
      path: f.rel,
      sizeBytes: f.contents.length,
      sha256: crypto.createHash("sha256").update(f.contents).digest("hex"),
    }));
  const described = describe(files);

  const existing = await listSnapshots(entry);
  const newest = existing[0];
  if (newest && sameContents(newest.files, described)) return null;

  // 2026-08-03T14:30:12.345Z -> 20260803T143012345Z: sortable as a plain
  // string, which is what the listing and the pruning both rely on.
  const id = new Date().toISOString().replace(/[-:.]/g, "");
  const dir = snapshotDir(entry, id);
  await fsp.mkdir(dir, { recursive: true });
  for (const file of files) {
    const dest = path.join(dir, file.rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, file.contents);
  }
  const snapshot: ConfigSnapshot = {
    id,
    at: new Date().toISOString(),
    reason,
    actor: actor ?? null,
    files: described,
  };
  await fsp.writeFile(path.join(dir, "snapshot.json"), JSON.stringify(snapshot, null, 2), "utf-8");
  await pruneOldest(entry);
  return snapshot;
}

function sameContents(a: SnapshotFile[], b: SnapshotFile[]): boolean {
  if (a.length !== b.length) return false;
  const byPath = new Map(a.map((f) => [f.path, f.sha256]));
  return b.every((f) => byPath.get(f.path) === f.sha256);
}

export async function listSnapshots(entry: ServerEntry): Promise<ConfigSnapshot[]> {
  const dir = historyDir(entry);
  let ids: string[];
  try {
    ids = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const snapshots: ConfigSnapshot[] = [];
  for (const id of ids) {
    try {
      const meta = JSON.parse(
        await fsp.readFile(path.join(dir, id, "snapshot.json"), "utf-8")
      ) as ConfigSnapshot;
      snapshots.push(meta);
    } catch {
      // A snapshot without readable metadata is not one that can be offered.
    }
  }
  return snapshots.sort((a, b) => b.id.localeCompare(a.id));
}

async function readSnapshotFile(
  entry: ServerEntry,
  id: string,
  rel: string
): Promise<string | null> {
  if (!TRACKED_FILES.includes(rel)) throw new ConfigHistoryError("Nem követett fájl.");
  try {
    return await fsp.readFile(path.join(snapshotDir(entry, id), rel), "utf-8");
  } catch {
    return null;
  }
}

async function readCurrent(entry: ServerEntry, rel: string): Promise<string | null> {
  try {
    return await fsp.readFile(resolveSafePath(entry.folder, rel), "utf-8");
  } catch {
    return null;
  }
}

export interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
}

/**
 * Line diff via the usual longest-common-subsequence table.
 *
 * Written out rather than pulled in: these files are hundreds of lines, the
 * algorithm is twenty of them, and a diff library is a dependency that would
 * exist for one screen.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] =
        a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i] });
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      out.push({ kind: "removed", text: a[i++] });
    } else {
      out.push({ kind: "added", text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++] });
  while (j < b.length) out.push({ kind: "added", text: b[j++] });
  return out;
}

export interface FileDiff {
  path: string;
  /** Null when the file exists on only one side. */
  lines: DiffLine[];
  onlyInSnapshot: boolean;
  onlyInCurrent: boolean;
  changed: boolean;
}

export async function diffSnapshot(entry: ServerEntry, id: string): Promise<FileDiff[]> {
  const snapshot = (await listSnapshots(entry)).find((s) => s.id === id);
  if (!snapshot) throw new ConfigHistoryError("Nincs ilyen pillanatkép.");

  const paths = new Set([...snapshot.files.map((f) => f.path), ...TRACKED_FILES]);
  const diffs: FileDiff[] = [];
  for (const rel of paths) {
    const before = await readSnapshotFile(entry, id, rel);
    const current = await readCurrent(entry, rel);
    if (before === null && current === null) continue;
    const lines = diffLines(before ?? "", current ?? "");
    diffs.push({
      path: rel,
      lines,
      onlyInSnapshot: current === null,
      onlyInCurrent: before === null,
      changed: lines.some((l) => l.kind !== "context"),
    });
  }
  return diffs.sort((a, b) => Number(b.changed) - Number(a.changed) || a.path.localeCompare(b.path));
}

/**
 * Puts files back as they were.
 *
 * The current state is snapshotted first, so a restore made in a panic is
 * itself undoable - the mistake this whole feature exists for is exactly the
 * kind someone makes twice in a row.
 */
export async function restoreSnapshot(
  entry: ServerEntry,
  id: string,
  only: string[] | null,
  actor?: string | null
): Promise<string[]> {
  const snapshot = (await listSnapshots(entry)).find((s) => s.id === id);
  if (!snapshot) throw new ConfigHistoryError("Nincs ilyen pillanatkép.");

  await snapshotConfigs(entry, "visszaállítás előtt", actor);

  const restored: string[] = [];
  for (const file of snapshot.files) {
    if (only && !only.includes(file.path)) continue;
    const contents = await readSnapshotFile(entry, id, file.path);
    if (contents === null) continue;
    const dest = resolveSafePath(entry.folder, file.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, contents, "utf-8");
    restored.push(file.path);
  }
  return restored;
}

export async function deleteHistory(entry: ServerEntry): Promise<void> {
  await fsp.rm(historyDir(entry), { recursive: true, force: true });
}
