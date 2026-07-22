import type { Request, Response, NextFunction } from "express";
import { userStore } from "./user-store";
import type { ServerPermissions, UserRecord } from "../types";

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRecord;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = req.session.userId;
  const user = userId ? userStore.get(userId) : undefined;
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  req.user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

// Applies to routes with a `:id` param identifying the target server. Admins
// bypass the check; everyone else needs the specific capability granted for
// that exact server.
export function requirePermission(capability: keyof ServerPermissions) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.isAdmin) {
      next();
      return;
    }
    const serverId = req.params.id;
    const granted = req.user?.permissions[serverId]?.[capability];
    if (!granted) {
      res.status(403).json({ error: "You do not have permission to do this" });
      return;
    }
    next();
  };
}

export function userToPublic(user: UserRecord) {
  const { passwordHash, ...rest } = user;
  return rest;
}
