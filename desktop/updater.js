const { app, dialog, shell } = require("electron");
const profiles = require("./profiles");

/**
 * Update check, against the dashboard first and GitHub as a fallback.
 *
 * The GitHub check on its own never found anything: this project's repository
 * is private, so an unauthenticated request for its latest release returns 404
 * - which the code below has always handled quietly, meaning the feature has
 * looked like it worked while doing nothing at all. The dashboard the app is
 * already connected to can serve the installer instead, and does not need a
 * token that would have to be shipped inside the app to be useful.
 *
 * Deliberately *not* electron-updater: that installs silently in the
 * background, which needs signed builds to be safe, and these are unsigned
 * (no Apple Developer ID, no Windows certificate). Telling the user a newer
 * version exists and opening the download is the honest version of this until
 * there are certificates to sign with.
 */

const RELEASES_API = "https://api.github.com/repos/GREG13-PRO/mc-dashboard/releases/latest";

/** Which published build this machine can actually install. */
function platformKey() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  return null;
}

async function fromDashboard() {
  const profile = profiles.activeProfile(app);
  const key = platformKey();
  if (!profile || !key) return null;
  const base = `http://${profile.host}:${profile.port}`;
  try {
    const res = await fetch(`${base}/api/app/platform/${key}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const build = await res.json();
    return { version: build.version, url: `${base}${build.url}`, source: "dashboard" };
  } catch {
    // An unreachable dashboard is the normal state when working away from the
    // server; it is not worth interrupting anyone over.
    return null;
  }
}

function parseVersion(tag) {
  return (tag || "")
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number(n) || 0);
}

function isNewer(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

async function checkForUpdates(interactive) {
  const published = await fromDashboard();
  if (published) {
    if (isNewer(published.version, app.getVersion())) {
      const { response } = await dialog.showMessageBox({
        type: "info",
        title: "Elérhető frissítés",
        message: `Új verzió érhető el: ${published.version}`,
        detail: `A jelenlegi verzió ${app.getVersion()}. A telepítőt a dashboard szolgálja ki.`,
        buttons: ["Letöltés", "Később"],
        defaultId: 0,
      });
      if (response === 0) shell.openExternal(published.url);
    } else if (interactive) {
      dialog.showMessageBox({
        type: "info",
        title: "Frissítéskeresés",
        message: "Ez a legfrissebb verzió.",
        detail: `Verzió: ${app.getVersion()}`,
      });
    }
    return;
  }

  let release;
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "mc-dashboard-desktop" },
      signal: AbortSignal.timeout(8000),
    });
    // A private repo returns 404 to an unauthenticated request, which is not
    // an error worth interrupting anyone over on the automatic check.
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    release = await res.json();
  } catch (err) {
    if (interactive) {
      dialog.showMessageBox({
        type: "info",
        title: "Frissítéskeresés",
        message: "Nem sikerült lekérdezni a frissítéseket.",
        detail: String(err.message ?? err),
      });
    }
    return;
  }

  const latest = release.tag_name;
  if (isNewer(latest, app.getVersion())) {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Elérhető frissítés",
      message: `Új verzió érhető el: ${latest}`,
      detail: `A jelenlegi verzió ${app.getVersion()}. A letöltéshez nyisd meg a kiadási oldalt.`,
      buttons: ["Letöltés megnyitása", "Később"],
      defaultId: 0,
    });
    if (response === 0) shell.openExternal(release.html_url);
  } else if (interactive) {
    dialog.showMessageBox({
      type: "info",
      title: "Frissítéskeresés",
      message: "Ez a legfrissebb verzió.",
      detail: `Verzió: ${app.getVersion()}`,
    });
  }
}

module.exports = { checkForUpdates, isNewer };
