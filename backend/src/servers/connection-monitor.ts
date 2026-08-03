import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { serverRegistry } from "./registry";
import { readProperties } from "./properties";
import type { ServerEntry } from "../types";

const execFileAsync = promisify(execFile);

/**
 * Watches who is connected to each server's port, and says when that stops
 * looking normal.
 *
 * This is what a dashboard can honestly do about a flood: count sockets and
 * raise a flag. It cannot absorb one - that is the firewall's job, and the
 * point of the alert is to tell someone which address to block while it is
 * still happening rather than the next morning from the logs.
 */

const SAMPLE_INTERVAL_MS = 15_000;
const HISTORY_SAMPLES = 240; // an hour at fifteen seconds
/** Sockets from one address beyond which it stops looking like a player. */
const PER_IP_LIMIT = 12;
/** Total sockets beyond which something is going on, whatever it is. */
const TOTAL_LIMIT = 120;
const MAX_ALERTS = 100;

export interface ConnectionSample {
  at: string;
  total: number;
  distinctIps: number;
  /** The busiest addresses in this sample, worst first. */
  top: { ip: string; count: number }[];
}

export interface ConnectionAlert {
  at: string;
  serverId: string;
  kind: "per-ip" | "total";
  ip: string | null;
  count: number;
  message: string;
}

const history = new Map<string, ConnectionSample[]>();
const alerts: ConnectionAlert[] = [];
let timer: NodeJS.Timeout | null = null;

function portFor(entry: ServerEntry): number | null {
  const file = path.join(entry.folder, "server.properties");
  if (!fs.existsSync(file)) return null;
  const props = readProperties(file);
  const port = Number(props["server-port"] ?? props["query.port"]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * Established sockets on a port, grouped by peer address.
 *
 * `ss` rather than parsing /proc/net/tcp: it is present on this Debian box,
 * already used elsewhere in this project's tooling, and it does the hex
 * address decoding that /proc would leave to us.
 */
export async function connectionsOnPort(port: number): Promise<Map<string, number>> {
  const byIp = new Map<string, number>();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ss", ["-Htn", "state", "established", `sport = :${port}`], {
      timeout: 5000,
    }));
  } catch {
    return byIp;
  }
  for (const line of stdout.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4) continue;
    const peer = columns[3];
    // Peer is address:port, and the address half of an IPv6 socket is bracketed
    // or dotted through; taking everything before the last colon handles both.
    const ip = peer.slice(0, peer.lastIndexOf(":")).replace(/^\[|\]$/g, "");
    if (!ip) continue;
    byIp.set(ip, (byIp.get(ip) ?? 0) + 1);
  }
  return byIp;
}

function record(entry: ServerEntry, byIp: Map<string, number>): void {
  const top = [...byIp]
    .map(([ip, count]) => ({ ip, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const total = [...byIp.values()].reduce((sum, n) => sum + n, 0);

  const samples = history.get(entry.id) ?? [];
  samples.push({ at: new Date().toISOString(), total, distinctIps: byIp.size, top });
  if (samples.length > HISTORY_SAMPLES) samples.splice(0, samples.length - HISTORY_SAMPLES);
  history.set(entry.id, samples);

  const raise = (alert: Omit<ConnectionAlert, "at" | "serverId">) => {
    // One alert per kind per address per ten minutes: a flood lasts for
    // thousands of samples and a page of identical rows helps nobody.
    const recent = Date.now() - 10 * 60_000;
    const duplicate = alerts.some(
      (a) =>
        a.serverId === entry.id &&
        a.kind === alert.kind &&
        a.ip === alert.ip &&
        new Date(a.at).getTime() > recent
    );
    if (duplicate) return;
    alerts.unshift({ ...alert, at: new Date().toISOString(), serverId: entry.id });
    if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;
  };

  for (const { ip, count } of top) {
    if (count >= PER_IP_LIMIT) {
      raise({
        kind: "per-ip",
        ip,
        count,
        message: `${count} egyidejű kapcsolat egyetlen címről (${ip}) a(z) ${entry.name} szerveren.`,
      });
    }
  }
  if (total >= TOTAL_LIMIT) {
    raise({
      kind: "total",
      ip: null,
      count: total,
      message: `${total} egyidejű kapcsolat a(z) ${entry.name} szerveren, ${byIp.size} különböző címről.`,
    });
  }
}

async function sampleAll(): Promise<void> {
  for (const entry of serverRegistry.list()) {
    const port = portFor(entry);
    if (port === null) continue;
    record(entry, await connectionsOnPort(port));
  }
}

export function startConnectionMonitor(intervalMs = SAMPLE_INTERVAL_MS): void {
  if (timer) return;
  void sampleAll();
  timer = setInterval(() => void sampleAll(), intervalMs);
}

export function stopConnectionMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function connectionHistory(serverId: string): ConnectionSample[] {
  return history.get(serverId) ?? [];
}

export function connectionAlerts(serverId?: string): ConnectionAlert[] {
  return serverId ? alerts.filter((a) => a.serverId === serverId) : alerts;
}

export function forgetServer(serverId: string): void {
  history.delete(serverId);
}
