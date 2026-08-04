import { serverRegistry } from "./registry";
import {
  isServerRunning,
  restartServer,
  startServer,
  stopServer,
  sendCommand,
} from "./process-manager";
import { createBackup } from "./backup-manager";
import { takeSnapshot } from "./world-timeline";
import { listSchedules, saveSchedule, recordRun, isDue, type Schedule } from "./schedules";
import { recordAudit, SYSTEM_ACTOR } from "../audit/audit-log";
import type { ServerEntry } from "../types";

/**
 * Runs the schedules.
 *
 * Replaces restart-scheduler.ts, which knew one job. The tick is the same 30
 * seconds, and so is the reason for the fired-this-minute set: a schedule that
 * matches a wall-clock minute would otherwise match twice.
 */

const CHECK_INTERVAL_MS = 30_000;

/** Keyed by schedule id plus the minute, so a job fires once per due minute. */
const fired = new Set<string>();

function minuteKey(id: string, now: Date, suffix: string): string {
  return `${id}:${suffix}:${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
}

export function startScheduler(): void {
  void migrateLegacyRestarts();
  setInterval(() => void tick(), CHECK_INTERVAL_MS);
}

/**
 * Moves the old per-server `scheduledRestart` into a real schedule, once.
 *
 * Leaving both alive would mean two things restarting the same server from two
 * different screens, which is exactly the kind of drift that had this project's
 * RCON settings disagreeing with its server.properties for weeks.
 */
async function migrateLegacyRestarts(): Promise<void> {
  for (const entry of serverRegistry.list()) {
    if (!entry.scheduledRestart?.enabled) continue;
    const existing = await listSchedules(entry);
    if (existing.some((s) => s.name === "Napi újraindítás" && s.action === "restart")) continue;
    await saveSchedule(entry, {
      name: "Napi újraindítás",
      action: "restart",
      kind: "daily",
      time: entry.scheduledRestart.time,
      enabled: true,
    });
    // Switched off rather than deleted: the field still exists on the record,
    // and leaving it on would let the old setting fire again if anything ever
    // read it.
    serverRegistry.update(entry.id, { scheduledRestart: { enabled: false } });
    console.log(`[scheduler] Migrated the scheduled restart of "${entry.name}"`);
  }
}

async function runAction(entry: ServerEntry, schedule: Schedule): Promise<string> {
  const running = await isServerRunning(entry);
  switch (schedule.action) {
    case "restart":
      // Only ever restarts something already up: this is for clearing lag on a
      // live server, not for starting one on a timer. That is what "start" is.
      if (!running) return "kihagyva: a szerver nem fut";
      await restartServer(entry);
      return "újraindítva";
    case "start":
      if (running) return "kihagyva: már fut";
      await startServer(entry);
      return "elindítva";
    case "stop":
      if (!running) return "kihagyva: már áll";
      await stopServer(entry);
      return "leállítva";
    case "backup": {
      const backup = await createBackup(entry);
      return `mentés kész: ${backup.filename}`;
    }
    case "snapshot": {
      const snapshot = await takeSnapshot(entry);
      return `pillanatkép kész: ${snapshot.id}`;
    }
    case "command":
      if (!running) return "kihagyva: a szerver nem fut";
      await sendCommand(entry, schedule.command);
      return `parancs elküldve: ${schedule.command}`;
  }
}

async function tick(): Promise<void> {
  const now = new Date();
  for (const entry of serverRegistry.list()) {
    let schedules: Schedule[];
    try {
      schedules = await listSchedules(entry);
    } catch {
      continue;
    }

    for (const schedule of schedules) {
      if (!schedule.enabled) continue;

      // The warning first: it is checked against the same minute the action
      // would be checked against later, so both can be due on the same tick
      // only when warnMinutes is zero.
      if (schedule.warnMinutes > 0 && isDue(schedule, now, schedule.warnMinutes)) {
        const key = minuteKey(schedule.id, now, "warn");
        if (!fired.has(key)) {
          fired.add(key);
          if (await isServerRunning(entry)) {
            await sendCommand(entry, `say ${schedule.warnMessage}`).catch(() => undefined);
          }
        }
      }

      if (!isDue(schedule, now)) continue;
      const key = minuteKey(schedule.id, now, "run");
      if (fired.has(key)) continue;
      fired.add(key);

      let result: string;
      let ok = true;
      try {
        result = await runAction(entry, schedule);
      } catch (err) {
        ok = false;
        result = `hiba: ${(err as Error).message}`;
      }
      console.log(`[scheduler] "${entry.name}" / ${schedule.name}: ${result}`);
      await recordRun(entry, schedule.id, result).catch(() => undefined);
      recordAudit({
        actor: SYSTEM_ACTOR,
        actorId: null,
        action: `Ütemezés: ${schedule.name}`,
        serverId: entry.id,
        serverName: entry.name,
        detail: result,
        ip: null,
        ok,
      });
    }
  }

  // The set only needs the current minute; anything older can never match
  // again, and left alone it would grow for as long as the process runs.
  const stale = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  for (const key of fired) {
    if (!key.endsWith(stale)) fired.delete(key);
  }
}
