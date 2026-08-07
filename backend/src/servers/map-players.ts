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
  /**
   * Height. Parsed all along - `Pos` is three numbers and the regex has always
   * captured all three - and thrown away, because a flat map has no use for it.
   * The 3D view does: a marker at the wrong height either sinks into the hill
   * or floats over it.
   */
  y: number;
  z: number;
  /** Where the player is looking, in degrees. Null when it could not be read. */
  yaw: number | null;
  dimension: Dimension;
}

// The same allowlist the moderation commands use. Names are interpolated into
// an RCON command, so nothing outside this set may reach the server.
const PLAYER_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

// "Steve has the following entity data: [1.5d, 64.0d, -3.25d]"
const POS_RE = /\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\s*]/;
// "Steve has the following entity data: [0.0f, -12.5f]" - yaw then pitch.
const ROT_RE = /\[\s*(-?[\d.]+)f?,\s*(-?[\d.]+)f?\s*]/;
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
      names.flatMap((name) => [
        `data get entity ${name} Pos`,
        `data get entity ${name} Dimension`,
        `data get entity ${name} Rotation`,
      ])
    );
  } catch {
    // A map that briefly cannot reach RCON should still show the terrain.
    return [];
  }

  return parsePositions(names, replies);
}

/**
 * Turns RCON's replies into positions.
 *
 * Separate from the call that fetched them so it can be checked against known
 * `data get` output rather than against a server with somebody standing on it -
 * which needs a running server, a client, and on this one an AuthMe account.
 * Three commands go out per player and they come back in order, so the parsing
 * is entirely a question of indexing, and indexing is exactly the thing worth
 * testing.
 */
export function parsePositions(names: string[], replies: string[]): PlayerPosition[] {
  const out: PlayerPosition[] = [];
  const PER_PLAYER = 3;
  names.forEach((name, i) => {
    const pos = POS_RE.exec(replies[i * PER_PLAYER] ?? "");
    if (!pos) return;
    const dim = DIM_RE.exec((replies[i * PER_PLAYER + 1] ?? "").trim());
    // Rotation is [yaw, pitch]; only the yaw matters for an arrow seen from
    // above. A player whose rotation could not be read yields null rather than
    // 0, which would be a confident claim that they are facing south.
    const rot = ROT_RE.exec(replies[i * PER_PLAYER + 2] ?? "");
    out.push({
      name,
      x: Math.round(Number(pos[1])),
      y: Math.round(Number(pos[2])),
      z: Math.round(Number(pos[3])),
      yaw: rot ? Number(rot[1]) : null,
      dimension: DIMENSION_BY_ID[dim?.[1] ?? ""] ?? "overworld",
    });
  });
  return out;
}
