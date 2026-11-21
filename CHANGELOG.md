# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.0.0] - 2026-11-20

### Added
- **Anti-skip enforcement** for models that ignore the setup instruction and start answering directly:
  - The setup directive now declares itself system-mandatory (overrides the user's task request; no answers, other text, or non-question tools before the dialog completes).
  - Skip detection: when the model runs any other tool while the dialog is pending, the next request injects a stern enforced instruction variant (`buildEnforcedSetupInstruction`).
  - Hard block: `tool.execute.before` rejects every tool except `question` while the dialog is pending, with an error message that tells the model exactly how to complete the setup. Disable with `THINK_LANGUAGE_ENFORCE=0`.
- New test coverage: skip detection, enforced instruction, hard block (including question-tool exemption and unblock after choice), and the disable switch — 57 assertions total.

### Changed
- **OpenCode 2 port.** The plugin now uses the plugin V2 contract: `Plugin.define({ id, setup(ctx) })` with hooks registered through the plugin context. V1 plugin implementations do not run in OpenCode 2, so this is a required upgrade; OpenCode 1 users should stay on v1.3.0.
  - `chat.message` state machine → `ctx.session.hook("prompt", ...)`.
  - Hidden synthetic message part + `experimental.chat.system.transform` → `context` / `compaction` / `generate` / `title` request hooks editing `event.messages` and `event.system`.
  - `chat.params` temperature → the same request hooks setting `event.options.temperature` for every request kind (agent loop, compaction, generate, title), matching V1.
  - `tool.execute.after` → `ctx.tool.hook("execute.after", ...)`.
  - `dispose()` → the cleanup function returned by `setup`.
- Packaging follows the OpenCode 2 layout: a plugin package folder (`package.json` `exports` → `src/index.js`) discovered from `.opencode/plugins/` or `~/.config/opencode/plugins/`. The host provides the `@opencode/plugin` module, so no `node_modules` is required at install time.
- Config entries use the V2 `plugins` key (directories, not single files).
- Console logging replaces the removed `client.app.log` calls; the file debug log (`~/.local/share/opencode/think-temperature.log`) is unchanged.

### Kept identical
- First-turn native `question`-tool dialog with 中文推理 / 英文推理 / 自定义 and the free-text entry; text-menu fallback; `[think:zh|en|auto]` markers; custom-rule capture and sanitization; per-mode temperatures (zh 0.3 / en 0.7 / custom & auto 0.5); per-session state file with LRU pruning; both env-var overrides; all question-tool result shapes.

## [1.3.0] - 2026-11-19

### Changed
- First-turn selection now pops a **native UI dialog** via OpenCode's built-in `question` tool (interactive option list in the TUI, clickable dialog in the desktop app) instead of a printed text menu.
- The dialog offers 中文推理 / 英文推理 / 自定义, plus the question tool's built-in "type your own answer" free-text entry.

### Added
- `tool.execute.after` hook intercepts the dialog answer and persists it per session. Supports all question-tool result shapes: `{metadata.answers}`, `{answers}`, and a formatted-output-string fallback.
- Free-text answers in the dialog are captured directly as custom reasoning rules (no follow-up round trip needed).
- Automatic fallback to the numbered text menu when the question tool is unavailable (e.g. `opencode run` print mode) or the call fails.

## [1.2.0] - 2026-11-19

### Changed
- Menu options are now 中文推理 / 英文推理 / 自定义 (the previous 自动 option was replaced by 自定义).

### Added
- 自定义 flow: picking it triggers a follow-up question; the user's next reply is captured, sanitized (whitespace collapsed, `[think:]` markers stripped, 60-char cap) and stored as a per-session custom reasoning rule.
- `custom` temperature entry (0.5, the default).

## [1.1.0] - 2026-11-19

### Added
- Initial release: first-session text menu (中文推理 / 英文推理 / 自动), per-session persistent choice, per-mode output temperature via `chat.params` (zh 0.3 / en 0.7 / auto 0.5), hidden synthetic instruction injection via `chat.message`, system-prompt fallback via `experimental.chat.system.transform`, and `[think:zh|en|auto]` first-message markers that bypass the menu.
