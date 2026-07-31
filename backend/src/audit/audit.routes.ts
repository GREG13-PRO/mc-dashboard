import { Router } from "express";
import { readAudit } from "./audit-log";

export const auditRouter = Router();

auditRouter.get("/", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  try {
    res.json({ entries: await readAudit(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
