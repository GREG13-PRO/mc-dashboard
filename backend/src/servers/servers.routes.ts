import { Router, type Request, type Response, type NextFunction } from "express";
import { serverRegistry, toPublicEntry } from "./registry";
import {
  startServer,
  stopServer,
  restartServer,
  killServer,
  isServerRunning,
  sendCommand,
  getResourceUsageMap,
} from "./process-manager";
import { getCachedPlayers } from "./rcon-poller";
import { createBackup, listBackups, restoreBackup, deleteBackup, resolveBackupPath } from "./backup-manager";
import { filesRouter } from "../files/fs.routes";
import { requireAdmin, requirePermission } from "../auth/auth.middleware";
import type { ServerEntryInput } from "../types";

export const serversRouter = Router();

function hasAnyPermission(req: Request, serverId: string): boolean {
  if (req.user?.isAdmin) return true;
  const perms = req.user?.permissions[serverId];
  return Boolean(perms && (perms.console || perms.files || perms.players || perms.settings));
}

// Gate for routes with a `:id` param where any granted capability on that
// server is enough to view it (the list and detail endpoints) - the finer
// per-capability checks (console/files/players/settings) are applied on top
// of this for the actions that actually do something.
function requireAnyPermission(req: Request, res: Response, next: NextFunction) {
  if (!hasAnyPermission(req, req.params.id)) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  next();
}

// Vanilla Minecraft usernames only ever contain these characters - reject
// anything else so a player name can never be used to smuggle extra
// commands into the console (the name is concatenated into a command string
// sent verbatim via `screen -X stuff`).
const PLAYER_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

// Plain vanilla commands so these work regardless of which plugins (if any)
// a given server has installed.
const PLAYER_ACTION_COMMANDS: Record<string, (name: string) => string> = {
  kill: (name) => `kill ${name}`,
  heal: (name) => `effect give ${name} minecraft:instant_health 1 10 true`,
  feed: (name) => `data merge entity ${name} {foodLevel:20}`,
  starve: (name) => `data merge entity ${name} {foodLevel:0}`,
  kick: (name) => `kick ${name}`,
};

serversRouter.get("/", async (req, res) => {
  const entries = serverRegistry.list().filter((entry) => hasAnyPermission(req, entry.id));
  const usage = await getResourceUsageMap(entries);
  const withStatus = await Promise.all(
    entries.map(async (entry) => ({
      ...toPublicEntry(entry),
      running: await isServerRunning(entry),
      players: getCachedPlayers(entry.id) ?? null,
      resources: usage.get(entry.id) ?? null,
    }))
  );
  res.json({ servers: withStatus });
});

serversRouter.post("/", requireAdmin, (req, res) => {
  const input = req.body as ServerEntryInput;
  if (!input?.name || !input?.folder || !input?.startScript) {
    res.status(400).json({ error: "name, folder and startScript are required" });
    return;
  }
  try {
    const entry = serverRegistry.create(input);
    res.status(201).json({ server: toPublicEntry(entry) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id", requireAnyPermission, async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  const usage = await getResourceUsageMap([entry]);
  res.json({
    server: toPublicEntry(entry),
    running: await isServerRunning(entry),
    players: getCachedPlayers(entry.id) ?? null,
    resources: usage.get(entry.id) ?? null,
  });
});

serversRouter.put("/:id", requirePermission("settings"), (req, res) => {
  try {
    const entry = serverRegistry.update(req.params.id, req.body as Partial<ServerEntryInput>);
    res.json({ server: toPublicEntry(entry) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

serversRouter.delete("/:id", requireAdmin, async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  if (await isServerRunning(entry)) {
    res.status(409).json({ error: "Stop the server before deleting it" });
    return;
  }
  try {
    serverRegistry.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/start", requirePermission("console"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await startServer(entry);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/stop", requirePermission("console"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await stopServer(entry);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/restart", requirePermission("console"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await restartServer(entry);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/kill", requirePermission("console"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await killServer(entry);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/backups", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.json({ backups: await listBackups(entry) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/backups", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    const backup = await createBackup(entry);
    res.status(201).json({ backup });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/backups/:filename/download", requirePermission("settings"), (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    const filePath = resolveBackupPath(entry, req.params.filename);
    res.download(filePath);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/backups/:filename/restore", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await restoreBackup(entry, req.params.filename);
    res.json({ ok: true });
  } catch (err) {
    const message = (err as Error).message;
    res.status(message.includes("Stop the server") ? 409 : 400).json({ error: message });
  }
});

serversRouter.delete("/:id/backups/:filename", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await deleteBackup(entry, req.params.filename);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/players", requirePermission("players"), (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  res.json({ players: getCachedPlayers(entry.id) ?? null });
});

serversRouter.post("/:id/players/:name/action", requirePermission("players"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  if (!PLAYER_NAME_RE.test(req.params.name)) {
    res.status(400).json({ error: "Invalid player name" });
    return;
  }
  const buildCommand = PLAYER_ACTION_COMMANDS[String(req.body?.action)];
  if (!buildCommand) {
    res.status(400).json({ error: `Unknown action, expected one of: ${Object.keys(PLAYER_ACTION_COMMANDS).join(", ")}` });
    return;
  }
  if (!(await isServerRunning(entry))) {
    res.status(409).json({ error: "Server is not running" });
    return;
  }
  try {
    await sendCommand(entry, buildCommand(req.params.name));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.use("/:id/files", requirePermission("files"), filesRouter);
