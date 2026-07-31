import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchJson, downloadFile, createTtlCache } from "./http-download";
import { resolveSafePath } from "../files/safe-path";
import type { ServerEntry } from "../types";

const execFileAsync = promisify(execFile);

export type PluginSource = "modrinth" | "hangar";

export interface PluginSearchResult {
  source: PluginSource;
  id: string;
  name: string;
  description: string;
  author: string;
  downloads: number;
  pageUrl: string;
}

export interface PluginVersionInfo {
  id: string;
  name: string;
  gameVersions: string[];
  loaders: string[];
  filename: string | null;
  /** Null when the project only links to an external host (e.g. a GitHub
   * release page) instead of hosting the jar - those can't be auto-installed. */
  downloadUrl: string | null;
  externalUrl: string | null;
  datePublished: string | null;
}

export interface InstalledPlugin {
  filename: string;
  /** Read out of the jar's plugin.yml; null for jars that don't have one. */
  name: string | null;
  version: string | null;
  sizeBytes: number;
  /** Present only for plugins this dashboard installed - see the manifest note. */
  source: PluginSource | null;
  projectId: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
}

// Server-side registry lookups are cached briefly: the plugin browser re-runs
// the same search as the user types, and both upstreams rate-limit.
const searchCache = createTtlCache<PluginSearchResult[]>(60_000);
const versionCache = createTtlCache<PluginVersionInfo[]>(60_000);

const MODRINTH_PLUGIN_FACETS = encodeURIComponent(
  JSON.stringify([["categories:paper", "categories:bukkit", "categories:spigot", "categories:folia"]])
);

interface ModrinthHit {
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
}

interface HangarProject {
  name: string;
  description: string;
  namespace: { owner: string; slug: string };
  stats: { downloads: number };
}

export async function searchPlugins(query: string, source: PluginSource): Promise<PluginSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  return searchCache(`${source}:${q}`, async () => {
    if (source === "modrinth") {
      const data = await fetchJson<{ hits: ModrinthHit[] }>(
        `https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}&limit=20&facets=${MODRINTH_PLUGIN_FACETS}`
      );
      return data.hits.map((h) => ({
        source: "modrinth" as const,
        id: h.slug,
        name: h.title,
        description: h.description,
        author: h.author,
        downloads: h.downloads,
        pageUrl: `https://modrinth.com/plugin/${h.slug}`,
      }));
    }
    const data = await fetchJson<{ result: HangarProject[] }>(
      `https://hangar.papermc.io/api/v1/projects?q=${encodeURIComponent(q)}&limit=20`
    );
    return (data.result ?? []).map((p) => ({
      source: "hangar" as const,
      id: p.namespace.slug,
      name: p.name,
      description: p.description ?? "",
      author: p.namespace.owner,
      downloads: p.stats?.downloads ?? 0,
      pageUrl: `https://hangar.papermc.io/${p.namespace.owner}/${p.namespace.slug}`,
    }));
  });
}

interface ModrinthVersion {
  id: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  date_published: string;
  files: { filename: string; url: string; primary: boolean }[];
}

export type PluginPlatform = "bukkit" | "bungeecord" | "velocity";

// Which Modrinth loader tags are actually loadable on each platform. Getting
// this wrong is not harmless: testing installed LuckPerms' NeoForge build (a
// mod, belongs in mods/) and then its Velocity build onto a Paper server, and
// Paper rejected both at startup with "does not contain a paper-plugin.yml".
const PLATFORM_LOADERS: Record<PluginPlatform, string[]> = {
  bukkit: ["paper", "bukkit", "spigot", "folia", "purpur"],
  bungeecord: ["bungeecord", "waterfall"],
  velocity: ["velocity"],
};

const HANGAR_PLATFORM_KEY: Record<PluginPlatform, string> = {
  bukkit: "PAPER",
  bungeecord: "WATERFALL",
  velocity: "VELOCITY",
};

/**
 * Works out which plugin platform a server folder is, so the version list only
 * offers jars that will actually load. Detected from the folder rather than
 * stored on the entry, so it also works for servers registered by hand and for
 * everything that predates the installer.
 */
