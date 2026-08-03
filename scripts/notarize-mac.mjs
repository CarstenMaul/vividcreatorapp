#!/usr/bin/env node
// Sign + notarize + staple the macOS DMGs produced by electron-builder.
//
// electron-builder signs the app bundle with the "Developer ID Application"
// certificate and a hardened runtime, but it does NOT sign or notarize the DMG
// container itself. This script takes the finished DMGs in release/ and:
//   1. code-signs the DMG with the Developer ID Application identity
//      (so `spctl -t open` can assess the disk image as Notarized Developer ID)
//   2. submits each to Apple's notary service (notarytool, --wait)
//   3. staples the returned ticket into the DMG
//   4. validates the staple and runs a Gatekeeper assessment
//
// Notarizing the DMG also notarizes the .app inside it, so the distributed
// artifact passes Gatekeeper on download. (The .app itself is not individually
// stapled here; a machine that copies the app out and launches it while fully
// offline on first run would do an online check instead — a non-issue for the
// normal online case.)
//
// Credentials come from a notarytool keychain profile (default "VCA-NOTARY"),
// created once with:
//   xcrun notarytool store-credentials "VCA-NOTARY" \
//     --apple-id "you@example.com" --team-id "JBESYPZT8S"
// Override the profile name with NOTARY_PROFILE=<name>.
//
// The DMG-signing identity is auto-detected from the login keychain (the first
// "Developer ID Application" identity). Override with SIGNING_IDENTITY=<name>.
//
// Usage:
//   node scripts/notarize-mac.mjs              # every *.dmg in release/
//   node scripts/notarize-mac.mjs a.dmg b.dmg  # specific files

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const releaseDir = resolve(repoRoot, 'release');
const profile = process.env.NOTARY_PROFILE || 'VCA-NOTARY';

// Resolve the "Developer ID Application" identity used to sign the DMG.
function resolveSigningIdentity() {
  if (process.env.SIGNING_IDENTITY) return process.env.SIGNING_IDENTITY;
  const r = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const line = (r.stdout || '').split('\n').find((l) => l.includes('Developer ID Application'));
  const m = line && line.match(/"([^"]+)"/);
  return m ? m[1] : null;
}

function run(cmd, args) {
  console.log(`\n$ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status;
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Explicit DMG paths win; otherwise notarize every *.dmg in release/.
let dmgs = process.argv.slice(2).filter((a) => a.endsWith('.dmg'));
if (dmgs.length === 0) {
  if (!existsSync(releaseDir)) {
    console.error(`release/ not found at ${releaseDir} — build the DMGs first (e.g. npm run dist:mac).`);
    process.exit(1);
  }
  dmgs = readdirSync(releaseDir)
    .filter((f) => f.endsWith('.dmg'))
    .map((f) => join(releaseDir, f));
}
if (dmgs.length === 0) {
  console.error('No .dmg files found to notarize.');
  process.exit(1);
}

// Verify the keychain profile before uploading ~200 MB per DMG.
const check = capture('xcrun', ['notarytool', 'history', '--keychain-profile', profile]);
if (check.status !== 0) {
  console.error(`\nNotary credentials profile "${profile}" is not set up (or is invalid).`);
  if (check.stderr.trim()) console.error(check.stderr.trim());
  console.error('\nCreate it once (you will be prompted for the app-specific password):');
  console.error(`  xcrun notarytool store-credentials "${profile}" \\`);
  console.error('    --apple-id "<your-apple-id-email>" --team-id "JBESYPZT8S"');
  console.error('\nThen re-run:  npm run notarize:mac');
  process.exit(1);
}

const identity = resolveSigningIdentity();
if (!identity) {
  console.error('\nNo "Developer ID Application" signing identity found in the keychain.');
  console.error('Check with:  security find-identity -v -p codesigning');
  console.error('Or set SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)".');
  process.exit(1);
}

console.log(`Signing + notarizing ${dmgs.length} DMG(s)`);
console.log(`  identity: ${identity}`);
console.log(`  profile:  ${profile}`);
for (const d of dmgs) console.log(`  - ${d}`);

let failed = false;
for (const dmg of dmgs) {
  console.log(`\n=== ${dmg} ===`);
  if (!existsSync(dmg)) {
    console.error(`  missing: ${dmg}`);
    failed = true;
    continue;
  }

  // 1. Sign the DMG container itself (electron-builder only signs the app
  //    inside). Must happen before notarization: signing rewrites the file, so
  //    doing it after would invalidate any stapled ticket.
  if (run('codesign', ['--force', '--timestamp', '--sign', identity, dmg]) !== 0) {
    console.error(`  signing failed for ${dmg}`);
    failed = true;
    continue;
  }

  // 2. Submit and wait. notarytool exits non-zero unless status is Accepted.
  if (run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait']) !== 0) {
    console.error(`  notarization did NOT succeed for ${dmg} (see status above).`);
    console.error('  Fetch the detailed log with:');
    console.error(`    xcrun notarytool log <submission-id> --keychain-profile ${profile}`);
    failed = true;
    continue;
  }

  // 3. Staple the ticket into the DMG.
  if (run('xcrun', ['stapler', 'staple', dmg]) !== 0) {
    console.error(`  stapling failed for ${dmg}`);
    failed = true;
    continue;
  }

  // 4. Validate the staple + Gatekeeper assessment.
  run('xcrun', ['stapler', 'validate', dmg]);
  run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg]);
}

if (failed) {
  console.error('\nOne or more DMGs failed to notarize/staple.');
  process.exit(1);
}
console.log('\nAll DMGs notarized, stapled and validated. Distribute these exact files.');
