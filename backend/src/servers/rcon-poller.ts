import { Rcon } from "rcon-client";
import { serverRegistry } from "./registry";
import { isServerRunning } from "./process-manager";

interface PlayersSnapshot {
  online: number;
  max: number;
  names: string[];
  fetchedAt: string;
}

const LIST_RESPONSE_RE = /There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)/i;

const cache = new Map<string, PlayersSnapshot>();
let pollTimer: NodeJS.Timeout | null = null;

function parseListResponse(response: string): Omit<PlayersSnapshot, "fetchedAt"> {
  const match = LIST_RESPONSE_RE.exec(response.trim());
  if (!match) {
    return { online: 0, max: 0, names: [] };
  }
  const [, online, max, namesPart] = match;
  const names = namesPart
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  return { online: Number(online), max: Number(max), names };
}

async function pollOne(serverId: string, host: string, port: number, password: string): Promise<void> {
  let rcon: Rcon | undefined;
  try {
    rcon = await Rcon.connect({ host, port, password, timeout: 5000 });
    const response = await rcon.send("list");
    cache.set(serverId, { ...parseListResponse(response), fetchedAt: new Date().toISOString() });
  } catch {
    // Leave any previous cached snapshot in place; don't thrash the UI on a transient failure.
  } finally {
    await rcon?.end().catch(() => undefined);
  }
}

async function pollAll(): Promise<void> {
  const entries = serverRegistry.list().filter((e) => e.rcon.enabled);
  await Promise.all(
    entries.map(async (entry) => {
      if (!(await isServerRunning(entry))) {
        cache.delete(entry.id);
        return;
      }
      await pollOne(entry.id, entry.rcon.host, entry.rcon.port, entry.rcon.password);
    })
  );
}

export function startRconPoller(intervalMs = 15_000): void {
  if (pollTimer) return;
  void pollAll();
  pollTimer = setInterval(() => void pollAll(), intervalMs);
}

export function stopRconPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function getCachedPlayers(serverId: string): PlayersSnapshot | undefined {
  return cache.get(serverId);
}
