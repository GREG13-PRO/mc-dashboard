import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { env } from "../config/env";
import { sendCommand, isServerRunning } from "./process-manager";
import type { ServerEntry } from "../types";

/**
 * Named sequences of console commands, plus a recorder that captures what an
 * admin actually typed so a routine can be turned into a macro without
 * writing it out again.
 *
 * Stored per server: a macro is usually written against one server's plugins
 * and world, and offering another server's macros would mostly offer commands
 * that do not exist there.
 */

export interface MacroStep {
  command: string;
  /** Pause after this step, for commands that need the previous one to land. */
  delayMs: number;
}

export interface Macro {
  id: string;
  name: string;
  description: string;
  steps: MacroStep[];
  createdAt: string;
  updatedAt: string;
}

export interface MacroRun {
  executed: number;
  skipped: string[];
}

function macroFile(entry: ServerEntry): string {
  return path.join(env.dataDir, "macros", `${entry.id}.json`);
}

// Commands that would take the server down or wipe data are not runnable from
// a macro: a macro is fire-and-forget and often bound to a single click, which
// is the wrong shape for anything destructive.
const BLOCKED = [/^\s*stop\b/i, /^\s*restart\b/i, /^\s*end\b/i, /^\s*\/?op\b/i, /^\s*\/?deop\b/i];

export class MacroError extends Error {}

function validateStep(command: string): void {
  const trimmed = command.trim();
  if (!trimmed) throw new MacroError("Üres parancs a makróban.");
  if (trimmed.length > 400) throw new MacroError("Túl hosszú parancs.");
  // The command goes to `screen -X stuff`, where a newline would end it and
  // start another - so one step is exactly one command.
  if (/[\r\n]/.test(trimmed)) throw new MacroError("Egy lépés csak egy parancs lehet.");
  if (BLOCKED.some((re) => re.test(trimmed))) {
    throw new MacroError(`Ez a parancs nem futtatható makróból: ${trimmed.split(/\s+/)[0]}`);
  }
}

export async function listMacros(entry: ServerEntry): Promise<Macro[]> {
  const file = macroFile(entry);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(await fsp.readFile(file, "utf-8")) as Macro[];
  } catch {
    return [];
  }
}

async function writeMacros(entry: ServerEntry, macros: Macro[]): Promise<void> {
  const file = macroFile(entry);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(macros, null, 2), "utf-8");
}

export async function saveMacro(
  entry: ServerEntry,
  input: { id?: string; name: string; description?: string; steps: MacroStep[] }
): Promise<Macro> {
  if (!input.name?.trim()) throw new MacroError("A makrónak kell név.");
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new MacroError("A makró legalább egy lépést tartalmazzon.");
  }
  if (input.steps.length > 50) throw new MacroError("Legfeljebb 50 lépés lehet.");

  const steps: MacroStep[] = input.steps.map((s) => {
    validateStep(s.command);
    const delayMs = Number(s.delayMs) || 0;
    if (delayMs < 0 || delayMs > 30_000) throw new MacroError("A várakozás 0 és 30000 ms között lehet.");
    return { command: s.command.trim(), delayMs };
  });

  const macros = await listMacros(entry);
  const now = new Date().toISOString();
  if (input.id) {
    const existing = macros.find((m) => m.id === input.id);
    if (!existing) throw new MacroError("Nincs ilyen makró.");
    Object.assign(existing, {
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      steps,
      updatedAt: now,
    });
    await writeMacros(entry, macros);
    return existing;
  }

  const macro: Macro = {
    id: uuidv4(),
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    steps,
    createdAt: now,
    updatedAt: now,
  };
  macros.push(macro);
  await writeMacros(entry, macros);
  return macro;
}

export async function deleteMacro(entry: ServerEntry, id: string): Promise<void> {
  const macros = await listMacros(entry);
  await writeMacros(entry, macros.filter((m) => m.id !== id));
}

export async function runMacro(entry: ServerEntry, id: string): Promise<MacroRun> {
  const macro = (await listMacros(entry)).find((m) => m.id === id);
  if (!macro) throw new MacroError("Nincs ilyen makró.");
  if (!(await isServerRunning(entry))) throw new MacroError("A makró futtatásához futnia kell a szervernek.");

  let executed = 0;
  const skipped: string[] = [];
  for (const step of macro.steps) {
    // Re-checked at run time: the stored macro predates any change to the
    // blocklist, and a stored file could have been edited on disk.
    try {
      validateStep(step.command);
    } catch {
      skipped.push(step.command);
      continue;
    }
    await sendCommand(entry, step.command);
    executed++;
    if (step.delayMs > 0) await new Promise((r) => setTimeout(r, step.delayMs));
  }
  return { executed, skipped };
}

// -------------------------------------------------------------- recorder

interface Recording {
  startedAt: number;
  steps: MacroStep[];
  lastAt: number;
}

const recordings = new Map<string, Recording>();

export function startRecording(entry: ServerEntry): void {
  recordings.set(entry.id, { startedAt: Date.now(), steps: [], lastAt: Date.now() });
}

export function isRecording(entry: ServerEntry): boolean {
  return recordings.has(entry.id);
}

/**
 * Called from the console WebSocket for every command an admin sends. The gap
 * since the previous command is stored as that command's delay, so replaying
 * keeps the rhythm of the original - which matters for sequences where one
 * command has to finish before the next makes sense.
 */
export function recordCommand(entry: ServerEntry, command: string): void {
  const recording = recordings.get(entry.id);
  if (!recording) return;
  if (recording.steps.length >= 50) return;
  const now = Date.now();
  const gap = Math.min(30_000, now - recording.lastAt);
  const previous = recording.steps[recording.steps.length - 1];
  if (previous) previous.delayMs = gap;
  recording.steps.push({ command: command.trim(), delayMs: 0 });
  recording.lastAt = now;
}

export function stopRecording(entry: ServerEntry): MacroStep[] {
  const recording = recordings.get(entry.id);
  recordings.delete(entry.id);
  return recording?.steps ?? [];
}
