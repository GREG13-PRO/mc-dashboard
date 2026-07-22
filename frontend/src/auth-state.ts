import type { ServerPermissions, UserPublic } from "./types";

let currentUser: UserPublic | null = null;

export function setCurrentUser(user: UserPublic | null): void {
  currentUser = user;
}

export function getCurrentUser(): UserPublic | null {
  return currentUser;
}

export function isAdmin(): boolean {
  return Boolean(currentUser?.isAdmin);
}

export function permissionsFor(serverId: string): ServerPermissions {
  if (currentUser?.isAdmin) {
    return { console: true, files: true, players: true, settings: true };
  }
  return currentUser?.permissions[serverId] ?? { console: false, files: false, players: false, settings: false };
}

export function hasPermission(serverId: string, capability: keyof ServerPermissions): boolean {
  return permissionsFor(serverId)[capability];
}
