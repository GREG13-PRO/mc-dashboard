import https from "node:https";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ServerInstallType } from "../types";

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "mc-dashboard" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchJson<T>(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON from ${url}`));
          }
        });
      })
      .on("error", reject);
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "mc-dashboard" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadFile(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
      })
      .on("error", reject);
  });
}

export const SERVER_TYPES: { id: ServerInstallType; label: string }[] = [
  { id: "paper", label: "Paper" },
  { id: "vanilla", label: "Vanilla" },
  { id: "fabric", label: "Fabric" },
  { id: "bungeecord", label: "BungeeCord" },
];

// Pre-release/candidate builds are filtered out - the dropdown should only
// offer versions someone would actually want to run a real server on.
const PRERELEASE_RE = /-(rc|pre)/i;

export async function listVersions(type: ServerInstallType): Promise<string[]> {
  switch (type) {
    case "paper": {
      const data = await fetchJson<{ versions: Record<string, string[]> }>(
        "https://fill.papermc.io/v3/projects/paper"
      );
      const all: string[] = [];
      for (const group of Object.values(data.versions)) {
        for (const v of group) {
          if (!PRERELEASE_RE.test(v)) all.push(v);
        }
      }
      return all;
    }
    case "vanilla": {
      const data = await fetchJson<{ versions: { id: string; type: string }[] }>(
        "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
      );
      return data.versions.filter((v) => v.type === "release").map((v) => v.id);
    }
    case "fabric": {
      const data = await fetchJson<{ version: string; stable: boolean }[]>(
        "https://meta.fabricmc.net/v2/versions/game"
      );
      return data.filter((v) => v.stable).map((v) => v.version);
    }
    case "bungeecord":
      return ["latest"];
    default:
      throw new Error(`Unknown server type: ${type}`);
  }
}

export interface InstallResult {
  startScript: string;
  stopCommand: string;
}

/**
 * Downloads and sets up a fresh server of the given type/version into
 * `folder` (created if missing), from official sources only - the whole
 * point of this feature is to never repeat "download a plugin/jar from a
 * random site" (see the security incident this project already had).
 */
export async function installServer(input: {
  folder: string;
  type: ServerInstallType;
  version: string;
}): Promise<InstallResult> {
  const { folder, type, version } = input;
  await fsp.mkdir(folder, { recursive: true });

  switch (type) {
    case "paper": {
      const versions = await listVersions("paper");
      if (!versions.includes(version)) {
        throw new Error(`Unknown Paper version: ${version}`);
      }
      const build = await fetchJson<{ downloads: Record<string, { name: string; url: string }> }>(
        `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds/latest`
      );
      const download = build.downloads["server:default"];
      if (!download) throw new Error(`No server download available for Paper ${version}`);
      await downloadFile(download.url, path.join(folder, "server.jar"));
      await fsp.writeFile(path.join(folder, "eula.txt"), "eula=true\n");
      await fsp.writeFile(path.join(folder, "start.sh"), "java -Xmx4G -jar server.jar -nogui\n");
      return { startScript: "start.sh", stopCommand: "stop" };
    }
    case "vanilla": {
      const manifest = await fetchJson<{ versions: { id: string; url: string }[] }>(
        "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
      );
      const entry = manifest.versions.find((v) => v.id === version);
      if (!entry) throw new Error(`Unknown Vanilla version: ${version}`);
      const versionMeta = await fetchJson<{ downloads: { server?: { url: string } } }>(entry.url);
      if (!versionMeta.downloads.server) {
        throw new Error(`Vanilla ${version} has no server download (too old?)`);
      }
      await downloadFile(versionMeta.downloads.server.url, path.join(folder, "server.jar"));
      await fsp.writeFile(path.join(folder, "eula.txt"), "eula=true\n");
      await fsp.writeFile(path.join(folder, "start.sh"), "java -Xmx4G -jar server.jar -nogui\n");
      return { startScript: "start.sh", stopCommand: "stop" };
    }
    case "fabric": {
      const gameVersions = await listVersions("fabric");
      if (!gameVersions.includes(version)) {
        throw new Error(`Unknown Fabric game version: ${version}`);
      }
      const loaders = await fetchJson<{ loader: { version: string } }[]>(
        `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`
      );
      if (loaders.length === 0) throw new Error(`No Fabric loader available for ${version}`);
      const loaderVersion = loaders[0].loader.version;

      const installers = await fetchJson<{ version: string; stable: boolean }[]>(
        "https://meta.fabricmc.net/v2/versions/installer"
      );
      const installer = installers.find((i) => i.stable) ?? installers[0];
      if (!installer) throw new Error("No Fabric installer version available");

      const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(
        loaderVersion
      )}/${encodeURIComponent(installer.version)}/server/jar`;
      await downloadFile(url, path.join(folder, "server.jar"));
      await fsp.writeFile(path.join(folder, "eula.txt"), "eula=true\n");
      await fsp.writeFile(path.join(folder, "start.sh"), "java -Xmx4G -jar server.jar -nogui\n");
      return { startScript: "start.sh", stopCommand: "stop" };
    }
    case "bungeecord": {
      await downloadFile(
        "https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar",
        path.join(folder, "BungeeCord.jar")
      );
      await fsp.writeFile(path.join(folder, "start.sh"), "java -Xmx2G -jar BungeeCord.jar\n");
      return { startScript: "start.sh", stopCommand: "end" };
    }
    default:
      throw new Error(`Unknown server type: ${type}`);
  }
}
