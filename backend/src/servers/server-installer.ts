import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchText, fetchJson, downloadFile } from "./http-download";
import { writeProperties } from "./properties";
import type { ServerInstallSettings, ServerInstallType } from "../types";

const execFileAsync = promisify(execFile);

export type ServerTypeKind = "server" | "proxy";

export const SERVER_TYPES: { id: ServerInstallType; label: string; kind: ServerTypeKind }[] = [
  { id: "paper", label: "Paper", kind: "server" },
  { id: "purpur", label: "Purpur", kind: "server" },
  { id: "vanilla", label: "Vanilla", kind: "server" },
  { id: "fabric", label: "Fabric", kind: "server" },
  { id: "quilt", label: "Quilt", kind: "server" },
  { id: "forge", label: "Forge", kind: "server" },
  { id: "neoforge", label: "NeoForge", kind: "server" },
  { id: "bungeecord", label: "BungeeCord", kind: "proxy" },
  { id: "velocity", label: "Velocity", kind: "proxy" },
];

export function kindOf(type: ServerInstallType): ServerTypeKind {
  return SERVER_TYPES.find((t) => t.id === type)?.kind ?? "server";
}

// Pre-release/candidate/snapshot builds are filtered out - the dropdown should
// only offer versions someone would actually want to run a real server on.
const PRERELEASE_RE = /-(rc|pre|snapshot|beta|alpha)/i;

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Paper and Velocity are both published through PaperMC's "fill" v3 API. */
async function listPaperMcVersions(project: string): Promise<string[]> {
  const data = await fetchJson<{ versions: Record<string, string[]> }>(
    `https://fill.papermc.io/v3/projects/${project}`
  );
  const all: string[] = [];
  for (const group of Object.values(data.versions)) {
    for (const v of group) {
      if (!PRERELEASE_RE.test(v)) all.push(v);
    }
  }
  return all;
}

async function paperMcDownloadUrl(project: string, version: string): Promise<string> {
  const build = await fetchJson<{ downloads: Record<string, { name: string; url: string }> }>(
    `https://fill.papermc.io/v3/projects/${project}/versions/${encodeURIComponent(version)}/builds/latest`
  );
  const download = build.downloads["server:default"];
  if (!download) throw new Error(`No server download available for ${project} ${version}`);
  return download.url;
}

