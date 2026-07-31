import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";

export interface AuditRecord {
  at: string;
  /** Username, or "system" for the schedulers, which act with no logged-in user. */
  actor: string;
  actorId: string | null;
  action: string;
  serverId: string | null;
  serverName: string | null;
  detail: string | null;
  ip: string | null;
  ok: boolean;
}

export const SYSTEM_ACTOR = "system";

function auditFile(): string {
  return path.join(env.dataDir, "audit.log");
}

// Bounded so the log can't fill a small VM. Kept generous enough that a real
// investigation still has history to look at.
const MAX_RECORDS = 5000;
const ROTATE_CHECK_EVERY = 200;

let writesSinceRotateCheck = 0;
// Appends are serialized through this chain: several requests can finish at
// once, and interleaved appends would corrupt individual JSON lines.
let writeChain: Promise<void> = Promise.resolve();

/**
 * Appends one JSON object per line rather than rewriting a JSON array like the
 * server/user stores do. Those hold tens of records; an audit log only grows,
 * and re-serializing the whole thing on every action would be O(n) per request.
 */
export function recordAudit(record: Omit<AuditRecord, "at">): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n";
  writeChain = writeChain
    .then(async () => {
      await fsp.mkdir(env.dataDir, { recursive: true });
      await fsp.appendFile(auditFile(), line, "utf-8");
      if (++writesSinceRotateCheck >= ROTATE_CHECK_EVERY) {
        writesSinceRotateCheck = 0;
        await rotateIfNeeded();
      }
    })
    // Auditing must never take down the request it is describing.
    .catch((err) => console.error("[audit] Failed to write audit record:", err));
}

async function rotateIfNeeded(): Promise<void> {
  const file = auditFile();
  if (!fs.existsSync(file)) return;
  const lines = (await fsp.readFile(file, "utf-8")).split("\n").filter(Boolean);
  if (lines.length <= MAX_RECORDS) return;
  await fsp.writeFile(file, lines.slice(-MAX_RECORDS).join("\n") + "\n", "utf-8");
}

export async function readAudit(limit = 200): Promise<AuditRecord[]> {
  const file = auditFile();
  if (!fs.existsSync(file)) return [];
  const lines = (await fsp.readFile(file, "utf-8")).split("\n").filter(Boolean);
  const out: AuditRecord[] = [];
  // Newest first, and a single corrupt line (a truncated write) is skipped
  // rather than blanking the whole view.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]) as AuditRecord);
    } catch {
      continue;
    }
  }
  return out;
}
