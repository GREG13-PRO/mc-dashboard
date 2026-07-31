import { serverRegistry } from "./registry";
import { isServerRunning, restartServer } from "./process-manager";
import { recordAudit, SYSTEM_ACTOR } from "../audit/audit-log";

const CHECK_INTERVAL_MS = 30_000;

function currentHhMm(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

// Scheduled restarts only ever restart a server that's already running -
// this is meant to periodically clear memory/lag on a live server, not to
// start one up on a timer. Tracks the last minute each server was triggered
// so a 30s poll interval can't fire twice within the same target minute.
const lastTriggered = new Map<string, string>();

export function startRestartScheduler(): void {
  setInterval(() => void checkAll(), CHECK_INTERVAL_MS);
}

async function checkAll(): Promise<void> {
  const hhmm = currentHhMm();
  for (const entry of serverRegistry.list()) {
    if (!entry.scheduledRestart.enabled || entry.scheduledRestart.time !== hhmm) continue;
    if (lastTriggered.get(entry.id) === hhmm) continue;
    lastTriggered.set(entry.id, hhmm);

    if (await isServerRunning(entry)) {
      console.log(`[restart-scheduler] Restarting "${entry.name}" (scheduled ${hhmm})`);
      let ok = true;
      await restartServer(entry).catch((err) => {
        ok = false;
        console.error(`[restart-scheduler] Failed to restart "${entry.name}":`, err);
      });
      recordAudit({
        actor: SYSTEM_ACTOR,
        actorId: null,
        action: "Ütemezett újraindítás",
        serverId: entry.id,
        serverName: entry.name,
        detail: hhmm,
        ip: null,
        ok,
      });
    }
  }
}
