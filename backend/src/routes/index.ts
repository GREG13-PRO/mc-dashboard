import { Router } from "express";
import { authRouter } from "../auth/auth.routes";
import { usersRouter } from "../auth/users.routes";
import { requireAuth, requireAdmin } from "../auth/auth.middleware";
import { serversRouter } from "../servers/servers.routes";

export const apiRouter = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/users", requireAuth, requireAdmin, usersRouter);
apiRouter.use("/servers", requireAuth, serversRouter);
