import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "../config/env";
import { fetchText, downloadFile } from "./http-download";
import { rconCommand } from "./rcon";
import { isServerRunning } from "./process-manager";
import type { ServerEntry } from "../types";

const execFileAsync = promisify(execFile);

/**
 * Write a plugin in the dashboard, compile it, and put it on a test server
 * without leaving the browser.
 *
 * One source file per project on purpose. What this is for is trying a command
 * or a listener and seeing it work thirty seconds later; anything that grows a
 * package structure has outgrown a textarea and belongs in a real project with
 * a real build.
 *
 * Compilation happens on this machine with javac, against Paper's own API jar
 * for the version the target server runs - so a mistake is a compiler error in
 * the browser rather than a plugin that loads and then throws at runtime.
 */

export class PluginLabError extends Error {}

const PROJECT_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const PAPER_REPO = "https://repo.papermc.io/repository/maven-public/io/papermc/paper/paper-api";

export interface LabProject {
  name: string;
  source: string;
  updatedAt: string;
}

export interface CompileResult {
  ok: boolean;
  /** javac's own output, shown as-is: it is better at explaining Java than I am. */
  output: string;
  jarPath: string | null;
}

function labDir(): string {
  return path.join(env.dataDir, "plugin-lab");
}

/**
 * Java requires a public class to live in a file of the same name, so the
 * source is stored as <Name>.java rather than a generic source.java - javac
 * rejects the latter outright, which is exactly what it did the first time.
 */
function sourceFile(name: string): string {
  return path.join(projectDir(name), `${name}.java`);
}

function projectDir(name: string): string {
  if (!PROJECT_NAME_RE.test(name)) {
    throw new PluginLabError("A projekt neve betűvel kezdődjön, és csak betűt-számot tartalmazzon.");
  }
  return path.join(labDir(), name);
}

export function defaultSource(name: string): string {
  return `package hu.mcdashboard.lab;

import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.plugin.java.JavaPlugin;

public final class ${name} extends JavaPlugin {

    @Override
    public void onEnable() {
        getLogger().info("${name} enabled");
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        sender.sendMessage("Hello from ${name}");
        return true;
    }
}
`;
}

