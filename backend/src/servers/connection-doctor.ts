import net from "node:net";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readProperties } from "./properties";
import { readAccessLists } from "./access-manager";
import { isServerRunning } from "./process-manager";
import { detectMinecraftVersion } from "./version-check";
import { getCachedPlayers } from "./rcon-poller";
import path from "node:path";
import fs from "node:fs";
import type { ServerEntry } from "../types";

const execFileAsync = promisify(execFile);

/**
 * "Why can't my friend join?"
 *
 * The single most common question in any Minecraft community, and the dashboard
 * had every piece of the answer without ever putting them together: whether the
 * server is up, which port it listens on and on which address, whether the
 * whitelist is on and who is on it, whether the person is banned, what version
 * it speaks, and whether the slots are full.
 *
 * Checks run in the order a connection actually fails, so the first thing that
 * is wrong is the first thing reported. A list of nine green ticks and one red
 * cross buried in the middle is a worse answer than "it is the whitelist".
 *
 * What it deliberately does not claim: whether the port is open from the
 * internet. That question cannot be answered from inside the network - a
 * connection to your own public address usually fails on a router that does not
 * hairpin, which would report a working setup as broken. So the checks stop at
 * the machine's own edge and say so, rather than guessing.
 */

export type CheckStatus = "ok" | "problem" | "warning" | "unknown";

export interface ConnectionCheck {
  id: string;
  status: CheckStatus;
  title: string;
  detail: string;
  /** What to do about it, when there is something to do. */
  advice?: string;
  /** A tab to open, when the fix lives on one. */
  goTo?: string;
}

export interface ConnectionReport {
  /** The address a player on this network types in. */
  lanAddress: string | null;
  port: number;
  checks: ConnectionCheck[];
  /** Set when a name was given, so the answers can be about that person. */
  about: string | null;
}

/** The machine's address on the local network, as a player would type it. */
function lanAddress(): string | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

/** Whether anything is listening on a port, and on which addresses. */
async function listeningOn(port: number): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("ss", ["-ltn"], { timeout: 4000 });
    return stdout
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[3] ?? "")
      .filter((local) => local.endsWith(`:${port}`))
      .map((local) => local.slice(0, local.lastIndexOf(":")));
  } catch {
    return [];
  }
}

/** Can a connection actually be opened to it, from this machine? */
function canConnect(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

/**
 * Which port this thing actually listens on.
 *
 * A proxy has no server.properties, so falling back to 25565 there would be a
 * confident guess dressed as a reading - and the whole point of this screen is
 * to stop guessing. BungeeCord and Velocity put it in their own config, so
 * those are read instead.
 */
function portOf(entry: ServerEntry, props: Record<string, string>): number {
  const fromProperties = Number.parseInt(props["server-port"] ?? "", 10);
  if (Number.isFinite(fromProperties)) return fromProperties;

  // BungeeCord: `  host: 0.0.0.0:25565` under listeners.
  const bungee = path.join(entry.folder, "config.yml");
  if (fs.existsSync(bungee)) {
    const host = /^\s*host:\s*\S*?:(\d+)\s*$/m.exec(fs.readFileSync(bungee, "utf-8"));
    if (host) return Number.parseInt(host[1], 10);
  }
  // Velocity: `bind = "0.0.0.0:25577"` in a TOML file.
  const velocity = path.join(entry.folder, "velocity.toml");
  if (fs.existsSync(velocity)) {
    const bind = /^\s*bind\s*=\s*"[^"]*?:(\d+)"/m.exec(fs.readFileSync(velocity, "utf-8"));
    if (bind) return Number.parseInt(bind[1], 10);
  }
  return 25565;
}

const PLAYER_RE = /^[A-Za-z0-9_]{1,16}$/;

