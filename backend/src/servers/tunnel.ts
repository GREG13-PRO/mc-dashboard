import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import { env } from "../config/env";
import { downloadFile } from "./http-download";
import type { ServerEntry } from "../types";

const execFileAsync = promisify(execFile);

/**
 * A public address for a server behind a home router.
 *
 * The biggest wall a beginner hits is not the server - it is that nobody
 * outside the house can reach it. The usual answer, "forward a port in your
 * router", needs an admin password, a model-specific interface and an address
 * the ISP may change weekly. A tunnel replaces all of that with an outbound
 * connection.
 *
 * It also runs a third-party binary on the operator's machine, which is exactly
 * how this project was compromised once. So it is built to refuse rather than
 * to trust:
 *
 *   - one pinned version, from the project's own GitHub releases and nowhere
 *     else, with the URL built here rather than taken from a response;
 *   - a sha256 pinned in this file for every binary and every architecture,
 *     checked after the download - and checked again *before* the download
 *     against the digest GitHub's API reports, so a release swapped under its
 *     own tag fails before a byte is fetched;
 *   - no root: the agent's IPC socket goes in the dashboard's own data
 *     directory rather than /run, which is the only reason this needs no
 *     privileges at all;
 *   - nothing is published until somebody says so - the route refuses without
 *     an explicit acceptance, and the claim is a link the operator opens.
 *
 * Updating the agent is deliberately a code change. "Fetch the newest release
 * and run it" is the shape of the attack this project has already survived.
 */

const AGENT_VERSION = "v1.0.10";

/**
 * Both halves of the agent, pinned.
 *
 * 1.x is a daemon plus a control client that talk over a socket: the daemon
 * holds the connection, the client claims it and asks it questions. Both are
 * needed, so both are pinned.
 *
 * The hashes came from GitHub's release API, which publishes a digest per
 * asset, and were confirmed independently with curl and sha256sum. They live
 * here so the expected value never comes from the same request that delivers
 * the file.
 */
const PINNED: Record<"daemon" | "cli", Record<string, { asset: string; sha256: string }>> = {
  daemon: {
    x64: { asset: "playit-linux-amd64", sha256: "2df7d9f10227ab312b1ad341853db4e8a8243df5cfcdbae58713a4271711c339" },
    arm64: { asset: "playit-linux-aarch64", sha256: "4c0db3e7b3a8158e249441c2f0b73f54e83429395890c7b1ca45fd7a6303d763" },
    arm: { asset: "playit-linux-armv7", sha256: "92ec60988b1246e07ac090c663128bd04bdc0d7ff388db520e1ff7bb4e5003e0" },
    ia32: { asset: "playit-linux-i686", sha256: "d7215f3995e486bc231b3b542aa5f1ac6b0d604f8dae97bb14a9a64b49b3ed50" },
  },
  cli: {
    x64: { asset: "playit-cli-linux-amd64", sha256: "6fd54d147ae1d3232b22c1c1f4aa3d13cf16d889e840ca2d3f90b4f50a2e7301" },
    arm64: { asset: "playit-cli-linux-aarch64", sha256: "b126b4164c03838598c8f33f209d76f6acf1c257d07900c0af2d461b9647099f" },
    arm: { asset: "playit-cli-linux-armv7", sha256: "2e1140a838b42f00233065432ed36fbfe8af34e9aa22585bcb2e01fcdad282a6" },
    ia32: { asset: "playit-cli-linux-i686", sha256: "e8e4bd663d0781e3d168be2a4e45d3642a38bc7946f507ba6116e8687b8a678f" },
  },
};

export class TunnelError extends Error {}

export interface TunnelState {
  running: boolean;
  /** A stored secret is what "claimed" means here. */
  claimed: boolean;
  /**
   * Where to go to link this agent to a playit.gg account.
   *
   * Until somebody opens this the agent does nothing, so it is the whole first
   * run and belongs on screen rather than in a log.
   */
  claimUrl: string | null;
  agentVersion: string;
  /** The agent's last lines, so a failure is readable without opening a file. */
  log: string[];
  serverId: string | null;
}

const state: TunnelState = {
  running: false,
  claimed: false,
  claimUrl: null,
  agentVersion: AGENT_VERSION,
  log: [],
  serverId: null,
};

let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
let claimCode: string | null = null;

function homeDir(): string {
  return path.join(env.dataDir, "tunnel");
}
const secretPath = () => path.join(homeDir(), "secret.toml");
const socketPath = () => path.join(homeDir(), "playitd.sock");
const binaryPath = (kind: "daemon" | "cli") => path.join(homeDir(), `${kind}-${AGENT_VERSION}`);

