import fs from "node:fs";

/**
 * Sets `key=value` in a server.properties line array, replacing an existing
 * line for that key or appending a new one. Minecraft rewrites this file on
 * every startup, so anything we write has to survive being read back and
 * re-serialized - plain `key=value` lines with no quoting is what it expects.
 */
export function upsertProperty(lines: string[], key: string, value: string): string[] {
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  const line = `${key}=${value}`;
  if (idx >= 0) {
    lines[idx] = line;
    return lines;
  }
  return [...lines, line];
}

/**
 * Applies a batch of server.properties changes to a file on disk, creating it
 * if it doesn't exist yet (a freshly downloaded server jar has no
 * server.properties until its first run, so a fresh install has to write one
 * from scratch rather than patch).
 */
export function writeProperties(propsPath: string, values: Record<string, string>): void {
  const existing = fs.existsSync(propsPath) ? fs.readFileSync(propsPath, "utf-8").split("\n") : [];
  let lines = existing;
  for (const [key, value] of Object.entries(values)) {
    lines = upsertProperty(lines, key, value);
  }
  fs.writeFileSync(propsPath, lines.join("\n"), "utf-8");
}
