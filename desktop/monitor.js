const { Notification, nativeImage } = require("electron");

/**
 * Polls the active server's dashboard API in the background so the tray icon
 * and native notifications work while the window is closed or hidden.
 *
 * It reuses the session cookie the window already has: the app never handles
 * credentials itself, so if nobody has logged in yet the poll simply gets a
 * 401 and reports "unknown" rather than prompting.
 */

const POLL_MS = 20_000;

let timer = null;
let listeners = [];
// Previous snapshot per server id, so notifications fire on transitions only -
// otherwise every poll would re-announce a server that is merely still down.
let previous = new Map();
let firstPoll = true;

function onUpdate(handler) {
  listeners.push(handler);
  return () => {
    listeners = listeners.filter((l) => l !== handler);
  };
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: false }).show();
}

async function poll(session, baseUrl) {
  if (!baseUrl) return null;
  let servers;
  try {
    const cookies = await session.cookies.get({ url: baseUrl });
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const res = await fetch(`${baseUrl}/api/servers`, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { reachable: res.status !== 401 ? false : true, authed: res.status !== 401, servers: [] };
    ({ servers } = await res.json());
  } catch {
    return { reachable: false, authed: false, servers: [] };
  }

  const snapshot = { reachable: true, authed: true, servers };

  // The first poll after launch establishes a baseline; announcing everything
  // it happens to find would mean a burst of notifications at startup.
  if (!firstPoll) {
    for (const s of servers) {
      const before = previous.get(s.id);
      if (!before) continue;
      if (before.running && !s.running) {
        notify("Szerver leállt", `${s.name} nem fut tovább.`);
      }
      const beforeNames = before.players?.names ?? [];
      const nowNames = s.players?.names ?? [];
      for (const name of nowNames) {
        if (!beforeNames.includes(name)) notify("Játékos csatlakozott", `${name} · ${s.name}`);
      }
    }
  }
  firstPoll = false;
  previous = new Map(servers.map((s) => [s.id, s]));

  for (const l of listeners) l(snapshot);
  return snapshot;
}

function start(session, getBaseUrl) {
  stop();
  const tick = () => void poll(session, getBaseUrl());
  tick();
  timer = setInterval(tick, POLL_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Resets the baseline, so switching profiles does not announce the new
 * server's existing players as fresh joins. */
function resetBaseline() {
  previous = new Map();
  firstPoll = true;
}

/**
 * Tray glyph drawn as a coloured dot rather than shipping icon files: it has
 * to change with status, and a template image cannot carry colour on macOS.
 */
function statusIcon(color) {
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  const [r, g, b] = color;
  const cx = 7.5;
  const cy = 7.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const alpha = d <= 5 ? 255 : d <= 6 ? Math.round(255 * (6 - d)) : 0;
      const i = (y * size + x) * 4;
      canvas[i] = b;
      canvas[i + 1] = g;
      canvas[i + 2] = r;
      canvas[i + 3] = alpha;
    }
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

const COLORS = {
  online: [52, 199, 89],
  offline: [255, 59, 48],
  unknown: [142, 142, 147],
};

module.exports = { start, stop, onUpdate, resetBaseline, statusIcon, COLORS, notify };