export function detectPlatform(entry: ServerEntry): PluginPlatform {
  if (fs.existsSync(path.join(entry.folder, "BungeeCord.jar"))) return "bungeecord";
  if (
    fs.existsSync(path.join(entry.folder, "velocity.jar")) ||
    fs.existsSync(path.join(entry.folder, "velocity.toml"))
  ) {
    return "velocity";
  }
  return "bukkit";
}

interface HangarVersion {
  name: string;
  createdAt: string;
  downloads: Record<string, { fileInfo: { name: string } | null; downloadUrl: string | null; externalUrl: string | null }>;
  platformDependencies: Record<string, string[]>;
}

export async function listPluginVersions(
  source: PluginSource,
  projectId: string,
  platform: PluginPlatform = "bukkit"
): Promise<PluginVersionInfo[]> {
  const allowed = PLATFORM_LOADERS[platform];
  return versionCache(`${source}:${projectId}:${platform}`, async () => {
    if (source === "modrinth") {
      const loaders = encodeURIComponent(JSON.stringify(allowed));
      const versions = await fetchJson<ModrinthVersion[]>(
        `https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?loaders=${loaders}`
      );
      return versions.map((v) => {
        const file = v.files.find((f) => f.primary) ?? v.files[0];
        return {
          id: v.id,
          name: v.version_number,
          gameVersions: v.game_versions,
          loaders: v.loaders ?? [],
          filename: file?.filename ?? null,
          downloadUrl: file?.url ?? null,
          externalUrl: null,
          datePublished: v.date_published,
        };
      });
    }
    const data = await fetchJson<{ result: HangarVersion[] }>(
      `https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(projectId)}/versions?limit=25`
    );
    // A Hangar release can publish for several platforms at once; only the
    // entry matching this server's platform is loadable here.
    const hangarKey = HANGAR_PLATFORM_KEY[platform];
    return (data.result ?? [])
      .filter((v) => v.downloads?.[hangarKey])
      .map((v) => {
        const hosted = v.downloads[hangarKey];
        return {
          id: v.name,
          name: v.name,
          gameVersions: v.platformDependencies?.[hangarKey] ?? [],
          loaders: [hangarKey.toLowerCase()],
          filename: hosted?.fileInfo?.name ?? null,
          downloadUrl: hosted?.downloadUrl ?? null,
          externalUrl: hosted?.externalUrl ?? null,
          datePublished: v.createdAt ?? null,
        };
      });
  });
}

function pluginsDir(entry: ServerEntry): string {
  return path.join(entry.folder, "plugins");
}

const MANIFEST_NAME = ".mc-dashboard-plugins.json";

interface ManifestRecord {
  source: PluginSource;
  projectId: string;
  versionId: string;
  versionName: string;
  installedAt: string;
}

/**
 * Records which registry project each dashboard-installed jar came from.
 * Without it, "is there an update?" would have to guess the upstream project
 * from a filename, which is unreliable - a wrong guess here would offer to
 * overwrite a plugin with an unrelated project's jar. Jars placed by hand are
 * simply listed without update info rather than guessed at.
 */
async function readManifest(entry: ServerEntry): Promise<Record<string, ManifestRecord>> {
  const file = path.join(pluginsDir(entry), MANIFEST_NAME);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(await fsp.readFile(file, "utf-8")) as Record<string, ManifestRecord>;
  } catch {
    return {};
  }
}

async function writeManifest(entry: ServerEntry, manifest: Record<string, ManifestRecord>): Promise<void> {
  const file = path.join(pluginsDir(entry), MANIFEST_NAME);
  await fsp.writeFile(file, JSON.stringify(manifest, null, 2), "utf-8");
}

/**
 * Reads name+version out of a jar's descriptor using the system unzip, which
 * this project already depends on for backup restores. Newer Paper-native
 * plugins ship `paper-plugin.yml` instead of the classic Bukkit `plugin.yml`,
 * so both are tried before giving up.
 */
