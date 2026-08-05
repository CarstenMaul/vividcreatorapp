// Sync package.json "version" to the current git tag before a build.
//
// The git tag is the source of truth for the release version; electron-builder
// stamps package.json's "version" into the installer filename/metadata
// (artifactName ${version}). Running this before each dist:* build keeps the
// two in lockstep, so `npm run dist:win` always packages the version of the tag
// that's checked out — no hand-editing package.json, no accidental drift.
//
// The other direction (bumping both together) stays with `npm run release:bump`
// (`npm version patch`), which updates package.json AND creates the matching tag.
//
// No-ops (and never fails the build) when there is no repo/tag, or when the
// version already matches.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const pkgUrl = new URL("../package.json", import.meta.url);

let tag;
try {
  // Closest tag reachable from HEAD, e.g. "v1.0.2".
  tag = execSync("git describe --tags --abbrev=0", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  console.warn("[sync-version] no git tag found — leaving package.json version unchanged");
  process.exit(0);
}

const version = tag.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.warn(`[sync-version] tag "${tag}" is not semver — leaving package.json version unchanged`);
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(pkgUrl, "utf8"));
if (pkg.version === version) {
  console.log(`[sync-version] package.json already at ${version} (tag ${tag})`);
  process.exit(0);
}

const prev = pkg.version;
pkg.version = version;
writeFileSync(pkgUrl, JSON.stringify(pkg, null, 2) + "\n");
console.log(`[sync-version] package.json ${prev} -> ${version} (from tag ${tag})`);