export async function diagnoseConnection(
  entry: ServerEntry,
  playerName?: string
): Promise<ConnectionReport> {
  const about = playerName && PLAYER_RE.test(playerName) ? playerName : null;
  const props = readProperties(path.join(entry.folder, "server.properties"));
  const port = portOf(entry, props);
  const checks: ConnectionCheck[] = [];
  const lan = lanAddress();

  // 1. Running at all. Everything below it is meaningless if this is no.
  const running = await isServerRunning(entry);
  checks.push(
    running
      ? { id: "running", status: "ok", title: "A szerver fut", detail: "A folyamat él." }
      : {
          id: "running",
          status: "problem",
          title: "A szerver nem fut",
          detail: "Amíg nem indul el, senki nem tud csatlakozni.",
          advice: "Nyomd meg a Start gombot, és nézd meg a konzolt, ha nem indul el.",
          goTo: "console",
        }
  );
  if (!running) return { lanAddress: lan, port, checks, about };

  // 2. Listening, and where. A server bound to the loopback is up and
  //    unreachable, which looks identical from the outside to being down.
  const addresses = await listeningOn(port);
  const boundToLoopback = addresses.length > 0 && addresses.every((a) => a === "127.0.0.1" || a === "::1");
  if (addresses.length === 0) {
    checks.push({
      id: "listening",
      status: "problem",
      title: `Semmi nem figyel a ${port}-es porton`,
      detail:
        "A szerver fut, de nem nyitotta meg a portját. Ez rendszerint azt jelenti, hogy elindulás közben elakadt, vagy a port foglalt.",
      advice: "Nézd meg a konzolt: a „Failed to bind to port” pontosan ezt jelenti.",
      goTo: "console",
    });
  } else if (boundToLoopback) {
    checks.push({
      id: "listening",
      status: "problem",
      title: "A szerver csak saját magának figyel",
      detail: `A ${port}-es port a 127.0.0.1-re van kötve, így csak erről a gépről érhető el. A hálózat többi tagja számára ez ugyanaz, mintha le lenne állítva.`,
      advice: "Töröld a server-ip értékét a tulajdonságok között, hogy minden interfészen figyeljen.",
      goTo: "properties",
    });
  } else {
    checks.push({
      id: "listening",
      status: "ok",
      title: `Figyel a ${port}-es porton`,
      detail: `Cím: ${addresses.join(", ")}`,
    });
  }

  // 3. Reachable in practice, not just in theory. Firewalls on the machine
  //    itself are the difference between the two.
  if (lan && !boundToLoopback && addresses.length > 0) {
    const reachable = await canConnect(lan, port);
    checks.push(
      reachable
        ? {
            id: "reachable",
            status: "ok",
            title: "A helyi hálózatról elérhető",
            detail: `Add meg a barátaidnak ezt: ${lan}${port === 25565 ? "" : `:${port}`}`,
          }
        : {
            id: "reachable",
            status: "problem",
            title: "A helyi hálózatról nem érhető el",
            detail: `A port nyitva van, de a ${lan}:${port} címre nem sikerült kapcsolódni. Ezt rendszerint a gép tűzfala okozza.`,
            advice: `Engedd át a portot: sudo ufw allow ${port}/tcp`,
          }
    );
  }

  // 4. The whitelist, which is the most common answer of all.
  const access = await readAccessLists(entry).catch(() => null);
  const enforced = props["white-list"] === "true";
  if (enforced) {
    const listed = (access?.whitelist ?? []).map((e) => e.name.toLowerCase());
    if (about && !listed.includes(about.toLowerCase())) {
      checks.push({
        id: "whitelist",
        status: "problem",
        title: `${about} nincs a whitelisten`,
        detail: `A whitelist be van kapcsolva, és ${listed.length} név szerepel rajta. Aki nincs rajta, azt a szerver visszautasítja.`,
        advice: `Írd be a konzolba: whitelist add ${about}`,
        goTo: "access",
      });
    } else {
      checks.push({
        id: "whitelist",
        status: about ? "ok" : "warning",
        title: "A whitelist be van kapcsolva",
        detail: about
          ? `${about} rajta van a listán.`
          : `${listed.length} név szerepel rajta; aki nincs, azt a szerver visszautasítja.`,
        advice: about ? undefined : "Add meg a barátod nevét fent, és megnézem, rajta van-e.",
        goTo: "access",
      });
    }
  } else {
    checks.push({
      id: "whitelist",
      status: "ok",
      title: "A whitelist ki van kapcsolva",
      detail: "Bárki csatlakozhat, akit nem tiltottál ki.",
    });
  }

  // 5. Bans.
  if (about) {
    const banned = (access?.bannedPlayers ?? []).some((e) => e.name.toLowerCase() === about.toLowerCase());
    checks.push(
      banned
        ? {
            id: "banned",
            status: "problem",
            title: `${about} ki van tiltva`,
            detail: "A kitiltott játékos a whitelisttől függetlenül sem tud belépni.",
            advice: `Írd be a konzolba: pardon ${about}`,
            goTo: "access",
          }
        : { id: "banned", status: "ok", title: `${about} nincs kitiltva`, detail: "A tiltólistán nem szerepel." }
    );
  }

  // 6. Slots. A full server refuses with a message people misread as an error.
  const players = getCachedPlayers(entry.id);
  const max = Number.parseInt(props["max-players"] ?? "20", 10) || 20;
  if (players) {
    checks.push(
      players.online >= max
        ? {
            id: "slots",
            status: "problem",
            title: "A szerver tele van",
            detail: `${players.online}/${max} játékos van fent.`,
            advice: "Emeld meg a max-players értéket, vagy várj, amíg valaki kilép.",
            goTo: "properties",
          }
        : { id: "slots", status: "ok", title: "Van szabad hely", detail: `${players.online}/${max} játékos.` }
    );
  }

  // 7. Version. "Outdated client" is the most misread message in the game.
  const version = await detectMinecraftVersion(entry).catch(() => null);
  checks.push({
    id: "version",
    status: version ? "ok" : "unknown",
    title: version ? `A szerver verziója: ${version}` : "A verzió nem állapítható meg",
    detail: version
      ? "A barátodnak pontosan ezzel a verzióval kell csatlakoznia, hacsak nincs ViaVersion a szerveren."
      : "A szerver mappájában nem található verzióinformáció.",
  });

  // 8. Offline mode, which decides whose accounts are accepted.
  const online = props["online-mode"] !== "false";
  const loginPlugin =
    fs.existsSync(path.join(entry.folder, "plugins")) &&
    fs
      .readdirSync(path.join(entry.folder, "plugins"))
      .some((f) => /^(authme|nlogin|librelogin|loginsecurity|openlogin)/i.test(f));
  checks.push({
    id: "online-mode",
    status: "ok",
    title: online ? "Csak megvásárolt Minecraft-fiókkal" : "Fiók nélkül is csatlakozhat",
    detail: online
      ? "Az online-mode be van kapcsolva, tehát a barátodnak eredeti fiókkal kell belépnie."
      : loginPlugin
        ? "Az online-mode ki van kapcsolva, a belépést bejelentkeztető bővítmény őrzi. Regisztrálnia kell először."
        : "Az online-mode ki van kapcsolva, tehát bárki bármilyen néven beléphet.",
    goTo: "properties",
  });

  // 9. The edge of what can honestly be said from here.
  checks.push({
    id: "internet",
    status: "unknown",
    title: "Az internetről nem tudom megnézni",
    detail:
      "Idáig látok el: a gépről és a helyi hálózatról. Hogy a routeren át kívülről is elérhető-e, azt innen nem lehet megbízhatóan megállapítani - a saját nyilvános címre indított kapcsolat a legtöbb routeren akkor is elbukik, ha a beállítás egyébként jó.",
    advice:
      "Ha kívülről is kell, a routerben irányítsd át a portot erre a gépre - és előtte nézd meg a Biztonság fület.",
    goTo: "security",
  });

  return { lanAddress: lan, port, checks, about };
}
