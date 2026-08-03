import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";

/**
 * Hosts the Android app so phones can update themselves from the dashboard.
 *
 * Not from GitHub: this project's repository is private, so an unauthenticated
 * request for its latest release gets a 404 - which is exactly why the desktop
 * app's update check has never found anything. Embedding a token in a shipped
 * app is not an option either, since anyone holding the app holds the token.
 *
 * The dashboard is the one thing every phone running this app can already
 * reach, so it is the natural place to serve the update from.
 */

export interface AndroidBuild {
  version: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
}

export class AppDistError extends Error {}

// The name CI gives the artifact. Parsing the version out of the APK itself
// would mean decoding binary AndroidManifest XML; the filename carries it
// already, and an upload that does not match is rejected rather than guessed.
const APK_NAME_RE = /^mc-dashboard-v(\d+\.\d+\.\d+)\.apk$/;

function dir(): string {
  return path.join(env.dataDir, "app-dist");
}

export function parseApkVersion(filename: string): string | null {
  const match = APK_NAME_RE.exec(filename);
  return match ? match[1] : null;
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

export async function currentAndroidBuild(): Promise<AndroidBuild | null> {
  let names: string[];
  try {
    names = await fsp.readdir(dir());
  } catch {
    return null;
  }
  const builds = names
    .map((name) => ({ name, version: parseApkVersion(name) }))
    .filter((entry): entry is { name: string; version: string } => entry.version !== null)
    .sort((a, b) => compareVersions(b.version, a.version));
  if (builds.length === 0) return null;

  const newest = builds[0];
  const file = path.join(dir(), newest.name);
  const stat = await fsp.stat(file);
  return {
    version: newest.version,
    filename: newest.name,
    sizeBytes: stat.size,
    // Lets a phone verify it got the file the dashboard meant to send, and
    // gives the upload screen something to show besides a name.
    sha256: crypto.createHash("sha256").update(await fsp.readFile(file)).digest("hex"),
    uploadedAt: stat.mtime.toISOString(),
  };
}

export function apkPath(filename: string): string {
  if (!APK_NAME_RE.test(filename)) throw new AppDistError("Ismeretlen fájlnév.");
  return path.join(dir(), filename);
}

export async function saveAndroidBuild(filename: string, data: Buffer): Promise<AndroidBuild> {
  const version = parseApkVersion(filename);
  if (!version) {
    throw new AppDistError(
      "A fájlnévnek mc-dashboard-vX.Y.Z.apk alakúnak kell lennie - ezen a néven adja ki a build."
    );
  }
  // A zip signature is the cheapest check that this is an APK at all, and it
  // stops an accidental upload of the wrong file from being offered to every
  // phone as an update.
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new AppDistError("Ez nem APK fájl.");
  }
  if (!data.includes("AndroidManifest.xml")) {
    throw new AppDistError("Ez nem APK fájl: nincs benne AndroidManifest.xml.");
  }

  await fsp.mkdir(dir(), { recursive: true });
  // Only the newest build is kept: this is an update source, not an archive,
  // and old APKs on a disk this small are pure cost.
  for (const name of await fsp.readdir(dir())) {
    if (parseApkVersion(name) && name !== filename) {
      await fsp.rm(path.join(dir(), name), { force: true });
    }
  }
  await fsp.writeFile(path.join(dir(), filename), data);

  const build = await currentAndroidBuild();
  if (!build) throw new AppDistError("A feltöltés nem sikerült.");
  return build;
}

export async function deleteAndroidBuild(): Promise<void> {
  if (!fs.existsSync(dir())) return;
  await fsp.rm(dir(), { recursive: true, force: true });
}
