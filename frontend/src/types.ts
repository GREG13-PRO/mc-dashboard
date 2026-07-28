export interface RconPublicConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface ScheduledRestartConfig {
  enabled: boolean;
  time: string;
}

export interface ServerEntry {
  id: string;
  name: string;
  folder: string;
  startScript: string;
  screenName: string;
  stopCommand: string;
  rcon: RconPublicConfig;
  scheduledRestart: ScheduledRestartConfig;
  createdAt: string;
  updatedAt: string;
  order: number;
}

export interface PlayersSnapshot {
  online: number;
  max: number;
  names: string[];
  fetchedAt: string;
}

export interface ResourceUsage {
  cpuPercent: number;
  memoryMb: number;
}

export interface ServerWithStatus extends ServerEntry {
  running: boolean;
  players: PlayersSnapshot | null;
  resources: ResourceUsage | null;
}

export interface ServerEntryInput {
  name: string;
  folder: string;
  startScript: string;
  stopCommand?: string;
  rcon?: {
    enabled: boolean;
    host: string;
    port: number;
    password: string;
  };
  scheduledRestart?: {
    enabled: boolean;
    time: string;
  };
}

export interface BackupInfo {
  filename: string;
  size: number;
  createdAt: string;
}

export type PlayerAction = "kill" | "heal" | "feed" | "starve" | "kick";

export const PLAYER_ACTIONS: { action: PlayerAction; label: string }[] = [
  { action: "kill", label: "Ölés" },
  { action: "heal", label: "Gyógyítás" },
  { action: "feed", label: "Etetés" },
  { action: "starve", label: "Éheztetés" },
  { action: "kick", label: "Kirúgás" },
];

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

export interface UserPublic {
  id: string;
  username: string;
  isAdmin: boolean;
  permissions: Record<string, ServerPermissions>;
  createdAt: string;
  updatedAt: string;
}

export interface UserInput {
  username: string;
  password?: string;
  isAdmin?: boolean;
  permissions?: Record<string, Partial<ServerPermissions>>;
}

export type ServerInstallType = "paper" | "vanilla" | "fabric" | "bungeecord";

export interface ServerTypeOption {
  id: ServerInstallType;
  label: string;
}

export interface ServerInstallInput {
  name: string;
  folder: string;
  type: ServerInstallType;
  version: string;
}
