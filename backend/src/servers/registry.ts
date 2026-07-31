import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { paths } from "../config/env";
import { assertFileInsideRoot } from "../files/safe-path";
import { syncRconToServerProperties } from "./rcon-sync";
import type {
  CrashRestartConfig,
  ScheduledRestartConfig,
  ServerEntry,
  ServerEntryInput,
  TimeMachineConfig,
} from "../types";

/**
 * Strips the RCON password before an entry is sent to a client. Shared by
 * every route that returns a server, so a new secret added to ServerEntry
 * only has to be stripped in one place.
 */
export function toPublicEntry(entry: ServerEntry): Omit<ServerEntry, "rcon"> & {
  rcon: { enabled: boolean; host: string; port: number };
} {
  const { rcon, ...rest } = entry;
  return { ...rest, rcon: { enabled: rcon.enabled, host: rcon.host, port: rcon.port } };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const DEFAULT_CRASH_RESTART: CrashRestartConfig = { enabled: false, maxAttempts: 3 };

// Off by default: even diffed, snapshotting an active world costs real disk,
// and this deployment's VM does not have much of it.
const DEFAULT_TIME_MACHINE: TimeMachineConfig = { enabled: false, intervalMinutes: 1, maxSnapshots: 60 };

function normalizeTimeMachine(
  input: Partial<TimeMachineConfig> | undefined,
  existing: TimeMachineConfig
): TimeMachineConfig {
  const intervalMinutes = input?.intervalMinutes ?? existing.intervalMinutes;
  const maxSnapshots = input?.maxSnapshots ?? existing.maxSnapshots;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 60) {
    throw new Error(`Invalid snapshot interval: ${intervalMinutes} (expected 1-60 minutes)`);
  }
  if (!Number.isInteger(maxSnapshots) || maxSnapshots < 5 || maxSnapshots > 500) {
    throw new Error(`Invalid snapshot limit: ${maxSnapshots} (expected 5-500)`);
  }
  return { enabled: input?.enabled ?? existing.enabled, intervalMinutes, maxSnapshots };
}

function normalizeCrashRestart(
  input: Partial<CrashRestartConfig> | undefined,
  existing: CrashRestartConfig
): CrashRestartConfig {
  const maxAttempts = input?.maxAttempts ?? existing.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new Error(`Invalid crash restart attempt limit: ${maxAttempts} (expected 1-20)`);
  }
  return { enabled: input?.enabled ?? existing.enabled, maxAttempts };
}

