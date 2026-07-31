/**
 * Who is editing what, right now.
 *
 * In-memory and short-lived on purpose: this answers "is someone else in this
 * file" for a handful of admins, not "who has ever opened it". A stale entry
 * is worse than none - it would stop people editing a file nobody is in - so
 * entries expire quickly and the client re-announces while the editor is open.
 */

const TTL_MS = 45_000;

interface Presence {
  userId: string;
  username: string;
  serverId: string;
  resource: string;
  at: number;
}

const entries = new Map<string, Presence>();

function key(userId: string, serverId: string, resource: string): string {
  return `${userId}|${serverId}|${resource}`;
}

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of entries) {
    if (v.at < cutoff) entries.delete(k);
  }
}

export function announce(userId: string, username: string, serverId: string, resource: string): void {
  sweep();
  entries.set(key(userId, serverId, resource), { userId, username, serverId, resource, at: Date.now() });
}

export function release(userId: string, serverId: string, resource: string): void {
  entries.delete(key(userId, serverId, resource));
}

export interface PresenceEntry {
  username: string;
  resource: string;
  since: string;
}

/** Everyone currently in this server, excluding the caller - the point is to
 * show who *else* is here. */
export function listFor(serverId: string, exceptUserId: string): PresenceEntry[] {
  sweep();
  return [...entries.values()]
    .filter((p) => p.serverId === serverId && p.userId !== exceptUserId)
    .map((p) => ({ username: p.username, resource: p.resource, since: new Date(p.at).toISOString() }));
}
