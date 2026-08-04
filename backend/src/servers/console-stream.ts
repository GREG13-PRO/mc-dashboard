import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ServerEntry } from "../types";
import { consoleLogPath } from "./process-manager";
import { followFile, hasTail, type TailFollower } from "./file-tail";

type OutputListener = (chunk: Buffer) => void;

interface TailHandle {
  /** One or the other: `tail` where it exists, a file follower where it does not. */
  proc: ChildProcessByStdio<null, Readable, Readable> | null;
  follower: TailFollower | null;
  listeners: Set<OutputListener>;
}

const tails = new Map<string, TailHandle>();

/**
 * Subscribes to live console output for a server by tailing its logfile
 * (servers are started with stdout piped through `tee` into this file, see
 * process-manager). Lazily spawns one `tail -F` per server on the first
 * subscriber and tears it down when the last subscriber leaves. Returns an
 * unsubscribe function.
 *
 * This deliberately does NOT attach with `screen -x`. An interactive attach
 * streams screen's full-window *redraws* - absolute cursor addressing sized to
 * an exact terminal geometry - and feeding that into a read-only xterm of a
 * different size produced a runaway redraw loop that spat out endless blank
 * lines (which is exactly the "console keeps inserting empty lines" bug). The
 * logfile instead holds the inner program's plain, line-based stdout/stderr, so
 * tailing it is stable no matter the viewer's terminal size.
 */
export function subscribeConsole(entry: ServerEntry, onData: OutputListener): () => void {
  let handle = tails.get(entry.id);

  if (!handle) {
    const emit = (data: Buffer) => {
      for (const listener of handle!.listeners) {
        listener(data);
      }
    };

    if (!hasTail()) {
      // Windows has no tail. The follower does the same job in Node - see
      // file-tail for why it polls rather than watching.
      handle = {
        proc: null,
        follower: followFile(consoleLogPath(entry), 200, emit),
        listeners: new Set(),
      };
      tails.set(entry.id, handle);
    } else {
      // -n 200: seed the view with recent history on attach.
      // -F (not -f): follow by name and keep retrying if the file doesn't exist
      // yet (server not started) or gets recreated/truncated on the next start.
      const proc = spawn("tail", ["-n", "200", "-F", consoleLogPath(entry)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      handle = { proc, follower: null, listeners: new Set() };
      tails.set(entry.id, handle);

      proc.stdout.on("data", emit);
      // While the logfile is missing, `tail -F` prints "cannot open ... No such
      // file" retry chatter to stderr - swallow it so it never reaches the view.
      proc.stderr.on("data", () => undefined);
      proc.on("exit", () => {
        tails.delete(entry.id);
      });
    }
  }

  handle.listeners.add(onData);

  return () => {
    const current = tails.get(entry.id);
    if (!current) return;
    current.listeners.delete(onData);
    if (current.listeners.size === 0) {
      current.proc?.kill();
      current.follower?.stop();
      tails.delete(entry.id);
    }
  };
}

export function isConsoleAttached(serverId: string): boolean {
  return tails.has(serverId);
}
