# think-language-temperature

OpenCode plugin that sets a **per-session reasoning language** and **model temperature** for you.

- 🇨🇳 中文推理 — temperature `0.3`
- 🇬🇧 英文推理 — temperature `0.7`
- ⚙️ 自动 — no interference, temperature `0.5`

On the first turn of every session it asks you to pick (reply `1` / `2` / `3`); from then on it applies that choice to every request of the session. You can also skip the menu with a marker in your first message, e.g. `[think:en]`.

**无构建步骤 · 纯 ESM · 零运行时依赖 · 不新增任何网络出站**

---

## English

OpenCode plugin that sets a **per-session reasoning language** and **model temperature** for you.

- 🇨🇳 Chinese reasoning — temperature `0.3`
- 🇬🇧 English reasoning — temperature `0.7`
- ⚙️ Auto — no interference, temperature `0.5`

On the first turn of every session it asks you to pick (reply `1` / `2` / `3`); from then on it applies the choice to every request of the session. You can also skip the menu with a marker in your first message, e.g. `[think:en]`.

**No build step · plain ESM · no runtime dependencies · no added outbound network**

---

## 中文

### 这是什么

`think-language-temperature` 是一个 [OpenCode](https://opencode.ai) 插件（V2 插件 API，版本 `2.0.0`）。它做两件事：

1. 在每个会话的首次交互时展示选择菜单（回复数字 1/2/3），为会话"选语言"；
2. 之后每个该会话的模型请求都会被施加对应策略：`ctx` 的 `session` 钩子（`prompt` / `context`）在 `context` 阶段写入 `options.temperature`，并在系统提示词里附上推理语言指令。

机制细节：

- 支持显式标记 `[think:zh|en|auto]`（可在会话任意一条消息里使用，多个标记时以最后一个有效标记为准）；
- 菜单答案更宽松：`1/2/3`、全角数字、中文/英文单词，以及带前缀的「我选 2」「回复 3」等写法；无效回答会再提醒，连续无效 `2` 次后自动落到"自动"（可用环境变量调阈值，见下）；
- 策略按会话隔离（session key），状态持久化在用户目录而非仓库；
- `auto` / 未初始化状态下不注入任何指令，温度按默认值 `0.5`；
- 出错即吞：钩子内部所有处理均有防护，任何失败都不会阻断模型请求或改坏输入。

### 安装

本包是普通目录，可以按下面任一方式分发。加载语义以你所用 OpenCode 版本的官方文档为准（本 README 只描述已被本项目环境验证过的布局 + 官方文档支持的通用路径）。

**A. 按"已安装"布局放置（本机实际验证过的布局）**

```
<opencode-config>/plugins/think-language-temperature.js
<opencode-config>/lib/think-language-temperature-core.js
<opencode-config>/lib/think-language-temperature-state.js
```

即把本仓库的 `plugins/`、`lib/` 两个目录整体拷到 OpenCode 配置目录（本机为 `C:\Users\BY\.config\opencode`，Linux/macOS 通常是 `~/.config/opencode`）。该布局会被配置目录下的插件扫描机制发现（入口文件头部注释也记录了 `{config}/plugins/*.js` 的加载方式）。

**B. 作为本地目录/包引用**

把仓库目录（含 `package.json` 与 `exports`）通过 OpenCode 配置里的 `plugins` 数组引用，或安装为已发布的 npm 包——两者的具体机制与版本要求见 OpenCode 官方文档（"Configure plugins" / "Plugins"，插件包 = `package.json` + parts + `@opencode/plugin` 依赖的模型）。

**C. Git / npm 发布（手动）**

- GitHub：推送仓库后，用户按 `git clone` + 方式 A/B 自行安装；
- npm：`npm publish`（需满足 npm 名称可用性与认证要求；本打包不代执行任何上传动作）。

> 两处版本号目前是分散的：插件入口文件内部常量 `PLUGIN_VERSION` 与 `package.json` 的 `version`。改版本时请两处同步。

### 使用

1. 首次交互会出现菜单，回复 `1`、`2` 或 `3`（详见机制细节里的宽松格式）；
2. 或在消息里带标记直接选择，如 `[think:en]`；`auto` 表示不干预；
3. 选择对该会话生效并持久化；新会话重新选择。

环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `THINK_LANGUAGE_STATE_PATH` | 自定义状态文件路径 | `~/.local/share/opencode/think-language-state.json`（按 `os.homedir()` 计算，取决于平台） |
| `THINK_LANGUAGE_MAX_INVALID` | 允许的无效回答次数，超过后自动回退 `auto` | `2`（下限 1） |

（日志路径不提供环境变量覆盖，固定在同一目录下的 `think-temperature.log`。）

### 仓库内容

| 文件 | 说明 |
|---|---|
| `plugins/think-language-temperature.js` | 插件入口：`id` + `setup(ctx)`，注册 `prompt` / `context` 两个 session 钩子 |
| `lib/think-language-temperature-core.js` | 纯函数：标记/选项解析、温度表、指令文案 |
| `lib/think-language-temperature-state.js` | 会话状态的读写、剪枝（上限 500 条） |
| `package.json` | 包元数据 + `exports`（单一 server part） |
| `README.md` / `LICENSE` | 本文档 / MIT（版权行待填） |
| `.gitignore` | 常规忽略项（`node_modules/`、`dist/`、`*.log` 等） |

不入仓库的东西：`~/.local/share/opencode/` 下的运行时状态与日志（含会话相关元数据，属于本机数据；注意对外分享日志前先确认内容）、任何凭据。

静态核查（2026-11-11）：三个源文件对 `fetch` / `axios` / `http(s)://` 等出站网络引用命中 0 处；仅导入 `node:fs` / `node:os` / `node:path`。

### 兼容性与已知边界

- 按入口文件注释，目标是 OpenCode 2.x 的 V2 插件 API（`ctx.session.hook`、`default export = { id, setup }`；V1 形态的入口会被加载期拒绝）。**请在你自己的 OpenCode 版本上验证加载与行为**——加载路径与插件约定随版本演进；
- 本机基线：OpenCode Desktop 2.2.6（项目文档记录）+ Node v26.13.0，Windows。未做跨版本/跨平台全面验证；
- 纯 ESM、无构建产物、无运行时依赖；Node 侧仅用到 `node:fs` 等长期存在的 API，但插件实际跑在 OpenCode 提供的运行时内；
- 本包只影响"推理语言指令 + temperature 这一个请求字段"；其余 request 选项不动（菜单首轮还会清空该请求的 tools，见入口实现）。

### 本地验证（可复跑）

```bash
# 从仓库根跑一个纯函数 quick check（需 Node 支持 ESM）
node --input-type=module -e "import { getTemperature } from './lib/think-language-temperature-core.js'; console.log(getTemperature('en'))"
```

更完整的做法：写一个临时 ESM 脚本，`import` 上面三个文件，断言 `getTemperature/parseChoice/parseThinkMarker/parseChoice` 与 `buildLanguageInstruction` 的行为，`THINK_LANGUAGE_STATE_PATH` 指向临时文件后测 `loadState/setSessionState`，并给 `setup()` 传一个假 `ctx` 捕获两个钩子。2026-11-11 我就是用这个方式跑的（Node v26.13.0，全部通过），临时文件已清理。

### 许可证

MIT — 见 `LICENSE`。发布前请把版权行（`Copyright (c) 2026 …`）换成你的名字或组织。

---

## English

### What it is

`think-language-temperature` is an [OpenCode](https://opencode.ai) plugin (V2 plugin API, version `2.0.0`). It does two things:

1. offers a choice menu (reply `1` / `2` / `3`) at the first interaction of each session, and
2. applies the session's strategy to every model request of that session — the `context` hook sets `options.temperature` and appends a reasoning-language instruction to the system prompt.

Mechanism:

- explicit marker `[think:zh|en|auto]` supported (any message; with several markers the last valid one wins);
- menu answers are matched leniently (`1/2/3`, full-width digits, `zh`/`en`/`chinese`/`english`/`中文推理`…, plus prefixed forms like `我选 2` / `回复 3`); invalid replies are re-prompted, and after 2 consecutive invalid replies (configurable) the session falls back to `auto`;
- policy is isolated per session (session key) and persisted in the user directory, never in the repo;
- `auto` / uninitialized sessions get no instruction and the default temperature `0.5`;
- everything is failure-safe: hooks never throw into the model request and never touch the user's input.

### Installation

This is a plain directory package; any of the routes below works conceptually, but **loading semantics follow your OpenCode version's official docs** — this README states what was verified in this environment plus the generic documented paths.

**A. Place it in the "as-installed" layout (verified in this environment)**

```
<opencode-config>/plugins/think-language-temperature.js
<opencode-config>/lib/think-language-temperature-core.js
<opencode-config>/lib/think-language-temperature-state.js
```

i.e. copy this repo's `plugins/` and `lib/` directories into your OpenCode config directory (here: `C:\Users\BY\.config\opencode`; on Linux/macOS usually `~/.config/opencode`). That layout is picked up by the config directory's plugin scanning (the entry file's header comment documents the `{config}/plugins/*.js` load path).

**B. Reference the directory/package from config**

A local plugin directory with a `package.json` `name` and `exports`, or an installed/publishable npm package, can be referenced through the `plugins` array in `opencode.json(c)` — exact mechanism and version requirements per the OpenCode docs ("Configure plugins" / plugin package model: `package.json` + parts, `@opencode/plugin` dependency).

**C. Git / npm release (manual, not performed here)**

- GitHub: push the repo; users then `git clone` + use A/B.
- npm: `npm publish` (npm name availability & auth requirements apply; nothing is uploaded by this packaging step).

> Version lives in two places today: the entry file's internal constant `PLUGIN_VERSION` and `package.json` `version`. Bump both together.

### Usage

1. First interaction shows the menu — reply `1`, `2` or `3` (lenient formats as listed above);
2. or a marker such as `[think:en]` selects directly; `auto` means no interference;
3. the choice persists for that session; new sessions choose again.

Environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `THINK_LANGUAGE_STATE_PATH` | state file location | `~/.local/share/opencode/think-language-state.json` (computed from `os.homedir()`, platform-dependent) |
| `THINK_LANGUAGE_MAX_INVALID` | invalid replies tolerated before falling back to `auto` | `2` (floor 1) |

(no env override for the log file; it stays next to the state file as `think-temperature.log`.)

### Repository contents

| File | Description |
|---|---|
| `plugins/think-language-temperature.js` | entry: `id` + `setup(ctx)`, registers `prompt` / `context` session hooks |
| `lib/think-language-temperature-core.js` | pure helpers: marker/choice parsing, temperature table, instruction text |
| `lib/think-language-temperature-state.js` | per-session state load/save + pruning (cap 500) |
| `package.json` | metadata + `exports` (single server part) |
| `README.md` / `LICENSE` | this doc / MIT (copyright line to fill in) |
| `.gitignore` | `node_modules/`, `dist/`, `*.log`, … |

Deliberately not packaged: runtime data under `~/.local/share/opencode/` (session-related metadata — local machine data; review before sharing logs), credentials, nothing outbound.

Static check (2026-11-11): the three sources contain 0 references to `fetch` / `axios` / `http(s)://`; imports are limited to `node:fs` / `node:os` / `node:path`.

### Compatibility & known boundaries

- Per the entry file's header, target is the OpenCode 2.x V2 plugin API (`ctx.session.hook`, default export `{ id, setup }`); legacy V1-shaped entrypoints are rejected at load time. **Verify loading & behavior on your OpenCode version** — load paths and plugin conventions evolve.
- Local baseline: OpenCode Desktop 2.2.6 (per project docs) + Node v26.13.0 on Windows. No cross-version / cross-platform sweep performed.
- Plain ESM, no build output, no runtime deps; Node APIs used are long-standing (`node:fs` etc.), though the plugin actually runs inside the OpenCode-provided runtime.
- The plugin only affects the reasoning-language instruction and the `temperature` request field; other request options are left alone (the menu turn additionally clears that request's `tools` — see entry implementation).

### Reproducible local check

```bash
# quick pure-function check from the repo root (Node with ESM):
node --input-type=module -e "import { getTemperature } from './lib/think-language-temperature-core.js'; console.log(getTemperature('en'))"
```

…or the fuller scratch-script approach I ran on 2026-11-11 (imports all three files, asserts `getTemperature` / `parseChoice` / `parseThinkMarker` / `buildLanguageInstruction` / `loadState` / `setSessionState` with a temp `THINK_LANGUAGE_STATE_PATH`, and captures both hooks through a fake `ctx`) — all passed on Node v26.13.0; scratch files were removed afterwards.

### License

MIT — see `LICENSE`. Replace the copyright line (`Copyright (c) 2026 …`) with your name or organization before publishing.
