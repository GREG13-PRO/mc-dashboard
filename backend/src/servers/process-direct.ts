import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ServerEntry } from "../types";

const execFileAsync = promisify(execFile);

/**
 * Runs a Minecraft server as a child process of the dashboard, without screen.
 *
 * The screen-based path is the right one on a Linux host, where the dashboard
 * is a service and the servers have to outlive it. This one exists for the
 * case where the dashboard *is* the app on the user's own machine - notably
 * Windows, which has no screen, no tail, and no /proc - and the app owning the
 * process it started is the natural arrangement there.
 *
 * The trade is stated rather than hidden: a server started this way does not
 * survive the dashboard being closed, because it is a child of it. On a
 * single-machine install that is what someone expects; it is why this is not
 * the default anywhere screen is available.
 */

interface Running {
  child: ChildProcess;
  startedAt: number;
}

const running = new Map<string, Running>();

export function isRunningDirect(entry: ServerEntry): boolean {
  const found = running.get(entry.id);
  if (!found) return false;
  if (found.child.exitCode !== null || found.child.signalCode !== null) {
    running.delete(entry.id);
    return false;
  }
  return true;
}

export function runningIdsDirect(): Set<string> {
  for (const [id, found] of running) {
    if (found.child.exitCode !== null || found.child.signalCode !== null) running.delete(id);
  }
  return new Set(running.keys());
}

export function pidsDirect(): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, found] of running) {
    if (found.child.pid !== undefined) out.set(id, found.child.pid);
  }
  return out;
}

/**
 * Chooses how to run the start script.
 *
 * A .bat cannot be executed directly by CreateProcess and a .sh needs a shell
 * that Windows does not have, so the extension decides - and an unknown one is
 * an error rather than a guess, because guessing wrong here means a server
 * that silently never starts.
 */
function launcher(startScript: string): { command: string; args: string[] } {
  const lower = startScript.toLowerCase();
  if (lower.endsWith(".bat") || lower.endsWith(".cmd")) {
    return { command: process.env.COMSPEC ?? "cmd.exe", args: ["/c", startScript] };
  }
  if (lower.endsWith(".sh")) {
    return { command: "bash", args: [startScript] };
  }
  if (lower.endsWith(".jar")) {
    return { command: "java", args: ["-jar", startScript, "nogui"] };
  }
  throw new Error(`Nem tudom, hogyan kell futtatni: ${startScript}`);
}

export function startDirect(entry: ServerEntry, logFile: string): void {
  if (isRunningDirect(entry)) return;

  const { command, args } = launcher(entry.startScript);
  // Appended rather than truncated: the caller has already archived and
  // cleared the previous run's log, and the console tail is reading this file
  // as it grows.
  const log = fs.createWriteStream(logFile, { flags: "a" });
  const child = spawn(command, args, {
    cwd: entry.folder,
    // stdin stays open: it is how commands reach the server, in place of
    // screen's `stuff`.
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.on("exit", () => {
    log.end();
    running.delete(entry.id);
  });
  child.on("error", (err) => {
    log.write(`\n[dashboard] a folyamat nem indult el: ${err.message}\n`);
    log.end();
    running.delete(entry.id);
  });

  running.set(entry.id, { child, startedAt: Date.now() });
}

export function sendCommandDirect(entry: ServerEntry, command: string): void {
  const found = running.get(entry.id);
  if (!found?.child.stdin?.writable) {
    throw new Error("A szerver nem fut, vagy nem fogad parancsot.");
  }
  found.child.stdin.write(`${command}\n`);
}

async function killById(id: string): Promise<void> {
  const found = running.get(id);
  if (!found?.child.pid) return;
  if (process.platform === "win32") {
    // The JVM is a grandchild of cmd.exe, so killing the immediate child would
    // leave the server running with nothing holding its handle.
    await execFileAsync("taskkill", ["/pid", String(found.child.pid), "/T", "/F"]).catch(
      () => undefined
    );
  } else {
    try {
      found.child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  running.delete(id);
}

export async function killDirect(entry: ServerEntry): Promise<void> {
  await killById(entry.id);
}

/** Everything started this way, for shutting down cleanly with the dashboard. */
export async function killAllDirect(): Promise<void> {
  for (const id of [...running.keys()]) {
    await killById(id).catch(() => undefined);
  }
}

export function directLogPath(entry: ServerEntry): string {
  return path.join(entry.folder, "dashboard-console.log");
}
