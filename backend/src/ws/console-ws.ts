import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import type { Request, Response } from "express";
import { sessionMiddleware } from "../auth/session-middleware";
import { userStore } from "../auth/user-store";
import { serverRegistry } from "../servers/registry";
import { subscribeConsole } from "../servers/console-stream";
import { isServerRunning, sendCommand } from "../servers/process-manager";
import { recordAudit } from "../audit/audit-log";
import type { ServerEntry, UserRecord } from "../types";

const CONSOLE_PATH_RE = /^\/ws\/console\/([^/]+)$/;

function runSessionMiddleware(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    const fakeRes = {
      getHeader: () => undefined,
      setHeader: () => undefined,
      end: () => undefined,
      writeHead: () => undefined,
      on: () => undefined,
      once: () => undefined,
      emit: () => undefined,
    } as unknown as Response;
    sessionMiddleware(req as Request, fakeRes, (err?: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// The authenticated user is threaded in purely so console commands can be
// attributed in the audit log: these never touch Express, so the generic
// audit middleware cannot see them.
function handleConnection(ws: WebSocket, entry: ServerEntry, user: UserRecord): void {
  let statusTimer: NodeJS.Timeout | null = null;
  let lastRunning: boolean | null = null;

  const pushStatus = async () => {
    const running = await isServerRunning(entry);
    if (running !== lastRunning) {
      lastRunning = running;
      send(ws, { type: "status", running });
    }
  };

  void pushStatus();
  statusTimer = setInterval(() => void pushStatus(), 5000);

  // Attaching via `screen -x` itself delivers a full redraw of the current
  // screen buffer as part of its normal handshake, so there is no need for
  // a separate scrollback/history fetch here - doing both caused the same
  // content to be rendered twice in quick succession.
  const unsubscribe = subscribeConsole(entry, (chunk) => {
    send(ws, { type: "output", data: chunk.toString("base64") });
  });

  ws.on("message", (raw) => {
    void (async () => {
      let msg: { type: string; data?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case "input": {
          if (typeof msg.data === "string") {
            const line = msg.data.replace(/\r?\n$/, "");
            let ok = true;
            await sendCommand(entry, line).catch((err) => {
              ok = false;
              send(ws, { type: "error", message: (err as Error).message });
            });
            recordAudit({
              actor: user.username,
              actorId: user.id,
              action: "Konzolparancs",
              serverId: entry.id,
              serverName: entry.name,
              detail: line,
              ip: null,
              ok,
            });
          }
          break;
        }
      }
    })();
  });

  ws.on("close", () => {
    if (statusTimer) clearInterval(statusTimer);
    unsubscribe();
  });
}

export function setupConsoleWebSocket(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const match = CONSOLE_PATH_RE.exec(url.pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    const serverId = match[1];

    void (async () => {
      try {
        await runSessionMiddleware(req);
      } catch {
        socket.destroy();
        return;
      }

      const userId = (req as unknown as Request).session?.userId;
      const user = userId ? userStore.get(userId) : undefined;
      if (!user) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const entry = serverRegistry.get(serverId);
      if (!entry) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      if (!user.isAdmin && !user.permissions[serverId]?.console) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        handleConnection(ws, entry, user);
      });
    })();
  });
}
