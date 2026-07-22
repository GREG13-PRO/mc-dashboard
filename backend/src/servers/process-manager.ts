import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import type { ResourceUsage, ServerEntry } from "../types";

const execFileAsync = promisify(execFile);

/**
 * Path of the plain, line-based console log for a server, written by piping
 * the server's stdout through `tee` (see startServer). The console viewer
 * tails this file rather than attaching to screen directly (see
 * console-stream.ts).
 */
export function consoleLogPath(entry: ServerEntry): string {
  return `${entry.folder}/dashboard-console.log`;
}

// Matches the "<pid>.<name>" prefix of each session line in `screen -ls`
// output. Deliberately ignores everything after the name (state, and on
// some screen versions an extra "(date time)" field before the state) since
// only the name is needed to check whether a given session exists.
const SCREEN_LIST_RE = /^\s*(\d+)\.(\S+)/gm;

// `screen -ls` exits non-zero when there are zero sessions, but still
// prints (or omits) useful stdout on both success and that "failure" - this
// pulls the raw listing out of whichever path it came from.
async function rawScreenList(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("screen", ["-ls"]);
    return stdout;
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? "";
  }
}

export class ScreenNotInstalledError extends Error {
  constructor() {
    super("The 'screen' command is not installed on this machine (try: apt install screen)");
    this.name = "ScreenNotInstalledError";
  }
}

let screenAvailabilityChecked = false;

export async function assertScreenInstalled(): Promise<void> {
  if (screenAvailabilityChecked) return;
  try {
    await execFileAsync("screen", ["-v"]);
    screenAvailabilityChecked = true;
  } catch {
    throw new ScreenNotInstalledError();
  }
}

/**
 * Returns the set of screen session names currently known to `screen -ls`,
 * regardless of attached/detached state. Session names include the pid
 * prefix in raw `screen -ls` output (e.g. "12345.mc-survival-abc123"); this
 * returns just the name part after the dot.
 */
export async function listScreenSessionNames(): Promise<Set<string>> {
  const stdout = await rawScreenList();
  const names = new Set<string>();
  for (const match of stdout.matchAll(SCREEN_LIST_RE)) {
    names.add(match[2]);
  }
  return names;
}

/** Same as listScreenSessionNames, but keyed by name to the screen manager's own PID. */
export async function listScreenPids(): Promise<Map<string, number>> {
  const stdout = await rawScreenList();
  const pids = new Map<string, number>();
  for (const match of stdout.matchAll(SCREEN_LIST_RE)) {
    pids.set(match[2], Number(match[1]));
  }
  return pids;
}

export async function isServerRunning(entry: ServerEntry): Promise<boolean> {
  const names = await listScreenSessionNames();
  return names.has(entry.screenName);
}

export async function startServer(entry: ServerEntry): Promise<void> {
  await assertScreenInstalled();
  if (await isServerRunning(entry)) {
    return;
  }
  const logFile = consoleLogPath(entry);
  // Start each run from an empty logfile so the live console never replays
  // stale lines from a previous run on the next attach.
  await fs.writeFile(logFile, "").catch(() => undefined);
  // Pipe stdout/stderr through `tee` instead of using `screen -L -Logfile`:
  // screen's own logfile writer only flushes its buffer to disk every 10
  // seconds (hardcoded default, confirmed not adjustable at runtime via
  // `-X logfile flush <secs>` on a session already logging), which made the
  // tailed web console lag by up to 10s. `tee` writes each chunk as it
  // arrives, so the logfile - and the tailed console - stays near-real-time.
  // Stdin is unaffected: it still goes straight to the script/JVM on the left
  // of the pipe, so `sendCommand`'s `screen -X stuff` keeps working the same.
  const command = `cd "${entry.folder}" && bash "${entry.startScript}" 2>&1 | tee "${logFile}"`;
  await execFileAsync(
    "screen",
    ["-dmS", entry.screenName, "bash", "-c", command],
    // Under systemd there's no controlling terminal, so TERM is typically
    // missing/"dumb" - give the session a real one from the start so screen
    // never has to guess at terminal capabilities later when a display
    // attaches (see console-stream.ts for the full explanation).
    { env: { ...process.env, TERM: "xterm-256color" } }
  );
}

/**
 * Sends a line of input into the running screen session, as if typed at
 * the console. Independent of whether a console-stream viewer is attached.
 */
export async function sendCommand(entry: ServerEntry, command: string): Promise<void> {
  await execFileAsync("screen", ["-S", entry.screenName, "-X", "stuff", `${command}\n`]);
}

export async function stopServer(entry: ServerEntry, timeoutMs = 30_000): Promise<void> {
  if (!(await isServerRunning(entry))) {
    return;
  }
  await sendCommand(entry, entry.stopCommand);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!(await isServerRunning(entry))) {
      return;
    }
  }

  // Graceful stop timed out - kill the whole screen session (and whatever
  // process tree it holds) rather than leaving it to fight a restart loop.
  await execFileAsync("screen", ["-S", entry.screenName, "-X", "quit"]).catch(() => undefined);
}

export async function restartServer(entry: ServerEntry): Promise<void> {
  await stopServer(entry);
  await startServer(entry);
}

/**
 * Immediately tears down the screen session (and whatever process tree it
 * holds) without sending the stop command or waiting - for a server that's
 * hung or unresponsive to normal `stop`, not a substitute for it in the
 * common case.
 */
export async function killServer(entry: ServerEntry): Promise<void> {
  if (!(await isServerRunning(entry))) {
    return;
  }
  await execFileAsync("screen", ["-S", entry.screenName, "-X", "quit"]).catch(() => undefined);
}

interface PsRow {
  pid: number;
  ppid: number;
  cpu: number;
  rssKb: number;
  comm: string;
}

async function readProcessTable(): Promise<PsRow[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid,ppid,pcpu,rss,comm", "--no-headers"]);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, cpu, rssKb, ...commParts] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), cpu: Number(cpu), rssKb: Number(rssKb), comm: commParts.join(" ") };
    });
}

/**
 * Resource usage (CPU%, RAM) for every currently running server, keyed by
 * server id. A single `ps` + `screen -ls` call is shared across all servers
 * rather than spawning one of each per server, since this is polled on
 * every dashboard list refresh.
 *
 * Each server's screen session wraps `bash -c "... | tee ..."`, so the
 * actual java process is a few generations below the screen manager's own
 * PID - this walks the process tree from there to find it.
 */
export async function getResourceUsageMap(entries: ServerEntry[]): Promise<Map<string, ResourceUsage>> {
  const result = new Map<string, ResourceUsage>();
  const screenPids = await listScreenPids();
  const relevant = entries.filter((e) => screenPids.has(e.screenName));
  if (relevant.length === 0) return result;

  const rows = await readProcessTable();
  const byPpid = new Map<number, PsRow[]>();
  for (const row of rows) {
    const siblings = byPpid.get(row.ppid) ?? [];
    siblings.push(row);
    byPpid.set(row.ppid, siblings);
  }

  for (const entry of relevant) {
    const rootPid = screenPids.get(entry.screenName)!;
    const queue = [rootPid];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const children = byPpid.get(pid) ?? [];
      const javaProc = children.find((c) => c.comm.includes("java"));
      if (javaProc) {
        result.set(entry.id, { cpuPercent: javaProc.cpu, memoryMb: Math.round(javaProc.rssKb / 1024) });
        break;
      }
      for (const child of children) queue.push(child.pid);
    }
  }

  return result;
}
