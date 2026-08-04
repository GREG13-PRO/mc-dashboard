import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { listBackups } from "./backup-manager";
import { readProperties } from "./properties";
import { readPluginManifest } from "./plugin-manager";
import { dismissedUntil } from "./security-dismissals";
import type { FixId } from "./security-fixes";
import type { ServerEntry } from "../types";

/**
 * Security review of a server, from what the dashboard can see on disk.
 *
 * Deliberately not an anti-cheat: catching a player flying or reaching through
 * walls means watching movement packets, which needs code running inside the
 * server. What this does instead is the part that does not - configuration
 * that leaves the door open, plugin jars of unknown provenance, and login
 * patterns in the log - and it is the part that matters most here, because
 * this project has already been through one compromise that came in through a
 * hand-placed plugin jar.
 */

export type Severity = "critical" | "warning" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** One line on what to do about it. */
  advice: string;
  /**
   * Set when the dashboard can make the repair itself. Declared by the check
   * rather than looked up by id, because the same id can mean different things:
   * offline mode with no login plugin is fixable, offline mode guarded by
   * AuthMe is a decision and flipping it would lock the server's players out.
   */
  fix?: FixId;
  /** Tab to open when the repair needs a person. */
  goTo?: string;
  /** ISO instant, null for permanent, undefined when not dismissed. */
  dismissedUntil?: string | null;
}

export interface SecurityReport {
  generatedAt: string;
  findings: Finding[];
  /** Set when the log could not be read, so an empty login section is not
   *  mistaken for "nothing suspicious". */
  loginsChecked: boolean;
}

/**
 * Whether the server sits behind a proxy.
 *
 * This decides whether `online-mode=false` is a hole or the normal setup: on a
 * BungeeCord or Velocity network the backend servers are meant to have it off,
 * and the proxy does the authenticating.
 */
function behindProxy(entry: ServerEntry): boolean {
  const spigot = path.join(entry.folder, "spigot.yml");
  if (fs.existsSync(spigot) && /^\s*bungeecord:\s*true/m.test(fs.readFileSync(spigot, "utf-8"))) {
    return true;
  }
  for (const rel of ["config/paper-global.yml", "config/paper-velocity.yml"]) {
    const file = path.join(entry.folder, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf-8");
    // Velocity's modern forwarding block: `velocity:\n  enabled: true`
    if (/velocity:[\s\S]{0,200}?enabled:\s*true/m.test(text)) return true;
  }
  return false;
}

/**
 * Whether a login plugin guards the server.
 *
 * On a deliberately cracked server these stand in for Mojang's authentication,
 * and calling that setup critical would be crying wolf - the whole point of
 * running AuthMe is that offline mode is a decision, not an oversight. It is
 * still weaker than online mode, so it becomes a warning rather than silence.
 */
function loginPluginName(entry: ServerEntry): string | null {
  const dir = path.join(entry.folder, "plugins");
  if (!fs.existsSync(dir)) return null;
  const known = /^(authme|nlogin|librelogin|loginsecurity|openlogin|jpremium|fastlogin)/i;
  const hit = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith(".jar") && known.test(f));
  return hit ? hit.replace(/\.jar$/i, "") : null;
}

