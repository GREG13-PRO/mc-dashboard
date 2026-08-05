#!/usr/bin/env node
/**
 * How much of the map is being coloured by guesswork.
 *
 * `block-colours.ts` resolves a block name by rule, and falls back to a hash of
 * the name when no rule matches. The hash is deterministic and readable, but it
 * has nothing to do with the block: this is what used to paint `dark_prismarine`
 * lilac and `short_grass` purple, and why the map looked like nothing in the
 * game. The rules cannot be checked by reading them - a rule that never fires is
 * indistinguishable from a rule that fires correctly - so the check is to run
 * them over the real worlds on the machine and count.
 *
 * Run it after touching the resolver, and after a Minecraft update: renames like
 * 1.20.3's `grass` -> `short_grass` are invisible to a typecheck and show up
 * here as a percentage jumping off zero.
 *
 *   node tools/map-colour-audit.js            # every server in servers.json
 *   node tools/map-colour-audit.js --dim nether
 *
 * Needs the built backend, so run it on the machine that serves the dashboard:
 *   npm run build --workspace backend && node tools/map-colour-audit.js
 *
 * Run it from the repository root. The surface cache lives at `data/map-cache`
 * relative to the working directory, so from anywhere else this either cannot
 * write and stops, or quietly leaves a stray cache behind where you stood.
 *
 * Exits non-zero if anything still falls through, so it can gate a deploy.
 */

const fs = require("node:fs");
const path = require("node:path");

const backend = path.join(__dirname, "..", "backend");
const dist = path.join(backend, "dist", "servers");
if (!fs.existsSync(path.join(dist, "map-surface.js"))) {
  console.error("The backend is not built. Run `npm run build` in backend/ first.");
  process.exit(2);
}

const { regionSurface, EMPTY } = require(path.join(dist, "map-surface.js"));
const { colourOf } = require(path.join(dist, "map-render.js"));

/**
 * The fallback, duplicated deliberately.
 *
 * Importing it would let the audit pass if the fallback itself changed, which is
 * exactly the sort of silent agreement this is meant to catch. Keep in step with
 * `hashed()` in block-colours.ts.
 */
function hashed(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return [((h >>> 16) & 0x7f) + 80, ((h >>> 8) & 0x7f) + 80, (h & 0x7f) + 80];
}

const args = process.argv.slice(2);
const dim = args.includes("--dim") ? args[args.indexOf("--dim") + 1] : "overworld";
// Enough regions to meet the whole block vocabulary of a world without reading a
// gigabyte of it; a spawn area covers what a player actually sees.
const MAX_REGIONS = Number(args.includes("--regions") ? args[args.indexOf("--regions") + 1] : 8);

const WORLD_DIR = { overworld: "world", nether: "world_nether", end: "world_the_end" };

async function main() {
  const registry = path.join(backend, "data", "servers.json");
  if (!fs.existsSync(registry)) {
    console.error(`No server registry at ${registry}.`);
    process.exit(2);
  }
  const servers = JSON.parse(fs.readFileSync(registry, "utf-8"));
  let worst = 0;
  let looked = 0;
  /**
   * Servers whose region files were found but could not be read.
   *
   * Without this the audit is happy to report 0.00% having read nothing at all -
   * which is what it did when run from the wrong directory, because the surface
   * cache path is relative to the working directory and every read threw. A
   * reassuring number from an empty measurement is worse than no number.
   */
  const unreadable = [];

  for (const entry of servers) {
    const regionDir = path.join(entry.folder, WORLD_DIR[dim] ?? "world", "region");
    if (!fs.existsSync(regionDir)) continue;
    const files = fs
      .readdirSync(regionDir)
      .filter((f) => f.endsWith(".mca"))
      .slice(0, MAX_REGIONS);
    if (files.length === 0) continue;
    looked++;

    const counts = new Map();
    const failures = [];
    for (const file of files) {
      const at = /r\.(-?\d+)\.(-?\d+)\.mca/.exec(file);
      if (!at) continue;
      let surface;
      try {
        surface = await regionSurface(entry, dim, regionDir, Number(at[1]), Number(at[2]));
      } catch (err) {
        failures.push(err.message);
        continue;
      }
      if (!surface) continue;
      for (let i = 0; i < surface.blocks.length; i++) {
        const id = surface.blocks[i];
        if (id === EMPTY) continue;
        const name = surface.palette[id];
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }

    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total === 0) {
      unreadable.push(`${entry.name}: ${files.length} region files, no readable columns` +
        (failures.length > 0 ? ` (${failures[0]})` : ""));
      continue;
    }

    // Counted by visible column, not by distinct name: one unrecognised block
    // covering half the ground matters more than twenty covering a flowerpot.
    const missed = [...counts].filter(([name]) => colourOf(name).join() === hashed(name).join());
    const missedTotal = missed.reduce((sum, [, count]) => sum + count, 0);
    const percent = (missedTotal / total) * 100;
    worst = Math.max(worst, percent);

    console.log(
      `${entry.name.padEnd(20)} ${String(files.length).padStart(2)} regions, ` +
        `${String(counts.size).padStart(3)} distinct blocks, ` +
        `${percent.toFixed(2)}% guessed`
    );
    for (const [name, count] of missed.sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`    ${((count / total) * 100).toFixed(3).padStart(7)}%  ${name}`);
    }
  }

  if (unreadable.length > 0) {
    console.error("\nCould not read a world that is present:");
    for (const line of unreadable) console.error(`    ${line}`);
    console.error("Run this from the repository root - the surface cache path is relative to it.");
    process.exit(2);
  }
  if (looked === 0) {
    console.log(`No server has a ${dim} world on this machine; nothing to audit.`);
    return;
  }
  console.log(`\nworst: ${worst.toFixed(2)}% of the visible surface coloured by hash`);
  if (worst > 0) {
    console.log("Add a rule for the blocks above in backend/src/servers/block-colours.ts.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
