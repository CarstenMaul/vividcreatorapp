// Downloads a self-contained Node.js (plus Git incl. Git Bash on Windows) so
// the packaged desktop Electron app can build and version-control the apps
// users create — and so the pi coding agent's bash tool works — WITHOUT
// requiring Node (or, on Windows, Git) to be installed on the machine.
//
// Windows host (dist:win) → resources/runtime/:
//   resources/runtime/node/node.exe    ← exact Node version Electron bundles
//   resources/runtime/git/cmd/git.exe  ← Git (PortableGit for Windows)
//   resources/runtime/git/bin/bash.exe ← Git Bash, exposed to the pi agent as
//                                         its shell (src/bundled-runtime.ts +
//                                         settingsManager.setShellPath)
//
// We bundle the full PortableGit (not MinGit) specifically because MinGit omits
// bash, and pi's shell tool requires a bash on Windows.
//
// macOS host (dist:mac) → resources/runtime-mac/<arch>/, one Node per DMG arch:
//   resources/runtime-mac/x64/node/bin/node    ← Intel
//   resources/runtime-mac/arm64/node/bin/node  ← Apple Silicon
// No git/bash on macOS: the system provides /usr/bin/git and /bin/bash, and a
// Finder-launched app's PATH covers /usr/bin — only Node (usually installed via
// nvm/homebrew into shell-only paths) needs bundling.
//
// electron-builder copies these into the app's resources dir (see the
// `extraResources` entries in electron-builder.yml; the mac entry picks the
// matching arch via ${arch}), and src/bundled-runtime.ts prepends the dirs to
// PATH at runtime. Containerized deployments do NOT use this — they get
// node + git + bash from the image (node:24-slim + git).
//
// Run via `npm run bundle:runtime` (also invoked automatically by `dist:win`
// and `dist:mac`). Pass --force to re-download even when the cache already has
// everything. The flow is keyed on the build host platform: darwin bundles the
// mac runtimes, anything else the win-x64 ones (Linux runs in containers and
// bundles nothing).

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Pinned Git for Windows version. If this exact release ever disappears the
// script falls back to the latest git-for-windows release (see resolveGit).
const GIT_VERSION = "2.47.1";

const RUNTIME_DIR = path.join(ROOT, "resources", "runtime");
const NODE_DIR = path.join(RUNTIME_DIR, "node");
const GIT_DIR = path.join(RUNTIME_DIR, "git");
const CACHE_DIR = path.join(ROOT, ".cache", "runtime");
const MANIFEST = path.join(RUNTIME_DIR, "manifest.json");

// macOS runtimes live outside resources/runtime so the Windows build (which
// copies all of resources/runtime) never picks them up. One subdir per
// electron-builder arch name, matched by ${arch} in electron-builder.yml.
const MAC_ARCHES = ["x64", "arm64"];
const RUNTIME_MAC_DIR = path.join(ROOT, "resources", "runtime-mac");
const MAC_MANIFEST = path.join(RUNTIME_MAC_DIR, "manifest.json");

const FORCE = process.argv.includes("--force");

// Corporate TLS-intercepting proxies present a self-signed chain that Node's
// fetch rejects by default — the rest of the project already disables strict
// TLS for the same reason (Dockerfile, start scripts, npm strict-ssl). Honour an
// explicit setting; otherwise relax it so the build works behind such proxies.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

