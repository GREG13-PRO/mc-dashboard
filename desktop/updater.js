const { app, dialog, shell } = require("electron");

/**
 * Update check against the project's GitHub releases.
 *
 * Deliberately *not* electron-updater: that installs silently in the
 * background, which needs signed builds to be safe, and these are unsigned
 * (no Apple Developer ID, no Windows certificate). Telling the user a newer
 * version exists and opening the release page is the honest version of this
 * until there are certificates to sign with.
 */

const RELEASES_API = "https://api.github.com/repos/GREG13-PRO/mc-dashboard/releases/latest";

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
