import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { ServerEntry } from "../types";

type OutputListener = (chunk: Buffer) => void;

interface AttachHandle {
  pty: IPty;
  listeners: Set<OutputListener>;
}

const attachments = new Map<string, AttachHandle>();

/**
 * Subscribes to live console output for a server, lazily spawning a
 * `screen -x` attach pty on first subscriber and tearing it down when the
 * last subscriber leaves. Returns an unsubscribe function.
 */
export function subscribeConsole(entry: ServerEntry, onData: OutputListener): () => void {
  let handle = attachments.get(entry.id);

  if (!handle) {
    // Under systemd there is no controlling terminal, so `TERM` is typically
    // unset or "dumb" in process.env - spreading that in silently overrides
    // node-pty's `name` option (which only sets TERM when the env doesn't
    // already define one). Screen then can't reliably determine terminal
    // capabilities and falls into a runaway resize/redraw loop, growing its
    // scroll region on every redraw - which is what caused the console to
    // look like it was endlessly, erratically scrolling. Force a real TERM
    // explicitly instead of trusting the ambient environment.
    const attachPty = pty.spawn("screen", ["-x", entry.screenName], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    handle = { pty: attachPty, listeners: new Set() };
    attachments.set(entry.id, handle);

    attachPty.onData((data) => {
      const buf = Buffer.from(data, "utf-8");
      for (const listener of handle!.listeners) {
        listener(buf);
      }
    });
    attachPty.onExit(() => {
      attachments.delete(entry.id);
    });
  }

  handle.listeners.add(onData);

  return () => {
    const current = attachments.get(entry.id);
    if (!current) return;
    current.listeners.delete(onData);
    if (current.listeners.size === 0) {
      current.pty.kill();
      attachments.delete(entry.id);
    }
  };
}

export function resizeConsole(entry: ServerEntry, cols: number, rows: number): void {
  const handle = attachments.get(entry.id);
  handle?.pty.resize(cols, rows);
}

export function isConsoleAttached(serverId: string): boolean {
  return attachments.has(serverId);
}
