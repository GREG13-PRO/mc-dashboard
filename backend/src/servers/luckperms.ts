import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { consoleLogPath, sendCommand, isServerRunning } from "./process-manager";
import type { ServerEntry } from "../types";

/**
 * Surfaces LuckPerms' own web editor.
 *
 * `/lp editor` uploads a snapshot of the permission data to LuckPerms' hosted
 * editor and prints a one-time URL. Rather than reimplementing a permissions
 * UI - which would have to keep up with LuckPerms' data model forever - the
 * dashboard runs that command and picks the URL back out of the console.
 */

const EDITOR_URL_RE = /https:\/\/(?:editor\.luckperms\.net|luckperms\.net\/editor)\/\S+/i;

// The server writes colour codes (TERM is set for the screen session), and an
// SGR reset lands immediately after the URL - `\S+` swallows it, producing a
// link with a trailing escape sequence. They are stripped before matching.
const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Detected from the plugins folder rather than by asking the server, so the
 * tab is present even while it is stopped. */
export function hasLuckPerms(entry: ServerEntry): boolean {
  const dir = path.join(entry.folder, "plugins");
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).some((f) => /^luckperms.*\.jar$/i.test(f));
  } catch {
    return false;
  }
}

async function readLogTail(entry: ServerEntry, bytes = 64 * 1024): Promise<string> {
  const file = consoleLogPath(entry);
  if (!fs.existsSync(file)) return "";
  const stat = await fsp.stat(file);
  const start = Math.max(0, stat.size - bytes);
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(bytes, stat.size));
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf-8");
  } finally {
    await handle.close();
  }
}

export class LuckPermsError extends Error {}

/**
 * Whether a page will let itself be put in a frame.
 *
 * Asked here rather than detected in the browser, because the browser cannot
 * tell. A frame blocked by X-Frame-Options still fires `load` - it navigates to
 * the browser's own error page - and being cross-origin, nothing about its
 * contents is readable. Waiting for a load event that always arrives was the
 * first version of this and it never once caught the case it was written for.
 *
 * The headers are the actual rule, so the headers are what gets read.
 */
export async function isEmbeddable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(6000),
    });
    const xfo = (res.headers.get("x-frame-options") ?? "").toLowerCase();
    if (xfo.includes("deny") || xfo.includes("sameorigin")) return false;

    const csp = (res.headers.get("content-security-policy") ?? "").toLowerCase();
    const ancestors = /frame-ancestors([^;]*)/.exec(csp)?.[1]?.trim();
    if (ancestors === undefined) return true;
    // Any list that is not a wildcard excludes this dashboard: it is served
    // from a private address that nobody would have listed.
    return ancestors === "*" || ancestors.startsWith("* ");
  } catch {
    // Unreachable from here says nothing about the browser, which may well have
    // a route we do not. Assume it works and let the user fall back by hand.
    return true;
  }
}

/**
 * Reads whatever the server printed after a command.
 *
 * The console is one-way - commands go in through screen and nothing comes
 * back - so the only way to learn what happened is to note how long the log
 * was beforehand and read the bytes that appear after. Shared by both commands
 * here rather than written twice.
 */
async function runAndReadReply(
  entry: ServerEntry,
  command: string,
  matches: (fresh: string) => string | null,
  timeoutMs: number
): Promise<string> {
  const file = consoleLogPath(entry);
  const sizeBefore = fs.existsSync(file) ? (await fsp.stat(file)).size : 0;

  await sendCommand(entry, command);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    if (!fs.existsSync(file)) continue;
    const stat = await fsp.stat(file);
    if (stat.size <= sizeBefore) continue;

    const handle = await fsp.open(file, "r");
    let fresh: string;
    try {
      const buffer = Buffer.alloc(stat.size - sizeBefore);
      await handle.read(buffer, 0, buffer.length, sizeBefore);
      fresh = stripAnsi(buffer.toString("utf-8"));
    } finally {
      await handle.close();
    }

    const found = matches(fresh);
    if (found !== null) return found;
  }
  throw new LuckPermsError(
    `Nem érkezett válasz ${timeoutMs / 1000} másodpercen belül. A konzol vége: ${stripAnsi(
      await readLogTail(entry, 4000)
    ).slice(-300)}`
  );
}

/**
 * The editor hands back a code; this is what turns it into applied changes.
 *
 * Without it the round trip is: edit in the browser, copy a code, find the
 * console tab, type `lp applyedits <code>`. The code is checked against an
 * allowlist before it goes anywhere near the command line, because sendCommand
 * interpolates straight into `screen -X stuff` - the same reason player names
 * are validated in servers.routes.ts.
 */
const APPLY_CODE_RE = /^[A-Za-z0-9]{1,32}$/;

export async function applyEdits(entry: ServerEntry, code: string): Promise<string> {
  if (!APPLY_CODE_RE.test(code)) {
    throw new LuckPermsError("Ez nem érvényes alkalmazási kód.");
  }
  if (!(await isServerRunning(entry))) {
    throw new LuckPermsError("A módosítások alkalmazásához futnia kell a szervernek.");
  }

  return runAndReadReply(
    entry,
    `lp applyedits ${code}`,
    (fresh) => {
      // LuckPerms answers with a summary line on success and a complaint on
      // failure; both are reported back rather than only the happy path, so a
      // rejected code does not look like a timeout.
      const line = fresh
        .split("\n")
        .map((l) => l.replace(/^\[[^\]]*\]:?\s*/, "").trim())
        .filter(Boolean)
        .find((l) => /applied|unable|couldn't|could not|invalid|no data|error/i.test(l));
      return line ?? null;
    },
    20_000
  );
}

/**
 * Issues `lp editor` and waits for the URL to appear in the console.
 *
 * The console is the only channel: commands go in through screen and nothing
 * comes back, so the answer has to be read out of the log. The size of the log
 * before the command is recorded first, so a URL from an earlier invocation is
 * never mistaken for this one.
 */
export async function createEditorSession(entry: ServerEntry, timeoutMs = 25_000): Promise<string> {
  if (!hasLuckPerms(entry)) {
    throw new LuckPermsError("Ezen a szerveren nincs telepítve a LuckPerms.");
  }
  if (!(await isServerRunning(entry))) {
    throw new LuckPermsError("A LuckPerms szerkesztőhöz futnia kell a szervernek.");
  }

  const file = consoleLogPath(entry);
  const sizeBefore = fs.existsSync(file) ? (await fsp.stat(file)).size : 0;

  await sendCommand(entry, "lp editor");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    if (!fs.existsSync(file)) continue;
    const stat = await fsp.stat(file);
    if (stat.size <= sizeBefore) continue;

    // Only the bytes written since the command was sent are considered.
    const handle = await fsp.open(file, "r");
    let fresh: string;
    try {
      const buffer = Buffer.alloc(stat.size - sizeBefore);
      await handle.read(buffer, 0, buffer.length, sizeBefore);
      fresh = stripAnsi(buffer.toString("utf-8"));
    } finally {
      await handle.close();
    }

    const match = EDITOR_URL_RE.exec(fresh);
    // Trailing punctuation from whatever sentence the URL was printed inside.
    if (match) return match[0].replace(/[).,'"\]]+$/g, "");

    if (/no.*permission|unknown command/i.test(fresh)) {
      throw new LuckPermsError("A szerver nem ismerte fel az 'lp editor' parancsot.");
    }
  }

  const tail = stripAnsi(await readLogTail(entry, 4000));
  throw new LuckPermsError(
    `Nem érkezett szerkesztő-link ${timeoutMs / 1000} másodpercen belül. A konzol vége: ${tail.slice(-300)}`
  );
}
