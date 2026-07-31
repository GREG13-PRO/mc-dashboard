import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { consoleLogPath } from "./process-manager";
import { listArchivedLogs } from "./console-archive";
import type { ServerEntry } from "../types";

/**
 * Works out which Minecraft version a server actually runs, so the plugin
 * browser can warn before installing something built for a different one.
 *
 * Read from the startup banner rather than any config file: server.properties
 * does not record it, and the jar filename is whatever someone named it. The
 * banner is written on every start, so it is correct for the build in place
 * right now.
 */

const VERSION_RE = /Starting minecraft server version\s+([0-9][\w.\-]*)/i;
// Paper prints its own line, which also names the Minecraft version.
const PAPER_RE = /This server is running [^(]*\(MC:\s*([0-9][\w.\-]*)\)/i;

function stripAnsi(text: string): string {
  return text.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g"), "");
}

function findVersion(text: string): string | null {
  const clean = stripAnsi(text);
  return VERSION_RE.exec(clean)?.[1] ?? PAPER_RE.exec(clean)?.[1] ?? null;
}

async function readHead(file: string, bytes = 128 * 1024): Promise<string> {
  const stat = await fsp.stat(file);
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(bytes, stat.size));
    await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * Falls back through the archived logs when the live one has not been written
 * yet - a server that is currently stopped still has a knowable version from
 * its last run, and that is exactly when someone is installing plugins.
 */
export async function detectMinecraftVersion(entry: ServerEntry): Promise<string | null> {
  const live = consoleLogPath(entry);
  if (fs.existsSync(live)) {
    try {
      const version = findVersion(await readHead(live));
      if (version) return version;
    } catch {
      // Fall through to the archive.
    }
  }

  for (const archived of await listArchivedLogs(entry)) {
    try {
      const version = findVersion(await readHead(path.join(entry.folder, "console-logs", archived.filename)));
      if (version) return version;
    } catch {
      continue;
    }
  }
  return null;
}

export interface CompatibilityVerdict {
  serverVersion: string | null;
  compatible: boolean | null;
  message: string | null;
}

/** Loose match: 1.21.11 counts as supported by a build listing 1.21, since
 * plugins routinely declare the minor line rather than every patch. */
function matches(serverVersion: string, supported: string[]): boolean {
  if (supported.includes(serverVersion)) return true;
  const parts = serverVersion.split(".");
  const minorLine = parts.slice(0, 2).join(".");
  return supported.some((v) => v === minorLine || v.startsWith(`${minorLine}.`));
}

export function checkCompatibility(
  serverVersion: string | null,
  supportedVersions: string[]
): CompatibilityVerdict {
  if (!serverVersion) {
    return {
      serverVersion: null,
      compatible: null,
      message: "A szerver Minecraft-verziója nem ismert (még nem indult el egyszer sem).",
    };
  }
  if (supportedVersions.length === 0) {
    return { serverVersion, compatible: null, message: "Ez a build nem ad meg támogatott verziót." };
  }
  if (matches(serverVersion, supportedVersions)) {
    return { serverVersion, compatible: true, message: null };
  }
  return {
    serverVersion,
    compatible: false,
    message: `Ez a build nem jelöli meg támogatottként a szerver verzióját (${serverVersion}). Támogatott: ${supportedVersions
      .slice(-6)
      .join(", ")}`,
  };
}
