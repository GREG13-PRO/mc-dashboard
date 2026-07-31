import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serverRegistry } from "./registry";
import { isServerRunning } from "./process-manager";
import { writeProperties } from "./properties";
import type { ServerEntry } from "../types";

const execFileAsync = promisify(execFile);

/**
 * Clones a server into an isolated copy for testing changes against the real
 * world without risking it.
 *
 * The clone gets its own folder, its own port and RCON port, and RCON disabled
 * until the operator sets a password - copying the live server's RCON password
 * into a second listening service is not a good default.
 */

export class CloneError extends Error {}

async function directorySize(dir: string): Promise<number> {
  const { stdout } = await execFileAsync("du", ["-sb", dir]).catch(() => ({ stdout: "0" }));
  return Number.parseInt(stdout.split(/\s+/)[0], 10) || 0;
}

async function freeSpace(dir: string): Promise<number> {
  const { stdout } = await execFileAsync("df", ["-B1", "--output=avail", dir]).catch(() => ({ stdout: "" }));
  const line = stdout.trim().split("\n")[1];
  return Number.parseInt(line ?? "0", 10) || 0;
}

function nextFreePort(base: number, taken: Set<number>): number {
  let port = base;
  while (taken.has(port)) port++;
  return port;
}

function readPort(entry: ServerEntry): number {
  const file = path.join(entry.folder, "server.properties");
  if (!fs.existsSync(file)) return 25565;
  const line = fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .find((l) => l.startsWith("server-port="));
  return Number.parseInt(line?.split("=")[1] ?? "25565", 10) || 25565;
}

export async function cloneServer(source: ServerEntry, name: string): Promise<ServerEntry> {
  if (await isServerRunning(source)) {
    // A running server is mid-write on its region files; a copy taken now can
    // contain a half-written chunk.
    throw new CloneError("A klónozáshoz állítsd le a forrás szervert.");
  }
  const target = `${source.folder}-clone-${Date.now()}`;
  if (fs.existsSync(target)) throw new CloneError("A cél mappa már létezik.");

  const needed = await directorySize(source.folder);
  const available = await freeSpace(path.dirname(source.folder));
  if (needed > 0 && available > 0 && needed * 1.1 > available) {
    throw new CloneError(
      `Nincs elég hely: a klón kb. ${(needed / 1024 ** 3).toFixed(1)} GB, szabad ${(available / 1024 ** 3).toFixed(1)} GB.`
    );
  }

  // cp -a preserves permissions and is far faster than walking the tree in
  // Node for a world folder with tens of thousands of small files.
  await execFileAsync("cp", ["-a", source.folder, target], { timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 });

  // The clone must not keep the original's live console log or its timeline.
  await fsp.rm(path.join(target, "dashboard-console.log"), { force: true });
  await fsp.rm(path.join(target, "console-logs"), { recursive: true, force: true });

  const entries = serverRegistry.list();
  const usedPorts = new Set(entries.map(readPort));
  const usedRcon = new Set(entries.map((e) => e.rcon.port));
  const port = nextFreePort(Math.max(...usedPorts, 25565) + 1, usedPorts);

  const props = path.join(target, "server.properties");
  if (fs.existsSync(props)) {
    writeProperties(props, {
      "server-port": String(port),
      // Never leave a clone advertising the original's MOTD; it is the only
      // thing distinguishing them in a server list.
      motd: `${name} (teszt klón)`,
      "enable-rcon": "false",
      "rcon.port": String(nextFreePort(Math.max(...usedRcon, 25575) + 1, usedRcon)),
    });
  }

  return serverRegistry.create({
    name,
    folder: target,
    startScript: source.startScript,
    stopCommand: source.stopCommand,
    // RCON off with no password: copying the live password into a second
    // listener is not something to do silently.
    rcon: { enabled: false, host: source.rcon.host, port: nextFreePort(Math.max(...usedRcon, 25575) + 1, usedRcon), password: "" },
  });
}
