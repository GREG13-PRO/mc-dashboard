import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { listInstalledPlugins } from "./plugin-manager";
import { consoleLogPath, isServerRunning, sendCommand } from "./process-manager";
import type { ServerEntry } from "../types";

// --------------------------------------------------------- plugin conflicts

export interface PluginConflict {
  severity: "conflict" | "warning";
  plugins: string[];
  message: string;
}

/**
 * Known-bad plugin combinations.
 *
 * Deliberately a curated list rather than anything clever: conflicts are
 * specific facts about specific plugins, and guessing at them from jar
 * contents would produce confident nonsense. Matching is on the plugin name
 * from plugin.yml, lowercased.
 */
const KNOWN_CONFLICTS: { a: string; b: string; severity: "conflict" | "warning"; message: string }[] = [
  {
    a: "worldedit",
    b: "fastasyncworldedit",
    severity: "conflict",
    message: "A FAWE tartalmazza a WorldEditet; a kettő együtt nem tölthető be.",
  },
  {
    a: "essentials",
    b: "cmi",
    severity: "conflict",
    message: "Az EssentialsX és a CMI ugyanazokat az alapparancsokat regisztrálja.",
  },
  {
    a: "luckperms",
    b: "permissionsex",
    severity: "conflict",
    message: "Két jogosultságkezelő egyszerre - csak az egyik fog érvényesülni.",
  },
  { a: "luckperms", b: "groupmanager", severity: "conflict", message: "Két jogosultságkezelő egyszerre." },
  {
    a: "protocollib",
    b: "viaversion",
    severity: "warning",
    message: "Együtt működnek, de verzióeltérésnél gyakori a csomaghiba - tartsd mindkettőt naprakészen.",
  },
  {
    a: "authme",
    b: "opensecurity",
    severity: "warning",
    message: "Két bejelentkezés-kezelő egymás után futtatva kizárhatja a játékosokat.",
  },
  {
    a: "essentials",
    b: "essentialsx",
    severity: "conflict",
    message: "Ugyanaz a plugin kétszer, eltérő fájlnéven.",
  },
  {
    a: "multiverse-core",
    b: "myworlds",
    severity: "warning",
    message: "Két világkezelő; a világ-betöltési sorrend kiszámíthatatlanná válhat.",
  },
];

export async function detectConflicts(entry: ServerEntry): Promise<PluginConflict[]> {
  const installed = await listInstalledPlugins(entry);
  const byName = new Map<string, string>();
  for (const p of installed) {
    const key = (p.name ?? p.filename.replace(/\.jar$/i, "")).toLowerCase().replace(/[\s_-]/g, "");
    byName.set(key, p.name ?? p.filename);
  }

  const found: PluginConflict[] = [];
  for (const rule of KNOWN_CONFLICTS) {
    const a = byName.get(rule.a.replace(/[\s_-]/g, ""));
    const b = byName.get(rule.b.replace(/[\s_-]/g, ""));
    if (a && b) found.push({ severity: rule.severity, plugins: [a, b], message: rule.message });
  }

  // Two jars declaring the same plugin name is always wrong, whatever they are.
  const seen = new Map<string, string[]>();
  for (const p of installed) {
    if (!p.name) continue;
    const list = seen.get(p.name) ?? [];
    list.push(p.filename);
    seen.set(p.name, list);
  }
  for (const [name, files] of seen) {
    if (files.length > 1) {
      found.push({
        severity: "conflict",
        plugins: files,
        message: `A(z) "${name}" plugin két példányban van telepítve - az egyiket törölni kell.`,
      });
    }
  }
  return found;
}

// ------------------------------------------------------------- lag doctor

export interface LagReport {
  generatedAt: string;
  /** Raw console output of the diagnostic commands, for anything not parsed. */
  raw: string;
  tps: string | null;
  findings: string[];
}

// Paper prints "TPS from last 1m, 5m, 15m: *20.0, *20.0, *20.0". Anchoring on
// the colon after the window list matters: a looser pattern captures the "1"
// out of "1m" and reports a healthy server as being at 1 TPS.
const TPS_LINE_RE = /TPS from last[^:]*:\s*([^\n\r]+)/i;

