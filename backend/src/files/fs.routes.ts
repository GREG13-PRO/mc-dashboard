import fsp from "node:fs/promises";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import archiver from "archiver";
import { serverRegistry } from "../servers/registry";
import { resolveSafePath, UnsafePathError } from "./safe-path";
import type { FileEntryInfo } from "../types";

const MAX_EDITABLE_BYTES = 2 * 1024 * 1024; // 2 MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

export const filesRouter = Router({ mergeParams: true });

function getEntryOr404(req: Request, res: Response) {
  const entry = serverRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Server not found" });
    return null;
  }
  return entry;
}

function safeOrError(res: Response, root: string, userPath: string): string | null {
  try {
    return resolveSafePath(root, userPath);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      res.status(400).json({ error: err.message });
      return null;
    }
    throw err;
  }
}

filesRouter.get("/", async (req, res) => {
  const entry = getEntryOr404(req, res);
  if (!entry) return;
  const target = safeOrError(res, entry.folder, String(req.query.path ?? ""));
  if (!target) return;

  try {
    const names = await fsp.readdir(target, { withFileTypes: true });
    const items: FileEntryInfo[] = await Promise.all(
      names.map(async (dirent) => {
        const full = path.join(target, dirent.name);
        const stat = await fsp.lstat(full);
        return {
          name: dirent.name,
          type: stat.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "directory" : "file",
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        };
      })
    );
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

filesRouter.get("/content", async (req, res) => {
  const entry = getEntryOr404(req, res);
  if (!entry) return;
  const target = safeOrError(res, entry.folder, String(req.query.path ?? ""));
  if (!target) return;

  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) {
      res.status(400).json({ error: "Not a file" });
      return;
    }
    if (stat.size > MAX_EDITABLE_BYTES) {
      res.status(413).json({ error: "File too large to edit in the browser; download it instead." });
      return;
    }
    const content = await fsp.readFile(target, "utf-8");
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

filesRouter.put("/content", async (req, res) => {
  const entry = getEntryOr404(req, res);
  if (!entry) return;
  const target = safeOrError(res, entry.folder, String(req.query.path ?? ""));
  if (!target) return;

  const { content } = req.body ?? {};
  if (typeof content !== "string") {
    res.status(400).json({ error: "Body must be { content: string }" });
    return;
  }
  if (Buffer.byteLength(content, "utf-8") > MAX_EDITABLE_BYTES) {
    res.status(413).json({ error: "Content exceeds the editable size limit" });
    return;
  }

  try {
    await fsp.writeFile(target, content, "utf-8");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

filesRouter.post("/upload", upload.single("file"), async (req, res) => {
  const entry = getEntryOr404(req, res);
  if (!entry) return;
  const dir = safeOrError(res, entry.folder, String(req.query.path ?? ""));
  if (!dir) return;

  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file uploaded (field name must be 'file')" });
    return;
  }
  const destination = safeOrError(res, entry.folder, path.join(String(req.query.path ?? ""), file.originalname));
  if (!destination) return;

  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(destination, file.buffer);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

filesRouter.get("/download", async (req, res) => {
  const entry = getEntryOr404(req, res);
  if (!entry) return;
  const target = safeOrError(res, entry.folder, String(req.query.path ?? ""));
  if (!target) return;

  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) {
      res.attachment(`${path.basename(target)}.zip`);
      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.pipe(res);
      archive.directory(target, false);
      await archive.finalize();
      return;
    }
    res.download(target);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

filesRouter.delete("/", async (req, res) => {
  const entry = getEntryOr404(req, res);
  if (!entry) return;
  const target = safeOrError(res, entry.folder, String(req.query.path ?? ""));
  if (!target) return;
  if (target === entry.folder) {
    res.status(400).json({ error: "Cannot delete the server's root folder" });
    return;
  }

  try {
    await fsp.rm(target, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

filesRouter.post("/mkdir", async (req, res) => {
  const entry = getEntryOr404(req, res);
  if (!entry) return;
  const { path: relPath } = req.body ?? {};
  const target = safeOrError(res, entry.folder, String(relPath ?? ""));
  if (!target) return;

  try {
    await fsp.mkdir(target, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
