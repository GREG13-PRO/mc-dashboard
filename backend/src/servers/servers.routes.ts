import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
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
import { readAccessLists, setWhitelistEnforced } from "./access-manager";
import { listArchivedLogs, readArchivedLog, deleteArchivedLog } from "./console-archive";
import { hasLuckPerms, createEditorSession, LuckPermsError } from "./luckperms";
import { runWorldAction, WORLD_ACTIONS, WorldControlError } from "./world-control";
import { detectConflicts, diagnoseLag, recommendJvmFlags, applyJvmScript } from "./performance";
import {
  listMacros,
  saveMacro,
  deleteMacro,
  runMacro,
  startRecording,
  stopRecording,
  isRecording,
  MacroError,
} from "./macros";
import { cloneServer, CloneError } from "./clone";
import { compareWeeks } from "./stats";
import {
  mapInfo,
  regionTile,
  surfaceView,
  clearMapCache,
  MapError,
  MAX_VIEW_SIZE,
  type Dimension,
} from "./map-service";
import { playerPositions } from "./map-players";
import { securityReport } from "./security";
import {
  listWorlds,
  worldSettings,
  createWorld,
  activateWorld,
  deleteWorld,
  WORLD_TYPES,
  WorldError,
} from "./worlds";
import {
  listSchematics,
  saveSchematic,
  deleteSchematic,
  resolveSchematicPath,
  pasteSchematic,
  hasWorldEdit,
  SchematicError,
} from "./schematics";
import { detectMinecraftVersion, checkCompatibility } from "./version-check";
import { announce, release, listFor } from "./presence";
import {
  listPacks,
  savePack,
  deletePack,
  resolvePackPath,
  activateResourcePack,
  clearResourcePack,
  setRequireResourcePack,
  resourcePackStatus,
  ContentError,
  type PackKind,
} from "./content-manager";
import {
  takeSnapshot,
  listSnapshots,
  restoreSnapshot,
  timelineSize,
  deleteTimeline,
  TimelineError,
} from "./world-timeline";
import { getResourceHistory } from "./resource-history";
import {
  searchPlugins,
  listPluginVersions,
  listInstalledPlugins,
  installPlugin,
  deletePlugin,
  detectPlatform,
  getPluginDetails,
} from "./plugin-manager";
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
  ban: (name) => `ban ${name}`,
  pardon: (name) => `pardon ${name}`,
  whitelist_add: (name) => `whitelist add ${name}`,
  whitelist_remove: (name) => `whitelist remove ${name}`,
};

// An IP is not a player name, so it gets its own allowlist rather than being
// squeezed through PLAYER_NAME_RE. IPv4 only - that is all `ban-ip` accepts.
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

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

// Served separately rather than embedded in the server list: that list is
// refreshed every 5s by every open dashboard, and N samples x M servers on
// each of those responses is a lot of payload for data only one view shows.
serversRouter.get("/:id/resource-history", requireAnyPermission, (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  res.json({ history: getResourceHistory(entry.id) });
});

// Gated on "settings": handing someone the LuckPerms editor is handing them
// every permission on the server, which is a heavier grant than the console.
// Resource packs can be large; the same 500MB ceiling as the file manager.
const packUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

function packKind(value: unknown): PackKind {
  if (value !== "resourcepack" && value !== "datapack") {
    throw new ContentError(`Unknown pack kind: ${String(value)}`);
  }
  return value;
}

