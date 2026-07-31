import https from "node:https";
import fs from "node:fs";

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 60_000;

// Every upstream this project talks to (PaperMC, Mojang, Modrinth, Hangar,
// Maven) is https-only. Refusing to follow a redirect down to plain http keeps
// a compromised or misconfigured redirect from silently downgrading a jar
// download - which matters here more than usual, given this project's history
// with a tampered plugin batch.
function assertHttps(url: string): void {
  if (!url.startsWith("https://")) {
    throw new Error(`Refusing to fetch a non-https URL: ${url}`);
  }
}

export function fetchText(url: string, redirectsLeft = MAX_REDIRECTS): Promise<string> {
  assertHttps(url);
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "mc-dashboard" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft === 0) {
          reject(new Error(`Too many redirects fetching ${url}`));
          return;
        }
        fetchText(new URL(res.headers.location, url).toString(), redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Timed out fetching ${url}`)));
    req.on("error", reject);
  });
}

export async function fetchJson<T>(url: string): Promise<T> {
  const body = await fetchText(url);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }
}

export function downloadFile(url: string, dest: string, redirectsLeft = MAX_REDIRECTS): Promise<void> {
  assertHttps(url);
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "mc-dashboard" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft === 0) {
          reject(new Error(`Too many redirects downloading ${url}`));
          return;
        }
        downloadFile(new URL(res.headers.location, url).toString(), dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      // A half-written jar is worse than none: the next start would fail with a
      // confusing "invalid or corrupt jarfile" rather than a download error.
      const failPartial = (err: Error) => fs.rm(dest, { force: true }, () => reject(err));
      file.on("error", failPartial);
      res.on("error", failPartial);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Timed out downloading ${url}`)));
    req.on("error", reject);
  });
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Small TTL cache for upstream registry lookups. Plugin searches hit third
 * party APIs that rate-limit, and the dashboard re-queries them on every
 * keystroke-driven search, so identical queries within the window reuse the
 * previous answer.
 */
export function createTtlCache<T>(ttlMs: number) {
  const entries = new Map<string, CacheEntry<T>>();
  return async function cached(key: string, load: () => Promise<T>): Promise<T> {
    const hit = entries.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = await load();
    entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  };
}
