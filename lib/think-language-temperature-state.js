/**
 * Persistent per-session selection state for think-language-temperature.
 *
 * The state file is intentionally outside the plugin entrypoint: OpenCode
 * treats every exported function in a plugin file as a plugin.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_STATE_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "think-language-state.json",
);

const MAX_SESSIONS = 500;

export function getStatePath() {
  return process.env.THINK_LANGUAGE_STATE_PATH || DEFAULT_STATE_PATH;
}

export function emptyState() {
  return { version: 1, sessions: {} };
}

export function loadState(path = getStatePath()) {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyState();
    if (!parsed.sessions || typeof parsed.sessions !== "object") {
      parsed.sessions = {};
    }
    parsed.version = 1;
    return parsed;
  } catch {
    return emptyState();
  }
}

export function saveState(state, path = getStatePath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // State persistence must never break a model request.
  }
}

export function getSessionState(state, sessionID) {
  if (!sessionID || !state?.sessions) return null;
  return state.sessions[sessionID] ?? null;
}

export function setSessionState(state, sessionID, patch, path = getStatePath()) {
  if (!sessionID) return null;
  if (!state.sessions) state.sessions = {};

  const previous = state.sessions[sessionID] ?? {};
  const next = {
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  state.sessions[sessionID] = next;
  pruneState(state);
  saveState(state, path);
  return next;
}

export function pruneState(state, maxSessions = MAX_SESSIONS) {
  if (!state?.sessions) return;
  const entries = Object.entries(state.sessions);
  if (entries.length <= maxSessions) return;

  entries
    .sort((a, b) => {
      const left = Date.parse(a[1]?.updatedAt ?? "") || 0;
      const right = Date.parse(b[1]?.updatedAt ?? "") || 0;
      return left - right;
    })
    .slice(0, entries.length - maxSessions)
    .forEach(([sessionID]) => {
      delete state.sessions[sessionID];
    });
}
