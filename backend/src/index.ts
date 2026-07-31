import path from "node:path";
import http from "node:http";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env";
import { sessionMiddleware } from "./auth/session-middleware";
import { apiRouter } from "./routes";
import { setupConsoleWebSocket } from "./ws/console-ws";
import { startRconPoller } from "./servers/rcon-poller";
import { startRestartScheduler } from "./servers/restart-scheduler";
import { startCrashMonitor } from "./servers/crash-monitor";
import { startResourceHistory } from "./servers/resource-history";
import { startTimeMachine } from "./servers/world-timeline";
import { assertScreenInstalled } from "./servers/process-manager";

async function main() {
  try {
    await assertScreenInstalled();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "5mb" }));
  app.use(sessionMiddleware);
  app.use("/api", apiRouter);

  const frontendDist = path.resolve(__dirname, "../../frontend/dist");
  app.use(express.static(frontendDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });

  const httpServer = http.createServer(app);
  setupConsoleWebSocket(httpServer);
  startRconPoller();
  startRestartScheduler();
  startCrashMonitor();
  startResourceHistory();
  startTimeMachine();

  httpServer.listen(env.port, () => {
    console.log(`mc-dashboard listening on http://localhost:${env.port}`);
  });
}

void main();
