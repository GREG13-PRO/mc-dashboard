import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import archiver from "archiver";
import { env } from "../config/env";
import { resolveSafePath } from "../files/safe-path";
import { isServerRunning, sendCommand } from "./process-manager";
import type { BackupInfo, ServerEntry } from "../types";

const execFileAsync = promisify(execFile);

// Keep disk usage bounded on what's often a small VM - see the deployment's
// disk-space history. Oldest backups beyond this count are pruned whenever
// a new one is made.
const MAX_BACKUPS_PER_SERVER = 5;

export function backupsDir(entry: ServerEntry): string {
  return path.join(env.dataDir, "backups", entry.id);
}

function backupFilename(): string {
  return `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
}

export async function listBackups(entry: ServerEntry): Promise<BackupInfo[]> {
  const dir = backupsDir(entry);
  if (!fs.existsSync(dir)) return [];
  const names = await fsp.readdir(dir);
  const infos = await Promise.all(
    names
      .filter((n) => n.endsWith(".zip"))
      .map(async (name) => {
        const stat = await fsp.stat(path.join(dir, name));
        return { filename: name, size: stat.size, createdAt: stat.mtime.toISOString() };
      })
  );
  return infos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createBackup(entry: ServerEntry): Promise<BackupInfo> {
  const dir = backupsDir(entry);
  await fsp.mkdir(dir, { recursive: true });

  const running = await isServerRunning(entry);
  // Pause world saving for a consistent snapshot rather than zipping files
  // mid-write - this goes through the console like any other command, no
  // RCON needed.
  if (running) await sendCommand(entry, "save-off").catch(() => undefined);

  const filename = backupFilename();
  const fullPath = path.join(dir, filename);

  try {
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(fullPath);
      const archive = archiver("zip", { zlib: { level: 9 } });
      output.on("close", resolve);
      archive.on("error", reject);
      output.on("error", reject);
      archive.pipe(output);
      archive.directory(entry.folder, false);
      void archive.finalize();
    });
  } finally {
    if (running) {
      await sendCommand(entry, "save-on").catch(() => undefined);
      await sendCommand(entry, "save-all").catch(() => undefined);
    }
  }

  const existing = await listBackups(entry);
  const excess = existing.slice(MAX_BACKUPS_PER_SERVER);
  for (const old of excess) {
    await fsp.rm(path.join(dir, old.filename), { force: true });
  }

  const stat = await fsp.stat(fullPath);
  return { filename, size: stat.size, createdAt: stat.mtime.toISOString() };
}

export function resolveBackupPath(entry: ServerEntry, filename: string): string {
  return resolveSafePath(backupsDir(entry), filename);
}

export async function restoreBackup(entry: ServerEntry, filename: string): Promise<void> {
  if (await isServerRunning(entry)) {
    throw new Error("Stop the server before restoring a backup");
  }
  const zipPath = resolveBackupPath(entry, filename);
  if (!fs.existsSync(zipPath)) {
    throw new Error("Backup not found");
  }
  await execFileAsync("unzip", ["-o", "-q", zipPath, "-d", entry.folder]);
}

export async function deleteBackup(entry: ServerEntry, filename: string): Promise<void> {
  const zipPath = resolveBackupPath(entry, filename);
  await fsp.rm(zipPath, { force: true });
}
