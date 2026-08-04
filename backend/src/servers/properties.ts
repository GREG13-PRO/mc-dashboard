import fs from "node:fs";

/**
 * Sets `key=value` in a server.properties line array, replacing an existing
 * line for that key or appending a new one. Minecraft rewrites this file on
 * every startup, so anything we write has to survive being read back and
 * re-serialized - plain `key=value` lines with no quoting is what it expects.
 */
/**
 * Undoes Java's .properties escaping.
 *
 * Minecraft writes this file with `java.util.Properties`, which escapes colons
 * and equals signs in values - so `level-type` comes back as
 * `minecraft\:normal` and compares equal to nothing. Writing them unescaped is
 * fine, because only the first separator on a line is significant.
 */
function unescapeValue(value: string): string {
  return value.replace(/\\(.)/g, (_, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    if (ch === "t") return "\t";
    return ch;
  });
}

/** Parses a server.properties file into a plain map; missing file yields {}. */
export function readProperties(propsPath: string): Record<string, string> {
  if (!fs.existsSync(propsPath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(propsPath, "utf-8").split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const at = line.indexOf("=");
    if (at < 0) continue;
    out[line.slice(0, at).trim()] = unescapeValue(line.slice(at + 1).trim());
  }
  return out;
}

/**
 * Redoes the one piece of Java escaping that matters on the way out.
 *
 * A real newline in a value would end the line and turn the rest into a second,
 * bogus property - and the MOTD is legitimately two lines, so this is not a
 * theoretical case. Java writes it as a backslash-n pair, which `unescapeValue`
 * above turns back into a newline on read, so the two are inverses.
 *
 * Nothing else is escaped: only the first separator on a line is significant,
 * so a colon or an equals sign inside a value is already safe.
 */
function escapeValue(value: string): string {
  return value.replace(/\r?\n/g, "\\n");
}

export function upsertProperty(lines: string[], key: string, value: string): string[] {
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  const line = `${key}=${escapeValue(value)}`;
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
