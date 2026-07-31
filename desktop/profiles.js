const path = require("node:path");
const fs = require("node:fs");

/**
 * Saved server profiles.
 *
 * v2.2 stored a single `connection.json`; this keeps a list plus which one is
 * active, and migrates that older file on first read so an existing install
 * does not land back on the setup screen after updating.
 */
const PROFILES_NAME = "profiles.json";
const LEGACY_NAME = "connection.json";

function profilesPath(app) {
  return path.join(app.getPath("userData"), PROFILES_NAME);
}

function legacyPath(app) {
  return path.join(app.getPath("userData"), LEGACY_NAME);
}

function emptyState() {
  return { activeId: null, profiles: [] };
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function read(app) {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilesPath(app), "utf-8"));
    if (Array.isArray(parsed.profiles)) return parsed;
  } catch {
    // Falls through to the legacy migration below.
  }

  try {
    const legacy = JSON.parse(fs.readFileSync(legacyPath(app), "utf-8"));
    if (legacy && legacy.host) {
      const state = {
        activeId: "migrated",
        profiles: [{ id: "migrated", name: legacy.host, host: legacy.host, port: legacy.port }],
      };
      write(app, state);
      return state;
    }
  } catch {
    // No legacy file either - a genuinely fresh install.
  }
  return emptyState();
}

function write(app, state) {
  fs.mkdirSync(path.dirname(profilesPath(app)), { recursive: true });
  fs.writeFileSync(profilesPath(app), JSON.stringify(state, null, 2), "utf-8");
}

function activeProfile(app) {
  const state = read(app);
  return state.profiles.find((p) => p.id === state.activeId) ?? null;
}

/** Adds or updates by host+port, so reconnecting to a known server does not
 * pile up duplicates, and makes it active. */
function upsert(app, { name, host, port }) {
  const state = read(app);
  const existing = state.profiles.find((p) => p.host === host && Number(p.port) === Number(port));
  if (existing) {
    existing.name = name || existing.name;
    state.activeId = existing.id;
  } else {
    const profile = { id: makeId(), name: name || host, host, port };
    state.profiles.push(profile);
    state.activeId = profile.id;
  }
  write(app, state);
  return activeProfile(app);
}

function setActive(app, id) {
  const state = read(app);
  if (!state.profiles.some((p) => p.id === id)) return null;
  state.activeId = id;
  write(app, state);
  return activeProfile(app);
}

function remove(app, id) {
  const state = read(app);
  state.profiles = state.profiles.filter((p) => p.id !== id);
  if (state.activeId === id) state.activeId = state.profiles[0]?.id ?? null;
  write(app, state);
  return read(app);
}

module.exports = { read, upsert, setActive, remove, activeProfile };
