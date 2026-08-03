import { Rcon } from "rcon-client";
import type { ServerEntry } from "../types";

/**
 * One-off RCON round-trips for the features that need the server's *reply*.
 *
 * The console path (`sendCommand`) writes into a screen session and gets
 * nothing back, so anything that reads state - player coordinates, a plugin's
 * answer - has to go over RCON instead.
 */

export class RconError extends Error {}

/**
 * Runs several commands over a single connection.
 *
 * Per-command connections were the obvious first shape, but a map with a dozen
 * players online needs two commands each, and Minecraft's RCON handshake is
 * slow enough that twenty-odd of them do not finish inside one poll interval.
 */
export async function rconCommands(entry: ServerEntry, commands: string[]): Promise<string[]> {
  if (!entry.rcon.enabled) throw new RconError("Ehhez a szerverhez nincs bekapcsolva az RCON.");
  if (commands.length === 0) return [];

  let rcon: Rcon | undefined;
  try {
    rcon = await Rcon.connect({
      host: entry.rcon.host,
      port: entry.rcon.port,
      password: entry.rcon.password,
      timeout: 5000,
    });
    const out: string[] = [];
    for (const command of commands) {
      out.push(await rcon.send(command));
    }
    return out;
  } catch (err) {
    throw new RconError(err instanceof Error ? err.message : "RCON hiba.");
  } finally {
    await rcon?.end().catch(() => undefined);
  }
}

export async function rconCommand(entry: ServerEntry, command: string): Promise<string> {
  const [reply] = await rconCommands(entry, [command]);
  return reply;
}
