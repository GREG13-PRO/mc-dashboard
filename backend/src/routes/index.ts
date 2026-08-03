import { Router } from "express";
import { authRouter } from "../auth/auth.routes";
import { usersRouter } from "../auth/users.routes";
import { requireAuth, requireAdmin } from "../auth/auth.middleware";
import { serversRouter } from "../servers/servers.routes";
import { installRouter } from "../servers/install.routes";
import { auditRouter, xpRouter } from "../audit/audit.routes";
import { auditMiddleware } from "../audit/audit.middleware";
import { appDistPublicRouter, appDistAdminRouter } from "../app-dist/app-dist.routes";
import { labRouter } from "../servers/plugin-lab.routes";
import { webhooksRouter } from "../webhooks/webhooks.routes";

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

// An app's update check runs before anyone has logged in, so the read side is
// public and only publishing a build needs an admin.
apiRouter.use("/app", appDistPublicRouter);
apiRouter.use("/app", requireAuth, requireAdmin, appDistAdminRouter);
apiRouter.use("/lab", requireAuth, requireAdmin, labRouter);
apiRouter.use("/webhooks", requireAuth, requireAdmin, webhooksRouter);
