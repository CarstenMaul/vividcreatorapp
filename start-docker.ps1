#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build and run VCA in Docker (Windows/macOS/Linux via Docker Desktop).

.DESCRIPTION
    Verifies docker is available, ensures .env exists, builds the image (if
    missing or -Rebuild), then runs the container with .env loaded and the
    workspace data dir mounted at /mnt/storage.

.PARAMETER Rebuild
    Force a cache-bypassing `docker build --no-cache`. Default builds use the
    layer cache (so a no-change rebuild is near-instant) — pass -Rebuild when
    you want every layer re-executed.

.PARAMETER NoBuild
    Skip `docker build`; require the image to already exist.

.PARAMETER Detach
    Run the container in the background (`docker run -d`).

.PARAMETER Port
    Host port to publish (default: PORT from .env, else 3000).

.PARAMETER ImageName
    Image tag to build/run (default: vca:local).

.PARAMETER ContainerName
    Container name (default: vca).

.PARAMETER DataDir
    Host directory mounted at /mnt/storage (default: ./.vca-data-docker).

.EXAMPLE
    ./start-docker.ps1
    ./start-docker.ps1 -Rebuild
    ./start-docker.ps1 -Detach -Port 8080
#>
[CmdletBinding()]
param(
    [switch]$Rebuild,
    [switch]$NoBuild,
    [switch]$Detach,
    [int]$Port,
    [string]$ImageName = "vca:local",
    [string]$ContainerName = "vca",
    [string]$DataDir = "./.vca-data-docker"
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# --- 1. Docker check --------------------------------------------------------
# Native command stderr handling: we never redirect with `2>X` here because
# PowerShell 5.1 wraps native stderr lines as ErrorRecords, which combined
# with $ErrorActionPreference = "Stop" would halt the script even on expected
# non-zero exits (e.g. "image not found").
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "Docker is not installed or not on PATH. Install Docker Desktop and retry."
    exit 1
}
& docker info | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker daemon is not reachable. Start Docker Desktop and retry."
    exit 1
}

# --- 2. Ensure .env ---------------------------------------------------------
if ((-not (Test-Path ".env")) -and (Test-Path ".env.example")) {
    Write-Host "No .env found - creating one from .env.example."
    Copy-Item ".env.example" ".env"
}
if (-not (Test-Path ".env")) {
    Write-Error ".env is required. Copy .env.example to .env and retry."
    exit 1
}

# --- 3. Resolve port (CLI flag > .env > 3000) -------------------------------
if (-not $Port) {
    $match = Select-String -Path ".env" -Pattern "^\s*PORT\s*=\s*(\d+)" | Select-Object -First 1
    if ($match) { $Port = [int]$match.Matches[0].Groups[1].Value } else { $Port = 3000 }
}

# --- 4. Resolve data dir to an absolute host path ---------------------------
$AbsDataDir = (New-Item -ItemType Directory -Force -Path $DataDir).FullName
Write-Host "Image:      $ImageName"
Write-Host "Container:  $ContainerName"
Write-Host "Host port:  $Port"
Write-Host "Data mount: $AbsDataDir -> /mnt/storage"

# --- 5. Build image ---------------------------------------------------------
# Always build unless -NoBuild is passed. Docker's layer cache makes a
# no-change build nearly free, and rebuilding by default means a `git pull`
# is enough to pick up source changes — no stale-image footgun.
if ($NoBuild) {
    # `docker images -q` prints the image id to stdout or nothing — never
    # stderr — so it's safe under $ErrorActionPreference = "Stop".
    $ImageId = & docker images -q $ImageName
    if ([string]::IsNullOrWhiteSpace($ImageId)) {
        Write-Error "Image $ImageName does not exist and -NoBuild was passed."
        exit 1
    }
    Write-Host "Skipping build; using existing $ImageName."
} else {
    if ($Rebuild) {
        Write-Host "Building image $ImageName (--no-cache)..."
        & docker build --no-cache -t $ImageName .
    } else {
        Write-Host "Building image $ImageName (cached layers reused)..."
        & docker build -t $ImageName .
    }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# --- 6. Stop any existing container with the same name ---------------------
# Pre-filter with `docker ps -aq` so we only call `rm -f` when there's a hit,
# avoiding the "No such container" stderr line that would otherwise abort.
$ExistingContainer = & docker ps -aq -f "name=^$ContainerName$"
if (-not [string]::IsNullOrWhiteSpace($ExistingContainer)) {
    & docker rm -f $ContainerName | Out-Null
}

# --- 7. Run -----------------------------------------------------------------
$runArgs = @(
    "run", "--rm",
    "--name", $ContainerName,
    "-p", "${Port}:3000",
    "-v", "${AbsDataDir}:/mnt/storage",
    "--env-file", ".env",
    "-e", "WORKSPACES_ROOT=/mnt/storage",
    "-e", "PORT=3000",
    "-e", "NODE_TLS_REJECT_UNAUTHORIZED=0"
)
Write-Host "/mnt/storage is mounted from local folder: $AbsDataDir"
if ($Detach) {
    $runArgs += "-d"
    $runArgs += $ImageName
    Write-Host "Starting container in detached mode..."
    & docker @runArgs
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Container running. Open http://localhost:$Port"
        Write-Host "Follow logs:  docker logs -f $ContainerName"
        Write-Host "Stop:         docker stop $ContainerName"
    }
    exit $LASTEXITCODE
} else {
    $runArgs += "-it"
    $runArgs += $ImageName
    Write-Host "Starting container. Open http://localhost:$Port (Ctrl+C to stop)"
    & docker @runArgs
    exit $LASTEXITCODE
}
