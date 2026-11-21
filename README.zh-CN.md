# think-language-temperature

> 🌏 [English](README.md)

一个 [OpenCode 2](https://opencode.ai) 插件：在每个会话的首条消息时，通过**原生 UI 弹窗**让用户选择模型内部推理使用的语言，并在该会话内持续应用对应的输出温度。

| 选项 | 内部推理 | 输出温度 |
|---|---|---|
| **中文推理** | 简体中文 | 0.3 |
| **英文推理** | 英文 | 0.7 |
| **自定义** | 任意规则（如"日语推理"、"中英混合"） | 0.5 |

最终可见回答始终跟随用户提问的语言——本插件只约束隐藏的推理过程。

## 为什么

推理语言会实质影响模型行为：中文推理更适配文化、写作类任务，英文推理更适配逻辑、编程与科研。本插件把这一选择变成每个会话开始时的一次明确交互，而不是交给随机——并且允许用任意自定义规则覆盖。

## 工作原理

新会话的首条消息会触发插件注入一条隐藏指令，让模型调用 OpenCode 内置的 `question` 工具，从而渲染出**真实的交互选择界面**（桌面端为可点击的选项卡片，TUI 中为可键盘选择的列表，并自带"输入自己的答案"自由输入框）。插件通过工具钩子捕获选择结果，并按会话持久化。

本版本是 **OpenCode 2** 移植版（插件 V2 契约，`Plugin.define` + `setup(ctx)`）。V1 钩子映射如下：

| V1 钩子（≤1.3.0） | OpenCode 2 API |
|---|---|
| `chat.message`（状态机） | `ctx.session.hook("prompt", ...)` |
| `chat.message`（隐藏 synthetic 部分） | `context` / `compaction` / `generate` / `title` 请求钩子，编辑 `event.messages` |
| `chat.params`（`output.temperature`） | 同上请求钩子，设置 `event.options.temperature` |
| `experimental.chat.system.transform` | 同上请求钩子，向 `event.system` 追加 |
| `tool.execute.after` | `ctx.tool.hook("execute.after", ...)` |
| `dispose()` | `setup` 返回的清理函数 |

每条消息在准入时刻记录的指令会在每次模型请求时重新应用到外发转录上（V2 请求钩子的修改只影响外发调用，与 V1 的 synthetic 部分效果一致）。温度与推理语言指令注册到所有请求类型——主循环、压缩、临时生成、标题生成——与 V1 行为一致。

状态按会话 ID 存储在 `~/.local/share/opencode/think-language-state.json`（最多 500 个会话，LRU 淘汰）。

## 安装

### 方式 A —— 插件目录（手动复制）

把插件包文件夹复制到 OpenCode 配置目录：

```
src/ + lib/ + package.json  ->  ~/.config/opencode/plugins/think-language-temperature/
```

Windows 下为 `C:\Users\<你>\.config\opencode\plugins\`。OpenCode 2 会自动发现该目录下的插件包文件夹，且主机运行时自带 `@opencode/plugin` 模块——**无需 node_modules**。（也可以直接在仓库根目录运行 `install.ps1` / `install.sh`——已存在的安装会先备份。）

### 方式 B —— 配置项（本地目录）

把仓库克隆或解压到任意位置，然后在 `opencode.json(c)` 中指向该文件夹：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/绝对路径/think-language-temperature"
  ]
}
```

配置中的本地路径必须是目录（文件夹内 `package.json` 的 `exports` 指向 `src/index.js`）。

### 方式 C —— npm / GitHub（已发布包）

```bash
opencode plugin add github:<你的用户名>/think-language-temperature
# 或发布到 npm 后：
opencode plugin add think-language-temperature
```

## 使用

### 首次会话

在新会话中发送任意消息，会弹出带三个选项和自由输入框的选择界面：

- 选择 **中文推理** 或 **英文推理** —— 立即生效（包括当前这一轮）。
- 选择 **自定义** —— 模型会追问一句，回复你的规则（如"日语推理，代码注释用中文"）。
- 使用 **输入自己的答案** —— 输入的内容直接作为自定义推理规则生效。

### 用标记跳过弹窗

在首条消息开头加标记即可完全跳过弹窗：

```
[think:zh] 帮我写一首诗
[think:en] refactor this function
[think:auto] 随意
```

### 各客户端行为

| 客户端 | 首轮体验 |
|---|---|
| 桌面端 / TUI | `question` 工具原生弹窗（可交互） |
| `opencode run`（print 模式） | 数字文字菜单回退（该模式无 question 工具 UI） |

若弹窗调用失败或被关闭，插件会自动回退到文字菜单；回复 `1` / `2` / `3` 在所有客户端都有效。

### 重置

删除状态文件即可让已有会话重新弹出选择：

```
~/.local/share/opencode/think-language-state.json
```

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `THINK_LANGUAGE_STATE_PATH` | `~/.local/share/opencode/think-language-state.json` | 状态文件位置 |
| `THINK_LANGUAGE_MAX_INVALID` | `2` | 连续无效回复次数上限，超过后回退 auto 模式 |
| `THINK_LANGUAGE_ENFORCE` | `1` | 设为 `0` 关闭硬拦截（见下） |

### 防跳过加固

模型有时会无视注入的设置指令，直接开始处理用户任务。插件在三个层级进行防御：

1. **指令强化** —— 设置指令声明自身为系统强制流程，优先级高于用户消息中的任务请求；设置完成前禁止回答问题、禁止调用其他工具。
2. **跳过检测 + 重注入** —— 若弹窗未完成时模型调用了其他工具，下一轮请求改用更严厉的强制版指令（"你上一轮没有执行设置流程……"）。
3. **硬拦截** —— 弹窗未完成期间，`tool.execute.before` 阻断除 `question` 以外的所有工具调用；模型看到的错误信息会说明如何完成设置。用户做出选择后所有工具立即恢复正常。设置 `THINK_LANGUAGE_ENFORCE=0` 可关闭此层级。

## 开发

```bash
npm install        # 仅本地跑测试需要
node test/test.mjs
```

测试通过模拟插件上下文驱动 V2 契约，覆盖完整状态机：弹窗拦截（question 工具全部返回形状）、自定义规则捕获、标记旁路、文字菜单回退、无效输入处理、重启恢复与各请求类型的温度应用——共 42 项断言，无需网络或 OpenCode 实例。

## 兼容性

- OpenCode 2（插件 V2 契约，`Plugin.define`）。无法在 OpenCode 1 中加载——OpenCode 1 请使用 v1.3.0。
- 状态文件、`[think:]` 标记与菜单文案与 v1.3.0 完全一致，会话与使用习惯无缝延续。

## 许可证

[MIT](LICENSE)