function checkConfig(entry: ServerEntry, findings: Finding[]): void {
  const propsPath = path.join(entry.folder, "server.properties");
  const props = readProperties(propsPath);
  if (Object.keys(props).length === 0) return;

  const proxied = behindProxy(entry);
  const loginPlugin = loginPluginName(entry);
  if (props["online-mode"] === "false" && !proxied) {
    findings.push(
      loginPlugin
        ? {
            id: "online-mode",
            severity: "warning",
            title: "Az online-mode ki van kapcsolva, a belépést bővítmény őrzi",
            detail: `A szerver nem ellenőrzi a Mojang-fiókot, és nem találtam proxy-továbbítást sem, viszont fut rajta a(z) ${loginPlugin}. Így egy név átvételéhez a jelszó kell - de a fiókok biztonsága innentől ezen a bővítményen és a játékosok jelszavain múlik.`,
            advice:
              "Tartsd frissen a bejelentkeztető bővítményt, és nézd meg, hogy az adminok jelszavai erősek-e.",
            goTo: "plugins",
          }
        : {
            id: "online-mode",
            severity: "critical",
            title: "Az online-mode ki van kapcsolva, és nincs proxy előtte",
            detail:
              "A szerver nem ellenőrzi a Mojang-fiókot, és nem találtam BungeeCord- vagy Velocity-továbbítást, sem bejelentkeztető bővítményt. Így bárki bejelentkezhet bármelyik játékos - köztük egy admin - nevében.",
            advice:
              "Kapcsold be az online-mode-ot, tedd proxy mögé, vagy tegyél fel bejelentkeztető bővítményt.",
            fix: "online-mode",
          }
    );
  }

  // With a login plugin an open server is the intended setup, so the whitelist
  // is not the last line of defence and flagging it would just be noise.
  if (props["white-list"] !== "true" && props["online-mode"] === "false" && !proxied && !loginPlugin) {
    findings.push({
      id: "whitelist-open",
      severity: "warning",
      title: "Nyitott szerver whitelist nélkül",
      detail: "Az online-mode ki van kapcsolva, és a whitelist sincs bekapcsolva.",
      advice: "Amíg az online-mode ki van kapcsolva, a whitelist az egyetlen belépési korlát.",
      fix: "whitelist",
    });
  }

  if (props["enable-rcon"] === "true") {
    const password = props["rcon.password"] ?? "";
    if (password.length === 0) {
      findings.push({
        id: "rcon-empty-password",
        severity: "critical",
        title: "Az RCON jelszó üres",
        detail: "Az RCON be van kapcsolva, de nincs hozzá jelszó - aki eléri a portot, konzolparancsot futtathat.",
        advice: "Adj neki hosszú, véletlen jelszót, és frissítsd a szerver beállításait a dashboardban is.",
        fix: "rcon-password",
      });
    } else if (password.length < 12) {
      findings.push({
        id: "rcon-weak-password",
        severity: "warning",
        title: "Rövid RCON jelszó",
        detail: `Az RCON jelszó ${password.length} karakter. Az RCON-nak nincs sebességkorlátja, tehát a rövid jelszó végigpróbálható.`,
        advice: "Legalább 16 karakteres véletlen jelszót használj.",
        fix: "rcon-password",
      });
    }
    if (!props["server-ip"]) {
      findings.push({
        id: "rcon-all-interfaces",
        severity: "warning",
        title: "Az RCON minden hálózati interfészen figyel",
        detail:
          "A server-ip üres, így az RCON-port nem csak a localhoston érhető el. A dashboardnak ehhez elég a localhost.",
        advice: "Zárd le az RCON-portot tűzfallal, vagy kösd a szervert 127.0.0.1-re, ha nem kell kívülről.",
        goTo: "properties",
      });
    }
  }

  if (props["enable-command-block"] === "true") {
    findings.push({
      id: "command-blocks",
      severity: "warning",
      title: "A parancsblokkok engedélyezve vannak",
      detail:
        "Parancsblokkal az OP-jog gyakorlatilag továbbadható: aki elhelyezhet egyet, tetszőleges konzolparancsot futtathat.",
      advice: "Kapcsold ki, ha a szerver nem épít rá.",
      fix: "command-blocks",
    });
  }

  try {
    const mode = fs.statSync(propsPath).mode & 0o777;
    if (props["enable-rcon"] === "true" && mode & 0o044) {
      findings.push({
        id: "properties-readable",
        severity: "warning",
        title: "A server.properties más felhasználók számára is olvasható",
        detail: `A fájl jogosultsága ${mode.toString(8)}, és RCON-jelszót tartalmaz. A gép minden felhasználója kiolvashatja.`,
        advice: "chmod 600 a server.properties fájlra.",
        fix: "properties-perms",
      });
    }
  } catch {
    // A missing or unreadable file is already covered by the empty-props check.
  }
}

