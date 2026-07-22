import { Router } from "express";
import rateLimit from "express-rate-limit";
import { verifyPassword } from "./password";

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, try again later." },
});

export const authRouter = Router();

authRouter.post("/login", loginLimiter, (req, res) => {
  const { password } = req.body ?? {};
  if (typeof password !== "string" || password.length === 0) {
    res.status(400).json({ error: "Password is required" });
    return;
  }

  let valid: boolean;
  try {
    valid = verifyPassword(password);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
    return;
  }

  if (!valid) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ error: "Failed to establish session" });
      return;
    }
    req.session.authenticated = true;
    res.json({ ok: true });
  });
});

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

authRouter.get("/status", (req, res) => {
  res.json({ authenticated: Boolean(req.session.authenticated) });
});
