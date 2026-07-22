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
  sessionSecret: required("SESSION_SECRET", "dev-secret-change-me"),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? "",
};

export const paths = {
  serversFile: path.join(env.dataDir, "servers.json"),
};
