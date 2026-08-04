import type {
  AccessLists,
  AdminXp,
  ArchivedLog,
  AuditRecord,
  BackupInfo,
  FileEntryInfo,
  InstalledPlugin,
  PlayerAction,
  PluginSearchResult,
  PluginSource,
  PluginDetails,
  PluginVersionInfo,
  ResourceSample,
  ServerEntryInput,
  ServerInstallInput,
  ServerTypeOption,
  ServerInstallType,
  JvmRecommendation,
  LagReport,
  Macro,
  MapInfo,
  PlayerPosition,
  SurfaceView,
  SecurityReport,
  PublishedBuild,
  GithubSyncStatus,
  WorldsResponse,
  CreateWorldInput,
  DnaImportReport,
  BundleRestoreReport,
  ConfigSnapshot,
  FileDiff,
  NetworkReport,
  AntiCheatStatus,
  LabProject,
  LabToolchain,
  LabCompileResult,
  LabDeployResult,
  LoadTestReport,
  Webhook,
  WebhooksResponse,
  MacroStep,
  Pack,
  PackKind,
  PluginConflict,
  PresenceEntry,
  ResourcePackStatus,
  Schematic,
  ServerWithStatus,
  TimeMachineConfig,
  TimelineSnapshot,
  WeekComparison,
  UserInput,
  UserPublic,
  ServerProperties,
  ServerMotd,
  GameRuleState,
  Schedule,
} from "./types";

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  async login(username: string, password: string): Promise<{ user: UserPublic }> {
    return request("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  },
  async logout(): Promise<void> {
    await request("/auth/logout", { method: "POST" });
  },
  async authStatus(): Promise<{ authenticated: boolean; user?: UserPublic }> {
    return request("/auth/status");
  },

  async listUsers(): Promise<UserPublic[]> {
    const { users } = await request<{ users: UserPublic[] }>("/users");
    return users;
  },
  async createUser(input: UserInput): Promise<UserPublic> {
    const { user } = await request<{ user: UserPublic }>("/users", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return user;
  },
  async updateUser(id: string, input: Partial<UserInput>): Promise<UserPublic> {
    const { user } = await request<{ user: UserPublic }>(`/users/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    return user;
  },
  async deleteUser(id: string): Promise<void> {
    await request(`/users/${id}`, { method: "DELETE" });
  },

  async listServers(): Promise<ServerWithStatus[]> {
    const { servers } = await request<{ servers: ServerWithStatus[] }>("/servers");
    return servers;
  },
  async getServer(id: string): Promise<ServerWithStatus> {
    const { server, running, players, resources } = await request<{
      server: ServerWithStatus;
      running: boolean;
      players: ServerWithStatus["players"];
      resources: ServerWithStatus["resources"];
    }>(`/servers/${id}`);
    return { ...server, running, players, resources };
  },
  async createServer(input: ServerEntryInput): Promise<ServerWithStatus> {
    const { server } = await request<{ server: ServerWithStatus }>("/servers", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return server;
  },
  async updateServer(id: string, input: Partial<ServerEntryInput>): Promise<ServerWithStatus> {
    const { server } = await request<{ server: ServerWithStatus }>(`/servers/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    return server;
  },
  async deleteServer(id: string): Promise<void> {
    await request(`/servers/${id}`, { method: "DELETE" });
  },
  async startServer(id: string): Promise<void> {
    await request(`/servers/${id}/start`, { method: "POST" });
  },
  async stopServer(id: string): Promise<void> {
    await request(`/servers/${id}/stop`, { method: "POST" });
  },
  async restartServer(id: string): Promise<void> {
    await request(`/servers/${id}/restart`, { method: "POST" });
  },
  async killServer(id: string): Promise<void> {
    await request(`/servers/${id}/kill`, { method: "POST" });
  },

  async listBackups(serverId: string): Promise<BackupInfo[]> {
    const { backups } = await request<{ backups: BackupInfo[] }>(`/servers/${serverId}/backups`);
    return backups;
  },
  async createBackup(serverId: string): Promise<BackupInfo> {
    const { backup } = await request<{ backup: BackupInfo }>(`/servers/${serverId}/backups`, { method: "POST" });
    return backup;
  },
  async restoreBackup(serverId: string, filename: string): Promise<void> {
    await request(`/servers/${serverId}/backups/${encodeURIComponent(filename)}/restore`, { method: "POST" });
  },
  async deleteBackup(serverId: string, filename: string): Promise<void> {
    await request(`/servers/${serverId}/backups/${encodeURIComponent(filename)}`, { method: "DELETE" });
  },
  backupDownloadUrl(serverId: string, filename: string): string {
    return `/api/servers/${serverId}/backups/${encodeURIComponent(filename)}/download`;
  },
  async playerAction(serverId: string, playerName: string, action: PlayerAction): Promise<void> {
    await request(`/servers/${serverId}/players/${encodeURIComponent(playerName)}/action`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
  },

  async listFiles(serverId: string, dirPath: string): Promise<FileEntryInfo[]> {
    const { items } = await request<{ items: FileEntryInfo[] }>(
      `/servers/${serverId}/files?path=${encodeURIComponent(dirPath)}`
    );
    return items;
  },
  async readFile(serverId: string, filePath: string): Promise<string> {
    const { content } = await request<{ content: string }>(
      `/servers/${serverId}/files/content?path=${encodeURIComponent(filePath)}`
    );
    return content;
  },
  async writeFile(serverId: string, filePath: string, content: string): Promise<void> {
    await request(`/servers/${serverId}/files/content?path=${encodeURIComponent(filePath)}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    });
  },
  async deleteFile(serverId: string, filePath: string): Promise<void> {
    await request(`/servers/${serverId}/files?path=${encodeURIComponent(filePath)}`, { method: "DELETE" });
  },
  async mkdir(serverId: string, dirPath: string): Promise<void> {
    await request(`/servers/${serverId}/files/mkdir`, { method: "POST", body: JSON.stringify({ path: dirPath }) });
  },
  async uploadFile(serverId: string, dirPath: string, file: File): Promise<void> {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/servers/${serverId}/files/upload?path=${encodeURIComponent(dirPath)}`, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, body.error ?? res.statusText);
    }
  },
  downloadUrl(serverId: string, filePath: string): string {
    return `/api/servers/${serverId}/files/download?path=${encodeURIComponent(filePath)}`;
  },

  async listServerTypes(): Promise<ServerTypeOption[]> {
    const { types } = await request<{ types: ServerTypeOption[] }>("/install-server/types");
    return types;
  },
  async listServerVersions(type: ServerInstallType): Promise<string[]> {
    const { versions } = await request<{ versions: string[] }>(`/install-server/types/${type}/versions`);
    return versions;
  },
  async installServer(input: ServerInstallInput): Promise<ServerWithStatus> {
    const { server } = await request<{ server: ServerWithStatus }>("/install-server", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return server;
  },

  async getAdminXp(): Promise<{ leaderboard: AdminXp[]; rules: { label: string; points: number }[] }> {
    return request("/admin-xp");
  },
  async listAudit(limit = 200): Promise<AuditRecord[]> {
    const { entries } = await request<{ entries: AuditRecord[] }>(`/audit?limit=${limit}`);
    return entries;
  },

  async getResourceHistory(serverId: string): Promise<ResourceSample[]> {
    const { history } = await request<{ history: ResourceSample[] }>(`/servers/${serverId}/resource-history`);
    return history;
  },

  async listConsoleLogs(serverId: string): Promise<ArchivedLog[]> {
    const { logs } = await request<{ logs: ArchivedLog[] }>(`/servers/${serverId}/console-logs`);
    return logs;
  },
  async readConsoleLog(serverId: string, filename: string): Promise<string> {
    const { content } = await request<{ content: string }>(
      `/servers/${serverId}/console-logs/${encodeURIComponent(filename)}`
    );
    return content;
  },
  async deleteConsoleLog(serverId: string, filename: string): Promise<void> {
    await request(`/servers/${serverId}/console-logs/${encodeURIComponent(filename)}`, { method: "DELETE" });
  },

  async getWeeklyStats(serverId: string): Promise<WeekComparison> {
    const { comparison } = await request<{ comparison: WeekComparison }>(`/servers/${serverId}/stats/weekly`);
    return comparison;
  },
  async getMinecraftVersion(serverId: string): Promise<string | null> {
    const { version } = await request<{ version: string | null }>(`/servers/${serverId}/minecraft-version`);
    return version;
  },

  async listMacros(serverId: string): Promise<{ macros: Macro[]; recording: boolean }> {
    return request(`/servers/${serverId}/macros`);
  },
  async saveMacro(
    serverId: string,
    input: { id?: string; name: string; description?: string; steps: MacroStep[] }
  ): Promise<Macro> {
    const { macro } = await request<{ macro: Macro }>(`/servers/${serverId}/macros`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return macro;
  },
  async deleteMacro(serverId: string, macroId: string): Promise<void> {
    await request(`/servers/${serverId}/macros/${macroId}`, { method: "DELETE" });
  },
  async runMacro(serverId: string, macroId: string): Promise<{ executed: number; skipped: string[] }> {
    const { result } = await request<{ result: { executed: number; skipped: string[] } }>(
      `/servers/${serverId}/macros/${macroId}/run`,
      { method: "POST" }
    );
    return result;
  },
  async setMacroRecording(
    serverId: string,
    state: "start" | "stop"
  ): Promise<{ recording: boolean; steps?: MacroStep[] }> {
    return request(`/servers/${serverId}/macros/record/${state}`, { method: "POST" });
  },
  async cloneServer(serverId: string, name: string): Promise<ServerWithStatus> {
    const { server } = await request<{ server: ServerWithStatus }>(`/servers/${serverId}/clone`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return server;
  },
  async announcePresence(serverId: string, resource: string, leaving = false): Promise<PresenceEntry[]> {
    const { present } = await request<{ present: PresenceEntry[] }>(`/servers/${serverId}/presence`, {
      method: "POST",
      body: JSON.stringify({ resource, leaving }),
    });
    return present;
  },

  async listPublishedBuilds(): Promise<PublishedBuild[]> {
    const { builds } = await request<{ builds: PublishedBuild[] }>("/app/manifest");
    return builds;
  },
  async uploadBuild(file: File): Promise<PublishedBuild> {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/app", {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, body.error ?? res.statusText);
    }
    const { build } = await res.json();
    return build as PublishedBuild;
  },
  async deleteBuild(filename: string): Promise<void> {
    await request(`/app/${encodeURIComponent(filename)}`, { method: "DELETE" });
  },
  async githubStatus(): Promise<GithubSyncStatus> {
    return request("/app/github/status");
  },
  async setGithubToken(token: string): Promise<void> {
    await request("/app/github/token", { method: "PUT", body: JSON.stringify({ token }) });
  },
  async clearGithubToken(): Promise<void> {
    await request("/app/github/token", { method: "DELETE" });
  },
  async setGithubWatch(enabled: boolean): Promise<void> {
    await request("/app/github/watch", { method: "PUT", body: JSON.stringify({ enabled }) });
  },
  async checkGithubNow(): Promise<void> {
    await request("/app/github/check", { method: "POST" });
  },
  async syncFromGithub(): Promise<PublishedBuild[]> {
    const { builds } = await request<{ builds: PublishedBuild[] }>("/app/github/sync", {
      method: "POST",
    });
    return builds;
  },

  async listConfigSnapshots(serverId: string): Promise<ConfigSnapshot[]> {
    const { snapshots } = await request<{ snapshots: ConfigSnapshot[] }>(
      `/servers/${serverId}/config-history`
    );
    return snapshots;
  },
  async takeConfigSnapshot(
    serverId: string
  ): Promise<{ snapshots: ConfigSnapshot[]; unchanged: boolean }> {
    return request(`/servers/${serverId}/config-history`, { method: "POST" });
  },
  async diffConfigSnapshot(serverId: string, snapshotId: string): Promise<FileDiff[]> {
    const { diffs } = await request<{ diffs: FileDiff[] }>(
      `/servers/${serverId}/config-history/${snapshotId}/diff`
    );
    return diffs;
  },
  async restoreConfigSnapshot(
    serverId: string,
    snapshotId: string,
    only?: string[]
  ): Promise<string[]> {
    const { restored } = await request<{ restored: string[] }>(
      `/servers/${serverId}/config-history/${snapshotId}/restore`,
      { method: "POST", body: JSON.stringify({ only: only ?? null }) }
    );
    return restored;
  },

  bundleDownloadUrl(serverId: string, includeWorld: boolean, includeSecrets: boolean): string {
    const params = new URLSearchParams();
    if (!includeWorld) params.set("world", "0");
    if (includeSecrets) params.set("secrets", "1");
    const query = params.toString();
    return `/api/servers/${serverId}/bundle${query ? `?${query}` : ""}`;
  },
  async restoreBundle(serverId: string, file: File): Promise<BundleRestoreReport> {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/servers/${serverId}/bundle`, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, body.error ?? res.statusText);
    }
    const { report } = await res.json();
    return report as BundleRestoreReport;
  },

  dnaDownloadUrl(serverId: string, includeSecrets: boolean): string {
    return `/api/servers/${serverId}/dna${includeSecrets ? "?secrets=1" : ""}`;
  },
  async importDna(
    serverId: string,
    dna: unknown,
    options: { plugins: boolean; access: boolean }
  ): Promise<DnaImportReport> {
    const { report } = await request<{ report: DnaImportReport }>(`/servers/${serverId}/dna`, {
      method: "POST",
      body: JSON.stringify({ dna, ...options }),
    });
    return report;
  },

  async listWorlds(serverId: string): Promise<WorldsResponse> {
    return request(`/servers/${serverId}/worlds`);
  },
  async createWorld(serverId: string, input: CreateWorldInput): Promise<void> {
    await request(`/servers/${serverId}/worlds`, { method: "POST", body: JSON.stringify(input) });
  },
  async activateWorld(serverId: string, name: string): Promise<void> {
    await request(`/servers/${serverId}/worlds/${encodeURIComponent(name)}/activate`, {
      method: "POST",
    });
  },
  async deleteWorld(serverId: string, name: string): Promise<void> {
    await request(`/servers/${serverId}/worlds/${encodeURIComponent(name)}`, { method: "DELETE" });
  },

  async listLabProjects(): Promise<{ projects: LabProject[]; toolchain: LabToolchain }> {
    return request("/lab/projects");
  },
  async saveLabProject(name: string, source?: string): Promise<LabProject> {
    const { project } = await request<{ project: LabProject }>("/lab/projects", {
      method: "POST",
      body: JSON.stringify({ name, source }),
    });
    return project;
  },
  async deleteLabProject(name: string): Promise<void> {
    await request(`/lab/projects/${encodeURIComponent(name)}`, { method: "DELETE" });
  },
  async compileLabProject(name: string, serverId: string): Promise<LabCompileResult> {
    return request(`/lab/projects/${encodeURIComponent(name)}/compile`, {
      method: "POST",
      body: JSON.stringify({ serverId }),
    });
  },
  async deployLabProject(
    name: string,
    serverId: string,
    reload: boolean
  ): Promise<LabDeployResult> {
    return request(`/lab/projects/${encodeURIComponent(name)}/deploy`, {
      method: "POST",
      body: JSON.stringify({ serverId, reload }),
    });
  },

  async listWebhooks(): Promise<WebhooksResponse> {
    return request("/webhooks");
  },
  async saveWebhook(input: Partial<Webhook> & { url: string }): Promise<Webhook> {
    const { webhook } = await request<{ webhook: Webhook }>("/webhooks", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return webhook;
  },
  async deleteWebhook(id: string): Promise<void> {
    await request(`/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  async testWebhook(id: string): Promise<void> {
    await request(`/webhooks/${encodeURIComponent(id)}/test`, { method: "POST" });
  },

  async runLoadTest(
    serverId: string,
    connections: number,
    durationSeconds: number
  ): Promise<LoadTestReport> {
    return request(`/servers/${serverId}/load-test`, {
      method: "POST",
      body: JSON.stringify({ connections, durationSeconds }),
    });
  },

  async getAntiCheat(serverId: string): Promise<AntiCheatStatus> {
    return request(`/servers/${serverId}/anticheat`);
  },
  async installAntiCheat(serverId: string): Promise<AntiCheatStatus> {
    const { status } = await request<{ status: AntiCheatStatus }>(`/servers/${serverId}/anticheat`, {
      method: "POST",
    });
    return status;
  },
  async removeAntiCheat(serverId: string): Promise<AntiCheatStatus> {
    const { status } = await request<{ status: AntiCheatStatus }>(`/servers/${serverId}/anticheat`, {
      method: "DELETE",
    });
    return status;
  },

  async getNetworkReport(serverId: string): Promise<NetworkReport> {
    return request(`/servers/${serverId}/network`);
  },

  async getSecurityReport(serverId: string): Promise<SecurityReport> {
    return request(`/servers/${serverId}/security`);
  },

  async getMapInfo(serverId: string): Promise<MapInfo> {
    return request(`/servers/${serverId}/map`);
  },
  async getMapPlayers(serverId: string): Promise<PlayerPosition[]> {
    const { players } = await request<{ players: PlayerPosition[] }>(`/servers/${serverId}/map/players`);
    return players;
  },
  async getSurfaceView(
    serverId: string,
    dimension: string,
    x: number,
    z: number,
    size: number
  ): Promise<SurfaceView> {
    return request(`/servers/${serverId}/map/${dimension}/view?x=${x}&z=${z}&size=${size}`);
  },
  async clearMapCache(serverId: string): Promise<void> {
    await request(`/servers/${serverId}/map/cache`, { method: "DELETE" });
  },

  async listSchematics(serverId: string): Promise<{ schematics: Schematic[]; worldEdit: boolean }> {
    return request(`/servers/${serverId}/schematics`);
  },
  async uploadSchematic(serverId: string, file: File): Promise<void> {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/servers/${serverId}/schematics`, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, body.error ?? res.statusText);
    }
  },
  async deleteSchematic(serverId: string, filename: string): Promise<void> {
    await request(`/servers/${serverId}/schematics/${encodeURIComponent(filename)}`, { method: "DELETE" });
  },
  schematicDownloadUrl(serverId: string, filename: string): string {
    return `/api/servers/${serverId}/schematics/${encodeURIComponent(filename)}/download`;
  },
  async pasteSchematic(
    serverId: string,
    filename: string,
    options: { player?: string; x?: string; y?: string; z?: string; world?: string; ignoreAir?: boolean }
  ): Promise<string[]> {
    const { commands } = await request<{ commands: string[] }>(
      `/servers/${serverId}/schematics/${encodeURIComponent(filename)}/paste`,
      { method: "POST", body: JSON.stringify(options) }
    );
    return commands;
  },

  async listPacks(
    serverId: string,
    kind: PackKind
  ): Promise<{ packs: Pack[]; status: ResourcePackStatus | null }> {
    return request(`/servers/${serverId}/packs/${kind}`);
  },
  async uploadPack(serverId: string, kind: PackKind, file: File): Promise<void> {
    const form = new FormData();
    form.append("file", file);
    // Multipart, so it bypasses request() the same way file uploads do.
    const res = await fetch(`/api/servers/${serverId}/packs/${kind}`, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, body.error ?? res.statusText);
    }
  },
  async deletePack(serverId: string, kind: PackKind, filename: string): Promise<void> {
    await request(`/servers/${serverId}/packs/${kind}/${encodeURIComponent(filename)}`, { method: "DELETE" });
  },
  async activateResourcePack(
    serverId: string,
    filename: string,
    publicBaseUrl: string
  ): Promise<{ url: string; sha1: string }> {
    return request(`/servers/${serverId}/packs/resourcepack/${encodeURIComponent(filename)}/activate`, {
      method: "POST",
      body: JSON.stringify({ publicBaseUrl }),
    });
  },
  async clearResourcePack(serverId: string): Promise<void> {
    await request(`/servers/${serverId}/packs/resourcepack/clear`, { method: "POST" });
  },
  async setRequireResourcePack(serverId: string, required: boolean): Promise<void> {
    await request(`/servers/${serverId}/packs/resourcepack/require`, {
      method: "POST",
      body: JSON.stringify({ required }),
    });
  },

  async getPluginConflicts(serverId: string): Promise<PluginConflict[]> {
    const { conflicts } = await request<{ conflicts: PluginConflict[] }>(
      `/servers/${serverId}/performance/conflicts`
    );
    return conflicts;
  },
  async diagnoseLag(serverId: string): Promise<LagReport> {
    const { report } = await request<{ report: LagReport }>(`/servers/${serverId}/performance/lag`, {
      method: "POST",
    });
    return report;
  },
  async getJvmRecommendation(serverId: string, heapMb?: number): Promise<JvmRecommendation> {
    const { recommendation } = await request<{ recommendation: JvmRecommendation }>(
      `/servers/${serverId}/performance/jvm${heapMb ? `?heapMb=${heapMb}` : ""}`
    );
    return recommendation;
  },
  async applyJvmScript(serverId: string, script: string): Promise<void> {
    await request(`/servers/${serverId}/performance/jvm`, { method: "POST", body: JSON.stringify({ script }) });
  },

  async worldAction(serverId: string, action: string): Promise<void> {
    await request(`/servers/${serverId}/world/${action}`, { method: "POST" });
  },

  async getTimeline(
    serverId: string
  ): Promise<{ config: TimeMachineConfig; snapshots: TimelineSnapshot[]; sizeBytes: number }> {
    return request(`/servers/${serverId}/timeline`);
  },
  async takeSnapshot(serverId: string): Promise<TimelineSnapshot> {
    const { snapshot } = await request<{ snapshot: TimelineSnapshot }>(
      `/servers/${serverId}/timeline/snapshot`,
      { method: "POST" }
    );
    return snapshot;
  },
  async restoreSnapshot(serverId: string, id: string): Promise<number> {
    const { restored } = await request<{ restored: number }>(`/servers/${serverId}/timeline/restore`, {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    return restored;
  },
  async clearTimeline(serverId: string): Promise<void> {
    await request(`/servers/${serverId}/timeline`, { method: "DELETE" });
  },

  async getLuckPermsStatus(serverId: string): Promise<boolean> {
    const { installed } = await request<{ installed: boolean }>(`/servers/${serverId}/luckperms`);
    return installed;
  },
  async createLuckPermsEditor(serverId: string): Promise<string> {
    const { url } = await request<{ url: string }>(`/servers/${serverId}/luckperms/editor`, { method: "POST" });
    return url;
  },

  async getAccessLists(serverId: string): Promise<AccessLists> {
    const { access } = await request<{ access: AccessLists }>(`/servers/${serverId}/access`);
    return access;
  },
  async setWhitelistMode(serverId: string, enabled: boolean): Promise<void> {
    await request(`/servers/${serverId}/access/whitelist-mode`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
  },
  async ipAction(serverId: string, ip: string, action: "ban" | "pardon"): Promise<void> {
    await request(`/servers/${serverId}/access/ip`, { method: "POST", body: JSON.stringify({ ip, action }) });
  },

  async listPlugins(serverId: string, checkUpdates = false): Promise<InstalledPlugin[]> {
    const { plugins } = await request<{ plugins: InstalledPlugin[] }>(
      `/servers/${serverId}/plugins${checkUpdates ? "?checkUpdates=1" : ""}`
    );
    return plugins;
  },
  async searchPlugins(serverId: string, query: string, source: PluginSource): Promise<PluginSearchResult[]> {
    const { results } = await request<{ results: PluginSearchResult[] }>(
      `/servers/${serverId}/plugins/search?q=${encodeURIComponent(query)}&source=${source}`
    );
    return results;
  },
  async getPluginDetails(serverId: string, source: PluginSource, projectId: string): Promise<PluginDetails> {
    const { details } = await request<{ details: PluginDetails }>(
      `/servers/${serverId}/plugins/details?source=${source}&projectId=${encodeURIComponent(projectId)}`
    );
    return details;
  },
  async listPluginVersions(serverId: string, source: PluginSource, projectId: string): Promise<PluginVersionInfo[]> {
    const { versions } = await request<{ versions: PluginVersionInfo[] }>(
      `/servers/${serverId}/plugins/versions?source=${source}&projectId=${encodeURIComponent(projectId)}`
    );
    return versions;
  },
  async installPlugin(
    serverId: string,
    source: PluginSource,
    projectId: string,
    versionId: string
  ): Promise<InstalledPlugin> {
    const { plugin } = await request<{ plugin: InstalledPlugin }>(`/servers/${serverId}/plugins`, {
      method: "POST",
      body: JSON.stringify({ source, projectId, versionId }),
    });
    return plugin;
  },
  async getProperties(serverId: string): Promise<ServerProperties> {
    return request<ServerProperties>(`/servers/${serverId}/properties`);
  },
  async saveProperties(
    serverId: string,
    values: Record<string, string>
  ): Promise<{ saved: number; values: Record<string, string> }> {
    return request<{ saved: number; values: Record<string, string> }>(
      `/servers/${serverId}/properties`,
      { method: "PUT", body: JSON.stringify({ values }) }
    );
  },
  async getMotd(serverId: string): Promise<ServerMotd> {
    return request<ServerMotd>(`/servers/${serverId}/motd`);
  },
  async saveMotd(serverId: string, motd: string): Promise<{ motd: string }> {
    return request<{ motd: string }>(`/servers/${serverId}/motd`, {
      method: "PUT",
      body: JSON.stringify({ motd }),
    });
  },
  async uploadServerIcon(serverId: string, file: File): Promise<void> {
    const form = new FormData();
    form.append("file", file);
    // Sent with fetch rather than request(): the JSON content-type request()
    // sets would stop the browser writing the multipart boundary.
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/icon`, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, body.error ?? res.statusText);
    }
  },
  async deleteServerIcon(serverId: string): Promise<void> {
    await request(`/servers/${serverId}/icon`, { method: "DELETE" });
  },
  async getGameRules(serverId: string): Promise<GameRuleState> {
    return request<GameRuleState>(`/servers/${serverId}/gamerules`);
  },
  async setGameRule(
    serverId: string,
    rule: string,
    value: string
  ): Promise<{ rule: string; value: string }> {
    return request<{ rule: string; value: string }>(
      `/servers/${serverId}/gamerules/${encodeURIComponent(rule)}`,
      { method: "PUT", body: JSON.stringify({ value }) }
    );
  },
  async listSchedules(serverId: string): Promise<Schedule[]> {
    const { schedules } = await request<{ schedules: Schedule[] }>(`/servers/${serverId}/schedules`);
    return schedules;
  },
  async saveSchedule(serverId: string, schedule: Partial<Schedule>): Promise<Schedule> {
    const saved = await request<{ schedule: Schedule }>(`/servers/${serverId}/schedules`, {
      method: "PUT",
      body: JSON.stringify(schedule),
    });
    return saved.schedule;
  },
  async deleteSchedule(serverId: string, scheduleId: string): Promise<void> {
    await request(`/servers/${serverId}/schedules/${encodeURIComponent(scheduleId)}`, {
      method: "DELETE",
    });
  },
  async deletePlugin(serverId: string, filename: string): Promise<void> {
    await request(`/servers/${serverId}/plugins/${encodeURIComponent(filename)}`, { method: "DELETE" });
  },
};

export { ApiError };
