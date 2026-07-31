import { Router } from "express";
import rateLimit from "express-rate-limit";
import { userStore } from "./user-store";
import { requireAuth, userToPublic } from "./auth.middleware";
import { recordAudit } from "../audit/audit-log";

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, try again later." },
});

export const authRouter = Router();

authRouter.post("/login", loginLimiter, (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || !username || typeof password !== "string" || !password) {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }

  const user = userStore.verifyLogin(username, password);
  if (!user) {
    // Recorded here rather than by the generic middleware: req.user is only
    // populated behind requireAuth, which the login route is deliberately not.
    recordAudit({
      actor: username,
      actorId: null,
      action: "Sikertelen bejelentkezés",
      serverId: null,
      serverName: null,
      detail: null,
      ip: req.ip ?? null,
      ok: false,
    });
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ error: "Failed to establish session" });
      return;
    }
    req.session.userId = user.id;
    recordAudit({
      actor: user.username,
      actorId: user.id,
      action: "Bejelentkezés",
      serverId: null,
      serverName: null,
      detail: null,
      ip: req.ip ?? null,
      ok: true,
    });
    res.json({ ok: true, user: userToPublic(user) });
  });
});

authRouter.post("/logout", (req, res) => {
  // Captured before destroy(), which clears the session synchronously.
  const userId = req.session.userId;
  const username = userId ? userStore.get(userId)?.username : undefined;
  req.session.destroy(() => {
    if (username) {
      recordAudit({
        actor: username,
        actorId: userId ?? null,
        action: "Kijelentkezés",
        serverId: null,
        serverName: null,
        detail: null,
        ip: req.ip ?? null,
        ok: true,
      });
    }
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

authRouter.get("/status", (req, res) => {
  const user = req.session.userId ? userStore.get(req.session.userId) : undefined;
  if (!user) {
    res.json({ authenticated: false });
    return;
  }
  res.json({ authenticated: true, user: userToPublic(user) });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: userToPublic(req.user!) });
});
