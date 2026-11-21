/**
 * think-language-temperature — OpenCode 2 plugin entrypoint (v2.0.0)
 *
 * Ported from the OpenCode plugin V1 contract to the V2 contract: the default
 * export is a `Plugin.define({ id, setup(ctx) })` definition. All hooks are
 * registered through the context inside `setup`.
 *
 * First-turn selection flow (native UI, unchanged from v1.3.0):
 * - If the first user message contains a valid `[think:zh|en|auto]` marker,
 *   that marker wins and the dialog is skipped (backward compatible).
 * - Otherwise the plugin injects a hidden instruction that makes the model
 *   call the built-in `question` tool, which renders a real interactive
 *   selection dialog (TUI option list / desktop dialog) with the options
 *   中文推理 / 英文推理 / 自定义 plus a free-text "type your own answer"
 *   entry. A text menu is the documented fallback if the tool fails.
 * - `tool.execute.after` intercepts the question tool result, verifies the
 *   dialog is ours via QUESTION_TEXT, and persists the choice:
 *   中文推理→zh, 英文推理→en, 自定义→follow-up text question,
 *   free text→custom reasoning rule.
 * - Later turns apply the chosen temperature and reasoning-language
 *   instruction (custom mode embeds the user-defined rule).
 *
 * V1 → V2 hook mapping used here:
 * - V1 `chat.message` (state machine) → `ctx.session.hook("prompt", ...)`
 * - V1 `chat.message` (hidden synthetic part) and
 *   V1 `experimental.chat.system.transform` (system fallback) →
 *   `ctx.session.hook("context" | "compaction" | "generate" | "title", ...)`
 *   editing `event.messages` / `event.system`. These request hooks affect
 *   only the outgoing model call, which is exactly what the V1 synthetic
 *   part did; V2 has no persisted-part equivalent, so the per-message
 *   instruction chosen at admission time is remembered in memory and
 *   re-applied to the transcript on every model request.
 * - V1 `chat.params` (`output.temperature`) → the same request hooks setting
 *   `event.options.temperature`. Registered for every request kind so the
 *   temperature and directive apply to all session model calls, matching V1.
 * - V1 `tool.execute.after` → `ctx.tool.hook("execute.after", ...)`.
 * - V1 `dispose()` → the cleanup function returned by `setup`.
 *
 * IMPORTANT: OpenCode treats every exported function in a plugin file as a
 * plugin. Keep helper functions in `../lib/` and export only the plugin
 * entrypoint here.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  DEFAULT_TEMPERATURE,
  LANGUAGE_INSTRUCTION_PREFIX,
  LOG_PATH,
  QUESTION_HEADER,
  QUESTION_TEXT,
  buildCustomPromptInstruction,
  buildEnforcedSetupInstruction,
  buildLanguageInstruction,
  buildSetupInstruction,
  getTemperature,
  parseChoice,
  parseThinkMarker,
  sanitizeCustomValue,
} from "../lib/think-language-temperature-core.js";
import {
  getSessionState,
  loadState,
  setSessionState,
} from "../lib/think-language-temperature-state.js";

const PLUGIN_ID = "think-language-temperature";
const PLUGIN_VERSION = "2.0.0";

/**
 * OpenCode 2 provides the `@opencode/plugin` module to plugins at runtime.
 * Outside OpenCode (e.g. running the test suite with plain Node), fall back
 * to an equivalent local `define` — `Plugin.define` is an identity function,
 * so the definition object is identical either way.
 */
let Plugin;
try {
  Plugin = (await import("@opencode/plugin")).Plugin;
} catch {
  Plugin = { define: (definition) => definition };
}

const MAX_INVALID_CHOICES = Math.max(
  1,
  Number(process.env.THINK_LANGUAGE_MAX_INVALID) || 2,
);

/** First-message cache, mirroring the V1 plugin. */
const firstMessageCache = new Map();
/**
 * Instruction recorded at prompt-admission time, keyed by
 * `${sessionID}:${messageID}`. Replaces the V1 persisted synthetic part:
 * the request hooks re-apply it to the outgoing transcript.
 */
const messageInstructions = new Map();
/** Cap for the instruction cache so long-lived servers stay bounded. */
const MAX_CACHED_INSTRUCTIONS = 2000;
/**
 * Sessions where the model skipped the setup flow (ran other tools or
 * produced text while the dialog was still pending). The next model request
 * gets the stern enforced instruction instead of the plain one.
 */
const skippedSessions = new Set();

