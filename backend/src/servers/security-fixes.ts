import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readProperties, writeProperties } from "./properties";
import { serverRegistry } from "./registry";
import { createBackup } from "./backup-manager";
import type { ServerEntry } from "../types";

/**
 * The repairs the dashboard can make itself.
 *
 * Eight of the fifteen security findings have a mechanical fix - a property to
 * flip, a password to generate, a file mode to tighten, a backup to take. The
 * other seven need a person: deleting a modified plugin jar, deciding who
 * should keep operator, writing a firewall rule. Those get a link to the right
 * screen instead, and no button that pretends to know the answer.
 *
 * Nothing here applies without being shown first. The preview is the whole
 * point: `online-mode: false → true` is a sentence somebody can disagree with,
 * and "Fixed!" is not.
 */

export class FixError extends Error {}

export type FixId =
  | "online-mode"
  | "whitelist"
  | "rcon-password"
  | "command-blocks"
  | "properties-perms"
  | "bind-loopback"
  | "backup";

export interface FixChange {
  label: string;
  from: string;
  to: string;
}

export interface FixPreview {
  id: FixId;
  changes: FixChange[];
  /** Whether the server has to be restarted for this to take effect. */
  needsRestart: boolean;
  /**
   * Shown in red above the confirm button. Only set where applying the fix can
   * shut real players out - those are the two where a careless click costs
   * something that a page reload does not undo.
   */
  danger?: string;
}

function propsPath(entry: ServerEntry): string {
  return path.join(entry.folder, "server.properties");
}

/** 24 characters of base64url: long enough that RCON's lack of rate limiting
 *  stops mattering, short enough to paste. */
function strongPassword(): string {
  return crypto.randomBytes(18).toString("base64url");
}

/**
 * What a fix would do, without doing it.
 *
 * Read fresh from disk each time rather than from the report that produced the
 * finding: the report may be a minute old, and a preview that describes a value
 * somebody has since changed by hand is worse than no preview.
 */
export function previewFix(entry: ServerEntry, id: FixId): FixPreview {
  const props = readProperties(propsPath(entry));

  switch (id) {
    case "online-mode":
      return {
        id,
        changes: [{ label: "online-mode", from: props["online-mode"] ?? "true", to: "true" }],
        needsRestart: true,
        danger:
          "Bekapcsolás után csak érvényes Mojang-fiókkal lehet belépni. Aki eddig más néven játszott, kizáródik.",
      };

    case "whitelist":
      return {
        id,
        changes: [{ label: "white-list", from: props["white-list"] ?? "false", to: "true" }],
        needsRestart: false,
        danger:
          "Bekapcsolás után csak a whitelisten szereplők tudnak belépni. Ellenőrizd a listát a Whitelist / Ban fülön.",
      };

    case "rcon-password": {
      const current = props["rcon.password"] ?? "";
      return {
        id,
        changes: [
          {
            label: "rcon.password",
            from: current.length === 0 ? "(üres)" : `${current.length} karakter`,
            to: "24 karakter, generált",
          },
        ],
        needsRestart: true,
      };
    }

    case "command-blocks":
      return {
        id,
        changes: [
          { label: "enable-command-block", from: props["enable-command-block"] ?? "false", to: "false" },
        ],
        needsRestart: true,
      };

    case "bind-loopback":
      return {
        id,
        changes: [
          {
            label: "server-ip",
            from: props["server-ip"] || "(üres — minden interfész)",
            to: "127.0.0.1",
          },
        ],
        needsRestart: true,
        // Said out loud because it is the one way this fix can hurt: a proxy on
        // another machine reaches the backend over the network, and binding to
        // the loopback shuts it out along with everyone else.
        danger:
          "Csak akkor helyes, ha a proxy ugyanezen a gépen fut. Ha máshol, akkor tűzfalszabály kell helyette.",
      };

    case "properties-perms": {
      const mode = fs.existsSync(propsPath(entry))
        ? (fs.statSync(propsPath(entry)).mode & 0o777).toString(8)
        : "?";
      return {
        id,
        changes: [{ label: "server.properties", from: mode, to: "600" }],
        needsRestart: false,
      };
    }

    case "backup":
      return {
        id,
        changes: [{ label: "Mentés", from: "—", to: "új mentés készül" }],
        needsRestart: false,
      };
  }
}

/**
 * Does it, and says what it did.
 *
 * The RCON password goes through registry.update rather than straight into
 * server.properties, because that is what keeps servers.json and the file in
 * step - writing only one of them is exactly the drift that caused two "the
 * player list silently does nothing" bugs on this project.
 */
export async function applyFix(entry: ServerEntry, id: FixId): Promise<string> {
  switch (id) {
    case "online-mode":
      writeProperties(propsPath(entry), { "online-mode": "true" });
      return "online-mode=true";

    case "whitelist":
      writeProperties(propsPath(entry), { "white-list": "true" });
      return "white-list=true";

    case "rcon-password": {
      const password = strongPassword();
      serverRegistry.update(entry.id, { rcon: { password } });
      return "rcon.password frissítve";
    }

    case "command-blocks":
      writeProperties(propsPath(entry), { "enable-command-block": "false" });
      return "enable-command-block=false";

    case "bind-loopback":
      writeProperties(propsPath(entry), { "server-ip": "127.0.0.1" });
      return "server-ip=127.0.0.1";

    case "properties-perms": {
      const file = propsPath(entry);
      if (!fs.existsSync(file)) throw new FixError("Nincs server.properties fájl.");
      fs.chmodSync(file, 0o600);
      return "server.properties 600";
    }

    case "backup": {
      const backup = await createBackup(entry);
      return `mentés kész: ${backup.filename}`;
    }
  }
}
