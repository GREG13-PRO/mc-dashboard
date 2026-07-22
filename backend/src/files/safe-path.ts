import fs from "node:fs";
import path from "node:path";

export class UnsafePathError extends Error {
  constructor(message = "Path escapes the server's root directory") {
    super(message);
    this.name = "UnsafePathError";
  }
}

/**
 * Resolves a user-supplied relative path against a server's root directory,
 * guaranteeing the result stays inside that root even across symlinks.
 * Throws UnsafePathError on any attempt to escape.
 */
export function resolveSafePath(root: string, userPath: string): string {
  const normalizedRoot = path.resolve(root);
  const rawInput = userPath ?? "";

  if (rawInput.includes("\0")) {
    throw new UnsafePathError("Null byte in path");
  }
  if (path.isAbsolute(rawInput) || /^[a-zA-Z]:/.test(rawInput)) {
    throw new UnsafePathError("Absolute paths are not allowed");
  }
  if (rawInput.split(/[\\/]/).includes("..")) {
    throw new UnsafePathError("Parent directory references are not allowed");
  }

  const resolved = path.resolve(normalizedRoot, rawInput);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new UnsafePathError();
  }

  // If the target exists, resolve symlinks and re-check containment so a
  // symlink placed inside the sandbox can't point somewhere outside it.
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(normalizedRoot);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new UnsafePathError("Path resolves outside the sandbox via a symlink");
    }
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new UnsafePathError("Direct operations on symlinks are not allowed");
    }
  }

  return resolved;
}

/**
 * Validates that `candidatePath` (e.g. a startScript filename) exists as a
 * real file inside `root`. Used at server-registration time.
 */
export function assertFileInsideRoot(root: string, candidatePath: string): string {
  const resolved = resolveSafePath(root, candidatePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new UnsafePathError(`File not found inside server folder: ${candidatePath}`);
  }
  return resolved;
}
