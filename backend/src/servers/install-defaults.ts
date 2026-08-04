import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { serverRegistry } from "./registry";
import { readProperties } from "./properties";

/**
 * Sensible answers for the questions a first-time user cannot answer.
 *
 * The add-server form asks for fourteen things, and for someone installing
 * their first Paper server twelve of them are noise: where on this machine the
 * folder should go, which port is free, whether RCON should be on and what its
 * password should be. Every one of those has a right answer the server can work
 * out, and getting them wrong is how a beginner ends up with two servers
 * fighting over port 25565 and no player list.
 *
 * Suggestions only. The advanced form still shows every field, and these are
 * what it is pre-filled with.
 */

export interface InstallDefaults {
  folder: string;
  port: number;
  rconPort: number;
  rconPassword: string;
}

/** Turns "My Survival Server!" into "my-survival-server". */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "server";
}

/**
 * Where this dashboard's servers live.
 *
 * Taken from where the existing ones are rather than from a constant: whoever
 * set this machine up already made that decision, and a new server belongs
 * beside its siblings. The most common parent wins, so one oddly-placed server
 * does not drag the default with it.
 */
export function serverRoot(): string {
  const counts = new Map<string, number>();
  for (const entry of serverRegistry.list()) {
    const parent = path.dirname(entry.folder);
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [dir, count] of counts) {
    if (count > bestCount) {
      best = dir;
      bestCount = count;
    }
  }
  return best ?? path.join(os.homedir(), "servers");
}

function uniqueFolder(name: string): string {
  const root = serverRoot();
  const base = slugify(name);
  let candidate = path.join(root, base);
  let n = 2;
  // Both checks matter: a folder can exist without being registered, and a
  // registered server can point at a folder that has since been moved.
  const taken = new Set(serverRegistry.list().map((e) => path.resolve(e.folder)));
  while (fs.existsSync(candidate) || taken.has(path.resolve(candidate))) {
    candidate = path.join(root, `${base}-${n++}`);
    if (n > 100) break;
  }
  return candidate;
}

/** Ports already spoken for by a server this dashboard knows about. */
function claimedPorts(): Set<number> {
  const ports = new Set<number>();
  for (const entry of serverRegistry.list()) {
    ports.add(entry.rcon.port);
    const props = readProperties(path.join(entry.folder, "server.properties"));
    for (const key of ["server-port", "rcon.port", "query.port"]) {
      const value = Number(props[key]);
      if (Number.isFinite(value) && value > 0) ports.add(value);
    }
  }
  return ports;
}

/**
 * Whether anything is listening on a port right now.
 *
 * A bind test rather than parsing `ss` or `netstat`: it is the same question
 * the Minecraft server will ask a moment later, it needs no external command,
 * and it works on the machines where those tools are missing.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createServer();
    socket.once("error", () => resolve(false));
    socket.once("listening", () => socket.close(() => resolve(true)));
    socket.listen(port, "0.0.0.0");
  });
}

async function firstFreePort(from: number, claimed: Set<number>): Promise<number> {
  for (let port = from; port < from + 200; port++) {
    if (claimed.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  // Nothing free in range: hand back the starting point and let the server say
  // so on startup, rather than inventing a port that is no better.
  return from;
}

export async function suggestDefaults(name: string): Promise<InstallDefaults> {
  const claimed = claimedPorts();
  const port = await firstFreePort(25565, claimed);
  claimed.add(port);
  const rconPort = await firstFreePort(25575, claimed);
  return {
    folder: uniqueFolder(name),
    port,
    rconPort,
    // Generated rather than asked for. It is typed into server.properties and
    // into the dashboard's own config and read by nothing else, so a person
    // choosing it adds a weak password and a chance to mistype it.
    rconPassword: crypto.randomBytes(16).toString("base64url"),
  };
}
