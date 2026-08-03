import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";

/**
 * Hosts the installable apps so they can update themselves from the dashboard.
 *
 * Not from GitHub: this project's repository is private, so an unauthenticated
 * request for its latest release gets a 404 - which is why the desktop app's
 * update check had never found anything in its life, and why a phone could not
 * have checked at all. Embedding a token in a shipped app is not an option
 * either, since anyone holding the app holds the token.
 *
 * The dashboard is the one server every copy of these apps is already pointed
 * at, so it is the natural place to serve an update from.
 */

export type Platform = "android" | "mac-arm64" | "mac-x64" | "windows" | "plugin";

export const PLATFORMS: Platform[] = ["android", "mac-arm64", "mac-x64", "windows", "plugin"];

export interface PublishedBuild {
  platform: Platform;
  version: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  url: string;
}

export class AppDistError extends Error {}

/**
 * The names CI produces, which already carry the version and the platform.
 *
 * Reading the version out of the files themselves would mean decoding binary
 * AndroidManifest XML and picking apart a dmg; an upload whose name does not
 * match is rejected rather than guessed at, so a mistaken file can never be
 * offered to everyone as an update.
 */
const NAME_PATTERNS: { platform: Platform; re: RegExp }[] = [
  { platform: "android", re: /^mc-dashboard-v(\d+\.\d+\.\d+)\.apk$/ },
  { platform: "mac-arm64", re: /^Minecraft\.Dashboard-(\d+\.\d+\.\d+)-arm64\.dmg$/ },
  { platform: "mac-x64", re: /^Minecraft\.Dashboard-(\d+\.\d+\.\d+)\.dmg$/ },
  { platform: "windows", re: /^Minecraft\.Dashboard\.Setup\.(\d+\.\d+\.\d+)\.exe$/ },
  { platform: "plugin", re: /^McDashGuard-v(\d+\.\d+\.\d+)\.jar$/ },
];

// Cheap structural checks, so an accidental upload of the wrong file is caught
// before it reaches anyone. Both dmg and exe start with a recognisable header;
// an APK is a zip that has to contain an AndroidManifest.
const MAGIC: Record<Platform, (data: Buffer) => boolean> = {
  android: (d) => d[0] === 0x50 && d[1] === 0x4b && d.includes("AndroidManifest.xml"),
  // "koly" is the trailer of a UDIF disk image; electron-builder also produces
  // zip-based dmgs, so the zip header is accepted too.
  "mac-arm64": (d) => d.subarray(-512).includes("koly") || (d[0] === 0x78 || d[0] === 0x50),
  "mac-x64": (d) => d.subarray(-512).includes("koly") || (d[0] === 0x78 || d[0] === 0x50),
  // MZ, the DOS header every Windows executable still begins with.
  windows: (d) => d[0] === 0x4d && d[1] === 0x5a,
  // A plugin jar is a zip that has to declare itself to Paper.
  plugin: (d) => d[0] === 0x50 && d[1] === 0x4b && d.includes("plugin.yml"),
};

function dir(): string {
  return path.join(env.dataDir, "app-dist");
}

export function identify(filename: string): { platform: Platform; version: string } | null {
  for (const { platform, re } of NAME_PATTERNS) {
    const match = re.exec(filename);
    if (match) return { platform, version: match[1] };
  }
  return null;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((n) => Number(n) || 0);
  const right = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function describe(filename: string): Promise<PublishedBuild | null> {
  const identified = identify(filename);
  if (!identified) return null;
  const file = path.join(dir(), filename);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) return null;
  return {
    platform: identified.platform,
    version: identified.version,
    filename,
    sizeBytes: stat.size,
    // Lets a client verify it got the file the dashboard meant to send.
    sha256: crypto.createHash("sha256").update(await fsp.readFile(file)).digest("hex"),
    uploadedAt: stat.mtime.toISOString(),
    url: `/api/app/download/${encodeURIComponent(filename)}`,
  };
}

export async function publishedBuilds(): Promise<PublishedBuild[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dir());
  } catch {
    return [];
  }
  const builds = (await Promise.all(names.map(describe))).filter(
    (b): b is PublishedBuild => b !== null
  );
  return builds.sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform));
}

export async function publishedFor(platform: Platform): Promise<PublishedBuild | null> {
  const builds = await publishedBuilds();
  return builds.find((b) => b.platform === platform) ?? null;
}

export function buildPath(filename: string): string {
  if (!identify(filename)) throw new AppDistError("Ismeretlen fájlnév.");
  return path.join(dir(), filename);
}

export async function saveBuild(filename: string, data: Buffer): Promise<PublishedBuild> {
  const identified = identify(filename);
  if (!identified) {
    throw new AppDistError(
      "Ismeretlen fájlnév. A buildek eredeti nevén töltsd fel őket (mc-dashboard-vX.Y.Z.apk, " +
        "Minecraft.Dashboard-X.Y.Z.dmg, Minecraft.Dashboard-X.Y.Z-arm64.dmg, " +
        "Minecraft.Dashboard.Setup.X.Y.Z.exe, McDashGuard-vX.Y.Z.jar)."
    );
  }
  if (data.length < 4 || !MAGIC[identified.platform](data)) {
    throw new AppDistError("A fájl tartalma nem stimmel ehhez a típushoz.");
  }

  await fsp.mkdir(dir(), { recursive: true });
  // One build per platform: this is an update source, not an archive, and old
  // installers are 80-100 MB each on a disk that also holds Minecraft worlds.
  for (const name of await fsp.readdir(dir())) {
    const other = identify(name);
    if (other && other.platform === identified.platform && name !== filename) {
      await fsp.rm(path.join(dir(), name), { force: true });
    }
  }
  await fsp.writeFile(path.join(dir(), filename), data);

  const saved = await describe(filename);
  if (!saved) throw new AppDistError("A feltöltés nem sikerült.");
  return saved;
}

export async function deleteBuild(filename: string): Promise<void> {
  if (!identify(filename)) throw new AppDistError("Ismeretlen fájlnév.");
  await fsp.rm(path.join(dir(), filename), { force: true });
}