function normalizeScheduledRestart(
  input: Partial<ScheduledRestartConfig> | undefined,
  existing: ScheduledRestartConfig
): ScheduledRestartConfig {
  const time = input?.time ?? existing.time;
  if (input?.enabled && !TIME_RE.test(time)) {
    throw new Error(`Invalid scheduled restart time: ${time} (expected HH:MM)`);
  }
  return {
    enabled: input?.enabled ?? existing.enabled,
    time,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "server";
}

class ServerRegistry {
  private entries: Map<string, ServerEntry> = new Map();
  private loaded = false;

  private ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;

    fs.mkdirSync(path.dirname(paths.serversFile), { recursive: true });
    if (!fs.existsSync(paths.serversFile)) {
      fs.writeFileSync(paths.serversFile, "[]", "utf-8");
      return;
    }
    const raw = fs.readFileSync(paths.serversFile, "utf-8");
    const parsed = raw.trim() ? (JSON.parse(raw) as ServerEntry[]) : [];
    for (const entry of parsed) {
      // Servers registered before the scheduled-restart feature existed
      // won't have this field in the persisted JSON - backfill a disabled
      // default so downstream code never has to null-check it.
      if (!entry.scheduledRestart) {
        entry.scheduledRestart = { enabled: false, time: "04:00" };
      }
      if (!entry.crashRestart) {
        entry.crashRestart = { ...DEFAULT_CRASH_RESTART };
      }
      if (!entry.timeMachine) {
        entry.timeMachine = { ...DEFAULT_TIME_MACHINE };
      }
      this.entries.set(entry.id, entry);
    }
  }

  private persist() {
    const list = [...this.entries.values()].sort((a, b) => a.order - b.order);
    fs.writeFileSync(paths.serversFile, JSON.stringify(list, null, 2), "utf-8");
  }

  list(): ServerEntry[] {
    this.ensureLoaded();
    return [...this.entries.values()].sort((a, b) => a.order - b.order);
  }

  get(id: string): ServerEntry | undefined {
    this.ensureLoaded();
    return this.entries.get(id);
  }

  create(input: ServerEntryInput): ServerEntry {
    this.ensureLoaded();

    const folder = path.resolve(input.folder);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      throw new Error(`Folder does not exist or is not a directory: ${folder}`);
    }
    // Validates the start script both exists and resolves inside `folder`.
    assertFileInsideRoot(folder, input.startScript);

    const id = uuidv4();
    const now = new Date().toISOString();
    const entry: ServerEntry = {
      id,
      name: input.name.trim(),
      folder,
      startScript: input.startScript,
      screenName: `mc-${slugify(input.name)}-${id.slice(0, 8)}`,
      stopCommand: input.stopCommand?.trim() || "stop",
      rcon: {
        enabled: input.rcon?.enabled ?? false,
        host: input.rcon?.host ?? "127.0.0.1",
        port: input.rcon?.port ?? 25575,
        password: input.rcon?.password ?? "",
      },
      scheduledRestart: normalizeScheduledRestart(input.scheduledRestart, { enabled: false, time: "04:00" }),
      crashRestart: normalizeCrashRestart(input.crashRestart, DEFAULT_CRASH_RESTART),
      timeMachine: normalizeTimeMachine(input.timeMachine, DEFAULT_TIME_MACHINE),
      createdAt: now,
      updatedAt: now,
      order: this.entries.size,
    };

    this.entries.set(id, entry);
    this.persist();
    syncRconToServerProperties(entry);
    return entry;
  }

  update(id: string, input: Partial<ServerEntryInput>): ServerEntry {
    this.ensureLoaded();
    const existing = this.entries.get(id);
    if (!existing) {
      throw new Error(`Server not found: ${id}`);
    }

    const folder = input.folder ? path.resolve(input.folder) : existing.folder;
    if (input.folder) {
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        throw new Error(`Folder does not exist or is not a directory: ${folder}`);
      }
    }
    const startScript = input.startScript ?? existing.startScript;
    assertFileInsideRoot(folder, startScript);

    const updated: ServerEntry = {
      ...existing,
      name: input.name?.trim() ?? existing.name,
      folder,
      startScript,
      stopCommand: input.stopCommand?.trim() || existing.stopCommand,
      rcon: {
        enabled: input.rcon?.enabled ?? existing.rcon.enabled,
        host: input.rcon?.host ?? existing.rcon.host,
        port: input.rcon?.port ?? existing.rcon.port,
        // Empty string means "leave unchanged" here (the edit form never
        // pre-fills the password field), not "clear the password".
        password: input.rcon?.password || existing.rcon.password,
      },
      scheduledRestart: normalizeScheduledRestart(input.scheduledRestart, existing.scheduledRestart),
      crashRestart: normalizeCrashRestart(input.crashRestart, existing.crashRestart ?? DEFAULT_CRASH_RESTART),
      timeMachine: normalizeTimeMachine(input.timeMachine, existing.timeMachine ?? DEFAULT_TIME_MACHINE),
      updatedAt: new Date().toISOString(),
    };

    this.entries.set(id, updated);
    this.persist();
    syncRconToServerProperties(updated);
    return updated;
  }

  remove(id: string): void {
    this.ensureLoaded();
    if (!this.entries.delete(id)) {
      throw new Error(`Server not found: ${id}`);
    }
    this.persist();
  }
}

export const serverRegistry = new ServerRegistry();
