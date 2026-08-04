#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Builds a self-contained copy of the backend for the installer to carry.
 *
 * The repository is an npm workspaces monorepo, so the backend's dependencies
 * hoist to the root node_modules and backend/node_modules does not exist.
 * Pointing the packager at backend/ therefore shipped a server with no
 * dependencies at all - which fails at the first require, inside an installed
 * app, where nobody can see why.
 *
 * A staging directory with its own package.json is outside the workspace, so a
 * plain install there puts the modules where the packaged app will look for
 * them.
 */

const desktop = path.resolve(__dirname, "..");
const repo = path.resolve(desktop, "..");
const backend = path.join(repo, "backend");
const staging = path.join(desktop, "backend-bundle");

function run(command, args, cwd) {
  // A .cmd needs a shell on Windows. Node refuses to spawn one directly since
  // the 2024 fix for CVE-2024-27980 - it throws EINVAL rather than running it -
  // and a shell is the supported way through. Safe here because every argument
  // below is a fixed literal: nothing user-supplied is being interpolated into
  // a command line.
  const shell = process.platform === "win32" && command.endsWith(".cmd");
  execFileSync(command, args, { cwd, stdio: "inherit", shell });
}

/**
 * npm, by the name this platform can actually spawn.
 *
 * On Windows the executable is npm.cmd; the extensionless `npm` is a shell
 * script that exists for Git Bash and that CreateProcess cannot run. Without
 * this, execFileSync fails with a bare ENOENT on `npm` - which reads like npm
 * is missing rather than like it is spelled differently here. See run() for
 * why naming it correctly is still not quite enough.
 */
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * The TypeScript compiler this repository actually installed.
 *
 * `npx tsc` is not it: in a workspaces monorepo typescript hoists to the root,
 * so npx does not find it locally and helpfully fetches an unrelated package
 * called `tsc` from the registry instead - which prints "This is not the tsc
 * command you are looking for" and, in a less lucky version, could have
 * produced a silently wrong build.
 *
 * Nor is node_modules/.bin/tsc, which is what this reached for first. That is a
 * shell script on every platform and a .cmd shim beside it on Windows, so
 * execFileSync on the extensionless name works on macOS and fails on the
 * Windows runner - which is exactly the sort of difference that only shows up
 * on one of the two build machines.
 *
 * The package's own entry point has neither problem: it is a .js file, and this
 * process is already a Node that can run it.
 */
function tscEntry() {
  try {
    return require.resolve("typescript/lib/tsc.js", { paths: [repo, backend, desktop] });
  } catch {
    throw new Error(
      "A TypeScript fordító nincs telepítve. Futtasd a repó gyökerében: npm install"
    );
  }
}

console.log("[prepare-backend] fordítás");
run(process.execPath, [tscEntry(), "-p", "tsconfig.json"], backend);

console.log("[prepare-backend] staging:", staging);
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
fs.cpSync(path.join(backend, "dist"), path.join(staging, "dist"), { recursive: true });

// Only what a running server needs: no devDependencies, no scripts that would
// try to build again from inside the installer.
const manifest = JSON.parse(fs.readFileSync(path.join(backend, "package.json"), "utf-8"));
fs.writeFileSync(
  path.join(staging, "package.json"),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      private: true,
      main: "dist/index.js",
      dependencies: manifest.dependencies,
    },
    null,
    2
  )
);

console.log("[prepare-backend] függőségek telepítése a stagingbe");
run(NPM, ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"], staging);

const entry = path.join(staging, "dist", "index.js");
const modules = path.join(staging, "node_modules");
if (!fs.existsSync(entry)) throw new Error("A lefordított belépési pont hiányzik: " + entry);
if (!fs.existsSync(modules)) throw new Error("A függőségek nem települtek: " + modules);
for (const dep of Object.keys(manifest.dependencies ?? {})) {
  if (!fs.existsSync(path.join(modules, dep))) {
    throw new Error(`Hiányzó függőség a csomagban: ${dep}`);
  }
}
console.log(
  `[prepare-backend] kész: ${Object.keys(manifest.dependencies ?? {}).length} függőség ellenőrizve`
);
