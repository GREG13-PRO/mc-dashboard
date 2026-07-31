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
