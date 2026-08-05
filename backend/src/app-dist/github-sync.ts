import fs from "node:fs";
import fsp from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { env } from "../config/env";
import { identify, saveBuild, publishedFor, compareVersions, type PublishedBuild } from "./app-dist";

/**
 * Pulls the release artefacts from GitHub so they do not have to be downloaded
 * and re-uploaded by hand after every release.
 *
 * CI cannot push them here instead: the dashboard sits on a home network that
 * GitHub has no route to, so the direction has to be the other way round.
 *
 * A token used to be required, from when the repository was private. It is
 * public now, and asking for a personal access token before the feature will do
 * anything is a real cost - it is the step people stop at, and it puts a
 * credential on a machine that no longer needs one to do this job.
 *
 * So the token is optional. Without one the requests go out unauthenticated,
 * which GitHub allows for a public repository at sixty requests an hour per
 * address - the watcher makes two every six hours. With one, the limit is five
 * thousand, which is the only reason to still offer it.
 *
 * When there is a token it is the admin's own, stored on this machine only,
 * never sent back to a browser, and only ever used against this one repository.
 */

const REPO = "GREG13-PRO/mc-dashboard";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;

export class GithubSyncError extends Error {}

function tokenPath(): string {
  return path.join(env.dataDir, "github-token");
}

export function hasToken(): boolean {
  return fs.existsSync(tokenPath());
}

export async function setToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new GithubSyncError("A token nem lehet üres.");
  await fsp.mkdir(env.dataDir, { recursive: true });
  // Written 0600 rather than the default: the security review already flags a
  // world-readable server.properties for holding an RCON password, and a
  // repository token deserves at least the same care.
  await fsp.writeFile(tokenPath(), trimmed, { mode: 0o600 });
  await fsp.chmod(tokenPath(), 0o600);
}

export async function clearToken(): Promise<void> {
  await fsp.rm(tokenPath(), { force: true });
}

/** The stored token, or null to go out unauthenticated. */
async function readToken(): Promise<string | null> {
  try {
    const token = (await fsp.readFile(tokenPath(), "utf-8")).trim();
    return token || null;
  } catch {
    return null;
  }
}

interface Asset {
  name: string;
  url: string;
  size: number;
}

interface Release {
  tag_name: string;
  assets: Asset[];
}

function request(
  url: string,
  token: string | null,
  accept: string,
  redirectsLeft = MAX_REDIRECTS
): Promise<Buffer> {
  if (!url.startsWith("https://")) {
    throw new GithubSyncError(`Refusing to fetch a non-https URL: ${url}`);
  }
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "User-Agent": "mc-dashboard", Accept: accept };
    // The token goes to api.github.com only. GitHub redirects asset downloads
    // to its object storage, which rejects a request carrying both its own
    // signed URL and an Authorization header ("only one auth mechanism
    // allowed") - so the header is dropped the moment the host changes.
    if (token && new URL(url).hostname === "api.github.com") {
      headers.Authorization = `Bearer ${token}`;
    }

    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft === 0) {
          reject(new GithubSyncError(`Too many redirects fetching ${url}`));
          return;
        }
        request(new URL(res.headers.location, url).toString(), token, accept, redirectsLeft - 1)
          .then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new GithubSyncError(describeFailure(res.statusCode, res.headers, token)));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk as Buffer));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () =>
      req.destroy(new GithubSyncError(`Időtúllépés: ${url}`))
    );
    req.on("error", reject);
  });
}

/**
 * Says what went wrong in terms of what the reader can do about it.
 *
 * The three failures worth telling apart are a rate limit, a bad token and a
 * missing release - and the advice for each is different, so a single "GitHub
 * refused the request. Check your token" sent people looking for a problem with
 * a token they may not even have set.
 */
function describeFailure(
  status: number | undefined,
  headers: Record<string, string | string[] | undefined>,
  token: string | null
): string {
  const remaining = headers["x-ratelimit-remaining"];
  if (status === 403 && remaining === "0") {
    const resets = Number(headers["x-ratelimit-reset"]);
    const when = Number.isFinite(resets) ? new Date(resets * 1000).toLocaleTimeString("hu-HU") : null;
    return token
      ? `A GitHub óradíj-korlátja elfogyott.${when ? ` Újraindul: ${when}.` : ""}`
      : `A GitHub óradíj-korlátja elfogyott (token nélkül óránként 60 kérés).${
          when ? ` Újraindul: ${when}.` : ""
        } Egy token 5000-re emeli.`;
  }
  if (status === 401) {
    return "A GitHub elutasította a tokent. Lehet, hogy lejárt - töröld, vagy adj meg egy újat.";
  }
  if (status === 404) {
    return token
      ? "A GitHub nem találja ezt a repót. Ellenőrizd, hogy a token látja-e."
      : "A GitHub nem találja ezt a repót, vagy még nincs benne kiadás.";
  }
  return `HTTP ${status} a GitHubtól.`;
}

