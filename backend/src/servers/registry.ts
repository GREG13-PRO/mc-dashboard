import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { paths } from "../config/env";
import { assertFileInsideRoot } from "../files/safe-path";
import { syncRconToServerProperties } from "./rcon-sync";
import type { ScheduledRestartConfig, ServerEntry, ServerEntryInput } from "../types";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
