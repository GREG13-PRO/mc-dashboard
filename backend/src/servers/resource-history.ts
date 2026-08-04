import { serverRegistry } from "./registry";
import { getResourceUsageMap } from "./process-manager";
import { getCachedPlayers } from "./rcon-poller";

export interface ResourceSample {
  at: string;
  cpuPercent: number;
  memoryMb: number;
  /** Null when RCON is off, so the chart can show a gap rather than zero. */
  playersOnline: number | null;
}

const SAMPLE_INTERVAL_MS = 5_000;
// 60 samples at 5s each is five minutes of history - enough to see a lag spike
// or a memory climb, small enough to hold for every server without thought.
const MAX_SAMPLES = 60;

const history = new Map<string, ResourceSample[]>();
let timer: NodeJS.Timeout | null = null;

export function startResourceHistory(intervalMs = SAMPLE_INTERVAL_MS): void {
  if (timer) return;
  void sampleAll();
  timer = setInterval(() => void sampleAll(), intervalMs);
}

export function stopResourceHistory(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sampleAll(): Promise<void> {
  const entries = serverRegistry.list();
  if (entries.length === 0) return;
  let usage;
  try {
    usage = await getResourceUsageMap(entries);
  } catch {
    // A transient ps/screen failure shouldn't poison the series.
    return;
  }

  const at = new Date().toISOString();
  const knownIds = new Set(entries.map((e) => e.id));
  for (const entry of entries) {
    const current = usage.get(entry.id);
    // A stopped server records nothing rather than a run of zeroes, so the
    // chart shows a gap for downtime instead of implying idle-but-running.
    if (!current) continue;
    const series = history.get(entry.id) ?? [];
    series.push({
      at,
      cpuPercent: current.cpuPercent,
      memoryMb: current.memoryMb,
      playersOnline: getCachedPlayers(entry.id)?.online ?? null,
    });
    if (series.length > MAX_SAMPLES) series.splice(0, series.length - MAX_SAMPLES);
    history.set(entry.id, series);
  }

  // Deleting a server leaves no other cleanup hook, so drop its series here.
  for (const id of history.keys()) {
    if (!knownIds.has(id)) history.delete(id);
  }
}

export function getResourceHistory(serverId: string): ResourceSample[] {
  return history.get(serverId) ?? [];
}
