/**
 * think-language-temperature — OpenCode plugin entrypoint (v2.0.0, V2 API)
 *
 * OpenCode 2.x loads local plugins from `{config}/plugins/*.js` and requires
 * the default export to be a definition with `id` and `setup(ctx)`. V1
 * entrypoints (`{ id, version, server }`) are rejected at load time, so this
 * file registers V2 hooks instead:
 *
 * - `ctx.session.hook("prompt", ...)` runs once per admitted user prompt. It
 *   records the per-session mode: an explicit `[think:zh|en|auto]` marker, a
 *   1/2/3 menu answer, or the invalid-answer fallback.
 * - `ctx.session.hook("context", ...)` runs immediately before each agent
 *   model request. It applies `options.temperature` and appends the reasoning
 *   language (or first-turn menu) instruction to `system`.
 *
 * First-turn selection flow (unchanged from 1.x):
 * - If the first user message contains a valid `[think:zh|en|auto]` marker,
 *   that marker wins and the menu is skipped.
 * - Otherwise the session moves to `awaiting`: the model is instructed to
 *   print the menu verbatim on the first turn, and the user's 1/2/3 answer is
 *   recorded in a persistent per-session state file.
 * - Later turns apply the chosen temperature and reasoning-language
 *   instruction to every request of the session.
 *
 * IMPORTANT: OpenCode interprets every exported value of a plugin file as a
 * plugin candidate. Keep helpers inside this module (not exported) or in
 * `../lib/`.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  LANGUAGE_INSTRUCTION_PREFIX,
  LOG_PATH,
  buildLanguageInstruction,
  buildSetupInstruction,
  getTemperature,
  parseChoice,
  parseThinkMarker,
} from "../lib/think-language-temperature-core.js";
import {
  getSessionState,
  loadState,
  setSessionState,
} from "../lib/think-language-temperature-state.js";

const PLUGIN_ID = "think-language-temperature";
const PLUGIN_VERSION = "2.0.0";

const MAX_INVALID_CHOICES = Math.max(
  1,
  Number(process.env.THINK_LANGUAGE_MAX_INVALID) || 2,
);

function writeDebugLog(entry) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Logging must never break a model request.
  }
}

function promptText(event) {
  const text = event?.prompt?.text;
  return typeof text === "string" ? text : "";
}

function systemTexts(system) {
  if (!Array.isArray(system)) return [];
  return system
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean);
}

function hasInstruction(system) {
  return systemTexts(system).some((text) =>
    text.includes(LANGUAGE_INSTRUCTION_PREFIX),
  );
}

/**
 * Put the menu directive at the very end of the outgoing user message.
 *
 * A system note competes with a long system prompt and is easy for a model to
 * ignore; the last user turn is what most models follow most closely. This is
 * request-scoped: the persisted transcript keeps the user's original text, so
 * after the choice is recorded the original question is still there to answer.
 */
function reinforceMenuRequest(event, instruction) {
  if (!instruction || !Array.isArray(event?.messages)) return false;

  for (let i = event.messages.length - 1; i >= 0; i -= 1) {
    const message = event.messages[i];
    if (!message || message.role !== "user") continue;
    if (!Array.isArray(message.content)) return false;
    if (hasInstruction(message.content)) return false;

    try {
      message.content = [
        ...message.content,
        { type: "text", text: instruction },
      ];
      return true;
    } catch {
      // Frozen message objects: fall back to the system instruction.
      return false;
    }
  }
  return false;
}

/**
 * Decide what the next request must be told for this session.
 * Returns `null` when no instruction should be injected.
 */
function instructionFor(session) {
  if (session?.status === "chosen") {
    return buildLanguageInstruction(session.mode);
  }
  if (session?.status === "awaiting") {
    return buildSetupInstruction((session.invalidCount ?? 0) > 0);
  }
  return null;
}

