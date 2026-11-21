#!/usr/bin/env bash
# Install script for think-language-temperature (Linux / macOS, OpenCode 2).
# Copies the plugin package (entrypoint + lib + package.json) into the
# OpenCode config plugin directory as a plugin package folder, which OpenCode 2
# auto-discovers. An existing installation is backed up first.
# Usage:  bash install.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config_home="${HOME}/.config/opencode"
target="${config_home}/plugins/think-language-temperature"
stamp="$(date +%Y%m%d-%H%M%S)"

if [[ -d "$target" ]]; then
  backup="${target}.bak-${stamp}"
  cp -r "$target" "$backup"
  echo "backed up existing -> $backup"
fi

mkdir -p "$target/src" "$target/lib"
cp "$repo_root/package.json" "$target/"
cp "$repo_root/src/index.js" "$target/src/"
cp "$repo_root/lib/think-language-temperature-core.js" "$target/lib/"
cp "$repo_root/lib/think-language-temperature-state.js" "$target/lib/"
echo "installed -> $target"

echo
echo "Done. OpenCode 2 provides the @opencode/plugin module itself, so no"
echo "node_modules is needed. Restart OpenCode (or start a new session) and"
echo "send any message in a new session to see the reasoning-language"
echo "selection dialog."
