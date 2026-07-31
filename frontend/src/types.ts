export interface RconPublicConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface ScheduledRestartConfig {
  enabled: boolean;
  time: string;
}

export interface CrashRestartConfig {
  enabled: boolean;
  maxAttempts: number;
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
  crashRestart: CrashRestartConfig;
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

export interface ResourceSample {
  at: string;
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
  crashRestart?: {
    enabled: boolean;
    maxAttempts: number;
  };
}

export interface BackupInfo {
  filename: string;
  size: number;
  createdAt: string;
}

export type PlayerAction =
  | "kill"
  | "heal"
  | "feed"
  | "starve"
  | "kick"
  | "ban"
  | "pardon"
  | "whitelist_add"
  | "whitelist_remove";

// Only the in-game moderation verbs; ban/whitelist live in their own tab so
// this row of buttons stays short next to every online player.
export const PLAYER_ACTIONS: { action: PlayerAction; label: string }[] = [
  { action: "kill", label: "Ölés" },
  { action: "heal", label: "Gyógyítás" },
  { action: "feed", label: "Etetés" },
  { action: "starve", label: "Éheztetés" },
  { action: "kick", label: "Kirúgás" },
  { action: "ban", label: "Kitiltás" },
];

export interface AccessEntry {
  name: string;
  uuid: string | null;
  reason: string | null;
  created: string | null;
}

export interface AccessLists {
  whitelist: AccessEntry[];
  bannedPlayers: AccessEntry[];
  bannedIps: AccessEntry[];
  whitelistEnforced: boolean;
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

export interface ServerTypeOption {
  id: ServerInstallType;
  label: string;
  // Proxies (BungeeCord/Velocity) have no server.properties, so the Minecraft
  // world settings are hidden for them.
  kind: "server" | "proxy";
}

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
  type: ServerInstallType;
  version: string;
  settings?: ServerInstallSettings;
}

export type PluginSource = "modrinth" | "hangar";

export interface PluginSearchResult {
  source: PluginSource;
  id: string;
  name: string;
  description: string;
  author: string;
  downloads: number;
  pageUrl: string;
  iconUrl: string | null;
  categories: string[];
}

export interface PluginDetails {
  name: string;
  description: string;
  body: string;
  gallery: string[];
  pageUrl: string;
}

export interface PluginVersionInfo {
  id: string;
  name: string;
  gameVersions: string[];
  loaders: string[];
  filename: string | null;
  downloadUrl: string | null;
  externalUrl: string | null;
  datePublished: string | null;
}

export interface InstalledPlugin {
  filename: string;
  name: string | null;
  version: string | null;
  sizeBytes: number;
  source: PluginSource | null;
  projectId: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
}

export interface AuditRecord {
  at: string;
  actor: string;
  actorId: string | null;
  action: string;
  serverId: string | null;
  serverName: string | null;
  detail: string | null;
  ip: string | null;
  ok: boolean;
}