async function readPluginYml(jarPath: string): Promise<{ name: string | null; version: string | null }> {
  for (const descriptor of ["plugin.yml", "paper-plugin.yml"]) {
    try {
      const { stdout } = await execFileAsync("unzip", ["-p", jarPath, descriptor], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      const name = /^name:\s*(.+)$/m.exec(stdout)?.[1]?.trim() ?? null;
      const version = /^version:\s*(.+)$/m.exec(stdout)?.[1]?.trim() ?? null;
      if (name || version) {
        return { name, version: version?.replace(/^["']|["']$/g, "") ?? null };
      }
    } catch {
      // Try the next descriptor name.
    }
  }
  return { name: null, version: null };
}

export async function listInstalledPlugins(entry: ServerEntry, checkUpdates = false): Promise<InstalledPlugin[]> {
  const dir = pluginsDir(entry);
  if (!fs.existsSync(dir)) return [];
  const manifest = await readManifest(entry);
  const platform = detectPlatform(entry);
  const files = (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".jar"));

  const results = await Promise.all(
    files.map(async (filename): Promise<InstalledPlugin> => {
      const full = path.join(dir, filename);
      const [{ name, version }, stat] = await Promise.all([readPluginYml(full), fsp.stat(full)]);
      const record = manifest[filename];
      let latestVersion: string | null = null;
      if (checkUpdates && record) {
        try {
          const versions = await listPluginVersions(record.source, record.projectId, platform);
          latestVersion = versions[0]?.name ?? null;
        } catch {
          // An upstream being down shouldn't blank out the installed list.
        }
      }
      return {
        filename,
        name,
        version,
        sizeBytes: stat.size,
        source: record?.source ?? null,
        projectId: record?.projectId ?? null,
        latestVersion,
        updateAvailable: Boolean(latestVersion && record && latestVersion !== record.versionName),
      };
    })
  );
  return results.sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function installPlugin(
  entry: ServerEntry,
  source: PluginSource,
  projectId: string,
  versionId: string
): Promise<InstalledPlugin> {
  const versions = await listPluginVersions(source, projectId, detectPlatform(entry));
  const version = versions.find((v) => v.id === versionId);
  if (!version) throw new Error(`Unknown version ${versionId} for ${projectId}`);
  if (!version.downloadUrl || !version.filename) {
    throw new Error(
      version.externalUrl
        ? `Ez a verzió külső oldalon van (${version.externalUrl}), a dashboard nem tudja automatikusan letölteni.`
        : `No downloadable file for ${projectId} ${version.name}`
    );
  }

  const dir = pluginsDir(entry);
  await fsp.mkdir(dir, { recursive: true });
  // The filename comes from a third-party API, so it goes through the same
  // sandbox check as any user-supplied path rather than being trusted.
  const dest = resolveSafePath(dir, version.filename);
  await downloadFile(version.downloadUrl, dest);

  const manifest = await readManifest(entry);
  // Replacing a plugin usually means a differently-named jar (the version is
  // in the filename), so the old entry and its jar have to go or the server
  // would load both copies.
  for (const [filename, record] of Object.entries(manifest)) {
    if (record.source === source && record.projectId === projectId && filename !== version.filename) {
      await fsp.rm(path.join(dir, filename), { force: true });
      delete manifest[filename];
    }
  }
  manifest[version.filename] = {
    source,
    projectId,
    versionId: version.id,
    versionName: version.name,
    installedAt: new Date().toISOString(),
  };
  await writeManifest(entry, manifest);

  const stat = await fsp.stat(dest);
  const { name, version: ymlVersion } = await readPluginYml(dest);
  return {
    filename: version.filename,
    name,
    version: ymlVersion,
    sizeBytes: stat.size,
    source,
    projectId,
    latestVersion: version.name,
    updateAvailable: false,
  };
}

export async function deletePlugin(entry: ServerEntry, filename: string): Promise<void> {
  const dir = pluginsDir(entry);
  const target = resolveSafePath(dir, filename);
  if (!target.toLowerCase().endsWith(".jar")) {
    throw new Error("Only .jar files can be removed here");
  }
  await fsp.rm(target, { force: true });
  const manifest = await readManifest(entry);
  if (manifest[filename]) {
    delete manifest[filename];
    await writeManifest(entry, manifest);
  }
}
