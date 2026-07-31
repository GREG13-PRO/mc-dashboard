import fs from "node:fs";
import path from "node:path";
import { upsertProperty } from "./properties";
import type { ServerEntry } from "../types";

/**
 * Keeps a server's own server.properties in sync with the dashboard's RCON
 * settings. Without this, toggling "RCON enabled" in the edit form only
 * updates servers.json - the actual Minecraft process never learns about it
 * until someone edits server.properties by hand. That exact drift caused two
 * separate "player list silently does nothing" bugs (Lobby, then BedWars),
 * both traced back to the dashboard believing RCON was on while the real
 * config still had it off.
 *
 * No-op for servers with no server.properties (e.g. BungeeCord, which uses
 * config.yml and doesn't support RCON at all) - there's nothing to patch.
 */
export function syncRconToServerProperties(entry: ServerEntry): void {
  const propsPath = path.join(entry.folder, "server.properties");
  if (!fs.existsSync(propsPath)) return;

  let lines = fs.readFileSync(propsPath, "utf-8").split("\n");
  lines = upsertProperty(lines, "enable-rcon", String(entry.rcon.enabled));
  lines = upsertProperty(lines, "rcon.port", String(entry.rcon.port));
  if (entry.rcon.password) {
    lines = upsertProperty(lines, "rcon.password", entry.rcon.password);
  }
  fs.writeFileSync(propsPath, lines.join("\n"), "utf-8");
}
