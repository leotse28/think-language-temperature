# think-language-temperature

> 🌏 [中文说明](README.zh-CN.md)

An [OpenCode 2](https://opencode.ai) plugin that asks — through a **native UI dialog** — which language the model should use for its *internal reasoning* on the first message of every session, then applies a matching output temperature for the rest of that session.

| Choice | Internal reasoning | Output temperature |
|---|---|---|
| **中文推理** | Simplified Chinese | 0.3 |
| **英文推理** | English | 0.7 |
| **自定义** | Any rule you type (e.g. "日语推理", "中英混合") | 0.5 |

The final visible answer always follows the language you asked in — only the hidden reasoning process is governed.

## Why

Reasoning language measurably affects model behavior: Chinese reasoning tends to work better for cultural and writing tasks, English reasoning for logic, programming, and research. This plugin makes that choice explicit once per session instead of leaving it to chance — and lets you override it with any custom rule.

## How it works

On the first message of a new session the plugin injects a hidden instruction that makes the model call OpenCode's built-in `question` tool, which renders a **real interactive selection dialog** (clickable options in the desktop app, a keyboard-selectable list in the TUI, plus a built-in "type your own answer" free-text entry). A tool hook captures your choice and persists it per session.

This is the **OpenCode 2** port (plugin V2 contract, `Plugin.define` + `setup(ctx)`). The V1 hooks map as follows:

| V1 hook (≤1.3.0) | OpenCode 2 API |
|---|---|
| `chat.message` (state machine) | `ctx.session.hook("prompt", ...)` |
| `chat.message` (hidden synthetic part) | `context` / `compaction` / `generate` / `title` request hooks, editing `event.messages` |
| `chat.params` (`output.temperature`) | the same request hooks, setting `event.options.temperature` |
| `experimental.chat.system.transform` | the same request hooks, pushing to `event.system` |
| `tool.execute.after` | `ctx.tool.hook("execute.after", ...)` |
| `dispose()` | the cleanup function returned by `setup` |

The instruction recorded at each message's admission time is re-applied to the outgoing transcript on every model request (V2 request-hook edits affect only the outgoing call, exactly like the V1 synthetic part). The temperature and reasoning-language directive are registered for every request kind — agent loop, compaction, transient generation, and title generation — matching V1 behavior.

State is stored per session ID in `~/.local/share/opencode/think-language-state.json` (max 500 sessions, LRU-pruned).

## Install

### Option A — plugin directory (manual copy)

Copy the plugin package folder into your OpenCode config directory:

```
src/ + lib/ + package.json  ->  ~/.config/opencode/plugins/think-language-temperature/
```

On Windows: `C:\Users\<you>\.config\opencode\plugins\`. OpenCode 2 auto-discovers plugin package folders there, and the host provides the `@opencode/plugin` module itself — **no `node_modules` needed**. (Or just run `install.ps1` / `install.sh` from the repository root — an existing installation is backed up first.)

### Option B — config entry (local folder)

Clone or extract this repository anywhere, then point your `opencode.json(c)` at the folder:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/absolute/path/to/think-language-temperature"
  ]
}
```

Configured local paths must be directories (the folder's `package.json` `exports` points at `src/index.js`).

### Option C — npm / GitHub (published packages)

```bash
opencode plugin add github:<your-user>/think-language-temperature
# or, once published to npm:
opencode plugin add think-language-temperature
```

## Usage

### First session

Send any message in a new session. The dialog appears with three options plus a free-text input:

- Pick **中文推理** or **英文推理** — the choice applies immediately (including the current turn).
- Pick **自定义** — the model asks one follow-up question; reply with your rule (e.g. "日语推理，代码注释用中文").
- Use **type your own answer** — whatever you type becomes the custom reasoning rule directly.

### Skip the dialog with a marker

Start your first message with a marker to bypass the dialog entirely:

```
[think:zh] 帮我写一首诗
[think:en] refactor this function
[think:auto] anything goes
```

### Behavior by client

| Client | First-turn experience |
|---|---|
| Desktop app / TUI | Native `question` tool dialog (interactive) |
| `opencode run` (print mode) | Numbered text menu fallback (the question tool has no UI there) |

If the dialog fails or is dismissed, the plugin falls back to the text menu automatically; replying `1` / `2` / `3` works in every client.

### Reset

Delete the state file to re-trigger the dialog in existing sessions:

```
~/.local/share/opencode/think-language-state.json
```

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `THINK_LANGUAGE_STATE_PATH` | `~/.local/share/opencode/think-language-state.json` | State file location |
| `THINK_LANGUAGE_MAX_INVALID` | `2` | Invalid replies tolerated before falling back to auto mode |
| `THINK_LANGUAGE_ENFORCE` | `1` | Set `0` to disable the hard tool block (see below) |

### Anti-skip enforcement

Models sometimes ignore the injected setup instruction and start answering the user's task directly. The plugin counters this at three levels:

1. **Stronger instruction** — the setup directive states it is a system-mandatory flow that overrides the user's task request, and forbids answering or calling other tools before the dialog completes.
2. **Skip detection + re-injection** — if the model runs any other tool while the dialog is still pending, the next request carries a stern enforced variant ("you skipped the setup flow last turn…").
3. **Hard tool block** — while the dialog is pending, `tool.execute.before` blocks every tool call except `question` itself; the error the model sees explains exactly how to complete the setup. Once a choice is made, all tools work normally. Set `THINK_LANGUAGE_ENFORCE=0` to disable this level.

## Development

```bash
npm install        # only needed to run the tests locally
node test/test.mjs
```

The test suite drives the V2 contract through a mock plugin context and covers the full state machine: dialog interception (all question-tool result shapes), custom-rule capture, marker bypass, text-menu fallback, invalid-input handling, restart recovery, and temperature application across request kinds — 42 assertions, no network or OpenCode instance required.

## Compatibility

- OpenCode 2 (plugin V2 contract, `Plugin.define`). Not loadable by OpenCode 1 — use v1.3.0 for that.
- State file, `[think:]` markers, and menu texts are unchanged from v1.3.0, so sessions and habits carry over.

## License

[MIT](LICENSE)