interface OpEntry {
  name?: string;
  level?: number;
}

function checkOps(entry: ServerEntry, findings: Finding[]): void {
  const file = path.join(entry.folder, "ops.json");
  if (!fs.existsSync(file)) return;
  let ops: OpEntry[];
  try {
    ops = JSON.parse(fs.readFileSync(file, "utf-8")) as OpEntry[];
  } catch {
    return;
  }
  if (!Array.isArray(ops) || ops.length === 0) return;

  const full = ops.filter((o) => (o.level ?? 4) >= 4);
  if (full.length > 0) {
    findings.push({
      id: "ops",
      severity: full.length > 3 ? "warning" : "info",
      title: `${full.length} teljes jogú OP van a szerveren`,
      detail: `Level 4 OP: ${full.map((o) => o.name ?? "?").join(", ")}. Ezek bármilyen konzolparancsot futtathatnak, a stop és az op is beleértve.`,
      advice: "Vedd le az OP-t azokról, akiknek nem kell, és adj helyette LuckPerms-jogot.",
      goTo: "files",
    });
  }
}

async function checkBackups(entry: ServerEntry, findings: Finding[]): Promise<void> {
  const backups = await listBackups(entry).catch(() => []);
  if (backups.length === 0) {
    findings.push({
      id: "no-backup",
      severity: "warning",
      title: "Nincs egyetlen mentés sem",
      detail: "Ehhez a szerverhez nem készült mentés a dashboardból.",
      advice: "Készíts egyet a Beállítások fülön - kompromittálódás után ez az egyetlen tiszta visszaút.",
      fix: "backup",
    });
    return;
  }
  const newest = backups
    .map((b) => new Date(b.createdAt).getTime())
    .reduce((a, b) => Math.max(a, b), 0);
  const days = (Date.now() - newest) / 86_400_000;
  if (days > 14) {
    findings.push({
      id: "stale-backup",
      severity: "info",
      title: `A legfrissebb mentés ${Math.round(days)} napos`,
      detail: "Egy régi mentésből való visszaállás sok munkát dob el.",
      advice: "Készíts friss mentést.",
      fix: "backup",
    });
  }
}

async function sha256(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(await fsp.readFile(file));
  return hash.digest("hex");
}

/**
 * Provenance and integrity of the plugin jars.
 *
 * The dashboard records what it installed and from where; anything else in
 * plugins/ arrived by other means. That is not automatically bad - plenty of
 * plugins are only distributed as a direct download - but "where did this jar
 * come from" is exactly the question nobody could answer during the earlier
 * compromise, so it is worth surfacing rather than assuming.
 */
async function checkPlugins(entry: ServerEntry, findings: Finding[]): Promise<void> {
  const dir = path.join(entry.folder, "plugins");
  if (!fs.existsSync(dir)) return;

  const manifest = await readPluginManifest(entry);
  const jars = (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".jar"));
  const unknown: string[] = [];
  const changed: string[] = [];

  for (const jar of jars) {
    const record = manifest[jar];
    if (!record) {
      unknown.push(jar);
      continue;
    }
    if (!record.sha256) continue; // Installed before hashes were recorded.
    if ((await sha256(path.join(dir, jar))) !== record.sha256) changed.push(jar);
  }

  if (changed.length > 0) {
    findings.push({
      id: "plugin-modified",
      severity: "critical",
      title: `${changed.length} plugin jar megváltozott a telepítése óta`,
      detail: `A dashboard telepítette, de a fájl tartalma már nem az, ami letöltéskor volt: ${changed.join(", ")}.`,
      advice: "Töltsd le újra a bővítményt a Bővítmények fülön, és nézd meg, ki és mikor írta felül.",
      goTo: "plugins",
    });
  }

  if (unknown.length > 0) {
    findings.push({
      id: "plugin-unknown-origin",
      severity: "warning",
      title: `${unknown.length} plugin ismeretlen eredetű`,
      detail: `Nem a dashboardon keresztül kerültek a plugins mappába, így nincs róluk forrás: ${unknown.join(", ")}.`,
      advice:
        "Ahol van rá Modrinth- vagy Hangar-kiadás, telepítsd újra a Bővítmények fülről; a többinél ellenőrizd, honnan származik.",
      goTo: "plugins",
    });
  }
}

