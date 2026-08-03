import { rconCommands } from "./rcon";
import { getCachedPlayers } from "./rcon-poller";
import { isServerRunning } from "./process-manager";
import type { Dimension } from "./map-service";
import type { ServerEntry } from "../types";

/**
 * Where everyone currently is, for the live markers on the world map.
 *
 * Vanilla `data get` rather than a plugin: the whole point of the built-in map
 * is that it works on a plain server, without asking the admin to install
 * anything server-side first.
 */

export interface PlayerPosition {
  name: string;
  x: number;
  z: number;
  dimension: Dimension;
}

// The same allowlist the moderation commands use. Names are interpolated into
// an RCON command, so nothing outside this set may reach the server.
const PLAYER_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

// "Steve has the following entity data: [1.5d, 64.0d, -3.25d]"
const POS_RE = /\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\s*]/;
// "Steve has the following entity data: "minecraft:the_nether""
const DIM_RE = /"?minecraft:(\w+)"?\s*$/;

const DIMENSION_BY_ID: Record<string, Dimension> = {
  overworld: "overworld",
  the_nether: "nether",
  the_end: "end",
};

export async function playerPositions(entry: ServerEntry): Promise<PlayerPosition[]> {
  if (!entry.rcon.enabled) return [];
  if (!(await isServerRunning(entry))) return [];

  // Reuse the poller's player list instead of running `list` again: it refreshes
  // every 15s anyway, and a name that went stale in between simply yields no
  // position rather than an error.
  const names = (getCachedPlayers(entry.id)?.names ?? []).filter((n) => PLAYER_NAME_RE.test(n));
  if (names.length === 0) return [];

  let replies: string[];
  try {
    replies = await rconCommands(
      entry,
      names.flatMap((name) => [`data get entity ${name} Pos`, `data get entity ${name} Dimension`])
    );
  } catch {
    // A map that briefly cannot reach RCON should still show the terrain.
    return [];
  }

  const out: PlayerPosition[] = [];
  names.forEach((name, i) => {
    const pos = POS_RE.exec(replies[i * 2] ?? "");
    if (!pos) return;
    const dim = DIM_RE.exec((replies[i * 2 + 1] ?? "").trim());
    out.push({
      name,
      x: Math.round(Number(pos[1])),
      z: Math.round(Number(pos[3])),
      dimension: DIMENSION_BY_ID[dim?.[1] ?? ""] ?? "overworld",
    });
  });
  return out;
}
