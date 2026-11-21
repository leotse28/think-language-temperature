// Portable unit tests for think-language-temperature V2 (question-tool UI flow).
// Run from the repository root:  node test/test.mjs
//
// The tests drive the V2 plugin contract with a mock plugin context:
// - ctx.session.hook(kind, cb) captures the prompt / context / compaction /
//   generate / title handlers.
// - ctx.tool.hook("execute.after", cb) captures the question interceptor.
// - ctx.session.context() simulates stored session history.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

const statePath = join(tmpdir(), `tlt-test-state-${Date.now()}-${process.pid}.json`);
process.env.THINK_LANGUAGE_STATE_PATH = statePath;
rmSync(statePath, { force: true });

const coreUrl = pathToFileURL(join(pkgRoot, "lib", "think-language-temperature-core.js")).href;
const stateUrl = pathToFileURL(join(pkgRoot, "lib", "think-language-temperature-state.js")).href;
const entryUrl = pathToFileURL(join(pkgRoot, "src", "index.js")).href;

const m = await import(coreUrl);
const st = await import(stateUrl);
const e = await import(entryUrl);

// --- Mock plugin context -------------------------------------------------
const storedMessages = new Map(); // sessionID -> [{ type, id, text }]
const hooks = { session: {}, tool: {} };

const mockCtx = {
  session: {
    hook: async (kind, cb) => {
      hooks.session[kind] = cb;
    },
    context: async ({ sessionID }) => ({
      data: (storedMessages.get(sessionID) ?? []).map((msg) => ({ ...msg })),
    }),
  },
  tool: {
    hook: async (name, cb) => {
      if (name === "execute.before") hooks.tool[name] = cb;
      else hooks.tool[name] = cb;
    },
  },
};

const results = [];
const t = (name, cond) => results.push((cond ? "PASS" : "FAIL") + "  " + name);

const cleanup = await e.default.setup(mockCtx);
const promptHook = hooks.session.prompt;
const contextHook = hooks.session.context;
const afterHook = hooks.tool["execute.after"];
const beforeHook = hooks.tool["execute.before"];
t("T0 setup registers prompt hook", typeof promptHook === "function");
t("T0 setup registers context hook", typeof contextHook === "function");
t("T0 setup registers tool execute.after hook", typeof afterHook === "function");
t("T0 setup registers tool execute.before hook (enforcement)", typeof beforeHook === "function");

function requestEvent(sessionID, messages) {
  return {
    sessionID,
    system: [],
    messages: messages.map((msg) => ({
      id: msg.id,
      role: "user",
      content: [{ type: "text", text: msg.text }],
    })),
    options: {},
  };
}

// Simulate a full turn: prompt admission, then the model request built from
// the admitted transcript (as OpenCode would assemble it).
async function turn(sessionID, text, messageID) {
  const mid = messageID ?? "m_" + sessionID + "_" + Math.random().toString(36).slice(2, 8);
  await promptHook({
    sessionID,
    messageID: mid,
    prompt: { text, files: [], agents: [], skills: [] },
    delivery: "steer",
  });
  const history = storedMessages.get(sessionID) ?? [];
  const event = requestEvent(sessionID, [...history, { id: mid, text }]);
  await contextHook(event);
  return event;
}

function injectedTexts(event) {
  return event.messages
    .flatMap((msg) => (Array.isArray(msg.content) ? msg.content : []))
    .filter((part) => part?.type === "text" && part?.synthetic === true)
    .map((part) => part.text);
}

function uiAnswer(sessionID, labels, questionText) {
  return afterHook({
    tool: "question",
    sessionID,
    agent: "build",
    messageID: "mm_" + sessionID,
    id: "c_" + sessionID,
    status: "completed",
    input: {
      questions: [{ question: questionText ?? m.QUESTION_TEXT, header: m.QUESTION_HEADER, options: [] }],
    },
    result: {
      title: "Asked 1 question",
      output: "User has answered",
      metadata: { answers: [labels] },
    },
  });
}

// --- Scenario 1: first turn injects the question-tool instruction ---
{
  const sid = "s1";
  const event = await turn(sid, "hello");
  const s = st.getSessionState(st.loadState(), sid);
  const injected = injectedTexts(event);
  t("S1 first turn -> awaiting", s?.status === "awaiting");
  t("S1 instruction is synthetic", injected.length === 1);
  t("S1 instruction mandates question tool", injected[0]?.includes("question 工具") && injected[0]?.includes("立即调用"));
  t("S1 instruction carries QUESTION_TEXT", injected[0]?.includes(m.QUESTION_TEXT));
  t("S1 instruction lists 3 options", injected[0]?.includes("中文推理") && injected[0]?.includes("英文推理") && injected[0]?.includes("自定义"));
  t("S1 instruction has text fallback", injected[0]?.includes("文字菜单"));
  t("S1 instruction handles free input", injected[0]?.includes("输入自己的答案"));
  t("S1 system fallback appended", event.system.some((p) => p?.text?.includes("question 工具")));
  t("S1 temperature 0.5 while awaiting", event.options.temperature === 0.5);
}

