import type { FileEntryInfo, PlayerAction, ServerEntryInput, ServerWithStatus } from "./types";

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
  async login(password: string): Promise<void> {
    await request("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
  },
  async logout(): Promise<void> {
    await request("/auth/logout", { method: "POST" });
  },
  async authStatus(): Promise<{ authenticated: boolean }> {
    return request("/auth/status");
  },

  async listServers(): Promise<ServerWithStatus[]> {
    const { servers } = await request<{ servers: ServerWithStatus[] }>("/servers");
    return servers;
  },
  async getServer(id: string): Promise<ServerWithStatus> {
    const { server, running, players } = await request<{
      server: ServerWithStatus;
      running: boolean;
      players: ServerWithStatus["players"];
    }>(`/servers/${id}`);
    return { ...server, running, players };
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
};

export { ApiError };
