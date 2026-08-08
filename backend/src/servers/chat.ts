import fs from "node:fs";
import fsp from "node:fs/promises";
import { consoleLogPath, sendCommand, isServerRunning } from "./process-manager";
import type { ServerEntry } from "../types";

/**
 * The conversation, pulled out of the console.
 *
 * Chat has always been visible on this dashboard - buried in the console
 * between the GC notices, the plugin banners and whatever a mod decides to log
 * every tick. Somebody asking a question in game scrolls past in a second, and
 * answering meant typing `say` into a box built for `stop` and `op`.
 *
 * Read from the log rather than streamed. The console tail already exists and
 * a second live channel for the same bytes would be two things to keep in step;
 * the map polls its players every three seconds and nobody minds, and a chat
 * window that is three seconds behind is still a chat window.
 */

export type ChatKind = "chat" | "me" | "join" | "leave" | "death";

export interface ChatMessage {
  /** The clock time the server printed, as it printed it. */
  at: string;
  kind: ChatKind;
  /** Who it is about; null for anything that is not attributable. */
  player: string | null;
  text: string;
}

/**
 * The two shapes a Minecraft log line comes in.
 *
 * Paper's current format is `[22:50:39 INFO]: ...`; the classic one, still used
 * by vanilla and by older builds, is `[22:50:39] [Server thread/INFO]: ...`.
 * Both are matched because a dashboard managing four servers will meet both.
 */
const LINE_RE = /^\[(\d{2}:\d{2}:\d{2})(?:\s+\w+)?\](?:\s*\[[^\]]*\])?:\s?(.*)$/;

/** `<Steve> hello` - the vanilla chat format. */
const CHAT_RE = /^<([A-Za-z0-9_]{1,16})>\s(.*)$/;
/** `* Steve waves` - what /me produces. */
const ME_RE = /^\*\s([A-Za-z0-9_]{1,16})\s(.+)$/;
const JOIN_RE = /^([A-Za-z0-9_]{1,16}) joined the game$/;
const LEAVE_RE = /^([A-Za-z0-9_]{1,16}) left the game$/;

/**
 * Death messages, as a subset.
 *
 * There are well over a hundred of them and they are translated, so matching
 * them all is not a thing this can promise. These are the vanilla English
 * phrasings people actually see, and a line that is a death but not on this
 * list simply does not appear in the chat window - which is a gap, not a wrong
 * answer. Everything here starts with a player name, so a false positive would
 * need a player called something that begins a sentence.
 */
const DEATH_PHRASES = [
  " was slain by ",
  " was shot by ",
  " was killed by ",
  " was blown up by ",
  " was fireballed by ",
  " was pricked to death",
  " walked into a cactus",
  " drowned",
  " experienced kinetic energy",
  " blew up",
  " hit the ground too hard",
  " fell from a high place",
  " fell off ",
  " went up in flames",
  " burned to death",
  " tried to swim in lava",
  " suffocated in a wall",
  " starved to death",
  " froze to death",
  " was squashed by ",
  " was impaled by ",
  " was struck by lightning",
  " withered away",
  " died",
];

const DEATH_RE = new RegExp(
  `^([A-Za-z0-9_]{1,16})(${DEATH_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`
);

/** Colour codes and the ANSI the console wrapper adds. */
function clean(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/§[0-9a-fk-or]/gi, "");
}

/**
 * Turns console lines into messages, dropping everything that is not one.
 *
 * Exported so it can be checked against real log output. The parsing is the
 * whole of this module's risk - the reading is a file tail and the sending is
 * one command - so it is the part worth being able to test without a server
 * and somebody talking on it.
 */
export function parseChat(lines: string[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const raw of lines) {
    const line = LINE_RE.exec(clean(raw).trimEnd());
    if (!line) continue;
    const [, at, body] = line;

    const chat = CHAT_RE.exec(body);
    if (chat) {
      out.push({ at, kind: "chat", player: chat[1], text: chat[2] });
      continue;
    }
    const me = ME_RE.exec(body);
    if (me) {
      out.push({ at, kind: "me", player: me[1], text: me[2] });
      continue;
    }
    const join = JOIN_RE.exec(body);
    if (join) {
      out.push({ at, kind: "join", player: join[1], text: body });
      continue;
    }
    const leave = LEAVE_RE.exec(body);
    if (leave) {
      out.push({ at, kind: "leave", player: leave[1], text: body });
      continue;
    }
    const death = DEATH_RE.exec(body);
    if (death) {
      out.push({ at, kind: "death", player: death[1], text: body });
    }
  }
  return out;
}

/** How much of the log to read back. Enough for a conversation, not a history. */
const TAIL_BYTES = 512 * 1024;

export async function recentChat(entry: ServerEntry, limit = 200): Promise<ChatMessage[]> {
  const file = consoleLogPath(entry);
  if (!fs.existsSync(file)) return [];
  const { size } = await fsp.stat(file);
  const from = Math.max(0, size - TAIL_BYTES);
  const handle = await fsp.open(file, "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(size - from);
    await handle.read(buffer, 0, buffer.length, from);
    text = buffer.toString("utf-8");
  } finally {
    await handle.close();
  }
  // The first line of a mid-file read is half a line.
  const lines = text.split("\n").slice(from > 0 ? 1 : 0);
  return parseChat(lines).slice(-limit);
}

export class ChatError extends Error {}

/**
 * Says something in game, as the dashboard user rather than as "Server".
 *
 * `tellraw` rather than `say`: `say` prefixes everything with `[Server]` and
 * offers no way to show who actually typed it, and on a server with several
 * admins "who said that" is a real question.
 */
export async function sendChat(entry: ServerEntry, text: string, from: string): Promise<string> {
  if (!(await isServerRunning(entry))) {
    throw new ChatError("A küldéshez futnia kell a szervernek.");
  }
  // Newlines are the thing that matters here: the command is delivered by
  // typing it into the server's console, so a line break in the message would
  // end the command and run whatever followed it as the next one. The rest of
  // the control characters go with them. Ordinary punctuation stays - a chat
  // message full of apostrophes and question marks is just a sentence.
  // eslint-disable-next-line no-control-regex
  const message = text.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 256);
  if (!message) throw new ChatError("Üres üzenet.");
  const who = from.replace(/[^A-Za-z0-9_.\- ]/g, "").slice(0, 32) || "dashboard";

  const payload = JSON.stringify([
    { text: `[${who}] `, color: "light_purple" },
    { text: message, color: "white" },
  ]);
  await sendCommand(entry, `tellraw @a ${payload}`);
  return message;
}
