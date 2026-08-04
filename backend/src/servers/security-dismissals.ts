import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import type { ServerEntry } from "../types";

/**
 * Findings somebody has looked at and decided to live with.
 *
 * The security tab reports the same thing every time it is opened, which is
 * right for a problem and wrong for a decision. A server running offline mode
 * behind AuthMe is a choice; being told about it forever trains people to stop
 * reading the list, and then the one finding that mattered scrolls past.
 *
 * Dismissals expire. "I will deal with it later" is the honest state most of
 * the time, and a note that never comes back is indistinguishable from having
 * forgotten. Permanent is still offered - some of these really are settled -
 * but it has to be chosen.
 *
 * Stored per server like schedules are, and read on every report rather than
 * cached: the whole mechanism is a date comparison, and doing it once at
 * startup would mean a dismissal expiring only after a restart.
 */

export interface Dismissal {
  findingId: string;
  /** ISO instant, or null for permanent. */
  until: string | null;
  reason: string;
  by: string | null;
  at: string;
}

function file(entry: ServerEntry): string {
  return path.join(env.dataDir, "security-dismissals", `${entry.id}.json`);
}

export async function listDismissals(entry: ServerEntry): Promise<Dismissal[]> {
  const target = file(entry);
  if (!fs.existsSync(target)) return [];
  try {
    const raw = JSON.parse(await fsp.readFile(target, "utf-8")) as Dismissal[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function persist(entry: ServerEntry, items: Dismissal[]): Promise<void> {
  const target = file(entry);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, JSON.stringify(items, null, 2), "utf-8");
}

/** Null when the finding is not dismissed, or the dismissal has run out. */
export async function dismissedUntil(
  entry: ServerEntry,
  findingId: string,
  now = new Date()
): Promise<string | null | undefined> {
  const found = (await listDismissals(entry)).find((d) => d.findingId === findingId);
  if (!found) return undefined;
  if (found.until !== null && new Date(found.until) <= now) return undefined;
  return found.until;
}

export async function dismiss(
  entry: ServerEntry,
  findingId: string,
  days: number | null,
  reason: string,
  by: string | null
): Promise<Dismissal> {
  const record: Dismissal = {
    findingId,
    until: days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString(),
    reason: reason.trim().slice(0, 300),
    by,
    at: new Date().toISOString(),
  };
  const all = (await listDismissals(entry)).filter((d) => d.findingId !== findingId);
  all.push(record);
  await persist(entry, all);
  return record;
}

export async function undismiss(entry: ServerEntry, findingId: string): Promise<void> {
  const all = await listDismissals(entry);
  await persist(
    entry,
    all.filter((d) => d.findingId !== findingId)
  );
}

export async function deleteAllDismissals(entry: ServerEntry): Promise<void> {
  await fsp.rm(file(entry), { force: true });
}
