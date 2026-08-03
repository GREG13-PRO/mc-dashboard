import { Router } from "express";
import multer from "multer";
import {
  publishedBuilds,
  publishedFor,
  saveBuild,
  deleteBuild,
  buildPath,
  AppDistError,
  PLATFORMS,
  type Platform,
} from "./app-dist";

/**
 * The read side is deliberately outside `requireAuth`.
 *
 * An app checks for an update as it starts, before anyone has typed a password
 * - a check that needed a session would only ever run for someone already
 * looking at the dashboard, which is not when an app updates itself. What it
 * exposes is the app that anyone holding the app already has.
 */
export const appDistPublicRouter = Router();
export const appDistAdminRouter = Router();

// Desktop installers run to about 100 MB; the APK is a few tens of kilobytes.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });

/**
 * Kept exactly as it was when the Android app shipped.
 *
 * Phones already running 2.21.0 ask for this path by name, and an app that can
 * no longer find its update is an app that can never be fixed by shipping a
 * new one.
 */
appDistPublicRouter.get("/android", async (_req, res) => {
  const build = await publishedFor("android");
  if (!build) {
    res.status(404).json({ error: "No Android build published" });
    return;
  }
  res.json({ ...build, url: "/api/app/android/download" });
});

appDistPublicRouter.get("/android/download", async (_req, res) => {
  const build = await publishedFor("android");
  if (!build) {
    res.status(404).json({ error: "No Android build published" });
    return;
  }
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  res.download(buildPath(build.filename), build.filename);
});

appDistPublicRouter.get("/manifest", async (_req, res) => {
  res.json({ builds: await publishedBuilds() });
});

appDistPublicRouter.get("/platform/:platform", async (req, res) => {
  const platform = req.params.platform as Platform;
  if (!PLATFORMS.includes(platform)) {
    res.status(400).json({ error: "Unknown platform" });
    return;
  }
  const build = await publishedFor(platform);
  if (!build) {
    res.status(404).json({ error: "Nothing published for this platform" });
    return;
  }
  res.json(build);
});

appDistPublicRouter.get("/download/:filename", async (req, res) => {
  try {
    res.download(buildPath(req.params.filename), req.params.filename);
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

appDistAdminRouter.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "file is required" });
    return;
  }
  try {
    res.status(201).json({ build: await saveBuild(req.file.originalname, req.file.buffer) });
  } catch (err) {
    res.status(err instanceof AppDistError ? 400 : 500).json({ error: (err as Error).message });
  }
});

appDistAdminRouter.delete("/:filename", async (req, res) => {
  try {
    await deleteBuild(req.params.filename);
    res.json({ ok: true });
  } catch (err) {
    res.status(err instanceof AppDistError ? 400 : 500).json({ error: (err as Error).message });
  }
});
