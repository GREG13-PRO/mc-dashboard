import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { listArchivedLogs, readArchivedLog } from "./console-archive";
import type { ServerEntry } from "../types";

/**
 * Who logged in from where, across the current log and the archived ones.
 *
 * The security review already flags the two obvious shapes - one account from
 * many addresses, one address with many accounts. This is the view behind
 * those numbers, because deciding whether four accounts from one address is a
 * family or a ban evasion needs the names and the times, not a count.
 *
 * What it deliberately does not claim to know is whether an address is a VPN
 * or a proxy. That cannot be told from a log line; it needs a data source
 * about the address itself, and inventing an answer from the shape of the
 * number would be worse than saying nothing.
 */

// "Steve[/1.2.3.4:56789] logged in with entity id"
const LOGIN_RE = /([A-Za-z0-9_]{1,16})\[\/([0-9a-fA-F.:]+):\d+] logged in/;
/**
 * The time is looked for separately rather than being part of the match.
 *
 * Vanilla and Paper stamp lines "[16:45:10]"; a Forge modpack stamps them
 * "[03aug.2026 16:45:10.670]". Requiring the first shape silently found
 * nothing at all on the modpack server, which is exactly the kind of failure
 * that looks like "no suspicious logins" instead of "not looking".
 */
const TIME_RE = /(\d{2}:\d{2}:\d{2})/;

export interface IpSighting {
  player: string;
  first: string;
  last: string;
  logins: number;
}

export interface IpSummary {
  ip: string;
  logins: number;
  players: IpSighting[];
  first: string;
  last: string;
}

export interface PlayerSummary {
  player: string;
  ips: string[];
  logins: number;
}

export interface IpAnalysis {
  /** How many log files were read, so an empty result is distinguishable from
   *  a server whose logs have been rotated away. */
  logsRead: number;
  ips: IpSummary[];
  players: PlayerSummary[];
}

interface Login {
  player: string;
  ip: string;
  at: string;
}

function parseLogins(text: string, dateHint: string): Login[] {
  const out: Login[] = [];
  for (const line of text.split("\n")) {
    const match = LOGIN_RE.exec(line);
    if (!match) continue;
    const [, player, ip] = match;
    const time = TIME_RE.exec(line)?.[1] ?? "";
    out.push({ player, ip, at: `${dateHint} ${time}`.trim() });
  }
  return out;
}

export async function analyseIps(entry: ServerEntry, maxLogs = 15): Promise<IpAnalysis> {
  const logins: Login[] = [];
  let logsRead = 0;

  const live = path.join(entry.folder, "logs", "latest.log");
  if (fs.existsSync(live)) {
    const stat = await fsp.stat(live);
    logins.push(
      ...parseLogins(
        await fsp.readFile(live, "utf-8"),
        stat.mtime.toISOString().slice(0, 10)
      )
    );
    logsRead++;
  }

  // The archives the dashboard keeps, newest first; their filenames carry the
  // date the log ended, which is the only date a log line itself does not have.
  for (const archived of (await listArchivedLogs(entry).catch(() => [])).slice(0, maxLogs)) {
    try {
      logins.push(
        ...parseLogins(await readArchivedLog(entry, archived.filename), archived.endedAt.slice(0, 10))
      );
      logsRead++;
    } catch {
      // A log that cannot be read is one fewer data point, not a failure.
    }
  }

  const byIp = new Map<string, Map<string, Login[]>>();
  const byPlayer = new Map<string, Set<string>>();
  for (const login of logins) {
    if (!byIp.has(login.ip)) byIp.set(login.ip, new Map());
    const players = byIp.get(login.ip)!;
    if (!players.has(login.player)) players.set(login.player, []);
    players.get(login.player)!.push(login);

    if (!byPlayer.has(login.player)) byPlayer.set(login.player, new Set());
    byPlayer.get(login.player)!.add(login.ip);
  }

  const ips: IpSummary[] = [...byIp].map(([ip, players]) => {
    const sightings: IpSighting[] = [...players].map(([player, list]) => {
      const times = list.map((l) => l.at).sort();
      return { player, logins: list.length, first: times[0], last: times[times.length - 1] };
    });
    const all = sightings.flatMap((s) => [s.first, s.last]).sort();
    return {
      ip,
      logins: sightings.reduce((sum, s) => sum + s.logins, 0),
      players: sightings.sort((a, b) => b.logins - a.logins),
      first: all[0],
      last: all[all.length - 1],
    };
  });

  const players: PlayerSummary[] = [...byPlayer].map(([player, addresses]) => ({
    player,
    ips: [...addresses],
    logins: logins.filter((l) => l.player === player).length,
  }));

  return {
    logsRead,
    // Most accounts first: that is the shape worth looking at.
    ips: ips.sort((a, b) => b.players.length - a.players.length || b.logins - a.logins),
    players: players.sort((a, b) => b.ips.length - a.ips.length || b.logins - a.logins),
  };
}