serversRouter.get("/:id/packs/:kind", requirePermission("files"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    const kind = packKind(req.params.kind);
    res.json({
      packs: await listPacks(entry, kind),
      status: kind === "resourcepack" ? resourcePackStatus(entry) : null,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

serversRouter.post(
  "/:id/packs/:kind",
  requirePermission("files"),
  packUpload.single("file"),
  async (req, res) => {
    const entry = serverRegistry.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }
    try {
      const pack = await savePack(entry, packKind(req.params.kind), req.file.originalname, req.file.buffer);
      res.status(201).json({ pack });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }
);

serversRouter.delete("/:id/packs/:kind/:filename", requirePermission("files"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await deletePack(entry, packKind(req.params.kind), req.params.filename);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Clients fetch resource packs themselves, so this endpoint is what the URL in
// server.properties points at. It is intentionally outside the auth-gated API:
// a joining player has no dashboard session. The path is sandboxed and only
// .zip files under the pack folder can be reached.
export const publicPackRouter = Router();

publicPackRouter.get("/:serverId/:filename", (req, res) => {
  const entry = serverRegistry.get(req.params.serverId);
  if (!entry) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const file = resolvePackPath(entry, "resourcepack", req.params.filename);
    if (!/\.zip$/i.test(file)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.sendFile(file);
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

serversRouter.post("/:id/packs/resourcepack/:filename/activate", requirePermission("files"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  const base = String(req.body?.publicBaseUrl ?? "").trim();
  if (!/^https?:\/\/.+/.test(base)) {
    res.status(400).json({ error: "Adj meg egy elérhető alapcímet (pl. http://a-szerver-ip:3000/packs/<id>)." });
    return;
  }
  try {
    res.json(await activateResourcePack(entry, req.params.filename, base));
  } catch (err) {
    res.status(err instanceof ContentError ? 409 : 500).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/packs/resourcepack/clear", requirePermission("files"), (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  clearResourcePack(entry);
  res.json({ ok: true });
});

serversRouter.post("/:id/packs/resourcepack/require", requirePermission("files"), (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    setRequireResourcePack(entry, Boolean(req.body?.required));
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

const DIMENSIONS = new Set(["overworld", "nether", "end"]);

serversRouter.get("/:id/worlds", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  res.json({
    worlds: await listWorlds(entry),
    settings: worldSettings(entry),
    types: WORLD_TYPES,
    running: await isServerRunning(entry),
  });
});

serversRouter.post("/:id/worlds", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await createWorld(entry, req.body ?? {});
    res.status(201).json({ worlds: await listWorlds(entry), settings: worldSettings(entry) });
  } catch (err) {
    res.status(err instanceof WorldError ? 400 : 500).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/worlds/:name/activate", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await activateWorld(entry, req.params.name);
    res.json({ worlds: await listWorlds(entry), settings: worldSettings(entry) });
  } catch (err) {
    res.status(err instanceof WorldError ? 400 : 500).json({ error: (err as Error).message });
  }
});

serversRouter.delete("/:id/worlds/:name", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await deleteWorld(entry, req.params.name);
    res.json({ worlds: await listWorlds(entry), settings: worldSettings(entry) });
  } catch (err) {
    res.status(err instanceof WorldError ? 400 : 500).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/security", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.json(await securityReport(entry));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/map", requireAnyPermission, async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.json(await mapInfo(entry));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/map/players", requireAnyPermission, async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  res.json({ players: await playerPositions(entry) });
});

serversRouter.get("/:id/map/:dim/view", requireAnyPermission, async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  const dim = req.params.dim;
  const x = Number(req.query.x);
  const z = Number(req.query.z);
  const size = Number(req.query.size ?? MAX_VIEW_SIZE);
  if (!DIMENSIONS.has(dim) || !Number.isInteger(x) || !Number.isInteger(z)) {
    res.status(400).json({ error: "Invalid view request" });
    return;
  }
  try {
    res.json(await surfaceView(entry, dim as Dimension, x, z, size));
  } catch (err) {
    res.status(err instanceof MapError ? 400 : 500).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/map/:dim/:x/:z.png", requireAnyPermission, async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  const dim = req.params.dim;
  const x = Number(req.params.x);
  const z = Number((req.params as Record<string, string>).z);
  if (!DIMENSIONS.has(dim) || !Number.isInteger(x) || !Number.isInteger(z)) {
    res.status(400).json({ error: "Invalid tile request" });
    return;
  }
  try {
    const { png } = await regionTile(entry, dim as Dimension, x, z);
    res.setHeader("Content-Type", "image/png");
    // Revalidated by the client on pan; the tile itself is regenerated only
    // when the region file changes.
    res.setHeader("Cache-Control", "no-cache");
    res.send(png);
  } catch (err) {
    res.status(err instanceof MapError ? 404 : 500).json({ error: (err as Error).message });
  }
});

serversRouter.delete("/:id/map/cache", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  await clearMapCache(entry);
  res.json({ ok: true });
});

serversRouter.get("/:id/schematics", requirePermission("files"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.json({ schematics: await listSchematics(entry), worldEdit: hasWorldEdit(entry) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/schematics", requirePermission("files"), packUpload.single("file"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }
  try {
    res.status(201).json({ schematic: await saveSchematic(entry, req.file.originalname, req.file.buffer) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/schematics/:filename/download", requirePermission("files"), (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.download(resolveSchematicPath(entry, req.params.filename));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

serversRouter.delete("/:id/schematics/:filename", requirePermission("files"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await deleteSchematic(entry, req.params.filename);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/schematics/:filename/paste", requirePermission("files"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    const commands = await pasteSchematic(entry, { filename: req.params.filename, ...(req.body ?? {}) });
    res.json({ ok: true, commands });
  } catch (err) {
    res.status(err instanceof SchematicError ? 409 : 500).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/stats/weekly", requireAnyPermission, async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.json({ comparison: await compareWeeks(entry) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/minecraft-version", requireAnyPermission, async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  res.json({ version: await detectMinecraftVersion(entry) });
});

serversRouter.get("/:id/macros", requirePermission("console"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  res.json({ macros: await listMacros(entry), recording: isRecording(entry) });
});

serversRouter.post("/:id/macros", requirePermission("console"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.status(201).json({ macro: await saveMacro(entry, req.body ?? {}) });
  } catch (err) {
    res.status(err instanceof MacroError ? 400 : 500).json({ error: (err as Error).message });
  }
});

serversRouter.delete("/:id/macros/:macroId", requirePermission("console"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  await deleteMacro(entry, req.params.macroId);
  res.json({ ok: true });
});

serversRouter.post("/:id/macros/:macroId/run", requirePermission("console"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.json({ result: await runMacro(entry, req.params.macroId) });
  } catch (err) {
    res.status(err instanceof MacroError ? 409 : 500).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/macros/record/:state", requirePermission("console"), (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  if (req.params.state === "start") {
    startRecording(entry);
    res.json({ ok: true, recording: true });
    return;
  }
  res.json({ ok: true, recording: false, steps: stopRecording(entry) });
});

serversRouter.post("/:id/clone", requireAdmin, async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  const name = String(req.body?.name ?? "").trim() || `${entry.name} teszt`;
  try {
    res.status(201).json({ server: toPublicEntry(await cloneServer(entry, name)) });
  } catch (err) {
    res.status(err instanceof CloneError ? 409 : 500).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/presence", requireAnyPermission, (req, res) => {
  res.json({ present: listFor(req.params.id, req.user!.id) });
});

serversRouter.post("/:id/presence", requireAnyPermission, (req, res) => {
  const resource = String(req.body?.resource ?? "").slice(0, 200);
  if (req.body?.leaving) release(req.user!.id, req.params.id, resource);
  else if (resource) announce(req.user!.id, req.user!.username, req.params.id, resource);
  res.json({ present: listFor(req.params.id, req.user!.id) });
});

serversRouter.get("/:id/performance/conflicts", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.json({ conflicts: await detectConflicts(entry) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/performance/lag", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.json({ report: await diagnoseLag(entry) });
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/performance/jvm", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  const heap = req.query.heapMb ? Number(req.query.heapMb) : undefined;
  try {
    res.json({ recommendation: await recommendJvmFlags(entry, heap) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/performance/jvm", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await applyJvmScript(entry, String(req.body?.script ?? ""));
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

// Time and weather ride on the "players" capability: they are live moderation
// of a running world, the same kind of act as healing or kicking someone.
serversRouter.post("/:id/world/:action", requirePermission("players"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  if (!WORLD_ACTIONS.includes(req.params.action)) {
    res.status(400).json({ error: `Unknown action, expected one of: ${WORLD_ACTIONS.join(", ")}` });
    return;
  }
  try {
    await runWorldAction(entry, req.params.action);
    res.json({ ok: true });
  } catch (err) {
    res.status(err instanceof WorldControlError ? 409 : 500).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/timeline", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.json({
      config: entry.timeMachine,
      snapshots: await listSnapshots(entry),
      sizeBytes: await timelineSize(entry),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/timeline/snapshot", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.status(201).json({ snapshot: await takeSnapshot(entry) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/timeline/restore", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    const restored = await restoreSnapshot(entry, String(req.body?.id ?? ""));
    res.json({ ok: true, restored });
  } catch (err) {
    res.status(err instanceof TimelineError ? 409 : 500).json({ error: (err as Error).message });
  }
});

serversRouter.delete("/:id/timeline", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await deleteTimeline(entry);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/luckperms", requirePermission("settings"), (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  res.json({ installed: hasLuckPerms(entry) });
});

serversRouter.post("/:id/luckperms/editor", requirePermission("settings"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.json({ url: await createEditorSession(entry) });
  } catch (err) {
    const status = err instanceof LuckPermsError ? 409 : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/console-logs", requirePermission("console"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.json({ logs: await listArchivedLogs(entry) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/console-logs/:filename", requirePermission("console"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.json({ content: await readArchivedLog(entry, req.params.filename) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

serversRouter.delete("/:id/console-logs/:filename", requirePermission("console"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await deleteArchivedLog(entry, req.params.filename);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/access", requirePermission("players"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    res.json({ access: await readAccessLists(entry) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Toggling the whitelist writes server.properties so it also holds while the
// server is stopped, and additionally tells a running server so it takes
// effect without a restart.
serversRouter.post("/:id/access/whitelist-mode", requirePermission("players"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  const enabled = Boolean(req.body?.enabled);
  try {
    setWhitelistEnforced(entry, enabled);
    if (await isServerRunning(entry)) {
      await sendCommand(entry, `whitelist ${enabled ? "on" : "off"}`);
    }
    res.json({ ok: true, enabled });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/access/ip", requirePermission("players"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  const { ip, action } = req.body ?? {};
  if (typeof ip !== "string" || !IPV4_RE.test(ip)) {
    res.status(400).json({ error: "Invalid IP address" });
    return;
  }
  if (action !== "ban" && action !== "pardon") {
    res.status(400).json({ error: "action must be ban or pardon" });
    return;
  }
  if (!(await isServerRunning(entry))) {
    res.status(409).json({ error: "Az IP-tiltáshoz futnia kell a szervernek." });
    return;
  }
  try {
    await sendCommand(entry, action === "ban" ? `ban-ip ${ip}` : `pardon-ip ${ip}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Plugin management is gated on "files" - installing a jar into plugins/ is
// exactly a privileged write into the server folder, so it reuses that
// capability rather than introducing a fifth one.
serversRouter.get("/:id/plugins", requirePermission("files"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    const plugins = await listInstalledPlugins(entry, req.query.checkUpdates === "1");
    res.json({ plugins });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/plugins/search", requirePermission("files"), async (req, res) => {
  const source = String(req.query.source ?? "modrinth");
  if (source !== "modrinth" && source !== "hangar") {
    res.status(400).json({ error: `Unknown plugin source: ${source}` });
    return;
  }
  try {
    const results = await searchPlugins(String(req.query.q ?? ""), source);
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/plugins/versions", requirePermission("files"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  const source = String(req.query.source ?? "modrinth");
  const projectId = String(req.query.projectId ?? "");
  if (source !== "modrinth" && source !== "hangar") {
    res.status(400).json({ error: `Unknown plugin source: ${source}` });
    return;
  }
  if (!projectId) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  try {
    const versions = await listPluginVersions(source, projectId, detectPlatform(entry));
    // Attached here rather than computed in the browser: the server version
    // comes from the console log, which the client cannot read.
    const serverVersion = await detectMinecraftVersion(entry);
    res.json({
      versions: versions.map((v) => ({ ...v, compatibility: checkCompatibility(serverVersion, v.gameVersions) })),
      serverVersion,
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

serversRouter.get("/:id/plugins/details", requirePermission("files"), async (req, res) => {
  const source = String(req.query.source ?? "modrinth");
  const projectId = String(req.query.projectId ?? "");
  if (source !== "modrinth" && source !== "hangar") {
    res.status(400).json({ error: `Unknown plugin source: ${source}` });
    return;
  }
  if (!projectId) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  try {
    res.json({ details: await getPluginDetails(source, projectId) });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

serversRouter.post("/:id/plugins", requirePermission("files"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  const { source, projectId, versionId } = req.body ?? {};
  if ((source !== "modrinth" && source !== "hangar") || !projectId || !versionId) {
    res.status(400).json({ error: "source, projectId and versionId are required" });
    return;
  }
  try {
    const plugin = await installPlugin(entry, source, projectId, versionId);
    res.status(201).json({ plugin });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

serversRouter.delete("/:id/plugins/:filename", requirePermission("files"), async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  try {
    await deletePlugin(entry, req.params.filename);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

serversRouter.use("/:id/files", requirePermission("files"), filesRouter);
