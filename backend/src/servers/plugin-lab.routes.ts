import { Router } from "express";
import { serverRegistry } from "./registry";
import { detectMinecraftVersion } from "./version-check";
import {
  listProjects,
  saveProject,
  deleteProject,
  compileProject,
  deployProject,
  defaultSource,
  toolchain,
  PluginLabError,
} from "./plugin-lab";

/**
 * Its own router rather than a corner of the servers one: a lab project is not
 * owned by a server. It is written once and tried against whichever server is
 * today's scratch server, and hanging "/lab/..." off "/servers/:id/..." would
 * have left it one route name away from being shadowed by a server id.
 */
export const labRouter = Router();

labRouter.get("/projects", async (_req, res) => {
  res.json({ projects: await listProjects(), toolchain: await toolchain() });
});

labRouter.post("/projects", async (req, res) => {
  const name = String(req.body?.name ?? "");
  try {
    const source = String(req.body?.source ?? "") || defaultSource(name);
    res.status(201).json({ project: await saveProject(name, source) });
  } catch (err) {
    res.status(err instanceof PluginLabError ? 400 : 500).json({ error: (err as Error).message });
  }
});

labRouter.delete("/projects/:name", async (req, res) => {
  try {
    await deleteProject(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(err instanceof PluginLabError ? 400 : 500).json({ error: (err as Error).message });
  }
});

/** The target server decides which Paper API the code is compiled against. */
async function targetVersion(serverId: string): Promise<{ entry: ReturnType<typeof serverRegistry.get>; version: string }> {
  const entry = serverRegistry.get(serverId);
  if (!entry) throw new PluginLabError("Válassz egy szervert.");
  const version = await detectMinecraftVersion(entry);
  if (!version) {
    throw new PluginLabError(
      "A szerver Minecraft-verziója nem ismerhető fel - indítsd el egyszer, hogy a log megmondja."
    );
  }
  return { entry, version };
}

labRouter.post("/projects/:name/compile", async (req, res) => {
  try {
    const { entry, version } = await targetVersion(String(req.body?.serverId ?? ""));
    const result = await compileProject(req.params.name, entry!, version);
    res.json({ ok: result.ok, output: result.output, minecraftVersion: version });
  } catch (err) {
    res.status(err instanceof PluginLabError ? 400 : 500).json({ error: (err as Error).message });
  }
});

labRouter.post("/projects/:name/deploy", async (req, res) => {
  try {
    const { entry, version } = await targetVersion(String(req.body?.serverId ?? ""));
    res.json(await deployProject(req.params.name, entry!, version, req.body?.reload === true));
  } catch (err) {
    res.status(err instanceof PluginLabError ? 400 : 500).json({ error: (err as Error).message });
  }
});