export async function listProjects(): Promise<LabProject[]> {
  let names: string[];
  try {
    names = (await fsp.readdir(labDir(), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const projects: LabProject[] = [];
  for (const name of names) {
    if (!PROJECT_NAME_RE.test(name)) continue;
    const file = sourceFile(name);
    if (!fs.existsSync(file)) continue;
    const stat = await fsp.stat(file);
    projects.push({
      name,
      source: await fsp.readFile(file, "utf-8"),
      updatedAt: stat.mtime.toISOString(),
    });
  }
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveProject(name: string, source: string): Promise<LabProject> {
  await fsp.mkdir(projectDir(name), { recursive: true });
  await fsp.writeFile(sourceFile(name), source, "utf-8");
  return { name, source, updatedAt: new Date().toISOString() };
}

export async function deleteProject(name: string): Promise<void> {
  await fsp.rm(projectDir(name), { recursive: true, force: true });
}

/**
 * Resolves and caches Paper's API jar for a Minecraft version.
 *
 * Paper only publishes these as Maven snapshots, so the concrete filename has
 * to be read out of maven-metadata.xml - a snapshot's "latest" is a timestamped
 * build, not the version in the directory name.
 */
async function paperApiJar(minecraftVersion: string): Promise<string> {
  const version = `${minecraftVersion}-R0.1-SNAPSHOT`;
  const cached = path.join(labDir(), "lib", `paper-api-${version}.jar`);
  if (fs.existsSync(cached)) return cached;

  const metadata = await fetchText(`${PAPER_REPO}/${version}/maven-metadata.xml`).catch(() => "");
  const timestamp = /<timestamp>([^<]+)<\/timestamp>/.exec(metadata)?.[1];
  const buildNumber = /<buildNumber>([^<]+)<\/buildNumber>/.exec(metadata)?.[1];
  if (!timestamp || !buildNumber) {
    throw new PluginLabError(
      `A Paper API nem érhető el ehhez a verzióhoz: ${minecraftVersion}. Ellenőrizd, hogy a szerver verziója felismerhető-e.`
    );
  }
  const filename = `paper-api-${minecraftVersion}-R0.1-${timestamp}-${buildNumber}.jar`;
  await fsp.mkdir(path.dirname(cached), { recursive: true });
  await downloadFile(`${PAPER_REPO}/${version}/${filename}`, cached);
  return cached;
}

/** Whether this machine can compile at all, so the screen can say why not. */
export async function toolchain(): Promise<{ javac: string | null; jar: string | null }> {
  // `--version` rather than `-version`: javac accepts both, but `jar` only
  // understands the long form and exits non-zero on the short one, which made
  // a machine with a perfectly good JDK report as having none.
  const probe = async (binary: string) => {
    try {
      const { stdout, stderr } = await execFileAsync(binary, ["--version"], { timeout: 5000 });
      return `${stdout}${stderr}`.trim().split("\n")[0];
    } catch {
      return null;
    }
  };
  return { javac: await probe("javac"), jar: await probe("jar") };
}

/**
 * Every jar the target server itself loads.
 *
 * Paper's API jar alone is not enough to compile against: its signatures
 * mention Adventure classes, and javac refuses with "cannot access Namespaced"
 * the moment a plugin extends JavaPlugin. Rather than resolving Maven
 * dependencies by hand, the classpath is taken from the server's own
 * libraries folder - which is already on this disk and is by definition the
 * exact set of versions that server runs.
 */
async function serverLibraries(entry: ServerEntry): Promise<string[]> {
  const root = path.join(entry.folder, "libraries");
  const jars: string[] = [];
  const walk = async (dir: string) => {
    let items: fs.Dirent[];
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      // Only files that are actually there: a libraries folder accumulates
      // entries for jars a past version needed, and javac warns loudly about
      // every path element it cannot read.
      else if (item.name.endsWith(".jar") && item.isFile()) jars.push(full);
    }
  };
  await walk(root);
  return jars;
}

export async function compileProject(
  name: string,
  entry: ServerEntry,
  minecraftVersion: string
): Promise<CompileResult> {
  const dir = projectDir(name);
  const source = sourceFile(name);
  if (!fs.existsSync(source)) throw new PluginLabError("Nincs ilyen projekt.");

  const tools = await toolchain();
  if (!tools.javac || !tools.jar) {
    throw new PluginLabError(
      "Ezen a gépen nincs JDK. Telepítsd: sudo apt install openjdk-21-jdk-headless"
    );
  }

  const api = await paperApiJar(minecraftVersion);
  const classpath = [api, ...(await serverLibraries(entry))].join(path.delimiter);
  const build = path.join(dir, "build");
  await fsp.rm(build, { recursive: true, force: true });
  await fsp.mkdir(path.join(build, "classes"), { recursive: true });

  let output = "";
  try {
    const { stdout, stderr } = await execFileAsync(
      "javac",
      [
        "-cp",
        classpath,
        "-d",
        path.join(build, "classes"),
        // The server's libraries carry annotation processors that javac would
        // otherwise run and warn about; nothing here wants them.
        "-proc:none",
        "-Xlint:all",
        source,
      ],
      { timeout: 60_000 }
    );
    output = `${stdout}${stderr}`.trim();
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() || String(failure.message),
      jarPath: null,
    };
  }

  await fsp.writeFile(
    path.join(build, "classes", "plugin.yml"),
    [
      `name: ${name}`,
      `version: '1.0-lab'`,
      `main: hu.mcdashboard.lab.${name}`,
      `api-version: '${minecraftVersion.split(".").slice(0, 2).join(".")}'`,
      `commands:`,
      `  ${name.toLowerCase()}:`,
      `    description: ${name} lab command`,
      "",
    ].join("\n"),
    "utf-8"
  );

  const jarPath = path.join(build, `${name}-lab.jar`);
  await execFileAsync("jar", ["--create", "--file", jarPath, "-C", path.join(build, "classes"), "."], {
    timeout: 30_000,
  });
  return { ok: true, output: output || "Sikeres fordítás.", jarPath };
}

export interface DeployResult {
  installed: string;
  reloadOutput: string | null;
}

/**
 * Puts the compiled jar on a server, and optionally asks it to reload.
 *
 * The reload is offered but not the default, and the screen says why: Paper's
 * `/reload` re-initialises every plugin on the server and is documented as
 * unsupported. On a scratch test server that is an acceptable trade for a
 * thirty-second loop; anywhere else it is a way to corrupt an afternoon.
 */
export async function deployProject(
  name: string,
  entry: ServerEntry,
  minecraftVersion: string,
  reload: boolean
): Promise<DeployResult> {
  const result = await compileProject(name, entry, minecraftVersion);
  if (!result.ok || !result.jarPath) {
    throw new PluginLabError("A fordítás nem sikerült, így nincs mit telepíteni.");
  }

  const plugins = path.join(entry.folder, "plugins");
  await fsp.mkdir(plugins, { recursive: true });
  const target = path.join(plugins, `${name}-lab.jar`);
  await fsp.copyFile(result.jarPath, target);

  let reloadOutput: string | null = null;
  if (reload) {
    if (!(await isServerRunning(entry))) {
      reloadOutput = "A szerver nem fut, így nincs mit újratölteni - indításkor betöltődik.";
    } else {
      reloadOutput = await rconCommand(entry, "reload confirm").catch(
        (err: Error) => `Az újratöltés nem sikerült: ${err.message}`
      );
    }
  }
  return { installed: path.basename(target), reloadOutput };
}