async function sha256Of(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function pinFor(kind: "daemon" | "cli"): { asset: string; sha256: string } {
  const pin = PINNED[kind][process.arch];
  if (!pin) throw new TunnelError(`Ehhez az architektúrához (${process.arch}) nincs rögzített ügynök.`);
  return pin;
}

/**
 * Fetches a pinned binary, or returns the one already fetched and still intact.
 *
 * A local copy that no longer matches is replaced rather than trusted: a
 * corrupted or swapped file on disk is exactly the thing that must not be run,
 * and re-downloading puts it back through the same check.
 */
async function ensureBinary(kind: "daemon" | "cli"): Promise<string> {
  const { asset, sha256 } = pinFor(kind);
  const dest = binaryPath(kind);
  if (fs.existsSync(dest) && (await sha256Of(dest)) === sha256) return dest;

  // Asked before a byte is fetched: if the release has been replaced under its
  // own tag, nothing should be downloaded at all.
  try {
    const res = await fetch(
      `https://api.github.com/repos/playit-cloud/playit-agent/releases/tags/${AGENT_VERSION}`,
      { headers: { "User-Agent": "mc-dashboard" } }
    );
    const release = (await res.json()) as { assets?: { name: string; digest?: string }[] };
    const published = release.assets?.find((a) => a.name === asset)?.digest?.replace("sha256:", "");
    if (published && published.toLowerCase() !== sha256) {
      throw new TunnelError(
        `A(z) ${asset} ellenőrzőösszege megváltozott a GitHubon azóta, hogy ez a verzió ide be lett építve. Semmi nem töltődött le.`
      );
    }
  } catch (err) {
    // An unreachable API is not a reason to refuse - the pinned hash below is
    // the check that matters, and this was only the second opinion.
    if (err instanceof TunnelError) throw err;
  }

  await fsp.mkdir(homeDir(), { recursive: true });
  await downloadFile(
    `https://github.com/playit-cloud/playit-agent/releases/download/${AGENT_VERSION}/${asset}`,
    dest
  );
  const actual = await sha256Of(dest);
  if (actual !== sha256) {
    await fsp.rm(dest, { force: true });
    throw new TunnelError(
      `A letöltött ${asset} ellenőrzőösszege nem egyezik a beépítettel. A fájl törölve, semmi nem indult el.`
    );
  }
  await fsp.chmod(dest, 0o755);
  return dest;
}

function note(line: string): void {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  if (!clean) return;
  state.log.push(clean);
  if (state.log.length > 80) state.log.splice(0, state.log.length - 80);
}

/** Talks to the running daemon over the socket in our own directory. */
async function cli(args: string[]): Promise<string> {
  const bin = await ensureBinary("cli");
  const { stdout } = await execFileAsync(bin, ["--socket-path", socketPath(), ...args], {
    cwd: homeDir(),
    timeout: 20_000,
    env: { ...process.env, HOME: homeDir() },
  });
  return stdout.trim();
}

export function tunnelState(): TunnelState {
  return { ...state, claimed: fs.existsSync(secretPath()), log: [...state.log] };
}

async function waitForSocket(timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath())) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export async function startTunnel(entry: ServerEntry): Promise<TunnelState> {
  if (child) throw new TunnelError("Már fut egy alagút. Előbb állítsd le.");
  const daemon = await ensureBinary("daemon");
  await ensureBinary("cli");
  await fsp.rm(socketPath(), { force: true });

  state.log = [];
  state.claimUrl = null;
  state.serverId = entry.id;

  // The socket goes in our own directory rather than /run, which is the whole
  // reason this needs no privileges. Started with the dashboard's own user.
  child = spawn(daemon, ["--secret-path", secretPath(), "--socket-path", socketPath()], {
    cwd: homeDir(),
    env: { ...process.env, HOME: homeDir() },
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessByStdio<null, Readable, Readable>;

  state.running = true;
  const onData = (chunk: Buffer) => chunk.toString("utf-8").split("\n").forEach(note);
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    note(`az ügynök kilépett (${code})`);
    state.running = false;
    child = null;
  });

  if (!(await waitForSocket())) {
    await stopTunnel();
    throw new TunnelError("Az ügynök nem indult el időben. A napló mutatja, mi történt.");
  }

  // An unclaimed agent needs a link opened; a claimed one is already working.
  if (!fs.existsSync(secretPath())) {
    try {
      claimCode = await cli(["claim", "generate"]);
      state.claimUrl = await cli(["claim", "url", claimCode]);
      note(`igényléshez nyisd meg: ${state.claimUrl}`);
    } catch (err) {
      note(`az igénylési link nem készült el: ${(err as Error).message}`);
    }
  }
  return tunnelState();
}

/**
 * Turns an opened claim link into a stored secret.
 *
 * Separate from starting because the step in between is a person visiting a
 * website. Nothing here can do that for them, and pretending to would mean
 * linking somebody's machine to an account they never agreed to.
 */
export async function completeClaim(): Promise<TunnelState> {
  if (!child) throw new TunnelError("Nem fut ügynök.");
  if (!claimCode) throw new TunnelError("Nincs függőben lévő igénylés.");
  try {
    await cli(["claim", "exchange", claimCode]);
  } catch (err) {
    throw new TunnelError(
      `Az igénylés még nincs jóváhagyva a playit.gg oldalán. (${(err as Error).message.slice(0, 120)})`
    );
  }
  note("igénylés kész, a titok elmentve");
  state.claimUrl = null;
  claimCode = null;
  return tunnelState();
}

export async function stopTunnel(): Promise<TunnelState> {
  if (child) {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    if (child) child.kill("SIGKILL");
    child = null;
  }
  state.running = false;
  state.claimUrl = null;
  claimCode = null;
  await fsp.rm(socketPath(), { force: true });
  note("leállítva");
  return tunnelState();
}

/** Stops the agent when the dashboard does, so it cannot outlive its manager. */
export function stopTunnelOnShutdown(): void {
  if (child) child.kill("SIGTERM");
}

/**
 * Forgets the secret, so the agent can be claimed again.
 *
 * The counterpart to claiming: without it, handing this machine on would hand
 * on a live link to the previous owner's playit account.
 */
export async function resetTunnel(): Promise<TunnelState> {
  await stopTunnel();
  await fsp.rm(secretPath(), { force: true });
  note("a mentett titok törölve");
  return tunnelState();
}

export function hostArchSupported(): boolean {
  return os.platform() === "linux" && PINNED.daemon[process.arch] !== undefined;
}
