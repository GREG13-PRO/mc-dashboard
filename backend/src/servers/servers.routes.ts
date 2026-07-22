import { Router } from "express";
import { serverRegistry } from "./registry";
import { startServer, stopServer, restartServer, isServerRunning, sendCommand } from "./process-manager";
import { getCachedPlayers } from "./rcon-poller";
import { filesRouter } from "../files/fs.routes";
import type { ServerEntryInput } from "../types";

export const serversRouter = Router();

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

function toPublicEntry(entry: ReturnType<typeof serverRegistry.get>) {
  if (!entry) return entry;
  // Never send the RCON password back to the client.
  const { rcon, ...rest } = entry;
  return { ...rest, rcon: { enabled: rcon.enabled, host: rcon.host, port: rcon.port } };
}

serversRouter.get("/", async (_req, res) => {
  const entries = serverRegistry.list();
  const withStatus = await Promise.all(
    entries.map(async (entry) => ({
      ...toPublicEntry(entry),
      running: await isServerRunning(entry),
      players: getCachedPlayers(entry.id) ?? null,
    }))
  );
  res.json({ servers: withStatus });
});

serversRouter.post("/", (req, res) => {
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

serversRouter.get("/:id", async (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  res.json({
    server: toPublicEntry(entry),
    running: await isServerRunning(entry),
    players: getCachedPlayers(entry.id) ?? null,
  });
});

serversRouter.put("/:id", (req, res) => {
  try {
    const entry = serverRegistry.update(req.params.id, req.body as Partial<ServerEntryInput>);
    res.json({ server: toPublicEntry(entry) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

serversRouter.delete("/:id", async (req, res) => {
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

serversRouter.post("/:id/start", async (req, res) => {
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

serversRouter.post("/:id/stop", async (req, res) => {
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

serversRouter.post("/:id/restart", async (req, res) => {
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

serversRouter.get("/:id/players", (req, res) => {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  res.json({ players: getCachedPlayers(entry.id) ?? null });
});

serversRouter.post("/:id/players/:name/action", async (req, res) => {
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

serversRouter.use("/:id/files", filesRouter);
