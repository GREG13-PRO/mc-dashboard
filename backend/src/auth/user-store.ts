import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { env, paths } from "../config/env";
import type { ServerPermissions, UserInput, UserRecord } from "../types";

const EMPTY_PERMISSIONS: ServerPermissions = {
  console: false,
  files: false,
  players: false,
  settings: false,
};

function normalizePermissions(
  input: Record<string, Partial<ServerPermissions>> | undefined
): Record<string, ServerPermissions> {
  const result: Record<string, ServerPermissions> = {};
  if (!input) return result;
  for (const [serverId, perms] of Object.entries(input)) {
    result[serverId] = {
      console: Boolean(perms.console),
      files: Boolean(perms.files),
      players: Boolean(perms.players),
      settings: Boolean(perms.settings),
    };
  }
  return result;
}

class UserStore {
  private entries: Map<string, UserRecord> = new Map();
  private loaded = false;

  private ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;

    fs.mkdirSync(path.dirname(paths.usersFile), { recursive: true });
    if (!fs.existsSync(paths.usersFile)) {
      this.seedAdmin();
      this.persist();
      return;
    }
    const raw = fs.readFileSync(paths.usersFile, "utf-8");
    const parsed = raw.trim() ? (JSON.parse(raw) as UserRecord[]) : [];
    for (const entry of parsed) {
      this.entries.set(entry.id, entry);
    }
    if (this.entries.size === 0) {
      this.seedAdmin();
      this.persist();
    }
  }

  private seedAdmin() {
    if (!env.adminPasswordHash) {
      throw new Error(
        "ADMIN_PASSWORD_HASH is not set. Generate one with: node -e \"console.log(require('bcryptjs').hashSync('yourpassword', 10))\""
      );
    }
    const now = new Date().toISOString();
    const admin: UserRecord = {
      id: uuidv4(),
      username: "admin",
      passwordHash: env.adminPasswordHash,
      isAdmin: true,
      permissions: {},
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(admin.id, admin);
  }

  private persist() {
    const list = [...this.entries.values()];
    fs.writeFileSync(paths.usersFile, JSON.stringify(list, null, 2), "utf-8");
  }

  list(): UserRecord[] {
    this.ensureLoaded();
    return [...this.entries.values()];
  }

  get(id: string): UserRecord | undefined {
    this.ensureLoaded();
    return this.entries.get(id);
  }

  getByUsername(username: string): UserRecord | undefined {
    this.ensureLoaded();
    return [...this.entries.values()].find((u) => u.username === username);
  }

  verifyLogin(username: string, password: string): UserRecord | null {
    const user = this.getByUsername(username);
    if (!user) return null;
    if (!bcrypt.compareSync(password, user.passwordHash)) return null;
    return user;
  }

  create(input: UserInput): UserRecord {
    this.ensureLoaded();
    const username = input.username.trim();
    if (!username) {
      throw new Error("Username is required");
    }
    if (this.getByUsername(username)) {
      throw new Error(`A user named "${username}" already exists`);
    }
    if (!input.password) {
      throw new Error("Password is required");
    }

    const now = new Date().toISOString();
    const user: UserRecord = {
      id: uuidv4(),
      username,
      passwordHash: bcrypt.hashSync(input.password, 10),
      isAdmin: Boolean(input.isAdmin),
      permissions: normalizePermissions(input.permissions),
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(user.id, user);
    this.persist();
    return user;
  }

  update(id: string, input: Partial<UserInput>): UserRecord {
    this.ensureLoaded();
    const existing = this.entries.get(id);
    if (!existing) {
      throw new Error("User not found");
    }

    if (input.username && input.username.trim() !== existing.username) {
      const clash = this.getByUsername(input.username.trim());
      if (clash && clash.id !== id) {
        throw new Error(`A user named "${input.username.trim()}" already exists`);
      }
    }

    if (existing.isAdmin && input.isAdmin === false && this.countAdmins() <= 1) {
      throw new Error("Cannot remove admin rights from the last remaining admin");
    }

    const updated: UserRecord = {
      ...existing,
      username: input.username?.trim() || existing.username,
      passwordHash: input.password ? bcrypt.hashSync(input.password, 10) : existing.passwordHash,
      isAdmin: input.isAdmin ?? existing.isAdmin,
      permissions: input.permissions ? normalizePermissions(input.permissions) : existing.permissions,
      updatedAt: new Date().toISOString(),
    };
    this.entries.set(id, updated);
    this.persist();
    return updated;
  }

  remove(id: string): void {
    this.ensureLoaded();
    const existing = this.entries.get(id);
    if (!existing) {
      throw new Error("User not found");
    }
    if (existing.isAdmin && this.countAdmins() <= 1) {
      throw new Error("Cannot delete the last remaining admin");
    }
    this.entries.delete(id);
    this.persist();
  }

  private countAdmins(): number {
    return [...this.entries.values()].filter((u) => u.isAdmin).length;
  }
}

export const userStore = new UserStore();
export { EMPTY_PERMISSIONS };