function extractRequestMessageText(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.text === "string") return message.text;
  const parts = Array.isArray(message.parts) ? message.parts : null;
  if (parts) {
    return parts
      .filter(
        (part) =>
          part &&
          part.type === "text" &&
          typeof part.text === "string" &&
          part.synthetic !== true,
      )
      .map((part) => part.text)
      .join("\n");
  }
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter(
        (part) =>
          part &&
          part.type === "text" &&
          typeof part.text === "string" &&
          part.synthetic !== true,
      )
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function cacheFirstMessage(sessionID, messageID, text, origin) {
  if (!sessionID) return null;
  if (firstMessageCache.has(sessionID)) {
    return firstMessageCache.get(sessionID);
  }
  const result = {
    messageID: messageID ?? null,
    text,
    parsed: parseThinkMarker(text),
    origin,
  };
  firstMessageCache.set(sessionID, result);
  return result;
}

/**
 * Resolve the session's first user message. `history` is the transcript
 * already available in request-hook events; `currentText` is the prompt
 * being admitted in the prompt hook (not yet in history there).
 */
async function resolveFirstMessage(ctx, sessionID, history, currentText, currentMessageID, preferredOrigin) {
  if (!sessionID) return null;
  if (firstMessageCache.has(sessionID)) {
    return firstMessageCache.get(sessionID);
  }

  let first = null;
  if (Array.isArray(history)) {
    first = history.find((m) => m?.role === "user" || m?.type === "user") ?? null;
    if (first) {
      return cacheFirstMessage(
        sessionID,
        first.id ?? currentMessageID ?? null,
        extractRequestMessageText(first),
        "history",
      );
    }
  }

  // No transcript available (prompt admission): consult stored session
  // history first, like the V1 plugin did with session.messages. The current
  // prompt is only the first message when the session has no user message
  // yet (it is not admitted at this point).
  try {
    const response = await ctx.session.context({ sessionID });
    const messages = response?.data ?? response;
    if (Array.isArray(messages)) {
      const stored = messages.find((msg) => msg?.type === "user");
      if (stored) {
        return cacheFirstMessage(
          sessionID,
          stored.id ?? null,
          typeof stored.text === "string" ? stored.text : "",
          "session.context",
        );
      }
    }
  } catch {
    // Fall back to the current message if session history is unavailable.
  }

  if (typeof currentText === "string" && currentText) {
    return cacheFirstMessage(sessionID, currentMessageID ?? null, currentText, preferredOrigin ?? "prompt");
  }

  return null;
}

function writeDebugLog(entry) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Logging must never break a model request.
  }
}

function logToOpenCode(entry, message) {
  try {
    const line = `[${PLUGIN_ID}] ${message}`;
    if (entry.source === "error") console.warn(line);
    else console.log(line);
  } catch {
    // OpenCode console logging is best-effort.
  }
}

function rememberInstruction(sessionID, messageID, instruction) {
  if (!sessionID || !messageID || !instruction) return;
  if (messageInstructions.size >= MAX_CACHED_INSTRUCTIONS) {
    const oldest = messageInstructions.keys().next().value;
    if (oldest !== undefined) messageInstructions.delete(oldest);
  }
  messageInstructions.set(`${sessionID}:${messageID}`, instruction);
}

function hasInstructionPrefix(text) {
  return typeof text === "string" && text.includes(LANGUAGE_INSTRUCTION_PREFIX);
}

function messageHasInstruction(message) {
  if (!message || typeof message !== "object") return false;
  const parts = Array.isArray(message.parts) ? message.parts : null;
  if (parts) {
    return parts.some((part) => part?.type === "text" && hasInstructionPrefix(part?.text));
  }
  if (Array.isArray(message.content)) {
    return message.content.some((part) => part?.type === "text" && hasInstructionPrefix(part?.text));
  }
  return hasInstructionPrefix(message.content) || hasInstructionPrefix(message.text);
}

/**
 * Prepend the instruction as a hidden synthetic text part to a user message
 * in the outgoing request transcript (the V2 equivalent of the V1 synthetic
 * user-message part). Handles both parts-array and content-array messages.
 */
function prependSyntheticInstruction(message, instruction) {
  if (!message || typeof message !== "object" || messageHasInstruction(message)) return false;
  const part = { type: "text", text: instruction, synthetic: true };
  if (Array.isArray(message.parts)) {
    message.parts.unshift(part);
    return true;
  }
  if (Array.isArray(message.content)) {
    message.content.unshift(part);
    return true;
  }
  if (typeof message.content === "string") {
    message.content = [part, { type: "text", text: message.content }];
    return true;
  }
  if (message.content === undefined) {
    message.content = [part];
    return true;
  }
  return false;
}

