import type {
  AccessLists,
  BackupInfo,
  FileEntryInfo,
  InstalledPlugin,
  PlayerAction,
  PluginSearchResult,
  PluginSource,
  PluginVersionInfo,
  ResourceSample,
  ServerEntryInput,
  ServerInstallInput,
  ServerTypeOption,
  ServerInstallType,
  ServerWithStatus,
  UserInput,
  UserPublic,
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

  async getResourceHistory(serverId: string): Promise<ResourceSample[]> {
    const { history } = await request<{ history: ResourceSample[] }>(`/servers/${serverId}/resource-history`);
    return history;
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
  async deletePlugin(serverId: string, filename: string): Promise<void> {
    await request(`/servers/${serverId}/plugins/${encodeURIComponent(filename)}`, { method: "DELETE" });
  },
};

export { ApiError };
