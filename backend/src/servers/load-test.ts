import net from "node:net";
import path from "node:path";
import { readProperties } from "./properties";
import { isServerRunning } from "./process-manager";
import type { ServerEntry } from "../types";

/**
 * Measures how a server copes with connections, by making a lot of them.
 *
 * What this does is the server list ping: connect, handshake, ask for status,
 * read the answer, close. That is the path a connection flood hits first, and
 * it exercises the accept queue, the netty threads and the main thread's status
 * handler.
 *
 * What it deliberately does not do is play. A logged-in client sends movement,
 * loads chunks and ticks entities, and simulating that means implementing the
 * login and configuration phases of a protocol that changes every release -
 * this project already found that mineflayer cannot complete a login against
 * Paper 1.21.11. So this measures the front door, not the house, and the screen
 * says so rather than letting a green result be mistaken for "holds 200
 * players".
 *
 * It only ever targets servers registered in this dashboard. A tool that
 * opens hundreds of connections to an arbitrary address on request is a
 * different kind of tool.
 */

export class LoadTestError extends Error {}

const MAX_CONNECTIONS = 500;
const MAX_DURATION_SECONDS = 60;

function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buffer: Buffer, offset: number): { value: number; size: number } | null {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= buffer.length) return null;
    const byte = buffer[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size++;
    if ((byte & 0x80) === 0) return { value, size };
    if (size > 5) return null;
  }
}

function packet(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function stringField(value: string): Buffer {
  const bytes = Buffer.from(value, "utf-8");
  return Buffer.concat([writeVarInt(bytes.length), bytes]);
}

/**
 * One server list ping, timed.
 *
 * The protocol version is sent as -1, which every server accepts for status:
 * it means "I do not know yet", and using a real number would make this fail
 * against a server whose version moved on.
 */
function ping(host: string, port: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let received = Buffer.alloc(0);
    let settled = false;

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(Date.now() - started);
    };

    socket.setTimeout(timeoutMs, () => finish(new Error("timeout")));
    socket.on("error", (err) => finish(err));

    socket.on("connect", () => {
      const handshake = packet(
        0x00,
        Buffer.concat([
          writeVarInt(0xffffffff), // protocol version -1
          stringField(host),
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          writeVarInt(1), // next state: status
        ])
      );
      socket.write(Buffer.concat([handshake, packet(0x00, Buffer.alloc(0))]));
    });

    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      const length = readVarInt(received, 0);
      if (!length) return;
      // The whole response has arrived once the framed length is satisfied.
      if (received.length >= length.size + length.value) finish(null);
    });

    socket.on("close", () => {
      if (!settled) finish(new Error("closed before answering"));
    });
  });
}

export interface LoadTestOptions {
  connections: number;
  durationSeconds: number;
}

export interface LoadTestReport {
  host: string;
  port: number;
  connections: number;
  durationSeconds: number;
  attempted: number;
  succeeded: number;
  failed: number;
  errors: Record<string, number>;
  latencyMs: { min: number; median: number; p95: number; max: number } | null;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

export async function runLoadTest(
  entry: ServerEntry,
  options: LoadTestOptions
): Promise<LoadTestReport> {
  if (!(await isServerRunning(entry))) {
    throw new LoadTestError("A szervernek futnia kell a teszthez.");
  }
  const connections = Math.floor(options.connections);
  const durationSeconds = Math.floor(options.durationSeconds);
  if (!Number.isInteger(connections) || connections < 1 || connections > MAX_CONNECTIONS) {
    throw new LoadTestError(`A párhuzamos kapcsolatok száma 1 és ${MAX_CONNECTIONS} között legyen.`);
  }
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < 1 ||
    durationSeconds > MAX_DURATION_SECONDS
  ) {
    throw new LoadTestError(`A teszt hossza 1 és ${MAX_DURATION_SECONDS} másodperc között legyen.`);
  }

  const props = readProperties(path.join(entry.folder, "server.properties"));
  const port = Number(props["server-port"]);
  if (!Number.isInteger(port) || port <= 0) {
    throw new LoadTestError("A szerver portja nem olvasható ki a server.properties-ből.");
  }
  const host = props["server-ip"] || "127.0.0.1";

  const latencies: number[] = [];
  const errors: Record<string, number> = {};
  let attempted = 0;
  let succeeded = 0;

  const deadline = Date.now() + durationSeconds * 1000;
  const worker = async () => {
    while (Date.now() < deadline) {
      attempted++;
      try {
        latencies.push(await ping(host, port, 5000));
        succeeded++;
      } catch (err) {
        const key = (err as Error).message.slice(0, 60);
        errors[key] = (errors[key] ?? 0) + 1;
        // A refused connection returns instantly, so without this a server
        // that is down turns the test into a tight loop hammering the local
        // machine tens of thousands of times for nothing.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  };

  // Every worker runs its own connect-ping-close loop for the whole duration,
  // so `connections` is the number in flight rather than a total.
  await Promise.all(Array.from({ length: connections }, worker));

  latencies.sort((a, b) => a - b);
  return {
    host,
    port,
    connections,
    durationSeconds,
    attempted,
    succeeded,
    failed: attempted - succeeded,
    errors,
    latencyMs:
      latencies.length === 0
        ? null
        : {
            min: latencies[0],
            median: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
            max: latencies[latencies.length - 1],
          },
  };
}
