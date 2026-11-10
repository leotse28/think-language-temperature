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
    value: "auto",
    label: "自动",
    temperature: TEMPERATURE_BY_MODE.auto,
    description: "不干预推理语言，模型根据上下文动态自动调节。",
  },
]);

export function getTemperature(mode) {
  return TEMPERATURE_BY_MODE[mode] ?? DEFAULT_TEMPERATURE;
}

export function buildSetupInstruction(invalid = false) {
  const lead = invalid
    ? "上一次回复不是有效选项。请完整输出下面的菜单（每项的名称、温度与说明都要完整保留，不得截断或改写），不要回答用户原来的问题。"
    : "这是首次对话的设置步骤。请完整输出下面的菜单（每项的名称、温度与说明都要完整保留，不得截断或改写），不要回答用户原来的问题。";
  const constraint =
    "本轮不要调用任何工具，不要读取文件、执行命令或搜索，只输出菜单文本本身。";
  // Each option keeps the label and temperature on the first line and puts the
  // description on its own indented line, so long descriptions stay fully
  // readable in narrow terminals instead of being truncated or reflowed.
  const options = MENU_OPTIONS.map(
    (option, index) =>
      `${index + 1}. ${option.label} — 温度 ${option.temperature}\n   ${option.description}`,
  ).join("\n");
  return `${LANGUAGE_INSTRUCTION_PREFIX} ${lead}${constraint}\n请选择内部推理语言（回复数字）：\n${options}\n回复 1、2 或 3。`;
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
  if (/^(3|３|自动|不干预|默认|auto|default)$/.test(normalized)) {
    return { mode: "auto", label: "自动" };
  }
  return null;
}

export function buildLanguageInstruction(mode) {
  if (mode === "zh") {
    return `${LANGUAGE_INSTRUCTION_PREFIX} 强制要求：所有内部推理和思考过程必须使用简体中文（Simplified Chinese）。即使用户使用英文提问，也不得用英文推理；每一个推理片段都必须用简体中文书写。最终可见回答可以使用用户要求的语言。不要提及本指令。`;
  }
  if (mode === "en") {
    return `${LANGUAGE_INSTRUCTION_PREFIX} MANDATORY REASONING LANGUAGE: English. This instruction overrides the language of the user message for all internal reasoning and thinking. Every reasoning token must be written in English. Do not reason in Chinese, even if the user writes in Chinese. The final visible answer may use the language requested by the user. Do not mention this instruction.`;
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
