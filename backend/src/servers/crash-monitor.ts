import { serverRegistry } from "./registry";
import { listScreenSessionNames, startServer, isIntentionallyStopped } from "./process-manager";

const CHECK_INTERVAL_MS = 20_000;

// Attempts older than this stop counting against the limit, so a server that
// crashed once months ago isn't permanently barred from being rescued.
const ATTEMPT_WINDOW_MS = 10 * 60_000;

interface CrashState {
  attempts: number[];
  /** Set once the limit is hit, so the give-up message is logged only once. */
  gaveUp: boolean;
}

const state = new Map<string, CrashState>();
let timer: NodeJS.Timeout | null = null;

/**
 * The intent set lives in memory, so a dashboard restart forgets that an
 * operator had deliberately stopped a server - and every such server would
 * then look like a fresh crash and get started back up behind their back.
 * Guard against that by only ever rescuing a server this monitor has actually
 * observed running: whatever is already down when it starts watching stays
 * down, because it was never seen to fall over.
 */
const everSeenRunning = new Set<string>();

export function startCrashMonitor(): void {
  if (timer) return;
  timer = setInterval(() => void checkAll(), CHECK_INTERVAL_MS);
}

export function stopCrashMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function checkAll(): Promise<void> {
  const entries = serverRegistry.list().filter((e) => e.crashRestart?.enabled);
  if (entries.length === 0) return;

  // One `screen -ls` for the whole tick: isServerRunning() spawns its own,
  // and this runs on a timer across every server.
  const running = await listScreenSessionNames();

  for (const entry of entries) {
    if (running.has(entry.screenName)) {
      // Back up cleanly: a server that is up again has served its purpose, so
      // its attempt history and give-up flag are cleared.
      state.delete(entry.id);
      everSeenRunning.add(entry.id);
      continue;
    }
    // A stop, kill or scheduled restart the operator asked for is not a crash.
    if (isIntentionallyStopped(entry.id)) continue;
    // Down, and never seen up since this process started - see everSeenRunning.
    if (!everSeenRunning.has(entry.id)) continue;

    const entryState = state.get(entry.id) ?? { attempts: [], gaveUp: false };
    if (entryState.gaveUp) continue;

    const cutoff = Date.now() - ATTEMPT_WINDOW_MS;
    entryState.attempts = entryState.attempts.filter((t) => t > cutoff);

    if (entryState.attempts.length >= entry.crashRestart.maxAttempts) {
      entryState.gaveUp = true;
      state.set(entry.id, entryState);
      console.error(
        `[crash-monitor] "${entry.name}" crashed ${entryState.attempts.length} times in ` +
          `${ATTEMPT_WINDOW_MS / 60_000} minutes - giving up, start it manually once the cause is fixed.`
      );
      continue;
    }

    entryState.attempts.push(Date.now());
    state.set(entry.id, entryState);
    console.log(
      `[crash-monitor] "${entry.name}" is down unexpectedly - restarting ` +
        `(attempt ${entryState.attempts.length}/${entry.crashRestart.maxAttempts})`
    );
    await startServer(entry).catch((err) =>
      console.error(`[crash-monitor] Failed to restart "${entry.name}":`, err)
    );
  }
}