// "Steve[/1.2.3.4:56789] logged in with entity id"
const LOGIN_RE = /: ([A-Za-z0-9_]{1,16})\[\/([0-9a-fA-F.:]+):\d+] logged in with entity id/;
// A connection that never got as far as logging in.
const REFUSED_RE = /Disconnecting|lost connection: (Failed to verify|Internal Exception|Timed out)/;

function checkLogins(entry: ServerEntry, findings: Finding[]): boolean {
  const log = path.join(entry.folder, "logs", "latest.log");
  if (!fs.existsSync(log)) return false;

  let text: string;
  try {
    text = fs.readFileSync(log, "utf-8");
  } catch {
    return false;
  }

  const ipsByPlayer = new Map<string, Set<string>>();
  const playersByIp = new Map<string, Set<string>>();
  let refused = 0;

  for (const line of text.split("\n")) {
    const login = LOGIN_RE.exec(line);
    if (login) {
      const [, name, ip] = login;
      if (!ipsByPlayer.has(name)) ipsByPlayer.set(name, new Set());
      ipsByPlayer.get(name)!.add(ip);
      if (!playersByIp.has(ip)) playersByIp.set(ip, new Set());
      playersByIp.get(ip)!.add(name);
      continue;
    }
    if (REFUSED_RE.test(line)) refused++;
  }

  const roaming = [...ipsByPlayer].filter(([, ips]) => ips.size >= 3);
  if (roaming.length > 0) {
    findings.push({
      id: "player-many-ips",
      severity: "info",
      title: `${roaming.length} játékos lépett be háromnál több IP-címről`,
      detail: roaming.map(([name, ips]) => `${name}: ${ips.size} cím`).join(", "),
      advice:
        "Mobilnetről ez normális. Ha admin-fiókról van szó és az online-mode ki van kapcsolva, érdemes utánanézni.",
      goTo: "access",
    });
  }

  const shared = [...playersByIp].filter(([, names]) => names.size >= 4);
  if (shared.length > 0) {
    findings.push({
      id: "ip-many-players",
      severity: "warning",
      title: `${shared.length} IP-címről négynél több különböző fiók lépett be`,
      detail: shared.map(([ip, names]) => `${ip}: ${[...names].join(", ")}`).join(" | "),
      advice: "Ez tipikusan alt-fiókos kikerülés egy ban után. Ellenőrizd, majd IP-t is tilthatsz.",
      goTo: "access",
    });
  }

  if (refused > 200) {
    findings.push({
      id: "connection-flood",
      severity: "warning",
      title: `${refused} megszakadt kapcsolódás a jelenlegi logban`,
      detail:
        "Sok kapcsolat szakadt meg még bejelentkezés előtt. Ez lehet botnetes csatlakozás-özön, de hálózati hiba is.",
      advice: "Nézd meg a konzolt, és ha egy IP-ről jön, tiltsd tűzfalon.",
    });
  }
  return true;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export async function securityReport(entry: ServerEntry): Promise<SecurityReport> {
  const findings: Finding[] = [];
  checkConfig(entry, findings);
  checkOps(entry, findings);
  await checkBackups(entry, findings);
  await checkPlugins(entry, findings);
  const loginsChecked = checkLogins(entry, findings);

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // Marked, not filtered. Which findings are hidden is the caller's decision,
  // and an expired dismissal comes back on its own because this is re-read
  // every time rather than cached.
  for (const finding of findings) {
    finding.dismissedUntil = await dismissedUntil(entry, finding.id);
  }
  return { generatedAt: new Date().toISOString(), findings, loginsChecked };
}
