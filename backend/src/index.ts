import path from "node:path";
import http from "node:http";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env";
import { sessionMiddleware } from "./auth/session-middleware";
import { apiRouter } from "./routes";
import { publicPackRouter } from "./servers/servers.routes";
import { setupConsoleWebSocket } from "./ws/console-ws";
import { startRconPoller } from "./servers/rcon-poller";
import { startRestartScheduler } from "./servers/restart-scheduler";
import { startCrashMonitor } from "./servers/crash-monitor";
import { startResourceHistory } from "./servers/resource-history";
import { startConnectionMonitor } from "./servers/connection-monitor";
import { startReleaseWatcher } from "./app-dist/github-sync";
import { startTimeMachine } from "./servers/world-timeline";
import { startStatsCollector } from "./servers/stats";
import { hasScreen } from "./servers/process-manager";

async function main() {
  // Refusing to start without screen was right when screen was the only way to
  // run a server. There is now a second way - the dashboard owning the process
  // itself - which is what the desktop app uses on Windows, where screen does
  // not exist at all. Absence is reported and carried on with rather than being
  // fatal.
  if (!(await hasScreen())) {
    console.log(
      "A 'screen' nincs telepítve - a szervereket ez a dashboard sajat gyermekfolyamatkent inditja."
    );
  }

  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "5mb" }));
  app.use(sessionMiddleware);
  app.use("/api", apiRouter);
  // Unauthenticated on purpose: Minecraft clients download resource packs
  // themselves and have no dashboard session. See publicPackRouter.
  app.use("/packs", publicPackRouter);

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
  startConnectionMonitor();
  void startReleaseWatcher();
  startTimeMachine();
  startStatsCollector();

  httpServer.listen(env.port, env.host, () => {
    console.log(`mc-dashboard listening on http://localhost:${env.port}`);
  });
}

void main();