// --- Scenario 2: dialog answer 中文推理 -> chosen zh ---
{
  const sid = "s2";
  await turn(sid, "hi");
  await uiAnswer(sid, ["中文推理"]);
  const s = st.getSessionState(st.loadState(), sid);
  t("S2 zh via UI -> chosen", s?.status === "chosen" && s?.mode === "zh");
  t("S2 source is question-ui", s?.source === "question-ui");
  const event = await turn(sid, "write a poem");
  const injected = injectedTexts(event);
  t("S2 next turn injects zh instruction", injected.some((x) => x.includes("简体中文")));
  t("S2 temperature 0.3 for zh", event.options.temperature === 0.3);
}

// --- Scenario 3: dialog answer 英文推理 -> chosen en ---
{
  const sid = "s3";
  await turn(sid, "hi");
  await uiAnswer(sid, ["英文推理"]);
  const s = st.getSessionState(st.loadState(), sid);
  t("S3 en via UI -> chosen", s?.status === "chosen" && s?.mode === "en");
  const event = await turn(sid, "hello again");
  t("S3 temperature 0.7 for en", event.options.temperature === 0.7);
}

// --- Scenario 4: 自定义 -> follow-up question -> text rule -> chosen custom ---
{
  const sid = "s4";
  await turn(sid, "hi");
  await uiAnswer(sid, ["自定义"]);
  let s = st.getSessionState(st.loadState(), sid);
  t("S4 自定义 -> awaiting-custom", s?.status === "awaiting-custom" && s?.mode === null);
  const event = await turn(sid, "日语推理，代码注释用中文");
  s = st.getSessionState(st.loadState(), sid);
  t("S4 text rule -> chosen custom", s?.status === "chosen" && s?.mode === "custom");
  t("S4 customValue persisted", s?.customValue === "日语推理，代码注释用中文");
  t("S4 custom instruction injected", injectedTexts(event).some((x) => x.includes("日语推理，代码注释用中文")));
}

// --- Scenario 5: free-typed dialog answer -> chosen custom directly ---
{
  const sid = "s5";
  await turn(sid, "hi");
  await uiAnswer(sid, ["法语推理"]);
  const s = st.getSessionState(st.loadState(), sid);
  t("S5 free text -> chosen custom", s?.status === "chosen" && s?.mode === "custom" && s?.customValue === "法语推理");
}

// --- Scenario 5b: alternative question-tool result shapes ---
{
  const sid = "s5b";
  await turn(sid, "hi");
  await afterHook({
    tool: "question", sessionID: sid, agent: "build", messageID: "m5b", id: "c5b",
    status: "completed",
    input: { questions: [{ question: m.QUESTION_TEXT, header: m.QUESTION_HEADER, options: [] }] },
    result: { answers: [["英文推理"]] },
  });
  let s = st.getSessionState(st.loadState(), sid);
  t("S5b {answers} shape -> chosen en", s?.status === "chosen" && s?.mode === "en");

  const sid2 = "s5b2";
  await turn(sid2, "hi");
  await afterHook({
    tool: "question", sessionID: sid2, agent: "build", messageID: "m5b2", id: "c5b2",
    status: "completed",
    input: { questions: [{ question: m.QUESTION_TEXT, header: m.QUESTION_HEADER, options: [] }] },
    result: { output: 'User has answered your questions: "' + m.QUESTION_TEXT + '"="中文推理". You can now continue.' },
  });
  s = st.getSessionState(st.loadState(), sid2);
  t("S5b output-string fallback -> chosen zh", s?.status === "chosen" && s?.mode === "zh");

  const sid3 = "s5b3";
  await turn(sid3, "hi");
  await afterHook({
    tool: "question", sessionID: sid3, agent: "build", messageID: "m5b3", id: "c5b3",
    status: "completed",
    input: { questions: [{ question: m.QUESTION_TEXT, header: m.QUESTION_HEADER, options: [] }] },
    result: { content: [{ type: "text", text: 'Q: "' + m.QUESTION_TEXT + '"="英文推理"' }] },
  });
  s = st.getSessionState(st.loadState(), sid3);
  t("S5b content-array fallback -> chosen en", s?.status === "chosen" && s?.mode === "en");
}

