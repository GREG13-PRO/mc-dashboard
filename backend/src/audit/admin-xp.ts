import { readAudit, SYSTEM_ACTOR, type AuditRecord } from "./audit-log";

/**
 * Admin experience levels, derived from the audit log rather than kept as a
 * separate counter.
 *
 * That choice matters: the log already records every action with its actor, so
 * scores are recomputed from history instead of incremented alongside it. A
 * parallel counter would drift the moment anything failed to increment it, and
 * could never be corrected retroactively.
 */

export interface XpRule {
  /** Matches the action label the audit middleware records. */
  match: RegExp;
  points: number;
  label: string;
}

// Weighted by effort and by what is worth encouraging: keeping servers healthy
// and maintained scores more than merely starting one.
const RULES: XpRule[] = [
  { match: /^Mentés készítése$/, points: 10, label: "Mentés" },
  { match: /^Mentés visszaállítása$/, points: 15, label: "Visszaállítás" },
  { match: /^Bővítmény telepítése$/, points: 8, label: "Bővítmény telepítés" },
  { match: /^Bővítmény törlése$/, points: 4, label: "Bővítmény karbantartás" },
  { match: /^Szerver telepítése$/, points: 25, label: "Szerver telepítés" },
  { match: /^Szerver beállításai$/, points: 5, label: "Beállítás" },
  { match: /^Fájl mentése$/, points: 3, label: "Config szerkesztés" },
  { match: /^Konzolparancs$/, points: 1, label: "Konzolparancs" },
  { match: /^Játékos-művelet$/, points: 2, label: "Moderálás" },
  { match: /^Whitelist kapcsoló$|^IP-tiltás$/, points: 3, label: "Hozzáférés-kezelés" },
  { match: /^Felhasználó létrehozása$|^Felhasználó módosítása$/, points: 6, label: "Csapatkezelés" },
  { match: /^Szerver (indítása|leállítása|újraindítása)$/, points: 1, label: "Üzemeltetés" },
];

// Each level costs more than the last, so the early ones arrive quickly and
// the later ones mean something.
const LEVEL_STEP = 120;

export interface AdminXp {
  username: string;
  points: number;
  level: number;
  /** Points into the current level, and what the level needs in total. */
  progress: number;
  nextLevelAt: number;
  actions: number;
  /** Highest-scoring categories, for showing what someone actually does. */
  breakdown: { label: string; points: number; count: number }[];
  lastActiveAt: string | null;
}

export function levelFor(points: number): { level: number; progress: number; nextLevelAt: number } {
  // Triangular thresholds: level n costs n * LEVEL_STEP.
  let level = 1;
  let remaining = points;
  let cost = LEVEL_STEP;
  while (remaining >= cost) {
    remaining -= cost;
    level++;
    cost = level * LEVEL_STEP;
  }
  return { level, progress: remaining, nextLevelAt: cost };
}

function scoreOf(record: AuditRecord): XpRule | null {
  // Failed actions earn nothing - otherwise retrying a broken command would be
  // the fastest way to level up.
  if (!record.ok) return null;
  return RULES.find((r) => r.match.test(record.action)) ?? null;
}

export async function computeLeaderboard(limit = 5000): Promise<AdminXp[]> {
  const records = await readAudit(limit);
  const byUser = new Map<
    string,
    { points: number; actions: number; last: string | null; cats: Map<string, { points: number; count: number }> }
  >();

  for (const record of records) {
    // The schedulers act with no human behind them; they are not competing.
    if (record.actor === SYSTEM_ACTOR) continue;
    const rule = scoreOf(record);
    if (!rule) continue;

    const entry = byUser.get(record.actor) ?? { points: 0, actions: 0, last: null, cats: new Map() };
    entry.points += rule.points;
    entry.actions += 1;
    // readAudit returns newest first, so the first sighting is the latest.
    if (!entry.last) entry.last = record.at;
    const cat = entry.cats.get(rule.label) ?? { points: 0, count: 0 };
    cat.points += rule.points;
    cat.count += 1;
    entry.cats.set(rule.label, cat);
    byUser.set(record.actor, entry);
  }

  return [...byUser.entries()]
    .map(([username, e]) => ({
      username,
      points: e.points,
      ...levelFor(e.points),
      actions: e.actions,
      breakdown: [...e.cats.entries()]
        .map(([label, v]) => ({ label, ...v }))
        .sort((a, b) => b.points - a.points)
        .slice(0, 5),
      lastActiveAt: e.last,
    }))
    .sort((a, b) => b.points - a.points);
}

export function describeRules(): { label: string; points: number }[] {
  // Deduplicated: several patterns share a label.
  const seen = new Map<string, number>();
  for (const rule of RULES) {
    if (!seen.has(rule.label)) seen.set(rule.label, rule.points);
  }
  return [...seen.entries()].map(([label, points]) => ({ label, points })).sort((a, b) => b.points - a.points);
}
