import { Router } from "express";
import rateLimit from "express-rate-limit";
import { userStore } from "./user-store";
import { requireAuth, userToPublic } from "./auth.middleware";

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
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ error: "Failed to establish session" });
      return;
    }
    req.session.userId = user.id;
    res.json({ ok: true, user: userToPublic(user) });
  });
});

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {
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
