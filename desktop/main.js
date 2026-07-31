const { app, BrowserWindow, ipcMain, Menu, Tray, shell, dialog, session } = require("electron");
const path = require("node:path");
const profiles = require("./profiles");
const monitor = require("./monitor");
const updater = require("./updater");

/**
 * The desktop app is a shell around the dashboard that already runs on the
 * Minecraft host: it asks where that host is, then shows it. It deliberately
 * does not bundle the server - the backend has to run next to the Minecraft
 * servers it manages (screen, ps, the world folders), which is not the machine
 * this app is installed on.
 */

let win = null;
let tray = null;
let quitting = false;

function baseUrl(profile) {
  return profile ? `http://${profile.host}:${profile.port}` : null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    // Traffic lights over the app's own toolbar rather than a separate title
    // bar, which is what makes it read as a native macOS window.
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

  // Registry project links belong in the real browser, not in a dashboard
  // window with no navigation controls.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Closing hides to the tray instead of quitting, so background monitoring
  // and notifications keep working - that is the point of having a tray icon.
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  const active = profiles.activeProfile(app);
  if (active) {
    loadDashboard(active);
  } else {
    win.loadFile(path.join(__dirname, "setup.html"));
  }
}

function loadDashboard(profile) {
  const url = baseUrl(profile);
  win.loadURL(url).catch(() => showConnectionError(profile));
  win.webContents.once("did-fail-load", () => showConnectionError(profile));
  monitor.resetBaseline();
  monitor.start(session.defaultSession, () => baseUrl(profiles.activeProfile(app)));
  buildMenu();
}

function showSetup() {
  win.loadFile(path.join(__dirname, "setup.html"));
}

function showConnectionError(profile) {
  dialog
    .showMessageBox(win, {
      type: "error",
      title: "Nem sikerült csatlakozni",
      message: `A dashboard nem érhető el itt: ${baseUrl(profile)}`,
      detail: "Ellenőrizd, hogy fut-e a szerveren a mc-dashboard szolgáltatás, és jó-e a cím.",
      buttons: ["Cím módosítása", "Újrapróbálás"],
      defaultId: 0,
    })
    .then(({ response }) => (response === 0 ? showSetup() : loadDashboard(profile)));
}

// Validated in the main process: the setup page has no network privileges of
// its own, and this doubles as the "is anything actually there" check.
ipcMain.handle("test-connection", async (_event, { host, port }) => {
  try {
    const res = await fetch(`http://${host}:${port}/api/auth/status`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { ok: false, error: `A szerver ${res.status} hibakóddal válaszolt.` };
    await res.json();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.name === "TimeoutError" ? "Időtúllépés." : "Nem érhető el." };
  }
});

ipcMain.handle("save-connection", (_event, connection) => {
  const profile = profiles.upsert(app, connection);
  loadDashboard(profile);
  return { ok: true };
});

ipcMain.handle("get-connection", () => profiles.activeProfile(app));
ipcMain.handle("list-profiles", () => profiles.read(app));

function switchProfile(id) {
  const profile = profiles.setActive(app, id);
  if (profile) loadDashboard(profile);
}

function buildTray() {
  tray = new Tray(monitor.statusIcon(monitor.COLORS.unknown));
  tray.setToolTip("Minecraft Dashboard");
  renderTrayMenu(null);

  monitor.onUpdate((snapshot) => {
    const running = snapshot.servers.filter((s) => s.running);
    const color = !snapshot.reachable
      ? monitor.COLORS.offline
      : running.length > 0
        ? monitor.COLORS.online
        : monitor.COLORS.unknown;
    tray.setImage(monitor.statusIcon(color));

    const players = running.reduce((sum, s) => sum + (s.players?.online ?? 0), 0);
    tray.setToolTip(
      !snapshot.reachable
        ? "Minecraft Dashboard — nem elérhető"
        : `Minecraft Dashboard — ${running.length} szerver fut · ${players} játékos`
    );
    renderTrayMenu(snapshot);
  });

  tray.on("click", () => {
    if (win.isVisible()) win.focus();
    else win.show();
  });
}

function renderTrayMenu(snapshot) {
  const state = profiles.read(app);
  const serverItems = (snapshot?.servers ?? []).map((s) => ({
    label: `${s.running ? "●" : "○"}  ${s.name}${
      s.running && s.players ? ` — ${s.players.online}/${s.players.max}` : ""
    }`,
    enabled: false,
  }));

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Dashboard megnyitása", click: () => win.show() },
      { type: "separator" },
      ...(serverItems.length > 0 ? serverItems : [{ label: "Nincs adat", enabled: false }]),
      { type: "separator" },
      {
        label: "Szerverprofilok",
        submenu:
          state.profiles.length > 0
            ? state.profiles.map((p) => ({
                label: `${p.name} (${p.host}:${p.port})`,
                type: "radio",
                checked: p.id === state.activeId,
                click: () => switchProfile(p.id),
              }))
            : [{ label: "Nincs mentett profil", enabled: false }],
      },
      { label: "Új szerver hozzáadása…", click: () => { win.show(); showSetup(); } },
      { type: "separator" },
      { label: "Frissítés keresése…", click: () => updater.checkForUpdates(true) },
      {
        label: "Kilépés",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function buildMenu() {
  const state = profiles.read(app);
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "Kapcsolat",
      submenu: [
        {
          label: "Szerverprofilok",
          submenu:
            state.profiles.length > 0
              ? state.profiles.map((p) => ({
                  label: `${p.name} (${p.host}:${p.port})`,
                  type: "radio",
                  checked: p.id === state.activeId,
                  click: () => switchProfile(p.id),
                }))
              : [{ label: "Nincs mentett profil", enabled: false }],
        },
        { label: "Új szerver hozzáadása…", click: showSetup },
        {
          label: "Aktív profil törlése",
          enabled: Boolean(state.activeId),
          click: () => {
            profiles.remove(app, state.activeId);
            const next = profiles.activeProfile(app);
            if (next) loadDashboard(next);
            else showSetup();
          },
        },
        { type: "separator" },
        {
          label: "Újratöltés",
          accelerator: "CmdOrCtrl+R",
          click: () => {
            const active = profiles.activeProfile(app);
            if (active) loadDashboard(active);
          },
        },
        { label: "Frissítés keresése…", click: () => updater.checkForUpdates(true) },
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
  buildTray();
  updater.checkForUpdates(false);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else win?.show();
  });
});

app.on("before-quit", () => {
  quitting = true;
  monitor.stop();
});

// Never quits on window close: the tray is the app's resting state.
app.on("window-all-closed", () => {});
