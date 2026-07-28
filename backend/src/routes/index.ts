import { Router } from "express";
import { authRouter } from "../auth/auth.routes";
import { usersRouter } from "../auth/users.routes";
import { requireAuth, requireAdmin } from "../auth/auth.middleware";
import { serversRouter } from "../servers/servers.routes";
import { installRouter } from "../servers/install.routes";

export const apiRouter = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/users", requireAuth, requireAdmin, usersRouter);
apiRouter.use("/servers", requireAuth, serversRouter);
apiRouter.use("/install-server", requireAuth, installRouter);