function handlePrompt(state, event) {
  const sessionID = event?.sessionID;
  if (!sessionID) return;

  const text = promptText(event);
  const marker = parseThinkMarker(text);
  const existing = getSessionState(state, sessionID);

  let mode = null;
  let action = "menu-shown";
  let invalid = false;

  try {
    if (marker.validCount > 0) {
      mode = marker.mode;
      setSessionState(state, sessionID, {
        status: "chosen",
        mode,
        source: "marker",
        invalidCount: 0,
      });
      action = "marker-selected";
    } else if (existing?.status === "chosen") {
      mode = existing.mode;
      action = mode === "auto" ? "auto-mode" : "language-instruction";
    } else if (existing?.status === "awaiting") {
      const choice = parseChoice(text);
      if (choice) {
        mode = choice.mode;
        setSessionState(state, sessionID, {
          status: "chosen",
          mode,
          source: "menu",
          invalidCount: 0,
        });
        action = "menu-choice";
      } else {
        const invalidCount = (existing.invalidCount ?? 0) + 1;
        if (invalidCount >= MAX_INVALID_CHOICES) {
          mode = "auto";
          setSessionState(state, sessionID, {
            status: "chosen",
            mode,
            source: "default",
            invalidCount,
          });
          action = "fallback-auto";
        } else {
          setSessionState(state, sessionID, {
            status: "awaiting",
            mode: null,
            source: null,
            invalidCount,
          });
          action = "invalid-choice";
          invalid = true;
        }
      }
    } else {
      setSessionState(state, sessionID, {
        status: "awaiting",
        mode: null,
        source: null,
        invalidCount: 0,
      });
      action = "menu-shown";
    }
  } catch {
    // Never break prompt admission. The context hook falls back to defaults.
  }

  const session = getSessionState(state, sessionID);
  const entry = {
    ts: new Date().toISOString(),
    event: "prompt",
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    sessionID,
    messageID: event?.messageID ?? null,
    marker: marker.marker,
    mode: session?.mode ?? "default",
    status: session?.status ?? "unset",
    action,
    invalidCount: session?.invalidCount ?? 0,
    invalid,
    source: session?.source ?? "prompt",
  };
  writeDebugLog(entry);
}

function handleContext(state, event) {
  const sessionID = event?.sessionID;
  if (!sessionID) return;

  const session = getSessionState(state, sessionID);
  const mode = session?.status === "chosen" ? session.mode : "default";
  // Same constants the menu displays, so the shown value and the applied
  // value can never drift apart.
  const temperature = getTemperature(mode);
  const instruction = instructionFor(session);
  const menuTurn = session?.status === "awaiting";
  let reinforced = false;

  try {
    // Only the temperature is overridden; every other request option keeps
    // whatever the configuration and earlier hooks decided.
    if (event.options && typeof event.options === "object") {
      event.options.temperature = temperature;
    }

    if (
      instruction &&
      Array.isArray(event.system) &&
      !hasInstruction(event.system)
    ) {
      event.system.push({ type: "text", text: instruction });
    }

    if (menuTurn && instruction) {
      // The menu turn needs no work: drop the tools so a wandering model cannot
      // start exploring instead of printing the menu, and repeat the directive
      // in the last user turn where models follow instructions most closely.
      if (event.tools && typeof event.tools === "object") {
        event.tools = {};
      }
      reinforced = reinforceMenuRequest(event, instruction);
    }
  } catch {
    // Never break a model request.
  }

  const entry = {
    ts: new Date().toISOString(),
    event: "context",
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    sessionID,
    messageID: null,
    mode,
    status: session?.status ?? "unset",
    temperature,
    invalidCount: session?.invalidCount ?? 0,
    instruction: instruction
      ? session?.status === "awaiting"
        ? "setup"
        : "language"
      : null,
    reinforced,
    toolsDisabled: menuTurn,
    source: session?.source ?? "default",
  };
  writeDebugLog(entry);
}

export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    const state = loadState();

    await ctx.session.hook("prompt", (event) => {
      handlePrompt(state, event);
    });

    await ctx.session.hook("context", (event) => {
      handleContext(state, event);
    });
  },
};
