#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Local start script for VCA (PowerShell / Windows, macOS, Linux).

.DESCRIPTION
    Verifies the toolchain, loads .env, ensures WORKSPACES_ROOT, installs
    dependencies, and launches the server.

.PARAMETER Prod
    Start in production mode (npm start) instead of the dev watcher.

.PARAMETER NoInstall
    Skip the dependency install step.

.EXAMPLE
    ./start.ps1
    ./start.ps1 -Prod
    ./start.ps1 -NoInstall
#>
[CmdletBinding()]
param(
    [switch]$Prod,
    [switch]$NoInstall
)

$ErrorActionPreference = "Stop"

# Always operate from the repo root (this script's directory).
Set-Location -Path $PSScriptRoot

# --- 1. Toolchain check -----------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is not installed or not on PATH. Install Node 24 (LTS) — the version Electron bundles internally."
    exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm is not installed or not on PATH."
    exit 1
}
Write-Host "Node $(node --version) / npm $(npm --version)"

# --- 2. Load .env -----------------------------------------------------------
if ((-not (Test-Path ".env")) -and (Test-Path ".env.example")) {
    Write-Host "No .env found - creating one from .env.example."
    Copy-Item ".env.example" ".env"
}
if (Test-Path ".env") {
    Write-Host "Loading environment from .env"
    foreach ($line in Get-Content ".env") {
        $trimmed = $line.Trim()
        if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }
        $idx = $trimmed.IndexOf("=")
        if ($idx -lt 1) { continue }
        $name = $trimmed.Substring(0, $idx).Trim()
        $value = $trimmed.Substring($idx + 1).Trim()
        # Strip surrounding single/double quotes if present.
        if ($value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or
             ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        Set-Item -Path "Env:$name" -Value $value
    }
}

# --- 3. WORKSPACES_ROOT -----------------------------------------------------
if (-not $env:WORKSPACES_ROOT) {
    $env:WORKSPACES_ROOT = "./.vca-data"
}
New-Item -ItemType Directory -Force -Path $env:WORKSPACES_ROOT | Out-Null
Write-Host "WORKSPACES_ROOT=$($env:WORKSPACES_ROOT)"

# Accept self-signed / intercepted certs (corporate TLS proxies). Applies to
# this server's outbound calls; spawned preview processes set it themselves.
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
$port = if ($env:PORT) { $env:PORT } else { "3000" }
Write-Host "PORT=$port"

# --- 4. Dependencies --------------------------------------------------------
if ((-not $NoInstall) -and (-not (Test-Path "node_modules"))) {
    Write-Host "Installing dependencies (npm install)..."
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# --- 5. Launch --------------------------------------------------------------
if ($Prod) {
    Write-Host "Starting VCA (production mode)..."
    npm start
} else {
    Write-Host "Starting VCA (dev mode, auto-reload). Open http://localhost:$port"
    npm run dev
}
