export interface RconConfig {
  enabled: boolean;
  host: string;
  port: number;
  password: string;
}

export interface ServerEntry {
  id: string;
  name: string;
  folder: string;
  startScript: string;
  screenName: string;
  stopCommand: string;
  rcon: RconConfig;
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
