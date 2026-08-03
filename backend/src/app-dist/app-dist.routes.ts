import { Router } from "express";
import multer from "multer";
import {
  currentAndroidBuild,
  saveAndroidBuild,
  deleteAndroidBuild,
  apkPath,
  AppDistError,
} from "./app-dist";
import { requireAuth, requireAdmin } from "../auth/auth.middleware";

/**
 * The read side is deliberately outside `requireAuth`.
 *
 * The Android app checks for an update as it starts, before anyone has typed a
 * password - a check that needed a session would only ever run for someone
 * already looking at the dashboard, which is not when an app updates itself.
 * What it exposes is the app anyone holding the app already has.
 */
export const appDistPublicRouter = Router();
export const appDistAdminRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

appDistPublicRouter.get("/android", async (_req, res) => {
  const build = await currentAndroidBuild();
  if (!build) {
    res.status(404).json({ error: "No Android build published" });
    return;
  }
  res.json({ ...build, url: `/api/app/android/download` });
});

appDistPublicRouter.get("/android/download", async (_req, res) => {
  const build = await currentAndroidBuild();
  if (!build) {
    res.status(404).json({ error: "No Android build published" });
    return;
  }
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  res.download(apkPath(build.filename), build.filename);
});

appDistAdminRouter.post("/android", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "file is required" });
    return;
  }
  try {
    res.status(201).json({ build: await saveAndroidBuild(req.file.originalname, req.file.buffer) });
  } catch (err) {
    res.status(err instanceof AppDistError ? 400 : 500).json({ error: (err as Error).message });
  }
});

appDistAdminRouter.delete("/android", async (_req, res) => {
  await deleteAndroidBuild();
  res.json({ ok: true });
});

export const appDistGuards = [requireAuth, requireAdmin];
