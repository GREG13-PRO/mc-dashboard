import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { consoleLogPath } from "./process-manager";
import { resolveSafePath } from "../files/safe-path";
import type { ServerEntry } from "../types";

/**
 * Keeps the console output of previous runs.
 *
 * Every start truncates `dashboard-console.log` so the live console never
 * replays a previous run, which meant the log of a server that crashed was
 * destroyed by the very restart you did to recover from it - including by the
 * automatic crash-restart. This moves the old file aside first instead.
 */

const ARCHIVE_DIR = "console-logs";
const MAX_ARCHIVED_RUNS = 14;
// Named by when the run ended, which is what someone looking for "the crash
// twenty minutes ago" actually remembers.
const FILE_RE = /^run-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z)\.log$/;

export interface ArchivedLog {
  filename: string;
  endedAt: string;
  sizeBytes: number;
}

function archiveDir(entry: ServerEntry): string {
  return path.join(entry.folder, ARCHIVE_DIR);
}

/**
 * Called just before a server starts. Anything already in the live log belongs
 * to the previous run, so it is rotated into the archive and the oldest
 * entries beyond the cap are dropped.
 */
export async function archiveCurrentLog(entry: ServerEntry): Promise<void> {
  const live = consoleLogPath(entry);
  if (!fs.existsSync(live)) return;
  try {
    const stat = await fsp.stat(live);
    // An empty file is a start that produced nothing - not worth a slot.
    if (stat.size === 0) return;

    const dir = archiveDir(entry);
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fsp.copyFile(live, path.join(dir, `run-${stamp}.log`));
    await pruneArchive(entry);
  } catch (err) {
    // Losing an archive copy must never stop a server from starting.
    console.error(`[console-archive] Failed to archive "${entry.name}":`, err);
  }
}

async function pruneArchive(entry: ServerEntry): Promise<void> {
  const dir = archiveDir(entry);
  const files = (await fsp.readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
  const excess = files.length - MAX_ARCHIVED_RUNS;
  for (let i = 0; i < excess; i++) {
    await fsp.rm(path.join(dir, files[i]), { force: true });
  }
}

export async function listArchivedLogs(entry: ServerEntry): Promise<ArchivedLog[]> {
  const dir = archiveDir(entry);
  if (!fs.existsSync(dir)) return [];
  const files = (await fsp.readdir(dir)).filter((f) => FILE_RE.test(f));
  const out = await Promise.all(
    files.map(async (filename) => {
      const stat = await fsp.stat(path.join(dir, filename));
      const stamp = FILE_RE.exec(filename)![1];
      // Undo the ISO mangling done when naming the file.
      const iso = stamp.replace(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z$/,
        (_m, y, mo, d, h, mi, s, ms) => `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms ?? "000"}Z`
      );
      return { filename, endedAt: iso, sizeBytes: stat.size };
    })
  );
  return out.sort((a, b) => b.filename.localeCompare(a.filename));
}

const MAX_READ_BYTES = 2 * 1024 * 1024;

export async function readArchivedLog(entry: ServerEntry, filename: string): Promise<string> {
  if (!FILE_RE.test(filename)) {
    throw new Error("Invalid log filename");
  }
  // The name is checked above, but it still goes through the sandbox: this is
  // a user-supplied path segment reaching the filesystem.
  const file = resolveSafePath(archiveDir(entry), filename);
  const stat = await fsp.stat(file);
  if (stat.size <= MAX_READ_BYTES) return fsp.readFile(file, "utf-8");

  // A multi-hour run can produce a very large log; the tail is the useful end.
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    await handle.read(buffer, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
    return `[… a napló eleje levágva, az utolsó 2 MB látszik …]\n${buffer.toString("utf-8")}`;
  } finally {
    await handle.close();
  }
}

export async function deleteArchivedLog(entry: ServerEntry, filename: string): Promise<void> {
  if (!FILE_RE.test(filename)) throw new Error("Invalid log filename");
  await fsp.rm(resolveSafePath(archiveDir(entry), filename), { force: true });
}