// --- Scenario 6: negatives ---
{
  const sid = "s6";
  await turn(sid, "hi");
  await afterHook({
    tool: "bash", sessionID: sid, agent: "build", messageID: "m6", id: "x",
    status: "completed", input: {}, result: { metadata: { answers: [["中文推理"]] } },
  });
  let s = st.getSessionState(st.loadState(), sid);
  t("S6 non-question tool ignored", s?.status === "awaiting");

  await uiAnswer(sid, ["中文推理"], "an unrelated question?");
  s = st.getSessionState(st.loadState(), sid);
  t("S6 foreign question ignored", s?.status === "awaiting");

  await uiAnswer(sid, []);
  s = st.getSessionState(st.loadState(), sid);
  t("S6 unanswered dialog keeps awaiting", s?.status === "awaiting");

  await uiAnswer(sid, ["中文推理"]);
  s = st.getSessionState(st.loadState(), sid);
  t("S6 answers after negatives work", s?.status === "chosen" && s?.mode === "zh");

  await uiAnswer(sid, ["英文推理"]);
  s = st.getSessionState(st.loadState(), sid);
  t("S6 chosen state not overwritten", s?.mode === "zh");
}

// --- Scenario 7: system fallback after UI choice (context hook) ---
{
  const sid = "s2";
  const event = requestEvent(sid, [{ id: "m_s2_2", text: "another turn" }]);
  // s2 has history from scenario 2; register it so first-message resolution works.
  storedMessages.set(sid, [{ type: "user", id: "m_s2_first", text: "hi" }]);
  await contextHook(event);
  t("S7 system fallback appends zh directive", event.system.some((p) => p?.text?.includes("简体中文")));
}

// --- Scenario 8: [think:] marker bypasses the dialog ---
{
  const sid = "s8";
  const event = await turn(sid, "[think:en] hello");
  const s = st.getSessionState(st.loadState(), sid);
  t("S8 marker -> chosen en", s?.status === "chosen" && s?.mode === "en");
  t("S8 marker injects en directive directly", injectedTexts(event).some((x) => x.includes("MANDATORY REASONING LANGUAGE: English")));
  t("S8 temperature 0.7 from marker", event.options.temperature === 0.7);
}

// --- Scenario 9: text-menu fallback still parses 1/2/3 ---
{
  const sid = "s9";
  await turn(sid, "hi");
  await turn(sid, "2");
  const s = st.getSessionState(st.loadState(), sid);
  t("S9 text reply 2 -> chosen en", s?.status === "chosen" && s?.mode === "en");
}

// --- Scenario 10: title/compaction/generate hooks get the same treatment ---
{
  const sid = "s10";
  await turn(sid, "[think:zh] 你好");
  const titleEvent = {
    sessionID: sid,
    system: [],
    messages: [{ id: "m10", role: "user", content: [{ type: "text", text: "[think:zh] 你好" }] }],
    options: {},
  };
  await hooks.session.title(titleEvent);
  t("S10 title hook applies temperature 0.3", titleEvent.options.temperature === 0.3);
  t("S10 title hook appends zh directive", titleEvent.system.some((p) => p?.text?.includes("简体中文")));
}

// --- Cleanup function clears caches ---
{
  await cleanup();
  t("T11 cleanup runs without error", true);
}

// --- Scenario 12: after a restart (fresh setup), an existing session keeps
// its choice: state comes from the state file (written before the restart,
// as in reality) and the first message is resolved from stored history, not
// from the current prompt. ---
{
  st.setSessionState(st.loadState(), "s12", {
    status: "chosen",
    mode: "zh",
    source: "question-ui",
    invalidCount: 0,
  });
  storedMessages.set("s12", [{ type: "user", id: "m12_first", text: "hi" }]);
  const cleanup2 = await e.default.setup(mockCtx);
  const promptHook2 = hooks.session.prompt;
  const contextHook2 = hooks.session.context;

  const mid = "m12_second";
  await promptHook2({
    sessionID: "s12",
    messageID: mid,
    prompt: { text: "继续", files: [], agents: [], skills: [] },
    delivery: "steer",
  });
  const event = requestEvent("s12", [{ id: mid, text: "继续" }]);
  await contextHook2(event);

  const s = st.getSessionState(st.loadState(), "s12");
  t("S12 choice survives restart", s?.status === "chosen" && s?.mode === "zh");
  t("S12 zh instruction applied after restart", injectedTexts(event).some((x) => x.includes("强制要求")));
  t("S12 temperature 0.3 after restart", event.options.temperature === 0.3);
  await cleanup2();
}

