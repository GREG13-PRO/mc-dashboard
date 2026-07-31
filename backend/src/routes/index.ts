import { Router } from "express";
import { authRouter } from "../auth/auth.routes";
import { usersRouter } from "../auth/users.routes";
import { requireAuth, requireAdmin } from "../auth/auth.middleware";
import { serversRouter } from "../servers/servers.routes";
import { installRouter } from "../servers/install.routes";
import { auditRouter, xpRouter } from "../audit/audit.routes";
import { auditMiddleware } from "../audit/audit.middleware";

export const apiRouter = Router();

// Sits ahead of every route so any mutating call is recorded, including ones
// added later - it keys off the HTTP method, not a per-feature opt-in.
apiRouter.use(auditMiddleware);

apiRouter.use("/auth", authRouter);
apiRouter.use("/users", requireAuth, requireAdmin, usersRouter);
apiRouter.use("/servers", requireAuth, serversRouter);
apiRouter.use("/install-server", requireAuth, installRouter);
apiRouter.use("/audit", requireAuth, requireAdmin, auditRouter);
apiRouter.use("/admin-xp", requireAuth, xpRouter);
