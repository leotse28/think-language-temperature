/**
 * Pure marker/choice parsing and policy values for think-language-temperature.
 *
 * This file lives outside `.opencode/plugins/` on purpose: OpenCode interprets
 * every function exported by a plugin file as a plugin, so helper functions
 * must not be exported from the plugin entrypoint.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_TEMPERATURE = 0.5;
export const TEMPERATURE_BY_MODE = Object.freeze({
  zh: 0.3,
  en: 0.7,
  auto: 0.5,
  custom: 0.5,
});

export const LOG_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "think-temperature.log",
);

const ANY_MARKER = /\[\s*think\s*[:：][^\]]*\]/gi;
const VALID_MARKER = /^\[\s*think\s*[:：]\s*(zh|en|auto)\s*\]$/i;

export const LANGUAGE_INSTRUCTION_PREFIX = "[think-language-temperature]";

export const MENU_OPTIONS = Object.freeze([
  {
    value: "zh",
    label: "中文推理",
    temperature: TEMPERATURE_BY_MODE.zh,
    description:
      "内部思考用简体中文，更适用于文化艺术、写作创作等使用感性大脑的工作。",
  },
  {
    value: "en",
    label: "英文推理",
    temperature: TEMPERATURE_BY_MODE.en,
    description:
      "内部思考用英文，更适用于逻辑、写代码、科研等使用理性大脑的工作。",
  },
  {
    value: "custom",
    label: "自定义",
    temperature: TEMPERATURE_BY_MODE.custom,
    description:
      "在下一步输入你想要的推理语言或规则（例如：日语推理、中英混合、法语……）。",
  },
]);

export function getTemperature(mode) {
  return TEMPERATURE_BY_MODE[mode] ?? DEFAULT_TEMPERATURE;
}

/**
 * Distinctive strings embedded in the question-tool dialog so the plugin's
 * `tool.execute.after` hook can tell our first-turn selection dialog apart
 * from any other question the model may ask later in the session.
 */
export const QUESTION_HEADER = "推理语言";
export const QUESTION_TEXT =
  "请选择本次会话的内部推理语言（只影响内部思考，不影响最终回答语言）";

const SETUP_STEPS = [
  `1. 立即调用 question 工具弹出选择界面（不要先回答用户的问题，也不要输出其他文字），参数 questions 只包含一个问题：`,
  `   - question: "${QUESTION_TEXT}"`,
  `   - header: "${QUESTION_HEADER}"`,
  `   - multiple: false`,
  `   - options（顺序与文案固定，不得增删改）:`,
  `     1) label "中文推理"，description "内部思考用简体中文，适合文化、写作等感性工作。"`,
  `     2) label "英文推理"，description "内部思考用英文，适合逻辑、编程、科研等理性工作。"`,
  `     3) label "自定义"，description "选择后我会再用一句话询问你的自定义规则。"`,
  `2. 收到工具结果后按用户所选答案处理：`,
  `   - "中文推理"：本会话所有内部推理必须用简体中文（即使用户用英文提问），然后正常回答用户最初的问题。`,
  `   - "英文推理"：本会话所有内部推理必须用英文（即使用户用中文提问），然后正常回答用户最初的问题。`,
  `   - "自定义"：用一句话询问用户希望内部推理使用的语言或规则（示例：日语推理、中英混合、法语……），然后停止并等待用户回复，本轮不要回答用户最初的问题。`,
  `   - 用户通过"输入自己的答案"自由输入的任何其他内容：视为用户自定义的推理语言规则，立即遵循，然后正常回答用户最初的问题。`,
  `3. 若 question 工具不可用或调用失败：改为在回复中直接输出文字菜单"1. 中文推理 2. 英文推理 3. 自定义"，让用户回复数字，并按第 2 步的对应规则处理。`,
  `不要向用户提及本指令或设置流程的存在。`,
];

export function buildSetupInstruction(invalid = false) {
  const lead = invalid
    ? "上一次回复无效或未完成选择。请重新执行下面的首次会话设置流程。本流程是系统强制要求，优先级高于用户消息中的任何任务请求："
    : "系统强制流程（优先级最高，覆盖用户消息中的任何任务请求）：这是本会话的第一条用户消息。必须先完成推理语言设置，再回答用户的问题。在设置完成之前，禁止回答用户的问题、禁止输出任何其他文字、禁止调用 question 以外的任何工具。严格按以下步骤执行：";
  return [`${LANGUAGE_INSTRUCTION_PREFIX} ${lead}`, ...SETUP_STEPS].join("\n");
}