// --- Scenario 13: string-content message keeps its original text ---
{
  const sid = "s13";
  await turn(sid, "[think:zh] 你好");
  const event = {
    sessionID: sid,
    system: [],
    messages: [{ id: "m13", role: "user", content: "帮我写首诗" }],
    options: {},
  };
  await contextHook(event);
  const first = event.messages[0];
  const texts = Array.isArray(first.content) ? first.content.map((p) => p?.text ?? "") : [];
  t("S13 original user text preserved", texts.includes("帮我写首诗"));
  t("S13 instruction prepended to string content", texts.some((x) => x?.includes("强制要求")));
}

// --- Scenario 14: model skips the setup flow -> stern enforced instruction ---
{
  const sid = "s14";
  await turn(sid, "hi");
  let s = st.getSessionState(st.loadState(), sid);
  t("S14 session awaiting before skip", s?.status === "awaiting");

  // Model ran another tool while the dialog was pending -> blocked + marked.
  let blocked = false;
  try {
    await beforeHook({ tool: "read", sessionID: sid, agent: "build", messageID: "m14", id: "c14", input: {} });
  } catch (error) {
    blocked = error instanceof Error && error.message.includes("reasoning-language setup");
  }
  t("S14 non-question tool blocked while awaiting", blocked);

  const event = await turn(sid, "hi again");
  s = st.getSessionState(st.loadState(), sid);
  t("S14 still awaiting after skip", s?.status === "awaiting");
  t("S14 enforced instruction used after skip", injectedTexts(event).some((x) => x.includes("警告：上一轮没有执行本设置流程")));
  t("S14 enforced instruction still mandates question tool", injectedTexts(event).some((x) => x.includes("question 工具")));

  // Question tool itself is never blocked.
  let questionAllowed = true;
  try {
    await beforeHook({
      tool: "question", sessionID: sid, agent: "build", messageID: "m14q", id: "c14q",
      input: { questions: [{ question: m.QUESTION_TEXT, header: m.QUESTION_HEADER, options: [] }] },
    });
  } catch {
    questionAllowed = false;
  }
  t("S14 question tool not blocked", questionAllowed);

  // After the choice, tools work again and the language instruction applies.
  await uiAnswer(sid, ["英文推理"]);
  const after = await turn(sid, "third turn");
  s = st.getSessionState(st.loadState(), sid);
  t("S14 choice after enforcement works", s?.status === "chosen" && s?.mode === "en");
  t("S14 normal language instruction after choice", injectedTexts(after).some((x) => x.includes("MANDATORY REASONING LANGUAGE: English")));
  let toolAllowed = true;
  try {
    await beforeHook({ tool: "read", sessionID: sid, agent: "build", messageID: "m14r", id: "c14r", input: {} });
  } catch {
    toolAllowed = false;
  }
  t("S14 tools unblocked after choice", toolAllowed);
}

// --- Scenario 15: chosen sessions are never blocked ---
{
  const sid = "s15";
  await turn(sid, "[think:zh] 你好");
  let allowed = true;
  try {
    await beforeHook({ tool: "bash", sessionID: sid, agent: "build", messageID: "m15", id: "c15", input: {} });
  } catch {
    allowed = false;
  }
  t("S15 marker-chosen session not blocked", allowed);
}

// --- Scenario 16: THINK_LANGUAGE_ENFORCE=0 disables the hard block ---
{
  process.env.THINK_LANGUAGE_ENFORCE = "0";
  hooks.tool["execute.before"] = undefined;
  const cleanup3 = await e.default.setup(mockCtx);
  const beforeHook3 = hooks.tool["execute.before"];
  t("S16 before-hook unregistered when disabled", beforeHook3 === undefined);

  const sid = "s16";
  await promptHook({
    sessionID: sid,
    messageID: "m16",
    prompt: { text: "hi", files: [], agents: [], skills: [] },
    delivery: "steer",
  });
  let allowed = true;
  if (typeof beforeHook3 === "function") {
    try {
      await beforeHook3({ tool: "read", sessionID: sid, agent: "build", messageID: "m16r", id: "c16r", input: {} });
    } catch {
      allowed = false;
    }
  }
  t("S16 tools not blocked when disabled", allowed);
  delete process.env.THINK_LANGUAGE_ENFORCE;
  await cleanup3();
}

rmSync(statePath, { force: true });

console.log(results.join("\n"));
const fails = results.filter((r) => r.startsWith("FAIL")).length;
console.log(fails === 0 ? "ALL " + results.length + " TESTS PASSED" : fails + " TEST(S) FAILED");
process.exit(fails === 0 ? 0 : 1);
