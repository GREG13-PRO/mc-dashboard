import { sendCommand, isServerRunning } from "./process-manager";
import type { ServerEntry } from "../types";

/**
 * One-click time and weather commands.
 *
 * Plain vanilla commands, so these work regardless of which plugins a server
 * has - the same reasoning as the player-action table. Every value is looked
 * up in a table rather than interpolated, so nothing a client sends reaches
 * the console as free text.
 */
const WORLD_COMMANDS: Record<string, string> = {
  day: "time set day",
  noon: "time set noon",
  night: "time set night",
  midnight: "time set midnight",
  clear: "weather clear",
  rain: "weather rain",
  thunder: "weather thunder",
  // Freezing the clock is what people actually want a "always day" button for.
  freeze_time: "gamerule doDaylightCycle false",
  resume_time: "gamerule doDaylightCycle true",
  freeze_weather: "gamerule doWeatherCycle false",
  resume_weather: "gamerule doWeatherCycle true",
};

export const WORLD_ACTIONS = Object.keys(WORLD_COMMANDS);

export class WorldControlError extends Error {}

export async function runWorldAction(entry: ServerEntry, action: string): Promise<void> {
  const command = WORLD_COMMANDS[action];
  if (!command) {
    throw new WorldControlError(`Unknown world action: ${action}`);
  }
  if (!(await isServerRunning(entry))) {
    throw new WorldControlError("A szervernek futnia kell ehhez a parancshoz.");
  }
  await sendCommand(entry, command);
}
