import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import type { ServerEntry } from "../types";

const execFileAsync = promisify(execFile);

/**
 * Path of the plain, line-based console log that `screen -L` writes for a
 * server. The console viewer tails this file rather than attaching to screen
 * directly (see console-stream.ts).
 */
export function consoleLogPath(entry: ServerEntry): string {
  return `${entry.folder}/dashboard-console.log`;
}

// Matches the "<pid>.<name>" prefix of each session line in `screen -ls`
// output. Deliberately ignores everything after the name (state, and on
// some screen versions an extra "(date time)" field before the state) since
// only the name is needed to check whether a given session exists.
const SCREEN_LIST_RE = /^\s*\d+\.(\S+)/gm;

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
  try {
    const { stdout } = await execFileAsync("screen", ["-ls"]);
    const names = new Set<string>();
    for (const match of stdout.matchAll(SCREEN_LIST_RE)) {
      names.add(match[1]);
    }
    return names;
  } catch (err) {
    // `screen -ls` exits with a non-zero status when there are zero
    // sessions, but still prints (or omits) useful stdout - treat as empty.
    const stdout = (err as { stdout?: string }).stdout ?? "";
    const names = new Set<string>();
    for (const match of stdout.matchAll(SCREEN_LIST_RE)) {
      names.add(match[1]);
    }
    return names;
  }
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
  // Start each run from an empty logfile: `screen -L` *appends*, so without
  // this the log would grow without bound across restarts and the live console
  // would replay stale lines from previous runs on the next attach.
  await fs.writeFile(logFile, "").catch(() => undefined);
  const command = `cd "${entry.folder}" && exec bash "${entry.startScript}"`;
  await execFileAsync(
    "screen",
    ["-L", "-Logfile", logFile, "-dmS", entry.screenName, "bash", "-c", command],
    // Under systemd there's no controlling terminal, so TERM is typically
    // missing/"dumb" - give the session a real one from the start so screen
    // never has to guess at terminal capabilities later when a display
    // attaches (see console-stream.ts for the full explanation).
    { env: { ...process.env, TERM: "xterm-256color" } }
  );
  // screen buffers logfile writes and flushes only every 10s by default, which
  // makes the tailed live console lag badly. Flush every second so the web
  // console stays near-real-time. Ignore failure - the console still works,
  // just less promptly.
  await execFileAsync("screen", [
    "-S",
    entry.screenName,
    "-X",
    "logfile",
    "flush",
    "1",
  ]).catch(() => undefined);
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
