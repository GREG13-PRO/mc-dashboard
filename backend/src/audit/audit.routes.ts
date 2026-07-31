import { Router } from "express";
import { readAudit } from "./audit-log";
import { computeLeaderboard, describeRules } from "./admin-xp";

export const auditRouter = Router();

// Visible to every signed-in user, not just admins: a scoreboard the team
// cannot see is not much of a motivator. Mounted separately from the log
// itself, which stays admin-only.
export const xpRouter = Router();

xpRouter.get("/", async (_req, res) => {
  try {
    res.json({ leaderboard: await computeLeaderboard(), rules: describeRules() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

auditRouter.get("/", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  try {
    res.json({ entries: await readAudit(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
