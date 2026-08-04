import fs from "node:fs";
import fsp from "node:fs/promises";

/**
 * Follows a growing logfile, in place of `tail -n 200 -F`.
 *
 * Windows has no tail, and the console is the one screen nobody can do without
 * - a dashboard that cannot show what a server is printing is not a dashboard.
 *
 * Polling rather than fs.watch: watch reports "something changed" with no
 * offset, so the size still has to be read to know what to send, and its
 * behaviour differs across platforms and network shares in exactly the ways
 * this would have to work around. A stat every 300ms on one file per attached
 * console is cheap, and it makes truncation and recreation - which happen on
 * every server start - just another size comparison.
 */

const POLL_MS = 300;
const SEED_BYTES = 64 * 1024;

export interface TailFollower {
  stop(): void;
}

export function followFile(
  file: string,
  seedLines: number,
  onData: (chunk: Buffer) => void
): TailFollower {
  let offset = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let reading = false;

  const seed = async () => {
    try {
      const stat = await fsp.stat(file);
      const from = Math.max(0, stat.size - SEED_BYTES);
      const handle = await fsp.open(file, "r");
      try {
        const buffer = Buffer.alloc(stat.size - from);
        await handle.read(buffer, 0, buffer.length, from);
        // Only whole lines, and only the last few: the first line of a
        // mid-file read is usually a fragment.
        const lines = buffer.toString("utf-8").split("\n");
        if (from > 0) lines.shift();
        const tail = lines.slice(-seedLines).join("\n");
        if (tail) onData(Buffer.from(tail));
      } finally {
        await handle.close();
      }
      offset = stat.size;
    } catch {
      // No file yet: the server has not started. Start from nothing and let
      // the poll pick it up when it appears.
      offset = 0;
    }
  };

  const poll = async () => {
    if (stopped || reading) return;
    reading = true;
    try {
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat) {
        // The file went away; whatever comes back is a new run.
        offset = 0;
        return;
      }
      if (stat.size < offset) {
        // Truncated - a server start clears this file - so everything from
        // here is new.
        offset = 0;
      }
      if (stat.size === offset) return;

      const handle = await fsp.open(file, "r");
      try {
        const buffer = Buffer.alloc(stat.size - offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (bytesRead > 0) onData(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      } finally {
        await handle.close();
      }
    } catch {
      // A read that fails now is retried on the next tick; a console that
      // stops updating is worse than one that skips a beat.
    } finally {
      reading = false;
    }
  };

  void seed().then(() => {
    if (!stopped) timer = setInterval(() => void poll(), POLL_MS);
  });

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/** Whether `tail` is on this machine; decided once, it cannot change. */
let tailAvailable: boolean | null = null;

export function hasTail(): boolean {
  if (tailAvailable === null) {
    tailAvailable =
      process.platform !== "win32" &&
      ["/usr/bin/tail", "/bin/tail", "/usr/local/bin/tail"].some((p) => fs.existsSync(p));
  }
  return tailAvailable;
}
