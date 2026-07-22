import type { Request, Response, NextFunction } from "express";

declare module "express-session" {
  interface SessionData {
    authenticated?: boolean;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session.authenticated) {
    next();
    return;
  }
  res.status(401).json({ error: "Not authenticated" });
}

export function isSessionAuthenticated(sessionData: { authenticated?: boolean } | undefined): boolean {
  return Boolean(sessionData?.authenticated);
}
