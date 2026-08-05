import path from "node:path";
import { Router } from "express";
import { SERVER_TYPES, kindOf, listVersions, installServer } from "./server-installer";
import { writeProperties } from "./properties";
import { serverRegistry, toPublicEntry } from "./registry";
import { suggestDefaults } from "./install-defaults";
import { requireAdmin } from "../auth/auth.middleware";
import type { ServerInstallType } from "../types";

export const installRouter = Router();

const VALID_TYPES = new Set(SERVER_TYPES.map((t) => t.id));

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

/**
 * What to pre-fill the form with. Admin-only because it discloses where this
 * machine keeps its servers and hands out a freshly generated RCON password.
 */
installRouter.get("/defaults", requireAdmin, async (req, res) => {
  const name = String(req.query.name ?? "").trim() || "server";
  res.json(await suggestDefaults(name));
});

installRouter.post("/", requireAdmin, async (req, res) => {
  const { name, folder, type, version, settings, rcon, acceptEula } = req.body ?? {};
  if (!name || !folder || !type) {
    res.status(400).json({ error: "name, folder and type are required" });
    return;
  }
  if (!VALID_TYPES.has(type)) {
    res.status(400).json({ error: `Unknown server type: ${type}` });
    return;
  }
  // A refusal to agree is a bad request, not a server fault. The installer
  // checks this too and that check stays: it is the one that guards the file
  // write, and a second caller could arrive without coming through here.
  if (kindOf(type) !== "proxy" && acceptEula !== true) {
    res.status(400).json({
      error:
        "A Minecraft EULA elfogadása nélkül nem hozható létre szerver. https://aka.ms/MinecraftEULA",
    });
    return;
  }
  try {
    const resolvedFolder = path.resolve(folder);
    const { startScript, stopCommand } = await installServer({
      folder: resolvedFolder,
      type,
      version: version ?? "latest",
      settings,
      acceptEula: acceptEula === true,
    });
    // syncRconToServerProperties, which registry.create calls, deliberately
    // no-ops when there is no server.properties - a proxy has none and never
    // will. So for a real server the file is created here first, or RCON would
    // end up on in servers.json and off in the config the server reads. That
    // exact drift caused two "player list silently does nothing" bugs.
    const wantsRcon = Boolean(rcon?.enabled) && kindOf(type) !== "proxy";
    if (wantsRcon) {
      writeProperties(path.join(resolvedFolder, "server.properties"), {
        "enable-rcon": "true",
        "rcon.port": String(Number(rcon.port) || 25575),
        "rcon.password": String(rcon.password ?? ""),
      });
    }

    // RCON is set up at creation when the caller asked for it. The installer
    // used to leave it off, so a freshly installed server had no player list
    // and no way to run a command that needs a reply - and turning it on later
    // means knowing it exists. registry.create writes it into
    // server.properties too, so the server and the dashboard agree from the
    // first start.
    const entry = serverRegistry.create({
      name,
      folder: resolvedFolder,
      startScript,
      stopCommand,
      ...(wantsRcon
        ? {
            rcon: {
              enabled: true,
              host: "127.0.0.1",
              port: Number(rcon.port) || 25575,
              password: String(rcon.password ?? ""),
            },
          }
        : {}),
    });
    res.status(201).json({ server: toPublicEntry(entry) });
  } catch (err) {
    const message = (err as NodeJS.ErrnoException).code === "EACCES"
      ? `Nincs jogosultság ide írni: ${folder}. A dashboard a "minecraft" felhasználóként fut, ezért olyan mappát adj meg, amit az elér (pl. /home/minecraft/Documents/Server/...).`
      : (err as Error).message;
    res.status(500).json({ error: message });
  }
});
