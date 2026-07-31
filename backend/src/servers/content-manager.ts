import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { writeProperties } from "./properties";
import { resolveSafePath } from "../files/safe-path";
import type { ServerEntry } from "../types";

/**
 * Resource packs and datapacks.
 *
 * The two are handled together because they are both "content zips the server
 * owns", but they reach players by completely different routes: a datapack is
 * a file in the world folder that the server loads itself, while a resource
 * pack is *not* uploaded anywhere - the server only tells the client a URL and
 * a hash, and the client downloads it. So this stores packs, and for resource
 * packs also serves them over HTTP and writes the URL and SHA-1 into
 * server.properties, which is the part people usually get wrong by hand.
 */

export type PackKind = "resourcepack" | "datapack";

export interface Pack {
  kind: PackKind;
  filename: string;
  sizeBytes: number;
  uploadedAt: string;
  /** SHA-1, which is the hash format server.properties expects. */
  sha1: string;
  /** True for the resource pack currently advertised in server.properties. */
  active: boolean;
}

const RESOURCE_DIR = "dashboard-resourcepacks";

function resourcePackDir(entry: ServerEntry): string {
  return path.join(entry.folder, RESOURCE_DIR);
}

/** Datapacks live where Minecraft looks for them, not in a folder of ours. */
function datapackDir(entry: ServerEntry): string {
  return path.join(entry.folder, "world", "datapacks");
}

function dirFor(entry: ServerEntry, kind: PackKind): string {
  return kind === "resourcepack" ? resourcePackDir(entry) : datapackDir(entry);
}

async function sha1(file: string): Promise<string> {
  const hash = crypto.createHash("sha1");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function readProperty(entry: ServerEntry, key: string): string | null {
  const file = path.join(entry.folder, "server.properties");
  if (!fs.existsSync(file)) return null;
  try {
    const line = fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : null;
  } catch {
    return null;
  }
}

export async function listPacks(entry: ServerEntry, kind: PackKind): Promise<Pack[]> {
  const dir = dirFor(entry, kind);
  if (!fs.existsSync(dir)) return [];
  const activeUrl = kind === "resourcepack" ? readProperty(entry, "resource-pack") : null;

  const files = (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".zip"));
  return Promise.all(
    files.map(async (filename) => {
      const full = path.join(dir, filename);
      const stat = await fsp.stat(full);
      return {
        kind,
        filename,
        sizeBytes: stat.size,
        uploadedAt: stat.mtime.toISOString(),
        sha1: await sha1(full),
        active: Boolean(activeUrl && activeUrl.includes(encodeURIComponent(filename))),
      };
    })
  );
}

export async function savePack(
  entry: ServerEntry,
  kind: PackKind,
  filename: string,
  data: Buffer
): Promise<Pack> {
  if (!/\.zip$/i.test(filename)) {
    throw new Error("Csak .zip csomag tölthető fel.");
  }
  const dir = dirFor(entry, kind);
  await fsp.mkdir(dir, { recursive: true });
  // The name comes from an upload, so it goes through the sandbox.
  const target = resolveSafePath(dir, path.basename(filename));
  await fsp.writeFile(target, data);

  const stat = await fsp.stat(target);
  return {
    kind,
    filename: path.basename(filename),
    sizeBytes: stat.size,
    uploadedAt: stat.mtime.toISOString(),
    sha1: await sha1(target),
    active: false,
  };
}

export async function deletePack(entry: ServerEntry, kind: PackKind, filename: string): Promise<void> {
  const target = resolveSafePath(dirFor(entry, kind), filename);
  if (!/\.zip$/i.test(target)) throw new Error("Csak .zip csomag törölhető.");
  await fsp.rm(target, { force: true });
}

export function resolvePackPath(entry: ServerEntry, kind: PackKind, filename: string): string {
  return resolveSafePath(dirFor(entry, kind), filename);
}

export class ContentError extends Error {}

/**
 * Points the server at a stored resource pack.
 *
 * Minecraft clients fetch the pack themselves, so the URL has to be reachable
 * from the players' machines - not from the server. The dashboard cannot know
 * its own public address, so the caller supplies the base URL and this only
 * writes it, along with the SHA-1 the client uses to verify the download and
 * to cache it between sessions.
 */
export async function activateResourcePack(
  entry: ServerEntry,
  filename: string,
  publicBaseUrl: string
): Promise<{ url: string; sha1: string }> {
  const file = resolvePackPath(entry, "resourcepack", filename);
  if (!fs.existsSync(file)) throw new ContentError("Nincs ilyen csomag.");
  const propsPath = path.join(entry.folder, "server.properties");
  if (!fs.existsSync(propsPath)) {
    throw new ContentError("Ennek a szervernek nincs server.properties fájlja (proxy?).");
  }

  const base = publicBaseUrl.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(filename)}`;
  const hash = await sha1(file);
  writeProperties(propsPath, {
    "resource-pack": url,
    "resource-pack-sha1": hash,
  });
  return { url, sha1: hash };
}

export function clearResourcePack(entry: ServerEntry): void {
  const propsPath = path.join(entry.folder, "server.properties");
  if (!fs.existsSync(propsPath)) return;
  writeProperties(propsPath, { "resource-pack": "", "resource-pack-sha1": "" });
}

export function setRequireResourcePack(entry: ServerEntry, required: boolean): void {
  const propsPath = path.join(entry.folder, "server.properties");
  if (!fs.existsSync(propsPath)) {
    throw new ContentError("Ennek a szervernek nincs server.properties fájlja (proxy?).");
  }
  writeProperties(propsPath, { "require-resource-pack": String(required) });
}

export function resourcePackStatus(entry: ServerEntry): { url: string | null; sha1: string | null; required: boolean } {
  return {
    url: readProperty(entry, "resource-pack") || null,
    sha1: readProperty(entry, "resource-pack-sha1") || null,
    required: readProperty(entry, "require-resource-pack") === "true",
  };
}