function parseTps(raw: string): { text: string; worst: number } | null {
  const line = TPS_LINE_RE.exec(raw)?.[1];
  if (!line) return null;
  // The JVM formats these with the host locale's decimal separator, so on a
  // Hungarian machine the line reads "20,0, 20,0, 20,0". Parsing only a dot
  // splits each value in two and yields a minimum of 0 - which reported a
  // perfectly healthy server as being in severe lag. Both separators are
  // accepted, and values carry a leading * when Paper considers them degraded.
  const numbers = [...line.matchAll(/\*?(\d+(?:[.,]\d+)?)/g)].map((m) =>
    Number.parseFloat(m[1].replace(",", "."))
  );
  const valid = numbers.filter((n) => Number.isFinite(n) && n <= 20.5);
  if (valid.length === 0) return null;
  return { text: valid.map((n) => n.toFixed(2)).join(", "), worst: Math.min(...valid) };
}

/**
 * Runs the diagnostic commands a human would run and reports what came back.
 *
 * There is no profiler here: real lag attribution needs Spark, which is a
 * plugin, not something a dashboard can synthesise. What this does is collect
 * `tps`, entity counts and the recent log, and point at what stands out - and
 * says plainly when it cannot tell.
 */
export async function diagnoseLag(entry: ServerEntry): Promise<LagReport> {
  if (!(await isServerRunning(entry))) {
    throw new Error("A diagnosztikához futnia kell a szervernek.");
  }

  const file = consoleLogPath(entry);
  const sizeBefore = fs.existsSync(file) ? (await fsp.stat(file)).size : 0;

  for (const command of ["tps", "list"]) {
    await sendCommand(entry, command).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 600));
  }
  await new Promise((r) => setTimeout(r, 2500));

  let raw = "";
  if (fs.existsSync(file)) {
    const stat = await fsp.stat(file);
    if (stat.size > sizeBefore) {
      const handle = await fsp.open(file, "r");
      try {
        const buffer = Buffer.alloc(stat.size - sizeBefore);
        await handle.read(buffer, 0, buffer.length, sizeBefore);
        raw = buffer.toString("utf-8").replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g"), "");
      } finally {
        await handle.close();
      }
    }
  }

  const findings: string[] = [];
  const parsed = parseTps(raw);
  const tps = parsed?.text ?? null;
  if (parsed) {
    // The 1m figure is the one that reflects "right now", but a dip in any
    // window is worth surfacing, so the worst of the three is judged.
    const { worst } = parsed;
    if (worst < 15) findings.push(`Súlyos lag: a legrosszabb TPS ${worst.toFixed(2)} (20 a normális).`);
    else if (worst < 19) findings.push(`Enyhe lag: a legrosszabb TPS ${worst.toFixed(2)}.`);
    else findings.push(`A TPS rendben van (${tps}).`);
  } else {
    findings.push("A szerver nem válaszolt a 'tps' parancsra - Paper/Purpur nélkül ez a parancs nincs meg.");
  }

  const worldSize = await estimateWorldSize(entry);
  if (worldSize > 5 * 1024 ** 3) {
    findings.push(
      `A világ ${(worldSize / 1024 ** 3).toFixed(1)} GB - a nagy, sokat bejárt világ önmagában is lassítja a chunk-betöltést.`
    );
  }

  const conflicts = await detectConflicts(entry);
  for (const c of conflicts.filter((c) => c.severity === "conflict")) {
    findings.push(`Plugin-ütközés: ${c.plugins.join(" + ")} - ${c.message}`);
  }

  findings.push(
    "Pontos okhoz (melyik entity/chunk/plugin) telepítsd a Spark plugint, és futtasd: /spark profiler start"
  );

  return { generatedAt: new Date().toISOString(), raw: raw.slice(-4000), tps, findings };
}

async function estimateWorldSize(entry: ServerEntry): Promise<number> {
  let total = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (/\.mca$/i.test(e.name)) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          continue;
        }
      }
    }
  }
  await walk(entry.folder, 0);
  return total;
}

// ------------------------------------------------------------- JVM wizard

