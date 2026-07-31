const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

/**
 * The desktop app is a shell around the dashboard that already runs on the
 * Minecraft host: it asks once where that host is, then shows it. It
 * deliberately does not bundle the server - the backend has to run next to the
 * Minecraft servers it manages (screen, ps, the world folders), which is not
 * the machine this app is installed on.
 */

const CONFIG_NAME = "connection.json";

function configPath() {
  return path.join(app.getPath("userData"), CONFIG_NAME);
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
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf-8");
}

function serverUrl(config) {
  return `http://${config.host}:${config.port}`;
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    // Traffic lights sit over the app's own toolbar rather than a separate
    // title bar, which is what makes it read as a native macOS window.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#f5f5f7",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Links to Modrinth/Hangar project pages belong in the real browser, not in
  // a dashboard window with no navigation controls.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const config = readConfig();
  if (config) {
    loadDashboard(config);
  } else {
    win.loadFile(path.join(__dirname, "setup.html"));
  }
}

function loadDashboard(config) {
  win.loadURL(serverUrl(config)).catch(() => showConnectionError(config));
  win.webContents.once("did-fail-load", () => showConnectionError(config));
}

function showConnectionError(config) {
  dialog
    .showMessageBox(win, {
      type: "error",
      title: "Nem sikerült csatlakozni",
      message: `A dashboard nem érhető el itt: ${serverUrl(config)}`,
      detail: "Ellenőrizd, hogy fut-e a szerveren a mc-dashboard szolgáltatás, és jó-e a cím.",
      buttons: ["Cím módosítása", "Újrapróbálás"],
      defaultId: 0,
    })
    .then(({ response }) => {
      if (response === 0) {
        win.loadFile(path.join(__dirname, "setup.html"));
      } else {
        loadDashboard(config);
      }
    });
}

// Validated in the main process: the setup page has no network privileges of
// its own, and this doubles as the "is anything actually there" check.
ipcMain.handle("test-connection", async (_event, { host, port }) => {
  try {
    const res = await fetch(`http://${host}:${port}/api/auth/status`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { ok: false, error: `A szerver ${res.status} hibakóddal válaszolt.` };
    await res.json();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.name === "TimeoutError" ? "Időtúllépés." : "Nem érhető el." };
  }
});

ipcMain.handle("save-connection", (_event, { host, port }) => {
  writeConfig({ host, port });
  loadDashboard({ host, port });
  return { ok: true };
});

ipcMain.handle("get-connection", () => readConfig());

function buildMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "Kapcsolat",
      submenu: [
        {
          label: "Szerver címének módosítása…",
          click: () => win?.loadFile(path.join(__dirname, "setup.html")),
        },
        {
          label: "Újratöltés",
          accelerator: "CmdOrCtrl+R",
          click: () => {
            const config = readConfig();
            if (config) loadDashboard(config);
          },
        },
        { type: "separator" },
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "Nézet",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