export interface RemoteRelease {
  tag: string;
  version: string;
  assets: { name: string; sizeBytes: number }[];
}

export async function latestRelease(): Promise<RemoteRelease> {
  const token = await readToken();
  const release = JSON.parse(
    (await request(API, token, "application/vnd.github+json")).toString("utf-8")
  ) as Release;
  return {
    tag: release.tag_name,
    version: release.tag_name.replace(/^v/, ""),
    // Only the artefacts this dashboard knows how to publish; the release also
    // carries source archives nobody here wants.
    assets: release.assets
      .filter((a) => identify(a.name))
      .map((a) => ({ name: a.name, sizeBytes: a.size })),
  };
}

export async function syncLatestRelease(): Promise<PublishedBuild[]> {
  const token = await readToken();
  const release = JSON.parse(
    (await request(API, token, "application/vnd.github+json")).toString("utf-8")
  ) as Release;

  const wanted = release.assets.filter((asset) => identify(asset.name));
  if (wanted.length === 0) {
    throw new GithubSyncError(`A(z) ${release.tag_name} kiadásban nincs publikálható build.`);
  }

  const published: PublishedBuild[] = [];
  for (const asset of wanted) {
    const data = await request(asset.url, token, "application/octet-stream");
    // Goes through the same validation as a hand upload rather than being
    // trusted because it came from GitHub.
    published.push(await saveBuild(asset.name, data));
  }
  return published;
}

/**
 * Checks GitHub on a timer and publishes anything newer.
 *
 * This is the piece that makes every app find updates on its own. The apps
 * do not check GitHub themselves: one dashboard asking is one request per
 * six hours, where every app asking is one per device - and the phones are on
 * a network where the dashboard is always reachable and GitHub may not be. So
 * the dashboard does the looking, and the apps ask the dashboard.
 *
 * Nothing is installed by this. It only makes the newer build available; every
 * app still shows its own "there is an update" prompt and waits to be told.
 */

export interface WatcherState {
  enabled: boolean;
  lastCheckedAt: string | null;
  lastResult: string | null;
  publishedVersion: string | null;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const state: WatcherState = {
  enabled: false,
  lastCheckedAt: null,
  lastResult: null,
  publishedVersion: null,
};
let timer: NodeJS.Timeout | null = null;

function settingsFile(): string {
  return path.join(env.dataDir, "github-watch.json");
}

async function loadEnabled(): Promise<boolean> {
  try {
    const raw = JSON.parse(await fsp.readFile(settingsFile(), "utf-8")) as { enabled?: boolean };
    return raw.enabled === true;
  } catch {
    return false;
  }
}

export async function setWatcherEnabled(enabled: boolean): Promise<void> {
  state.enabled = enabled;
  await fsp.mkdir(env.dataDir, { recursive: true });
  await fsp.writeFile(settingsFile(), JSON.stringify({ enabled }, null, 2), "utf-8");
  if (enabled) void checkOnce();
}

export function watcherState(): WatcherState {
  return { ...state };
}

export async function checkOnce(): Promise<WatcherState> {
  state.lastCheckedAt = new Date().toISOString();
  // No token check any more: the repository is public, so a check without one
  // is a check that works.
  try {
    const remote = await latestRelease();
    const current = await publishedFor("android");
    // Compared against what is published rather than against a remembered
    // number: someone may have uploaded or deleted a build by hand since the
    // last check, and the published set is the thing the apps actually see.
    if (current && compareVersions(remote.version, current.version) <= 0) {
      state.lastResult = `Nincs újabb kiadás (${remote.tag}).`;
      state.publishedVersion = current.version;
      return watcherState();
    }
    const published = await syncLatestRelease();
    state.publishedVersion = published[0]?.version ?? remote.version;
    state.lastResult = `${remote.tag} behúzva (${published.length} build).`;
  } catch (err) {
    state.lastResult = (err as Error).message;
  }
  return watcherState();
}

export async function startReleaseWatcher(intervalMs = CHECK_INTERVAL_MS): Promise<void> {
  if (timer) return;
  state.enabled = await loadEnabled();
  const current = await publishedFor("android");
  state.publishedVersion = current?.version ?? null;
  // A check on boot as well as on the timer: a dashboard that is restarted
  // more often than every six hours would otherwise never check at all.
  if (state.enabled) void checkOnce();
  timer = setInterval(() => {
    if (state.enabled) void checkOnce();
  }, intervalMs);
}

export function stopReleaseWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