const server = Plugin.define({
  id: PLUGIN_ID,

  async setup(ctx) {
    const state = loadState();

    /**
     * Prompt admission (V1 `chat.message` state machine). Runs once per
     * incoming user prompt, before durable admission. Does not mutate the
     * prompt text: the instruction is injected later, per model request.
     */
    await ctx.session.hook("prompt", async (event) => {
      try {
        const sessionID = event?.sessionID;
        if (!sessionID) return;

        const currentText =
          typeof event?.prompt?.text === "string" ? event.prompt.text : "";

        const first = await resolveFirstMessage(
          ctx,
          sessionID,
          null,
          currentText,
          event?.messageID ?? null,
          "prompt",
        );

        const marker = parseThinkMarker(first?.text ?? currentText);
        const existing = getSessionState(state, sessionID);

        let mode = null;
        let action = "menu-shown";
        let invalid = false;

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
        } else if (existing?.status === "awaiting-custom") {
          const customValue = sanitizeCustomValue(currentText);
          if (customValue) {
            mode = "custom";
            setSessionState(state, sessionID, {
              status: "chosen",
              mode: "custom",
              customValue,
              source: "menu",
              invalidCount: 0,
            });
            action = "custom-choice";
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
                status: "awaiting-custom",
                mode: null,
                customValue: null,
                source: null,
                invalidCount,
              });
              action = "invalid-custom";
              invalid = true;
            }
          }
        } else if (existing?.status === "awaiting") {
          const choice = parseChoice(currentText);
          if (choice && choice.mode === "custom") {
            setSessionState(state, sessionID, {
              status: "awaiting-custom",
              mode: null,
              customValue: null,
              source: "menu",
              invalidCount: 0,
            });
            action = "custom-prompt";
          } else if (choice) {
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

        const session = getSessionState(state, sessionID);
        let instruction;
        if (action === "custom-prompt") {
          instruction = buildCustomPromptInstruction(false);
        } else if (action === "invalid-custom") {
          instruction = buildCustomPromptInstruction(true);
        } else if (mode === "custom") {
          instruction = buildLanguageInstruction("custom", session?.customValue);
        } else if (mode) {
          instruction = buildLanguageInstruction(mode);
        } else if (skippedSessions.has(sessionID)) {
          // The model skipped the flow earlier: record the stern variant for
          // this message too, so the request hooks inject it.
          instruction = buildEnforcedSetupInstruction();
        } else {
          instruction = buildSetupInstruction(invalid);
        }

        if (instruction) {
          rememberInstruction(sessionID, event?.messageID ?? null, instruction);
        }

        const entry = {
          ts: new Date().toISOString(),
          event: "prompt",
          plugin: PLUGIN_ID,
          version: PLUGIN_VERSION,
          sessionID,
          messageID: event?.messageID ?? null,
          firstMessageID: first?.messageID ?? null,
          marker: marker.marker,
          mode: session?.mode ?? "default",
          status: session?.status ?? "unset",
          action,
          invalidCount: session?.invalidCount ?? 0,
          source: first?.origin ?? "prompt",
        };
        writeDebugLog(entry);
        logToOpenCode(
          entry,
          `prompt mode=${entry.mode} status=${entry.status} action=${entry.action}`,
        );
      } catch {
        // Admission observation must never break prompt handling.
      }
    });

    /**
     * Request hooks (V1 `chat.params` + `experimental.chat.system.transform`
     * + the message-part injection half of V1 `chat.message`). Registered
     * for every request kind so temperature and the directive apply to all
     * session model calls, matching V1 behavior.
     */
    const applyRequest = async (event, kind) => {
      try {
        const sessionID = event?.sessionID;
        const messages = Array.isArray(event?.messages) ? event.messages : [];

        const first = await resolveFirstMessage(
          ctx,
          sessionID,
          messages,
          null,
          null,
          kind,
        );

        let marker = first?.parsed ?? {
          mode: "default",
          marker: null,
          temperature: DEFAULT_TEMPERATURE,
          validCount: 0,
          invalidCount: 0,
        };

        let session = getSessionState(state, sessionID);
        if (!session && marker.validCount > 0) {
          session = setSessionState(state, sessionID, {
            status: "chosen",
            mode: marker.mode,
            source: "marker",
            invalidCount: 0,
          });
        }

        const mode =
          session?.status === "chosen" ? session.mode : "default";
        // Same constants the menu displays, so the shown value and the
        // applied value can never drift apart.
        const temperature = getTemperature(mode);

        if (event && typeof event === "object") {
          // Only this field is changed; all other request options untouched.
          event.options = event.options ?? {};
          event.options.temperature = temperature;
        }

        const instruction =
          session?.status === "chosen"
            ? session.mode === "custom"
              ? buildLanguageInstruction("custom", session.customValue)
              : buildLanguageInstruction(session.mode)
            : session?.status === "awaiting-custom"
              ? buildCustomPromptInstruction((session.invalidCount ?? 0) > 0)
              : session?.status === "awaiting"
                ? // The model skipped the setup flow earlier: switch to the
                  // stern enforced variant for this request.
                  skippedSessions.has(sessionID)
                  ? buildEnforcedSetupInstruction()
                  : buildSetupInstruction((session.invalidCount ?? 0) > 0)
                : null;

        if (instruction) {
          // 1. Hidden synthetic part on every user message of the outgoing
          //    transcript (V1 chat.message equivalent). The instruction
          //    recorded at each message's admission time wins; older or
          //    unknown messages fall back to the current instruction.
          let injected = 0;
          for (const message of messages) {
            const role = message?.role ?? (message?.type === "user" ? "user" : null);
            if (role !== "user") continue;
            const recorded = message?.id
              ? messageInstructions.get(`${sessionID}:${message.id}`)
              : undefined;
            const applied = recorded ?? instruction;
            if (applied && prependSyntheticInstruction(message, applied)) {
              injected += 1;
            }
          }

          // 2. Fallback directive appended to the system prompt (V1
          //    experimental.chat.system.transform equivalent).
          if (Array.isArray(event?.system)) {
            const already = event.system.some(
              (part) =>
                typeof part?.text === "string" &&
                part.text.includes(LANGUAGE_INSTRUCTION_PREFIX),
            );
            if (!already) event.system.push({ type: "text", text: instruction });
          }

          if (injected > 0) {
            const entry = {
              ts: new Date().toISOString(),
              event: kind,
              plugin: PLUGIN_ID,
              version: PLUGIN_VERSION,
              sessionID: sessionID ?? null,
              firstMessageID: first?.messageID ?? null,
              mode: session?.mode ?? "default",
              status: session?.status ?? "unset",
              action:
                session?.status === "awaiting-custom"
                  ? "appended-custom-prompt"
                  : session?.status === "awaiting"
                    ? "appended-setup-instruction"
                    : "appended-language-instruction",
              injectedParts: injected,
              source: session?.source ?? first?.origin ?? "none",
            };
            writeDebugLog(entry);
          }
        }

        const entry = {
          ts: new Date().toISOString(),
          event: `${kind}.params`,
          plugin: PLUGIN_ID,
          version: PLUGIN_VERSION,
          sessionID: sessionID ?? null,
          firstMessageID: first?.messageID ?? null,
          marker: marker.marker,
          mode,
          status: session?.status ?? "unset",
          temperature,
          validCount: marker.validCount,
          invalidCount: session?.invalidCount ?? marker.invalidCount,
          markerFound: marker.validCount > 0,
          source: session?.source ?? first?.origin ?? "default",
        };
        writeDebugLog(entry);

        logToOpenCode(
          entry,
          `${kind} temperature=${temperature} mode=${mode} status=${entry.status} source=${entry.source}`,
        );
      } catch {
        // Request transformation must never break a model call.
      }
    };

    await ctx.session.hook("context", (event) => applyRequest(event, "context"));
    await ctx.session.hook("compaction", (event) => applyRequest(event, "compaction"));
    await ctx.session.hook("generate", (event) => applyRequest(event, "generate"));
    await ctx.session.hook("title", (event) => applyRequest(event, "title"));

    /**
     * Question-dialog interception (V1 `tool.execute.after`).
     */
    await ctx.tool.hook("execute.after", async (event) => {
      try {
        if (event?.tool !== "question") return;
        if (event?.status && event.status !== "completed") return;
        const sessionID = event?.sessionID;
        if (!sessionID) return;

        const existing = getSessionState(state, sessionID);
        if (existing?.status !== "awaiting") return;

        // Only react to OUR first-turn dialog, never to questions the model
        // asks later for its own purposes.
        const questions = event?.input?.questions;
        const isOurs =
          Array.isArray(questions) &&
          questions.some(
            (q) =>
              q &&
              typeof q.question === "string" &&
              q.question.includes(QUESTION_TEXT),
          );
        if (!isOurs) return;

        // The question tool result comes in several shapes across builds:
        // {metadata:{answers}}, {answers}, {output}, or a content string.
        // Support all of them, plus a parse of the formatted output string
        // as a last resort.
        const result = event?.result;
        let raw = "";
        const answers = result?.metadata?.answers ?? result?.answers;
        if (Array.isArray(answers?.[0])) {
          raw = answers[0].join(", ").trim();
        }
        if (!raw && typeof result?.output === "string") {
          const pair = result.output.match(/"([^"]*)"\s*=\s*"([^"]*)"/);
          if (pair) raw = pair[2].trim();
        }
        if (!raw && typeof result?.content === "string") {
          const pair = result.content.match(/"([^"]*)"\s*=\s*"([^"]*)"/);
          if (pair) raw = pair[2].trim();
        }
        if (!raw && Array.isArray(result?.content)) {
          const text = result.content
            .filter((part) => part?.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n");
          const pair = text.match(/"([^"]*)"\s*=\s*"([^"]*)"/);
          raw = pair ? pair[2].trim() : text.trim();
        }
        if (!raw || raw === "Unanswered") {
          // Dialog dismissed or unanswered: keep waiting so the model's
          // text-menu fallback can still collect a choice.
          return;
        }

        let action = null;
        if (raw.includes("中文")) {
          setSessionState(state, sessionID, {
            status: "chosen",
            mode: "zh",
            source: "question-ui",
            invalidCount: 0,
          });
          action = "ui-choice-zh";
        } else if (raw.includes("英文") || /english/i.test(raw)) {
          setSessionState(state, sessionID, {
            status: "chosen",
            mode: "en",
            source: "question-ui",
            invalidCount: 0,
          });
          action = "ui-choice-en";
        } else if (raw.includes("自定义")) {
          setSessionState(state, sessionID, {
            status: "awaiting-custom",
            mode: null,
            customValue: null,
            source: "question-ui",
            invalidCount: 0,
          });
          action = "ui-choice-custom";
        } else {
          const customValue = sanitizeCustomValue(raw);
          if (!customValue) return;
          setSessionState(state, sessionID, {
            status: "chosen",
            mode: "custom",
            customValue,
            source: "question-ui",
            invalidCount: 0,
          });
          action = "ui-choice-custom-value";
        }

        const entry = {
          ts: new Date().toISOString(),
          event: "tool.execute.after",
          plugin: PLUGIN_ID,
          version: PLUGIN_VERSION,
          sessionID,
          callID: event?.id ?? null,
          answer: raw,
          action,
        };
        writeDebugLog(entry);
        logToOpenCode(entry, `tool.execute.after ${action} answer=${raw}`);
      } catch {
        // Observation only: never break the tool pipeline.
      }
    });

    /**
     * Hard enforcement (V1 `tool.execute.before` equivalent): while the
     * first-turn dialog is still pending, block every tool call except the
     * question tool itself. The error the model sees explains the setup
     * flow, so it self-corrects and pops the dialog. Disable by setting
     * THINK_LANGUAGE_ENFORCE=0.
     */
    const enforce = process.env.THINK_LANGUAGE_ENFORCE !== "0";
    if (enforce) {
      await ctx.tool.hook("execute.before", async (event) => {
        if (event?.tool === "question") return;
        const sessionID = event?.sessionID;
        if (!sessionID) return;

        const existing = getSessionState(state, sessionID);
        if (existing?.status !== "awaiting") return;

        skippedSessions.add(sessionID);

        const entry = {
          ts: new Date().toISOString(),
          event: "tool.execute.before",
          plugin: PLUGIN_ID,
          version: PLUGIN_VERSION,
          sessionID,
          callID: event?.id ?? null,
          blockedTool: event?.tool,
          action: "blocked-until-setup",
        };
        writeDebugLog(entry);
        logToOpenCode(
          entry,
          `tool.execute.before blocked ${event?.tool} until the reasoning-language setup completes`,
        );

        throw new Error(
          "The reasoning-language setup for this session has not been completed yet. " +
            "Before running any other tool, you MUST call the question tool now with exactly one question: " +
            `question: "${QUESTION_TEXT}", header: "${QUESTION_HEADER}", multiple: false, and the fixed options ` +
            `中文推理 / 英文推理 / 自定义. After the user answers, continue with the original task. ` +
            "If the question tool is unavailable, output the text menu " +
            '"1. 中文推理 2. 英文推理 3. 自定义" instead and wait for the user\'s reply.',
        );
      });
    }

    return () => {
      firstMessageCache.clear();
      messageInstructions.clear();
      skippedSessions.clear();
    };
  },
});

export default server;
