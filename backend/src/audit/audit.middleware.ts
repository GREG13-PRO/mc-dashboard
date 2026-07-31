import type { Request, Response, NextFunction } from "express";
import { recordAudit } from "./audit-log";
import { serverRegistry } from "../servers/registry";

/**
 * Describes a mutating request in words, so the log reads as actions rather
 * than as HTTP. Falls back to "METHOD /path" for anything not listed, which
 * means a route added later is still recorded, just less prettily.
 */
const ROUTE_LABELS: { method: string; pattern: RegExp; label: string }[] = [
  { method: "POST", pattern: /^\/servers\/[^/]+\/start$/, label: "Szerver indítása" },
  { method: "POST", pattern: /^\/servers\/[^/]+\/stop$/, label: "Szerver leállítása" },
  { method: "POST", pattern: /^\/servers\/[^/]+\/restart$/, label: "Szerver újraindítása" },
  { method: "POST", pattern: /^\/servers\/[^/]+\/kill$/, label: "Szerver kilövése (kill)" },
  { method: "POST", pattern: /^\/servers\/[^/]+\/backups$/, label: "Mentés készítése" },
  { method: "POST", pattern: /^\/servers\/[^/]+\/backups\/[^/]+\/restore$/, label: "Mentés visszaállítása" },
  { method: "DELETE", pattern: /^\/servers\/[^/]+\/backups\/[^/]+$/, label: "Mentés törlése" },
  { method: "POST", pattern: /^\/servers\/[^/]+\/players\/[^/]+\/action$/, label: "Játékos-művelet" },
  { method: "POST", pattern: /^\/servers\/[^/]+\/access\/whitelist-mode$/, label: "Whitelist kapcsoló" },
  { method: "POST", pattern: /^\/servers\/[^/]+\/access\/ip$/, label: "IP-tiltás" },
  { method: "POST", pattern: /^\/servers\/[^/]+\/plugins$/, label: "Bővítmény telepítése" },
  { method: "DELETE", pattern: /^\/servers\/[^/]+\/plugins\/[^/]+$/, label: "Bővítmény törlése" },
  { method: "PUT", pattern: /^\/servers\/[^/]+\/files\/content$/, label: "Fájl mentése" },
  { method: "POST", pattern: /^\/servers\/[^/]+\/files\/upload$/, label: "Fájl feltöltése" },
  { method: "DELETE", pattern: /^\/servers\/[^/]+\/files$/, label: "Fájl törlése" },
  { method: "POST", pattern: /^\/servers\/[^/]+\/files\/mkdir$/, label: "Mappa létrehozása" },
  { method: "POST", pattern: /^\/servers$/, label: "Szerver hozzáadása" },
  { method: "PUT", pattern: /^\/servers\/[^/]+$/, label: "Szerver beállításai" },
  { method: "DELETE", pattern: /^\/servers\/[^/]+$/, label: "Szerver törlése" },
  { method: "POST", pattern: /^\/install-server$/, label: "Szerver telepítése" },
  { method: "POST", pattern: /^\/users$/, label: "Felhasználó létrehozása" },
  { method: "PUT", pattern: /^\/users\/[^/]+$/, label: "Felhasználó módosítása" },
  { method: "DELETE", pattern: /^\/users\/[^/]+$/, label: "Felhasználó törlése" },
];

function labelFor(method: string, urlPath: string): string {
  const hit = ROUTE_LABELS.find((r) => r.method === method && r.pattern.test(urlPath));
  return hit ? hit.label : `${method} ${urlPath}`;
}

function serverIdFrom(urlPath: string): string | null {
  return /^\/servers\/([^/]+)/.exec(urlPath)?.[1] ?? null;
}

/**
 * Extra context worth having when reading the log back: which player, which
 * plugin, which action. Deliberately never the request body wholesale - that
 * would put RCON passwords and file contents into a long-lived plaintext file.
 */
function detailFor(req: Request, urlPath: string): string | null {
  const parts: string[] = [];
  const player = /^\/servers\/[^/]+\/players\/([^/]+)\/action$/.exec(urlPath)?.[1];
  if (player) parts.push(decodeURIComponent(player));
  if (typeof req.body?.action === "string") parts.push(req.body.action);
  if (typeof req.body?.projectId === "string") parts.push(req.body.projectId);
  if (typeof req.body?.ip === "string") parts.push(req.body.ip);
  if (typeof req.body?.name === "string") parts.push(req.body.name);
  if (typeof req.body?.username === "string") parts.push(req.body.username);
  if (typeof req.body?.enabled === "boolean") parts.push(req.body.enabled ? "be" : "ki");
  if (typeof req.query?.path === "string") parts.push(req.query.path);
  return parts.length > 0 ? parts.join(" · ") : null;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!MUTATING.has(req.method)) {
    next();
    return;
  }
  // Login/logout carry their own actor handling (req.user isn't populated on
  // those routes) and are recorded by the auth routes themselves.
  if (req.path.startsWith("/auth/")) {
    next();
    return;
  }

  const urlPath = req.path;
  const detail = detailFor(req, urlPath);

  res.on("finish", () => {
    const serverId = serverIdFrom(urlPath);
    recordAudit({
      actor: req.user?.username ?? "ismeretlen",
      actorId: req.user?.id ?? null,
      action: labelFor(req.method, urlPath),
      serverId,
      // Resolved at write time: a deleted server would otherwise leave only an
      // id that no longer means anything to whoever reads the log later.
      serverName: serverId ? serverRegistry.get(serverId)?.name ?? null : null,
      detail,
      ip: req.ip ?? null,
      ok: res.statusCode < 400,
    });
  });

  next();
}
