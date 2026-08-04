import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { env } from "../config/env";
import type { ServerEntry } from "../types";

/**
 * Timed jobs, of which "restart at 04:00" was only ever the first.
 *
 * The dashboard already restarted on a timer, through a single `scheduledRestart`
 * field on each server. That covered the one job somebody thought of first and
 * nothing else - not the nightly backup, not the snapshot before a busy
 * weekend, not the warning that gives players five minutes to find a bed.
 *
 * Stored per server in its own file, like macros, because a schedule is written
 * against one server's plugins and habits.
 */

export class ScheduleError extends Error {}

export type ScheduleAction = "restart" | "start" | "stop" | "backup" | "snapshot" | "command";

export const SCHEDULE_ACTIONS: ScheduleAction[] = [
  "restart",
  "start",
  "stop",
  "backup",
  "snapshot",
  "command",
];

export type ScheduleKind = "daily" | "weekly" | "interval";

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  action: ScheduleAction;
  /** Only for action "command". */
  command: string;
  kind: ScheduleKind;
  /** HH:MM for daily and weekly. */
  time: string;
  /** 0 = Sunday, for weekly. */
  days: number[];
  intervalMinutes: number;
  /**
   * Minutes before a disruptive action to broadcast `warnMessage`. Zero is off.
   *
   * Worth building in rather than leaving people to add a second schedule five
   * minutes earlier: the two would then drift apart the first time somebody
   * moved the restart, and a warning for a restart that no longer happens is
   * worse than no warning.
   */
  warnMinutes: number;
  warnMessage: string;
  createdAt: string;
  lastRunAt: string | null;
  lastResult: string | null;
}

function scheduleFile(entry: ServerEntry): string {
  return path.join(env.dataDir, "schedules", `${entry.id}.json`);
}

function normalise(raw: Partial<Schedule>): Schedule {
  const kind: ScheduleKind =
    raw.kind === "weekly" || raw.kind === "interval" ? raw.kind : "daily";
  const action = SCHEDULE_ACTIONS.includes(raw.action as ScheduleAction)
    ? (raw.action as ScheduleAction)
    : "restart";
  return {
    id: raw.id ?? uuidv4(),
    name: (raw.name ?? "").trim() || "Névtelen ütemezés",
    enabled: raw.enabled !== false,
    action,
    command: (raw.command ?? "").trim(),
    kind,
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time ?? "") ? raw.time! : "04:00",
    days: Array.isArray(raw.days)
      ? [...new Set(raw.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : [],
    // Ten minutes is the floor: anything shorter turns a restart schedule into
    // a server that is never up.
    intervalMinutes: Math.max(10, Math.min(10080, Math.round(raw.intervalMinutes ?? 60))),
    warnMinutes: Math.max(0, Math.min(60, Math.round(raw.warnMinutes ?? 0))),
    warnMessage: (raw.warnMessage ?? "").trim(),
    createdAt: raw.createdAt ?? new Date().toISOString(),
    lastRunAt: raw.lastRunAt ?? null,
    lastResult: raw.lastResult ?? null,
  };
}

function validate(schedule: Schedule): void {
  if (schedule.action === "command" && !schedule.command) {
    throw new ScheduleError("Parancs művelethez adj meg parancsot.");
  }
  if (schedule.kind === "weekly" && schedule.days.length === 0) {
    throw new ScheduleError("Heti ütemezéshez válassz legalább egy napot.");
  }
  if (schedule.warnMinutes > 0) {
    if (schedule.kind === "interval") {
      // The warning is found by asking whether the action is due in N minutes,
      // which needs a wall-clock time to compare against. An interval schedule
      // has none - it only knows how long since it last ran.
      throw new ScheduleError("Figyelmeztetés csak napi vagy heti ütemezéshez adható.");
    }
    if (!schedule.warnMessage) {
      throw new ScheduleError("Adj meg figyelmeztető üzenetet.");
    }
  }
}

export async function listSchedules(entry: ServerEntry): Promise<Schedule[]> {
  const file = scheduleFile(entry);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(await fsp.readFile(file, "utf-8")) as Partial<Schedule>[];
    return Array.isArray(raw) ? raw.map(normalise) : [];
  } catch {
    return [];
  }
}

async function persist(entry: ServerEntry, schedules: Schedule[]): Promise<void> {
  const file = scheduleFile(entry);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(schedules, null, 2), "utf-8");
}

export async function saveSchedule(
  entry: ServerEntry,
  input: Partial<Schedule>
): Promise<Schedule> {
  const schedule = normalise(input);
  validate(schedule);
  const all = await listSchedules(entry);
  const at = all.findIndex((s) => s.id === schedule.id);
  if (at >= 0) {
    // Run history belongs to the schedule, not to the form that edited it.
    schedule.createdAt = all[at].createdAt;
    schedule.lastRunAt = all[at].lastRunAt;
    schedule.lastResult = all[at].lastResult;
    all[at] = schedule;
  } else {
    all.push(schedule);
  }
  await persist(entry, all);
  return schedule;
}

export async function deleteSchedule(entry: ServerEntry, id: string): Promise<void> {
  const all = await listSchedules(entry);
  await persist(
    entry,
    all.filter((s) => s.id !== id)
  );
}

export async function recordRun(
  entry: ServerEntry,
  id: string,
  result: string
): Promise<void> {
  const all = await listSchedules(entry);
  const schedule = all.find((s) => s.id === id);
  if (!schedule) return;
  schedule.lastRunAt = new Date().toISOString();
  schedule.lastResult = result;
  await persist(entry, all);
}

export async function deleteAllSchedules(entry: ServerEntry): Promise<void> {
  await fsp.rm(scheduleFile(entry), { force: true });
}

/**
 * Whether a schedule wants to run at this wall-clock minute.
 *
 * `offsetMinutes` looks that far ahead, which is how the warning is asked about
 * with the same code that asks about the action: "is this due in five minutes?"
 */
export function isDue(schedule: Schedule, now: Date, offsetMinutes = 0): boolean {
  if (schedule.kind === "interval") {
    if (offsetMinutes !== 0) return false;
    // Counted from creation until it has run once, so "back up every six
    // hours" waits six hours rather than backing up the moment you save it.
    const since = new Date(schedule.lastRunAt ?? schedule.createdAt).getTime();
    return now.getTime() - since >= schedule.intervalMinutes * 60_000;
  }

  // Asked forwards rather than backwards: "would the action be due in
  // `offsetMinutes`?". Going the other way and subtracting from the target time
  // gets the day wrong across midnight - a warning at 23:55 on Monday is for
  // Tuesday's 00:05 action, and the weekly day check has to test Tuesday.
  const at = new Date(now.getTime() + offsetMinutes * 60_000);
  const [hh, mm] = schedule.time.split(":").map(Number);
  if (at.getHours() !== hh || at.getMinutes() !== mm) return false;
  if (schedule.kind === "weekly" && !schedule.days.includes(at.getDay())) return false;
  return true;
}
