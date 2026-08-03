import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import https from "node:https";
import http from "node:http";
import path from "node:path";
import { env } from "../config/env";

/**
 * Outgoing webhooks, and a record of how each one is being received.
 *
 * The delivery log is the point as much as the delivery. Every service worth
 * posting to rate-limits, and the way that goes wrong is silent: posts start
 * coming back 429, the dashboard shrugs, and nobody notices the alerts stopped
 * until the day one mattered. So every attempt is recorded with its status and
 * the rate-limit headers the service sent back, and the screen shows when a
 * hook is being throttled.
 */

export class WebhookError extends Error {}

export type WebhookEvent =
  | "server.started"
  | "server.stopped"
  | "server.crashed"
  | "security.alert"
  | "player.joined"
  | "player.left";

export const WEBHOOK_EVENTS: WebhookEvent[] = [
  "server.started",
  "server.stopped",
  "server.crashed",
  "security.alert",
  "player.joined",
  "player.left",
];

export interface Webhook {
  id: string;
  name: string;
  url: string;
  /** Discord accepts a specific JSON shape; anything else gets the raw event. */
  format: "discord" | "json";
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: string;
}

export interface Delivery {
  at: string;
  webhookId: string;
  event: WebhookEvent;
  status: number | null;
  ok: boolean;
  durationMs: number;
  error: string | null;
  /** What the service said about our budget, when it says anything. */
  rateLimit: { limit: string | null; remaining: string | null; resetSeconds: string | null } | null;
}

const MAX_DELIVERIES = 300;
const TIMEOUT_MS = 8000;

let hooks: Webhook[] | null = null;
const deliveries: Delivery[] = [];

function file(): string {
  return path.join(env.dataDir, "webhooks.json");
}

async function load(): Promise<Webhook[]> {
  if (hooks) return hooks;
  try {
    hooks = JSON.parse(await fsp.readFile(file(), "utf-8")) as Webhook[];
  } catch {
    hooks = [];
  }
  return hooks;
}

async function persist(): Promise<void> {
  await fsp.mkdir(env.dataDir, { recursive: true });
  // A webhook URL is a bearer credential - anyone holding a Discord webhook
  // URL can post to that channel - so the file is not world-readable.
  await fsp.writeFile(file(), JSON.stringify(hooks ?? [], null, 2), { mode: 0o600 });
  if (fs.existsSync(file())) await fsp.chmod(file(), 0o600);
}

export async function listWebhooks(): Promise<Webhook[]> {
  return [...(await load())];
}

export async function saveWebhook(input: Partial<Webhook> & { url: string }): Promise<Webhook> {
  if (!/^https?:\/\//.test(input.url)) throw new WebhookError("Az URL http vagy https legyen.");
  const all = await load();
  const existing = input.id ? all.find((h) => h.id === input.id) : undefined;
  const hook: Webhook = {
    id: existing?.id ?? crypto.randomUUID(),
    name: (input.name ?? "").trim() || "Webhook",
    url: input.url.trim(),
    format: input.format === "json" ? "json" : "discord",
    events: (input.events ?? []).filter((e) => WEBHOOK_EVENTS.includes(e)),
    enabled: input.enabled !== false,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  if (existing) all[all.indexOf(existing)] = hook;
  else all.push(hook);
  await persist();
  return hook;
}

export async function deleteWebhook(id: string): Promise<void> {
  const all = await load();
  const index = all.findIndex((h) => h.id === id);
  if (index >= 0) {
    all.splice(index, 1);
    await persist();
  }
}

function body(hook: Webhook, event: WebhookEvent, message: string, detail: unknown): string {
  if (hook.format === "discord") {
    // Discord rejects anything without content or embeds, and truncates at
    // 2000 characters rather than telling you why it failed.
    return JSON.stringify({ content: `**${event}** — ${message}`.slice(0, 1900) });
  }
  return JSON.stringify({ event, message, detail, at: new Date().toISOString() });
}

function post(url: string, payload: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(
      target,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "mc-dashboard",
        },
      },
      (response) => {
        // The body is drained and discarded: nothing here acts on it, and an
        // unread response keeps the socket alive.
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers })
        );
      }
    );
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error("időtúllépés")));
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function record(delivery: Delivery): void {
  deliveries.unshift(delivery);
  if (deliveries.length > MAX_DELIVERIES) deliveries.length = MAX_DELIVERIES;
}

/** Fires every hook subscribed to this event. Never throws at the caller. */
export async function emit(event: WebhookEvent, message: string, detail?: unknown): Promise<void> {
  const all = await load();
  const targets = all.filter((h) => h.enabled && h.events.includes(event));
  await Promise.all(
    targets.map(async (hook) => {
      const started = Date.now();
      try {
        const { status, headers } = await post(hook.url, body(hook, event, message, detail));
        record({
          at: new Date().toISOString(),
          webhookId: hook.id,
          event,
          status,
          ok: status >= 200 && status < 300,
          durationMs: Date.now() - started,
          error: null,
          rateLimit: {
            limit: (headers["x-ratelimit-limit"] as string) ?? null,
            remaining: (headers["x-ratelimit-remaining"] as string) ?? null,
            resetSeconds:
              (headers["x-ratelimit-reset-after"] as string) ??
              (headers["retry-after"] as string) ??
              null,
          },
        });
      } catch (err) {
        record({
          at: new Date().toISOString(),
          webhookId: hook.id,
          event,
          status: null,
          ok: false,
          durationMs: Date.now() - started,
          error: (err as Error).message,
          rateLimit: null,
        });
      }
    })
  );
}

export function listDeliveries(webhookId?: string): Delivery[] {
  return webhookId ? deliveries.filter((d) => d.webhookId === webhookId) : [...deliveries];
}

export interface RateLimitSummary {
  webhookId: string;
  attempts: number;
  failures: number;
  throttled: number;
  lastStatus: number | null;
  lastRemaining: string | null;
  lastResetSeconds: string | null;
  medianMs: number | null;
}

/** Per-hook health, which is what anyone actually wants to see. */
export function rateLimitSummary(): RateLimitSummary[] {
  const byHook = new Map<string, Delivery[]>();
  for (const delivery of deliveries) {
    if (!byHook.has(delivery.webhookId)) byHook.set(delivery.webhookId, []);
    byHook.get(delivery.webhookId)!.push(delivery);
  }
  return [...byHook].map(([webhookId, list]) => {
    const durations = list.map((d) => d.durationMs).sort((a, b) => a - b);
    const newest = list[0];
    return {
      webhookId,
      attempts: list.length,
      failures: list.filter((d) => !d.ok).length,
      // 429 is the one status worth counting on its own: it is the difference
      // between "broken" and "sending too fast".
      throttled: list.filter((d) => d.status === 429).length,
      lastStatus: newest?.status ?? null,
      lastRemaining: newest?.rateLimit?.remaining ?? null,
      lastResetSeconds: newest?.rateLimit?.resetSeconds ?? null,
      medianMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
    };
  });
}
