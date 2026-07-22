import { Router } from "express";
import { authRouter } from "../auth/auth.routes";
import { requireAuth } from "../auth/auth.middleware";
import { serversRouter } from "../servers/servers.routes";

export const apiRouter = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/servers", requireAuth, serversRouter);
