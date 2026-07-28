export interface RconConfig {
  enabled: boolean;
  host: string;
  port: number;
  password: string;
}

export interface ScheduledRestartConfig {
  enabled: boolean;
  // 24h "HH:MM", local time of the machine running the dashboard.
  time: string;
}

export interface ServerEntry {
  id: string;
  name: string;
  folder: string;
  startScript: string;
  screenName: string;
  stopCommand: string;
  rcon: RconConfig;
  scheduledRestart: ScheduledRestartConfig;
  createdAt: string;
  updatedAt: string;
  order: number;
}

export interface ServerEntryInput {
  name: string;
  folder: string;
  startScript: string;
  stopCommand?: string;
  rcon?: Partial<RconConfig>;
  scheduledRestart?: Partial<ScheduledRestartConfig>;
}

export interface ResourceUsage {
  cpuPercent: number;
  memoryMb: number;
}

export interface BackupInfo {
  filename: string;
  size: number;
  createdAt: string;
}

export interface ServerStatus {
  id: string;
  running: boolean;
  players?: {
    online: number;
    max: number;
    names: string[];
  };
}

export interface FileEntryInfo {
  name: string;
  type: "file" | "directory" | "symlink";
  size: number;
  mtime: string;
}

export interface ServerPermissions {
  console: boolean;
  files: boolean;
  players: boolean;
  settings: boolean;
}

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  isAdmin: boolean;
  permissions: Record<string, ServerPermissions>;
  createdAt: string;
  updatedAt: string;
}

export type UserPublic = Omit<UserRecord, "passwordHash">;

export interface UserInput {
  username: string;
  password?: string;
  isAdmin?: boolean;
  permissions?: Record<string, Partial<ServerPermissions>>;
}

export type ServerInstallType = "paper" | "vanilla" | "fabric" | "bungeecord";

export interface ServerInstallInput {
  name: string;
  folder: string;
  type: ServerInstallType;
  version: string;
}
