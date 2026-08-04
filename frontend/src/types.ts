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

export interface TimeMachineConfig {
  enabled: boolean;
  intervalMinutes: number;
  maxSnapshots: number;
}

export interface TimelineSnapshot {
  id: string;
  at: string;
  fileCount: number;
  addedBytes: number;
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
  timeMachine: TimeMachineConfig;
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
  timeMachine?: {
    enabled: boolean;
    intervalMinutes: number;
    maxSnapshots: number;
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

export interface CompatibilityVerdict {
  serverVersion: string | null;
  compatible: boolean | null;
  message: string | null;
}

export interface PluginVersionInfo {
  id: string;
  name: string;
  gameVersions: string[];
  loaders: string[];
  compatibility?: CompatibilityVerdict;
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

export interface ArchivedLog {
  filename: string;
  endedAt: string;
  sizeBytes: number;
}

export interface PluginConflict {
  severity: "conflict" | "warning";
  plugins: string[];
  message: string;
}

export interface LagReport {
  generatedAt: string;
  raw: string;
  tps: string | null;
  findings: string[];
}

export interface JvmRecommendation {
  hostMemoryMb: number;
  currentScript: string;
  recommendedHeapMb: number;
  flags: string[];
  script: string;
  notes: string[];
}

export type PackKind = "resourcepack" | "datapack";

export interface Pack {
  kind: PackKind;
  filename: string;
  sizeBytes: number;
  uploadedAt: string;
  sha1: string;
  active: boolean;
}

export interface ResourcePackStatus {
  url: string | null;
  sha1: string | null;
  required: boolean;
}

export interface MacroStep {
  command: string;
  delayMs: number;
}

export interface Macro {
  id: string;
  name: string;
  description: string;
  steps: MacroStep[];
  createdAt: string;
  updatedAt: string;
}

export interface PresenceEntry {
  username: string;
  resource: string;
  since: string;
}

export interface WeekSummary {
  peak: number;
  averageOnline: number;
  playtimeMinutes: number;
  upMinutes: number;
  samples: number;
}

export interface WeekComparison {
  thisWeek: WeekSummary;
  lastWeek: WeekSummary;
  peakChange: number | null;
  averageChange: number | null;
  playtimeChange: number | null;
  daily: { date: string; peak: number; playtimeMinutes: number }[];
}

export interface AdminXp {
  username: string;
  points: number;
  level: number;
  progress: number;
  nextLevelAt: number;
  actions: number;
  breakdown: { label: string; points: number; count: number }[];
  lastActiveAt: string | null;
}

export interface Schematic {
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
  size: { x: number; y: number; z: number } | null;
}

export type Dimension = "overworld" | "nether" | "end";

export interface SurfaceView {
  x: number;
  z: number;
  size: number;
  palette: string[];
  /** size*size palette indices, one byte each, base64. */
  colours: string;
  /** size*size heights as signed 16-bit little-endian, base64. */
  heights: string;
}

export interface PlayerPosition {
  name: string;
  x: number;
  z: number;
  dimension: Dimension;
}

export interface MapInfo {
  dimensions: {
    id: Dimension;
    regions: { x: number; z: number }[];
    spawn: { x: number; z: number };
  }[];
}

export type Severity = "critical" | "warning" | "info";

export interface SecurityFinding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  advice: string;
}

export interface SecurityReport {
  generatedAt: string;
  findings: SecurityFinding[];
  loginsChecked: boolean;
}

export type AppPlatform = "android" | "mac-arm64" | "mac-x64" | "windows" | "plugin";

export interface PublishedBuild {
  platform: AppPlatform;
  version: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  url: string;
}

export interface GithubWatcherState {
  enabled: boolean;
  lastCheckedAt: string | null;
  lastResult: string | null;
  publishedVersion: string | null;
}

export interface GithubSyncStatus {
  configured: boolean;
  latest?: { tag: string; version: string; assets: { name: string; sizeBytes: number }[] };
  error?: string;
  watcher: GithubWatcherState;
}

export interface WorldSummary {
  name: string;
  active: boolean;
  sizeBytes: number;
  seed: string | null;
  lastPlayed: string | null;
  hasNether: boolean;
  hasEnd: boolean;
}

export interface WorldSettings {
  levelName: string;
  seed: string;
  type: string;
  generateStructures: boolean;
}

export interface WorldsResponse {
  worlds: WorldSummary[];
  settings: WorldSettings;
  types: string[];
  running: boolean;
}

export interface CreateWorldInput {
  name: string;
  seed?: string;
  type?: string;
  generateStructures?: boolean;
}

export interface DnaImportReport {
  wroteFiles: string[];
  installedPlugins: string[];
  manualPlugins: string[];
  failedPlugins: { filename: string; error: string }[];
}

export interface ConfigSnapshotFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ConfigSnapshot {
  id: string;
  at: string;
  reason: string;
  actor: string | null;
  files: ConfigSnapshotFile[];
}

export interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
}

export interface FileDiff {
  path: string;
  lines: DiffLine[];
  onlyInSnapshot: boolean;
  onlyInCurrent: boolean;
  changed: boolean;
}

export interface ConnectionSample {
  at: string;
  total: number;
  distinctIps: number;
  top: { ip: string; count: number }[];
}

export interface ConnectionAlert {
  at: string;
  serverId: string;
  kind: "per-ip" | "total";
  ip: string | null;
  count: number;
  message: string;
}

export interface IpSighting {
  player: string;
  first: string;
  last: string;
  logins: number;
}

export interface IpSummary {
  ip: string;
  logins: number;
  players: IpSighting[];
  first: string;
  last: string;
}

export interface NetworkReport {
  history: ConnectionSample[];
  alerts: ConnectionAlert[];
  ips: {
    logsRead: number;
    ips: IpSummary[];
    players: { player: string; ips: string[]; logins: number }[];
  };
}

export interface AntiCheatFlag {
  kind: string;
  detail: string;
  at: string;
}

export interface AntiCheatPlayer {
  name: string;
  blocksBroken: number;
  oresMined: number;
  hiddenOres: number;
  valuableOres: number;
  hiddenValuableOres: number;
  maxSpeed: number;
  flags: AntiCheatFlag[];
}

export interface AntiCheatStatus {
  installed: boolean;
  installedVersion: string | null;
  availableVersion: string | null;
  running: boolean;
  generatedAt: string | null;
  players: AntiCheatPlayer[];
}

export interface LabProject {
  name: string;
  source: string;
  updatedAt: string;
}

export interface LabToolchain {
  javac: string | null;
  jar: string | null;
}

export interface LabCompileResult {
  ok: boolean;
  output: string;
  minecraftVersion: string;
}

export interface LabDeployResult {
  installed: string;
  reloadOutput: string | null;
}

export interface LoadTestReport {
  host: string;
  port: number;
  connections: number;
  durationSeconds: number;
  attempted: number;
  succeeded: number;
  failed: number;
  errors: Record<string, number>;
  latencyMs: { min: number; median: number; p95: number; max: number } | null;
}

export type WebhookEvent =
  | "server.started"
  | "server.stopped"
  | "server.crashed"
  | "security.alert"
  | "player.joined"
  | "player.left";

export interface Webhook {
  id: string;
  name: string;
  url: string;
  format: "discord" | "json";
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: string;
}

export interface WebhookDelivery {
  at: string;
  webhookId: string;
  event: WebhookEvent;
  status: number | null;
  ok: boolean;
  durationMs: number;
  error: string | null;
  rateLimit: { limit: string | null; remaining: string | null; resetSeconds: string | null } | null;
}

export interface RateLimitSummary {
  webhookId: string;
  attempts: number;
  failures: number;
  throttled: number;
  lastStatus: number | null;
  lastRemaining: string | null;
  lastResetSeconds: string | null;
  medianMs: number | null;
}

export interface WebhooksResponse {
  webhooks: Webhook[];
  events: WebhookEvent[];
  deliveries: WebhookDelivery[];
  rateLimits: RateLimitSummary[];
}

export interface BundleRestoreReport {
  serverName: string;
  wroteFiles: string[];
  installedPlugins: string[];
  copiedPlugins: string[];
  restoredWorld: string | null;
  failedPlugins: { filename: string; error: string }[];
}

export type PropertyCategory =
  | "gameplay"
  | "world"
  | "players"
  | "network"
  | "performance"
  | "security"
  | "rcon"
  | "resourcepack"
  | "info"
  | "advanced";

export interface PropertyDef {
  key: string;
  category: PropertyCategory;
  type: "bool" | "int" | "string" | "enum";
  options?: string[];
  min?: number;
  max?: number;
  secret?: boolean;
  restart?: boolean;
  /** What Minecraft uses when the key is absent from the file. */
  fallback: string;
}

export interface ServerProperties {
  definitions: PropertyDef[];
  values: Record<string, string>;
  /** Keys present in the file that the schema does not describe. */
  unknown: string[];
}