function log(msg) {
  console.log(`[bundle-runtime] ${msg}`);
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

async function download(url, dest) {
  log(`download ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

// Windows 10/11 ship bsdtar (`tar.exe`) which extracts .zip archives. Using it
// keeps this script dependency-free.
function extractZip(zip, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync("tar", ["-xf", zip, "-C", destDir], { stdio: "inherit" });
}

// PortableGit ships as a 7-Zip self-extracting .exe. Run it unattended:
//   -y          assume Yes (don't wait for input — shows a brief progress bar
//               that auto-closes; does not block)
//   -o<dir>     output directory (path attached, no space)
// The contents (cmd/, bin/, usr/, mingw64/, …) extract flat into destDir.
function extractSfx(sfxPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync(sfxPath, ["-y", `-o${destDir}`], {
    stdio: "inherit",
    timeout: 300000,
  });
}

// The version of Node that the installed Electron binary runs internally. We
// bundle exactly this so the apps users build run on the same engine VCA does.
function detectElectronNodeVersion() {
  const electronExe = require("electron");
  if (typeof electronExe !== "string") {
    throw new Error("could not resolve the electron binary path from require('electron')");
  }
  const out = execFileSync(
    electronExe,
    ["-e", "process.stdout.write(process.versions.node)"],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" },
  );
  const ver = out.trim();
  if (!/^\d+\.\d+\.\d+$/.test(ver)) {
    throw new Error(`unexpected Node version from electron: "${ver}"`);
  }
  return ver;
}

// PortableGit (full Git for Windows, incl. Git Bash) — NOT MinGit, which omits
// bash. Distributed as a 7-Zip self-extracting .exe.
async function resolveGit() {
  const pinned = `https://github.com/git-for-windows/git/releases/download/v${GIT_VERSION}.windows.1/PortableGit-${GIT_VERSION}-64-bit.7z.exe`;
  try {
    const head = await fetch(pinned, { method: "HEAD", redirect: "follow" });
    if (head.ok) return { url: pinned, version: GIT_VERSION };
    log(`pinned PortableGit ${GIT_VERSION} not available (${head.status}); falling back to latest`);
  } catch (err) {
    log(`pinned PortableGit HEAD failed (${err?.message || err}); falling back to latest`);
  }
  const api = await fetch("https://api.github.com/repos/git-for-windows/git/releases/latest", {
    headers: { "User-Agent": "vca-bundle-runtime", Accept: "application/vnd.github+json" },
    redirect: "follow",
  });
  if (!api.ok) {
    throw new Error(`PortableGit pinned URL unavailable and GitHub API failed (${api.status})`);
  }
  const rel = await api.json();
  const asset = (rel.assets || []).find((a) => /^PortableGit-.*-64-bit\.7z\.exe$/.test(a.name));
  if (!asset) throw new Error("no PortableGit 64-bit asset found in latest git-for-windows release");
  const m = asset.name.match(/PortableGit-(.+)-64-bit\.7z\.exe/);
  return { url: asset.browser_download_url, version: m ? m[1] : "latest" };
}

function readManifest(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function bundleComplete(nodeVersion, gitVersion) {
  const m = readManifest(MANIFEST);
  return (
    m &&
    m.node === nodeVersion &&
    m.git === gitVersion &&
    fs.existsSync(path.join(NODE_DIR, "node.exe")) &&
    fs.existsSync(path.join(GIT_DIR, "cmd", "git.exe")) &&
    fs.existsSync(path.join(GIT_DIR, "bin", "bash.exe"))
  );
}

async function bundleNode(nodeVersion) {
  const name = `node-v${nodeVersion}-win-x64`;
  const zip = path.join(CACHE_DIR, `${name}.zip`);
  if (!fs.existsSync(zip)) {
    await download(`https://nodejs.org/dist/v${nodeVersion}/${name}.zip`, zip);
  } else {
    log(`using cached ${name}.zip`);
  }
  const tmp = path.join(CACHE_DIR, `extract-node-${nodeVersion}`);
  rmrf(tmp);
  extractZip(zip, tmp);
  // The zip extracts to a single top-level folder; flatten its contents into
  // resources/runtime/node so node.exe sits directly at node/node.exe.
  const inner = path.join(tmp, name);
  rmrf(NODE_DIR);
  fs.mkdirSync(NODE_DIR, { recursive: true });
  fs.cpSync(inner, NODE_DIR, { recursive: true });
  rmrf(tmp);
  if (!fs.existsSync(path.join(NODE_DIR, "node.exe"))) {
    throw new Error("node.exe missing after extraction");
  }
  log(`node ${nodeVersion} ready at ${NODE_DIR}`);
}

async function bundleGit() {
  const { url, version } = await resolveGit();
  const sfx = path.join(CACHE_DIR, `PortableGit-${version}-64-bit.7z.exe`);
  if (!fs.existsSync(sfx)) {
    await download(url, sfx);
  } else {
    log(`using cached PortableGit-${version}-64-bit.7z.exe`);
  }
  // The SFX extracts the portable tree (cmd/, bin/, usr/, mingw64/, …) flat into
  // resources/runtime/git.
  rmrf(GIT_DIR);
  extractSfx(sfx, GIT_DIR);
  if (!fs.existsSync(path.join(GIT_DIR, "cmd", "git.exe"))) {
    throw new Error("git/cmd/git.exe missing after extraction");
  }
  if (!fs.existsSync(path.join(GIT_DIR, "bin", "bash.exe"))) {
    throw new Error("git/bin/bash.exe missing after extraction (Git Bash not bundled)");
  }
  log(`git ${version} (with bash) ready at ${GIT_DIR}`);
  return version;
}

function macBundleComplete(nodeVersion) {
  const m = readManifest(MAC_MANIFEST);
  return (
    m &&
    m.node === nodeVersion &&
    MAC_ARCHES.every((arch) => fs.existsSync(path.join(RUNTIME_MAC_DIR, arch, "node", "bin", "node")))
  );
}

async function bundleMacNode(nodeVersion, arch) {
  const name = `node-v${nodeVersion}-darwin-${arch}`;
  const tarball = path.join(CACHE_DIR, `${name}.tar.gz`);
  if (!fs.existsSync(tarball)) {
    await download(`https://nodejs.org/dist/v${nodeVersion}/${name}.tar.gz`, tarball);
  } else {
    log(`using cached ${name}.tar.gz`);
  }
  // --strip-components=1 drops the tarball's single top-level folder so node
  // sits directly at <arch>/node/bin/node, and tar preserves the npm/npx
  // symlinks and executable bits (fs.cpSync would not, reliably).
  const dest = path.join(RUNTIME_MAC_DIR, arch, "node");
  rmrf(dest);
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xf", tarball, "-C", dest, "--strip-components=1"], { stdio: "inherit" });
  if (!fs.existsSync(path.join(dest, "bin", "node"))) {
    throw new Error(`${arch}: bin/node missing after extraction`);
  }
  log(`node ${nodeVersion} (darwin-${arch}) ready at ${dest}`);
}

async function mainMac(nodeVersion) {
  if (!FORCE && macBundleComplete(nodeVersion)) {
    log(`already bundled (node ${nodeVersion}, darwin ${MAC_ARCHES.join("+")}) — nothing to do (use --force to rebuild)`);
    return;
  }
  for (const arch of MAC_ARCHES) {
    await bundleMacNode(nodeVersion, arch);
  }
  fs.writeFileSync(
    MAC_MANIFEST,
    JSON.stringify(
      { node: nodeVersion, arches: MAC_ARCHES, platform: "darwin", builtAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
  log(`done — node ${nodeVersion} for darwin ${MAC_ARCHES.join("+")}`);
}

async function mainWin(nodeVersion) {
  const { version: gitVersion } = await resolveGit();

  if (!FORCE && bundleComplete(nodeVersion, gitVersion)) {
    log(`already bundled (node ${nodeVersion}, git ${gitVersion} + bash) — nothing to do (use --force to rebuild)`);
    return;
  }

  await bundleNode(nodeVersion);
  const actualGit = await bundleGit();

  fs.writeFileSync(
    MANIFEST,
    JSON.stringify(
      { node: nodeVersion, git: actualGit, bash: true, platform: "win-x64", builtAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
  log(`done — node ${nodeVersion}, git ${actualGit} (with bash)`);
}

async function main() {
  const nodeVersion = detectElectronNodeVersion();
  log(`electron bundles Node ${nodeVersion} — bundling that exact version`);
  if (process.platform === "darwin") {
    fs.mkdirSync(RUNTIME_MAC_DIR, { recursive: true });
    await mainMac(nodeVersion);
  } else {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    await mainWin(nodeVersion);
  }
}

main().catch((err) => {
  console.error(`[bundle-runtime] FAILED: ${err?.stack || err}`);
  process.exit(1);
});
