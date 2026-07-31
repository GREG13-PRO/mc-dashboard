import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import { serverRegistry } from "./registry";
import { isServerRunning } from "./process-manager";
import { getCachedPlayers } from "./rcon-poller";
import type { ServerEntry } from "../types";

/**
 * Long-run player statistics.
 *
 * The resource history is a five-minute in-memory ring for the sparklines;
 * this is the opposite - a small, durable record kept for months so one week
 * can be compared against the last. It stores one row per server per hour
 * rather than per sample, which is enough resolution for "was last week
 * busier" and keeps the file tiny.
 */

const SAMPLE_INTERVAL_MS = 5 * 60_000;
const RETENTION_DAYS = 120;

export interface HourBucket {
  /** Hour start, ISO. */
  at: string;
  /** Highest concurrent players seen in the hour. */
  peak: number;
  /** Sum of samples, for deriving an average and rough playtime. */
  sampleSum: number;
  sampleCount: number;
  /** Minutes the server was observed running, from the sampling interval. */
  upMinutes: number;
}

export interface WeekSummary {
  peak: number;
  averageOnline: number;
  /** Player-minutes: each sample counts its players for the interval length. */
  playtimeMinutes: number;
  upMinutes: number;
  samples: number;
}

export interface WeekComparison {
  thisWeek: WeekSummary;
  lastWeek: WeekSummary;
  /** Percent change, null when last week has no basis to compare against. */
  peakChange: number | null;
  averageChange: number | null;
  playtimeChange: number | null;
  /** Per-day peaks for the last 14 days, oldest first. */
  daily: { date: string; peak: number; playtimeMinutes: number }[];
}

function statsFile(entry: ServerEntry): string {
  return path.join(env.dataDir, "stats", `${entry.id}.json`);
}

function hourKey(date: Date): string {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

async function readBuckets(entry: ServerEntry): Promise<HourBucket[]> {
  const file = statsFile(entry);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(await fsp.readFile(file, "utf-8")) as HourBucket[];
  } catch {
    return [];
  }
}

async function writeBuckets(entry: ServerEntry, buckets: HourBucket[]): Promise<void> {
  const file = statsFile(entry);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(buckets), "utf-8");
}

let timer: NodeJS.Timeout | null = null;

export function startStatsCollector(intervalMs = SAMPLE_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => void sampleAll(intervalMs), intervalMs);
}

export function stopStatsCollector(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function sampleAll(intervalMs: number): Promise<void> {
  const minutes = intervalMs / 60_000;
  for (const entry of serverRegistry.list()) {
    try {
      if (!(await isServerRunning(entry))) continue;
      // Only RCON-enabled servers report a player count; without it there is
      // nothing to record but uptime, which is still worth having.
      const players = getCachedPlayers(entry.id);
      const online = players?.online ?? 0;

      const buckets = await readBuckets(entry);
      const key = hourKey(new Date());
      let bucket = buckets[buckets.length - 1];
      if (!bucket || bucket.at !== key) {
        bucket = { at: key, peak: 0, sampleSum: 0, sampleCount: 0, upMinutes: 0 };
        buckets.push(bucket);
      }
      bucket.peak = Math.max(bucket.peak, online);
      bucket.sampleSum += online;
      bucket.sampleCount += 1;
      bucket.upMinutes += minutes;

      const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
      const kept = buckets.filter((b) => new Date(b.at).getTime() >= cutoff);
      await writeBuckets(entry, kept);
    } catch (err) {
      console.error(`[stats] Sampling failed for "${entry.name}":`, err);
    }
  }
}

function summarise(buckets: HourBucket[], intervalMinutes: number): WeekSummary {
  let peak = 0;
  let sum = 0;
  let count = 0;
  let up = 0;
  for (const b of buckets) {
    peak = Math.max(peak, b.peak);
    sum += b.sampleSum;
    count += b.sampleCount;
    up += b.upMinutes;
  }
  return {
    peak,
    averageOnline: count > 0 ? Math.round((sum / count) * 10) / 10 : 0,
    playtimeMinutes: Math.round(sum * intervalMinutes),
    upMinutes: Math.round(up),
    samples: count,
  };
}

function percentChange(now: number, before: number): number | null {
  // A jump from nothing is not a percentage anyone can act on, so it is left
  // unstated rather than reported as infinite growth.
  if (before === 0) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}

export async function compareWeeks(entry: ServerEntry): Promise<WeekComparison> {
  const buckets = await readBuckets(entry);
  const intervalMinutes = SAMPLE_INTERVAL_MS / 60_000;
  const now = Date.now();
  const weekMs = 7 * 86_400_000;

  const inRange = (from: number, to: number) =>
    buckets.filter((b) => {
      const t = new Date(b.at).getTime();
      return t >= from && t < to;
    });

  const thisWeek = summarise(inRange(now - weekMs, now), intervalMinutes);
  const lastWeek = summarise(inRange(now - 2 * weekMs, now - weekMs), intervalMinutes);

  const daily: WeekComparison["daily"] = [];
  for (let i = 13; i >= 0; i--) {
    const dayStart = new Date(now - i * 86_400_000);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = dayStart.getTime() + 86_400_000;
    const day = summarise(inRange(dayStart.getTime(), dayEnd), intervalMinutes);
    daily.push({
      date: dayStart.toISOString().slice(0, 10),
      peak: day.peak,
      playtimeMinutes: day.playtimeMinutes,
    });
  }

  return {
    thisWeek,
    lastWeek,
    peakChange: percentChange(thisWeek.peak, lastWeek.peak),
    averageChange: percentChange(thisWeek.averageOnline, lastWeek.averageOnline),
    playtimeChange: percentChange(thisWeek.playtimeMinutes, lastWeek.playtimeMinutes),
    daily,
  };
}

export async function deleteStats(entry: ServerEntry): Promise<void> {
  await fsp.rm(statsFile(entry), { force: true });
}
