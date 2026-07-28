import path from "node:path";
import { Router } from "express";
import { SERVER_TYPES, listVersions, installServer } from "./server-installer";
import { serverRegistry } from "./registry";
import { requireAdmin } from "../auth/auth.middleware";
import type { ServerInstallType } from "../types";

export const installRouter = Router();

const VALID_TYPES = new Set(SERVER_TYPES.map((t) => t.id));

function toPublicEntry(entry: ReturnType<typeof serverRegistry.get>) {
  if (!entry) return entry;
  const { rcon, ...rest } = entry;
  return { ...rest, rcon: { enabled: rcon.enabled, host: rcon.host, port: rcon.port } };
}

installRouter.get("/types", (_req, res) => {
  res.json({ types: SERVER_TYPES });
});

installRouter.get("/types/:type/versions", async (req, res) => {
  const type = req.params.type as ServerInstallType;
  if (!VALID_TYPES.has(type)) {
    res.status(400).json({ error: `Unknown server type: ${type}` });
    return;
  }
  try {
    const versions = await listVersions(type);
    res.json({ versions });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

installRouter.post("/", requireAdmin, async (req, res) => {
  const { name, folder, type, version } = req.body ?? {};
  if (!name || !folder || !type) {
    res.status(400).json({ error: "name, folder and type are required" });
    return;
  }
  if (!VALID_TYPES.has(type)) {
    res.status(400).json({ error: `Unknown server type: ${type}` });
    return;
  }
  try {
    const resolvedFolder = path.resolve(folder);
    const { startScript, stopCommand } = await installServer({
      folder: resolvedFolder,
      type,
      version: version ?? "latest",
    });
    const entry = serverRegistry.create({ name, folder: resolvedFolder, startScript, stopCommand });
    res.status(201).json({ server: toPublicEntry(entry) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
