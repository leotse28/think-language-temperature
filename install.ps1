# Install script for think-language-temperature (Windows, OpenCode 2).
# Copies the plugin package (entrypoint + lib + package.json) into the
# OpenCode config plugin directory as a plugin package folder, which OpenCode 2
# auto-discovers. An existing installation is backed up first.
# Usage:  powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configHome = Join-Path $env:USERPROFILE ".config\opencode"
$targetPluginDir = Join-Path $configHome "plugins\think-language-temperature"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

if (Test-Path $targetPluginDir) {
  $backup = "$targetPluginDir.bak-$stamp"
  Copy-Item $targetPluginDir $backup -Recurse -Force
  Write-Host "backed up existing -> $backup"
}

New-Item -ItemType Directory -Force -Path (Join-Path $targetPluginDir "src") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $targetPluginDir "lib") | Out-Null

Copy-Item (Join-Path $repoRoot "package.json") $targetPluginDir -Force
Copy-Item (Join-Path $repoRoot "src\index.js") (Join-Path $targetPluginDir "src") -Force
Copy-Item (Join-Path $repoRoot "lib\think-language-temperature-core.js") (Join-Path $targetPluginDir "lib") -Force
Copy-Item (Join-Path $repoRoot "lib\think-language-temperature-state.js") (Join-Path $targetPluginDir "lib") -Force

Write-Host "installed -> $targetPluginDir"
Write-Host ""
Write-Host "Done. OpenCode 2 provides the @opencode/plugin module itself, so no"
Write-Host "node_modules is needed. Restart OpenCode (or start a new session) and"
Write-Host "send any message in a new session to see the reasoning-language"
Write-Host "selection dialog."
