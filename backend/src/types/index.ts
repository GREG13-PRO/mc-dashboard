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

export interface CrashRestartConfig {
  enabled: boolean;
  // Give up after this many restarts inside the rolling window, so a server
  // that crashes on startup can't be restarted forever.
  maxAttempts: number;
}

export interface TimeMachineConfig {
  enabled: boolean;
  intervalMinutes: number;
  maxSnapshots: number;
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
  crashRestart: CrashRestartConfig;
  timeMachine: TimeMachineConfig;
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
  crashRestart?: Partial<CrashRestartConfig>;
  timeMachine?: Partial<TimeMachineConfig>;
}

export interface ResourceUsage {
  cpuPercent: number;
  memoryMb: number;
  /** Null where /proc is unavailable. */
  uptimeSeconds: number | null;
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

export type ServerInstallType =
  | "paper"
  | "purpur"
  | "vanilla"
  | "fabric"
  | "quilt"
  | "forge"
  | "neoforge"
  | "bungeecord"
  | "velocity";

export interface ServerInstallSettings {
  memoryMb?: number;
  port?: number;
  motd?: string;
  difficulty?: string;
  gamemode?: string;
  maxPlayers?: number;
}

export interface ServerInstallInput {
  name: string;
  folder: string;
  rcon?: { enabled: boolean; port: number; password: string };
  type: ServerInstallType;
  version: string;
  settings?: ServerInstallSettings;
  /**
   * The caller says the person in front of them accepted Mojang's EULA.
   *
   * Required for anything that runs a Minecraft server, because writing
   * `eula=true` is that acceptance and it is not the dashboard's to give. A
   * proxy is not a Minecraft server and has no eula.txt, so it does not ask.
   */
  acceptEula?: boolean;
}
