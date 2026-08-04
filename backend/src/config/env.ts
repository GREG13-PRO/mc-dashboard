import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  // Which interface to listen on. Unset keeps the previous behaviour - all of
  // them - because that is what a dashboard on a server host needs. The
  // desktop app sets 127.0.0.1, where the panel is for the person sitting at
  // the machine and putting it on the LAN would be a surprise.
  host: process.env.HOST ?? undefined,
  sessionSecret: required("SESSION_SECRET", "dev-secret-change-me"),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? "",
};

export const paths = {
  serversFile: path.join(env.dataDir, "servers.json"),
  usersFile: path.join(env.dataDir, "auth.json"),
};
