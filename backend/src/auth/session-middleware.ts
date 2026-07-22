import session from "express-session";
import { env } from "../config/env";

// Shared instance: used both as Express middleware and to authenticate the
// raw WebSocket upgrade handshake (native browser WebSocket can't send
// custom auth headers, so we piggyback on the same session cookie).
export const sessionMiddleware = session({
  secret: env.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 12,
  },
});
