import fs from "node:fs";
import fsp from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { env } from "../config/env";
import { identify, saveBuild, type PublishedBuild } from "./app-dist";

/**
 * Pulls the release artefacts from GitHub so they do not have to be downloaded
 * and re-uploaded by hand after every release.
 *
 * CI cannot push them here instead: the dashboard sits on a home network that
 * GitHub has no route to. So the direction has to be the other way round, and
 * that needs a token, because the repository is private.
 *
 * The token is the admin's own, stored on this machine only, never sent back to
 * a browser, and only ever used against this one repository.
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

async function readToken(): Promise<string> {
  try {
    return (await fsp.readFile(tokenPath(), "utf-8")).trim();
  } catch {
    throw new GithubSyncError("Nincs beállítva GitHub token.");
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
  token: string,
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
    if (new URL(url).hostname === "api.github.com") {
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
        reject(
          new GithubSyncError(
            res.statusCode === 401 || res.statusCode === 404
              ? "A GitHub elutasította a kérést. Ellenőrizd, hogy a token érvényes-e és látja-e ezt a repót."
              : `HTTP ${res.statusCode} a GitHubtól.`
          )
        );
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