export interface JvmRecommendation {
  hostMemoryMb: number;
  currentScript: string;
  recommendedHeapMb: number;
  flags: string[];
  script: string;
  notes: string[];
}

/**
 * Aikar's flags, which are the de-facto standard for Minecraft servers, sized
 * against the machine's actual RAM. The G1 region size and the new-generation
 * percentages differ above and below 12 GB, which is the one part of this that
 * is easy to get wrong by copying a snippet.
 */
export async function recommendJvmFlags(entry: ServerEntry, requestedHeapMb?: number): Promise<JvmRecommendation> {
  const hostMemoryMb = Math.floor(os.totalmem() / 1024 / 1024);
  const notes: string[] = [];

  // Leave room for the OS, the dashboard and any other server on the box.
  const headroomMb = Math.max(1024, Math.floor(hostMemoryMb * 0.25));
  const suggested = requestedHeapMb ?? Math.max(1024, hostMemoryMb - headroomMb);
  const recommendedHeapMb = Math.min(suggested, hostMemoryMb - 512);

  if (recommendedHeapMb >= hostMemoryMb - headroomMb + 1) {
    notes.push("A kért heap közel van a gép teljes memóriájához - swappeléshez és akadozáshez vezethet.");
  }
  if (hostMemoryMb < 3072) {
    notes.push(`A gépben összesen ${hostMemoryMb} MB RAM van; ez egy Minecraft szerverhez szűkös.`);
  }

  const large = recommendedHeapMb >= 12 * 1024;
  const flags = [
    `-Xms${recommendedHeapMb}M`,
    `-Xmx${recommendedHeapMb}M`,
    "-XX:+UseG1GC",
    "-XX:+ParallelRefProcEnabled",
    "-XX:MaxGCPauseMillis=200",
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:+DisableExplicitGC",
    "-XX:+AlwaysPreTouch",
    `-XX:G1NewSizePercent=${large ? 40 : 30}`,
    `-XX:G1MaxNewSizePercent=${large ? 50 : 40}`,
    `-XX:G1HeapRegionSize=${large ? "16M" : "8M"}`,
    `-XX:G1ReservePercent=${large ? 15 : 20}`,
    "-XX:G1HeapWastePercent=5",
    "-XX:G1MixedGCCountTarget=4",
    `-XX:InitiatingHeapOccupancyPercent=${large ? 20 : 15}`,
    "-XX:G1MixedGCLiveThresholdPercent=90",
    "-XX:G1RSetUpdatingPauseTimePercent=5",
    "-XX:SurvivorRatio=32",
    "-XX:+PerfDisableSharedMem",
    "-XX:MaxTenuringThreshold=1",
    "-Dusing.aikars.flags=https://mcflags.emc.gs",
    "-Daikars.new.flags=true",
  ];
  notes.push(
    large
      ? "12 GB fölött a G1 régióméret és az új generáció aránya eltér - a script ehhez van igazítva."
      : "12 GB alatti heaphez való beállítások."
  );

  let currentScript = "";
  try {
    currentScript = await fsp.readFile(path.join(entry.folder, entry.startScript), "utf-8");
  } catch {
    currentScript = "(nem olvasható)";
  }

  const jarLine = /-jar\s+(\S+)/.exec(currentScript);
  const jar = jarLine?.[1] ?? "server.jar";
  const nogui = /\bnogui\b/.test(currentScript) ? " -nogui" : "";
  const script = `java ${flags.join(" ")} -jar ${jar}${nogui}\n`;

  return { hostMemoryMb, currentScript, recommendedHeapMb, flags, script, notes };
}

export async function applyJvmScript(entry: ServerEntry, script: string): Promise<void> {
  if (!/^java\s/.test(script.trim())) {
    throw new Error("A start script első parancsának 'java'-nak kell lennie.");
  }
  if (await isServerRunning(entry)) {
    throw new Error("Állítsd le a szervert a start script módosítása előtt.");
  }
  const file = path.join(entry.folder, entry.startScript);
  // Keep a copy: this overwrites a file the user may have hand-tuned.
  await fsp.copyFile(file, `${file}.bak`).catch(() => undefined);
  await fsp.writeFile(file, script, "utf-8");
}
