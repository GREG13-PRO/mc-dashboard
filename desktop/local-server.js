const { app } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Runs the dashboard's own backend inside this app.
 *
 * The app has always been a window onto a dashboard running somewhere else,
 * which is right when the Minecraft servers live on another machine. This is
 * the other case: the servers are on *this* machine, and then asking someone
 * to install Node, clone a repository and run a service first is asking them
 * to do the hard part themselves.
 *
 * The backend is shipped compiled next to the app rather than bundled into the
 * asar: it spawns as a separate Node process, and a process cannot be started
 * from inside an archive.
 */

let child = null;

function backendDir() {
  // Packaged: resources/backend. Development: the sibling checkout.
  const packaged = path.join(process.resourcesPath ?? "", "backend");
  if (fs.existsSync(path.join(packaged, "dist", "index.js"))) return packaged;
  return path.join(__dirname, "..", "backend");
}

function configPath() {
  return path.join(app.getPath("userData"), "local-server.json");
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf-8"));
  } catch {
    return null;
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  // 0600: this file holds the session secret and the admin password hash.
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

function clearConfig() {
  try {
    fs.rmSync(configPath(), { force: true });
  } catch {
    // Nothing to clear.
  }
}

/**
 * Hashes with the backend's own bcryptjs.
 *
 * Reusing it rather than adding a dependency here guarantees the hash is
 * verifiable by the code that will check it - a mismatched bcrypt version
 * would produce a password that is simply always wrong.
 */
function hashPassword(password) {
  const bcrypt = require(path.join(backendDir(), "node_modules", "bcryptjs"));
  return bcrypt.hashSync(password, 10);
}

function isConfigured() {
  const config = readConfig();
  return Boolean(config && config.dataDir && config.port);
}

function configure({ dataDir, port, password }) {
  if (!dataDir) throw new Error("Válassz mappát.");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("A port 1024 és 65535 közötti szám legyen.");
  }
  if (!password || password.length < 8) {
    throw new Error("A jelszó legyen legalább 8 karakter.");
  }
  fs.mkdirSync(dataDir, { recursive: true });
  writeConfig({
    dataDir,
    port,
    // Generated once and kept: regenerating it on every start would log
    // everyone out whenever the app restarts.
    sessionSecret: crypto.randomBytes(32).toString("hex"),
    adminPasswordHash: hashPassword(password),
  });
}

function start() {
  const config = readConfig();
  if (!config) throw new Error("A helyi szerver nincs beállítva.");
  if (child) return config;

  const dir = backendDir();
  const entry = path.join(dir, "dist", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error("A beépített szerver hiányzik ebből a csomagból.");
  }

  child = spawn(process.execPath, [entry], {
    cwd: dir,
    env: {
      ...process.env,
      // Tells Electron's bundled Node to behave as plain Node for this child,
      // which is what running a server rather than a window needs.
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(config.port),
      // Only this machine: the panel is for the person sitting at it, and
      // putting it on the network without being asked would be a surprise.
      HOST: "127.0.0.1",
      DATA_DIR: config.dataDir,
      SESSION_SECRET: config.sessionSecret,
      ADMIN_PASSWORD_HASH: config.adminPasswordHash,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logFile = path.join(app.getPath("userData"), "local-server.log");
  const log = fs.createWriteStream(logFile, { flags: "a" });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.on("exit", (code) => {
    log.write(`\n[app] a beépített szerver kilépett (${code})\n`);
    child = null;
  });

  return config;
}

function stop() {
  if (!child) return;
  child.kill();
  child = null;
}

/** Waits for the backend to answer, so the window is not shown against nothing. */
async function waitUntilReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!child) throw new Error("A beépített szerver leállt indulás közben.");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok || res.status === 401) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("A beépített szerver nem indult el időben.");
}

module.exports = { isConfigured, configure, start, stop, waitUntilReady, readConfig, clearConfig };