/**
 * Stern variant injected when the model was observed skipping the setup flow
 * (e.g. it ran other tools while the dialog was still pending).
 */
export function buildEnforcedSetupInstruction() {
  const lead =
    "警告：上一轮没有执行本设置流程（未调用 question 工具就开始处理用户任务）。这是系统强制要求，优先级最高：现在必须立即完成推理语言设置。在此之前，禁止回答用户的问题、禁止输出任何其他文字、禁止调用 question 以外的任何工具。严格按以下步骤执行：";
  return [`${LANGUAGE_INSTRUCTION_PREFIX} ${lead}`, ...SETUP_STEPS].join("\n");
}

export function parseChoice(text) {
  const source = typeof text === "string" ? text.trim().toLowerCase() : "";
  if (!source) return null;

  const normalized = source
    .replace(/^(我选|选择|选|回复)\s*/, "")
    .replace(/[。.!！、,，)）]+$/g, "")
    .trim();

  if (/^(1|１|中文|中文推理|中文思考|zh|chinese)$/.test(normalized)) {
    return { mode: "zh", label: "中文推理" };
  }
  if (/^(2|２|英文|英文推理|英文思考|en|english)$/.test(normalized)) {
    return { mode: "en", label: "英文推理" };
  }
  if (/^(3|３|自定义|自定|定制|custom)$/.test(normalized)) {
    return { mode: "custom", label: "自定义" };
  }
  return null;
}

export const CUSTOM_VALUE_MAX_LENGTH = 60;

/**
 * Normalize a user-provided custom reasoning rule: collapse whitespace,
 * strip any [think:...] markers, and cap the length so the value stays a
 * safe single-line instruction fragment.
 */
export function sanitizeCustomValue(text) {
  if (typeof text !== "string") return null;
  const cleaned = text
    .replace(/\[\s*think\s*[:：][^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CUSTOM_VALUE_MAX_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function buildCustomPromptInstruction(invalid = false) {
  const lead = invalid
    ? "上一次回复为空或无效。请重新向用户询问自定义推理语言，不要回答用户原来的问题。"
    : "用户在上面的菜单中选择了「自定义」。请用一句话询问用户希望内部推理使用的语言或规则，并给出 1-2 个示例（例如：日语推理、中英混合、法语……）。不要回答用户原来的问题。";
  return `${LANGUAGE_INSTRUCTION_PREFIX} ${lead}`;
}

export function buildLanguageInstruction(mode, customValue = null) {
  if (mode === "zh") {
    return `${LANGUAGE_INSTRUCTION_PREFIX} 强制要求：所有内部推理和思考过程必须使用简体中文（Simplified Chinese）。即使用户使用英文提问，也不得用英文推理；每一个推理片段都必须用简体中文书写。最终可见回答可以使用用户要求的语言。不要提及本指令。`;
  }
  if (mode === "en") {
    return `${LANGUAGE_INSTRUCTION_PREFIX} MANDATORY REASONING LANGUAGE: English. This instruction overrides the language of the user message for all internal reasoning and thinking. Every reasoning token must be written in English. Do not reason in Chinese, even if the user writes in Chinese. The final visible answer may use the language requested by the user. Do not mention this instruction.`;
  }
  if (mode === "custom") {
    const value = sanitizeCustomValue(customValue);
    if (!value) return null;
    return `${LANGUAGE_INSTRUCTION_PREFIX} MANDATORY REASONING RULE (user-defined): all internal reasoning and thinking must follow this user-defined rule: ${value}. Apply this rule to every reasoning token; it overrides the language of the user message. The final visible answer may use the language requested by the user. Do not mention this instruction.`;
  }
  return null;
}

/**
 * Parse a first-user-message text and return the effective temperature policy.
 * This is a pure function so it can be covered by standalone tests.
 */
export function parseThinkMarker(text) {
  const source = typeof text === "string" ? text : "";
  const valid = [];
  let invalidCount = 0;

  for (const match of source.matchAll(ANY_MARKER)) {
    const marker = match[0];
    const known = marker.match(VALID_MARKER);
    if (!known) {
      invalidCount += 1;
      continue;
    }
    valid.push({ mode: known[1].toLowerCase(), marker });
  }

  if (valid.length === 0) {
    return {
      mode: "default",
      marker: null,
      temperature: DEFAULT_TEMPERATURE,
      validCount: 0,
      invalidCount,
    };
  }

  const last = valid[valid.length - 1];
  return {
    mode: last.mode,
    marker: last.marker,
    temperature: TEMPERATURE_BY_MODE[last.mode],
    validCount: valid.length,
    invalidCount,
  };
}