export async function listVersions(type: ServerInstallType): Promise<string[]> {
  switch (type) {
    case "paper":
      return listPaperMcVersions("paper");
    case "velocity":
      return listPaperMcVersions("velocity");
    case "purpur": {
      const data = await fetchJson<{ versions: string[] }>("https://api.purpurmc.org/v2/purpur");
      // Purpur lists oldest-first; every other type here comes back newest-first.
      return [...data.versions].reverse().filter((v) => !PRERELEASE_RE.test(v));
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
    case "quilt": {
      const data = await fetchJson<{ version: string; stable: boolean }[]>(
        "https://meta.quiltmc.org/v3/versions/game"
      );
      return data.filter((v) => v.stable).map((v) => v.version);
    }
    case "forge": {
      // promotions_slim maps "<mcVersion>-recommended"/"-latest" to a Forge
      // build number; the Minecraft versions are the keys' prefixes.
      const data = await fetchJson<{ promos: Record<string, string> }>(
        "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json"
      );
      const seen = new Set<string>();
      for (const key of Object.keys(data.promos)) {
        const mc = key.replace(/-(recommended|latest)$/, "");
        if (mc !== key) seen.add(mc);
      }
      return [...seen].reverse();
    }
    case "neoforge": {
      // NeoForge publishes only a Maven metadata XML. Its own version numbers
      // encode the Minecraft version they target, so they're offered directly
      // rather than guessed back into a Minecraft version.
      const xml = await fetchText("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml");
      const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
      // Maven lists these in publish order, which interleaves branches
      // (21.1.x alongside 26.1.x) - sort numerically so the dropdown reads
      // newest-first like every other type here.
      return versions.filter((v) => !PRERELEASE_RE.test(v)).sort(compareVersionsDesc);
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

const DIFFICULTIES = new Set(["peaceful", "easy", "normal", "hard"]);
const GAMEMODES = new Set(["survival", "creative", "adventure", "spectator"]);

// server.properties is a line-based key=value format, so a newline in a value
// would silently split it into a broken second line.
function sanitizePropertyValue(value: string): string {
  return value
    .split("")
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 32 || code === 127 ? " " : ch;
    })
    .join("")
    .trim();
}

function normalizeSettings(settings: ServerInstallSettings | undefined): Required<
  Pick<ServerInstallSettings, "memoryMb">
> &
  ServerInstallSettings {
  const s = settings ?? {};
  const memoryMb = s.memoryMb ?? 4096;
  if (!Number.isInteger(memoryMb) || memoryMb < 512 || memoryMb > 65536) {
    throw new Error(`Invalid memory size: ${memoryMb} MB (expected 512-65536)`);
  }
  if (s.port !== undefined && (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535)) {
    throw new Error(`Invalid port: ${s.port}`);
  }
  if (s.maxPlayers !== undefined && (!Number.isInteger(s.maxPlayers) || s.maxPlayers < 1 || s.maxPlayers > 1000)) {
    throw new Error(`Invalid max players: ${s.maxPlayers}`);
  }
  if (s.difficulty !== undefined && !DIFFICULTIES.has(s.difficulty)) {
    throw new Error(`Invalid difficulty: ${s.difficulty}`);
  }
  if (s.gamemode !== undefined && !GAMEMODES.has(s.gamemode)) {
    throw new Error(`Invalid gamemode: ${s.gamemode}`);
  }
  return { ...s, memoryMb };
}

function applyServerProperties(folder: string, settings: ServerInstallSettings): void {
  const values: Record<string, string> = {};
  if (settings.port !== undefined) values["server-port"] = String(settings.port);
  if (settings.maxPlayers !== undefined) values["max-players"] = String(settings.maxPlayers);
  if (settings.difficulty !== undefined) values["difficulty"] = settings.difficulty;
  if (settings.gamemode !== undefined) values["gamemode"] = settings.gamemode;
  if (settings.motd !== undefined && settings.motd.trim()) {
    values["motd"] = sanitizePropertyValue(settings.motd);
  }
  if (Object.keys(values).length === 0) return;
  writeProperties(path.join(folder, "server.properties"), values);
}

/**
 * Writes the launch script this platform can actually run, and returns its
 * name for the registry entry.
 *
 * A .sh is useless on Windows and a .bat is useless everywhere else, so the
 * installer has to pick - it is the only place that knows a server is being
 * created rather than adopted. CRLF and `@echo off` because cmd.exe wants
 * both: LF-only batch files misbehave, and without the echo suppression every
 * line of the script is printed into the console the dashboard is tailing.
 */
async function writeLaunchScript(
  folder: string,
  jarName: string,
  memoryMb: number,
  nogui: boolean
): Promise<string> {
  const command = `java -Xmx${memoryMb}M -jar ${jarName}${nogui ? " -nogui" : ""}`;
  if (process.platform === "win32") {
    await fsp.writeFile(path.join(folder, "start.bat"), `@echo off\r\n${command}\r\n`);
    return "start.bat";
  }
  await fsp.writeFile(path.join(folder, "start.sh"), `${command}\n`);
  return "start.sh";
}

/**
 * Runs a downloaded installer jar (Forge/NeoForge/Quilt don't publish a ready
 * server jar - they ship an installer that fetches libraries and generates the
 * launch scripts locally). Generous timeout: these pull tens of MB of
 * dependencies and routinely take over a minute on a small VM.
 */
async function runInstaller(folder: string, args: string[]): Promise<void> {
  await execFileAsync("java", args, { cwd: folder, timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 });
}

export async function installServer(input: {
  folder: string;
  type: ServerInstallType;
  version: string;
  settings?: ServerInstallSettings;
  acceptEula?: boolean;
}): Promise<InstallResult> {
  const { folder, type, version } = input;
  const settings = normalizeSettings(input.settings);
  await fsp.mkdir(folder, { recursive: true });

  const isProxy = kindOf(type) === "proxy";
  if (!isProxy) {
    // `eula=true` is a person agreeing to Mojang's licence. It used to be
    // written here unconditionally, which meant the dashboard entered into an
    // agreement on behalf of someone who was never shown it - convenient, and
    // not ours to do. The caller has to have asked.
    if (!input.acceptEula) {
      throw new Error(
        "A Minecraft EULA elfogadása nélkül nem hozható létre szerver. " +
          "https://aka.ms/MinecraftEULA"
      );
    }
    await fsp.writeFile(path.join(folder, "eula.txt"), "eula=true\n");
  }

  const result = await installJarAndScript(folder, type, version, settings.memoryMb);

  if (!isProxy) {
    applyServerProperties(folder, settings);
  }
  return result;
}

async function installJarAndScript(
  folder: string,
  type: ServerInstallType,
  version: string,
  memoryMb: number
): Promise<InstallResult> {
  switch (type) {
    case "paper":
    case "velocity": {
      const project = type === "paper" ? "paper" : "velocity";
      const versions = await listVersions(type);
      if (!versions.includes(version)) throw new Error(`Unknown ${project} version: ${version}`);
      const jar = type === "paper" ? "server.jar" : "velocity.jar";
      await downloadFile(await paperMcDownloadUrl(project, version), path.join(folder, jar));
      const launchScript = await writeLaunchScript(folder, jar, memoryMb, type === "paper");
      // Velocity's console shutdown command is "shutdown", not BungeeCord's "end".
      return { startScript: launchScript, stopCommand: type === "paper" ? "stop" : "shutdown" };
    }
    case "purpur": {
      const versions = await listVersions("purpur");
      if (!versions.includes(version)) throw new Error(`Unknown Purpur version: ${version}`);
      await downloadFile(
        `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/latest/download`,
        path.join(folder, "server.jar")
      );
      const launchScript = await writeLaunchScript(folder, "server.jar", memoryMb, true);
      return { startScript: launchScript, stopCommand: "stop"};
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
      const launchScript = await writeLaunchScript(folder, "server.jar", memoryMb, true);
      return { startScript: launchScript, stopCommand: "stop"};
    }
    case "fabric": {
      const gameVersions = await listVersions("fabric");
      if (!gameVersions.includes(version)) throw new Error(`Unknown Fabric game version: ${version}`);
      const loaders = await fetchJson<{ loader: { version: string } }[]>(
        `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`
      );
      if (loaders.length === 0) throw new Error(`No Fabric loader available for ${version}`);
      const installers = await fetchJson<{ version: string; stable: boolean }[]>(
        "https://meta.fabricmc.net/v2/versions/installer"
      );
      const installer = installers.find((i) => i.stable) ?? installers[0];
      if (!installer) throw new Error("No Fabric installer version available");

      const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(
        loaders[0].loader.version
      )}/${encodeURIComponent(installer.version)}/server/jar`;
      await downloadFile(url, path.join(folder, "server.jar"));
      const launchScript = await writeLaunchScript(folder, "server.jar", memoryMb, true);
      return { startScript: launchScript, stopCommand: "stop"};
    }
    case "quilt": {
      const gameVersions = await listVersions("quilt");
      if (!gameVersions.includes(version)) throw new Error(`Unknown Quilt game version: ${version}`);
      const installers = await fetchJson<{ version: string; url: string }[]>(
        "https://meta.quiltmc.org/v3/versions/installer"
      );
      if (installers.length === 0) throw new Error("No Quilt installer available");
      const installerJar = path.join(folder, "quilt-installer.jar");
      await downloadFile(installers[0].url, installerJar);
      await runInstaller(folder, [
        "-jar",
        "quilt-installer.jar",
        "install",
        "server",
        version,
        "--download-server",
        "--install-dir=.",
      ]);
      await fsp.rm(installerJar, { force: true });
      const launch = await firstExisting(folder, ["quilt-server-launch.jar"]);
      const launchScript = await writeLaunchScript(folder, launch, memoryMb, true);
      return { startScript: launchScript, stopCommand: "stop"};
    }
    case "forge": {
      const promos = await fetchJson<{ promos: Record<string, string> }>(
        "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json"
      );
      const forgeVersion = promos.promos[`${version}-recommended`] ?? promos.promos[`${version}-latest`];
      if (!forgeVersion) throw new Error(`No Forge build available for Minecraft ${version}`);
      const full = `${version}-${forgeVersion}`;
      const installerJar = path.join(folder, "forge-installer.jar");
      await downloadFile(
        `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`,
        installerJar
      );
      await runInstaller(folder, ["-jar", "forge-installer.jar", "--installServer"]);
      await fsp.rm(installerJar, { force: true });
      await fsp.rm(path.join(folder, "forge-installer.jar.log"), { force: true });
      return finishModLoaderInstall(folder, memoryMb);
    }
    case "neoforge": {
      const installerJar = path.join(folder, "neoforge-installer.jar");
      await downloadFile(
        `https://maven.neoforged.net/releases/net/neoforged/neoforge/${encodeURIComponent(
          version
        )}/neoforge-${encodeURIComponent(version)}-installer.jar`,
        installerJar
      );
      await runInstaller(folder, ["-jar", "neoforge-installer.jar", "--installServer"]);
      await fsp.rm(installerJar, { force: true });
      await fsp.rm(path.join(folder, "neoforge-installer.jar.log"), { force: true });
      return finishModLoaderInstall(folder, memoryMb);
    }
    case "bungeecord": {
      await downloadFile(
        "https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar",
        path.join(folder, "BungeeCord.jar")
      );
      const launchScript = await writeLaunchScript(folder, "BungeeCord.jar", memoryMb, false);
      return { startScript: launchScript, stopCommand: "end"};
    }
    default:
      throw new Error(`Unknown server type: ${type}`);
  }
}

async function firstExisting(folder: string, candidates: string[]): Promise<string> {
  for (const name of candidates) {
    if (fs.existsSync(path.join(folder, name))) return name;
  }
  throw new Error(`Installer finished but produced none of: ${candidates.join(", ")}`);
}

/**
 * Forge and NeoForge installers generate their own launcher rather than a
 * runnable jar. Modern versions (MC 1.17+) write a `run.sh` plus a
 * `user_jvm_args.txt` holding the heap flags; older ones leave a plain
 * universal jar behind. Which one appeared is detected rather than assumed,
 * since it depends on the Minecraft version being installed.
 */
async function finishModLoaderInstall(folder: string, memoryMb: number): Promise<InstallResult> {
  // The installer writes run.sh or run.bat depending on where it ran.
  const runner = process.platform === "win32" ? "run.bat" : "run.sh";
  if (fs.existsSync(path.join(folder, runner))) {
    await fsp.writeFile(path.join(folder, "user_jvm_args.txt"), `-Xmx${memoryMb}M\n`);
    // The runner forwards its arguments to the JVM launcher, and `nogui` is
    // what suppresses the Swing server GUI on a headless box.
    if (process.platform === "win32") {
      await fsp.writeFile(path.join(folder, "start.bat"), "@echo off\r\ncall run.bat nogui\r\n");
      return { startScript: "start.bat", stopCommand: "stop" };
    }
    await fsp.writeFile(path.join(folder, "start.sh"), "bash run.sh nogui\n");
    return { startScript: "start.sh", stopCommand: "stop" };
  }
  const entries = await fsp.readdir(folder);
  const jar = entries.find((f) => /^(forge|neoforge).*\.jar$/i.test(f) && !/installer/i.test(f));
  if (!jar) {
    throw new Error("Installer finished but produced neither run.sh nor a Forge/NeoForge server jar");
  }
  const launchScript = await writeLaunchScript(folder, jar, memoryMb, true);
  return { startScript: launchScript, stopCommand: "stop"};
}
