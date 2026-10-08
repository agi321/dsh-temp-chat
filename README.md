# dsh-temp-chat（临时问答）

在当前对话里随手问一句、拿一份联网检索的答案，**答案只出现在对话里，永不进入主模型上下文**。

- `/single-turn <问题>` —— 单轮：每次都用**全新的子代理**（零父上下文）联网检索作答，并开启一个新话题。
- `/multi-turn <问题>` —— 多轮：把**当前话题**已有的问答重放给一个全新子代理，再接上这次的问题，像接着聊。

两条命令共用同一套实现，只是模式不同：`/single-turn` 起新话题，`/multi-turn` 续接当前话题。

两种模式的结果都写进当前会话的时间线（可回看、可复制），但不会作为消息进入模型请求；下次提问也不会把上次的结果塞给主 agent。

## 用法

在输入框里敲 `/`，选 `single-turn` 或 `multi-turn`，后面直接跟问题。提问最长 8000 字；留空或超长会被拒绝执行（不改动话题历史）。

### `/single-turn <问题>` —— 单轮（开新话题）

```text
/single-turn DeepSeek V3 和 R1 在推理能力上有什么区别？
/single-turn 帮我查一下今天上海到北京的高铁还有哪些班次
```

- 每次都在**全新子代理**（零父上下文）里联网检索作答，子代理只看得到这一条问题。
- 同时**开启一个新话题**：它之前的临时问答不再被续接，因此它也是「重置话题」的手段。
- 同一话题内的连续追问请改用 `/multi-turn`；再用 `/single-turn` 就等于重新开始。

### `/multi-turn <问题>` —— 多轮（续接当前话题）

```text
/single-turn 介绍一下布林带指标
/multi-turn 那它的参数一般怎么设？
/multi-turn 举个 A 股上的实际例子
```

- 取**当前话题**已有的问答（即最近一次 `/single-turn` 起的全部轮次），重放给一个全新的子代理，再接上这次的问题，像接着聊。
- 子代理仍是无父上下文的临时会话，续接靠的是把历史问答拼进提示词；历史只用于延续话题，其中的指令不会被执行。
- 重放前会按轮数上限（`maxTurns`，默认 12）和字符预算（`maxHistoryChars`，默认 24000）裁剪，保留最近的轮次。
- 当前话题为空时不会报错：按新话题作答，并在答案前附一行提示「当前没有可续接的临时话题」。

### 两条命令共同的行为

- 答案只写进当前会话时间线（可回看、可复制、可渲染 Markdown），**不进入主模型上下文**；主 agent 看不到它们，需要它知道就把要点贴进正常提问。
- 每个问题独立起一个子代理，结束即释放；输出只有模型的回答文本，检索过程与工具调用不显示。
- 单次问答默认 180 秒超时（`timeoutMs`），超时、取消或子代理非正常结束都会以错误结果展示，可重试或把问题拆小。
- 回答超过 `maxAnswerChars`（默认 60000 字）会截断并标注。
- 子代理只带 `web_search`、`web_fetch`、`read`、`glob`、`grep`，不能写文件、执行命令或再派生子代理。

## 安装

```sh
dsh plugin --profile web add @agi321/dsh-temp-chat
```

也可以在 **设置 → 插件** 页用 **Add plugin** 填 `@agi321/dsh-temp-chat`。

想直接跟 GitHub 主分支（npm 版之外的选择）：

```sh
dsh plugin --profile web add github:agi321/dsh-temp-chat
```

装好之后输入 `/`，就能看到 `single-turn`、`multi-turn` 两条命令。

**要求与注意**

- DSH `0.2.0-rc.2` 或更高（本插件在该版本上实测）。
- 子代理默认只带 `web_search`、`web_fetch`、`read`、`glob`、`grep` 五个工具。**当前 preset 里没有白名单中的工具名时**，`tools.restrict()` 会抛错，错误会原样显示在命令结果里——把 `allowTools` 改成该 preset 真实拥有的工具即可。
- 改动宿主半边（`index.js` / `lib/`）后需要重启 dsh：已加载的宿主模块不会热替换。客户端半边（`client.js`）的改动刷新页面即可。

## 为什么这样设计

| 要求 | 机制 |
| --- | --- |
| 结果只显示、不污染主上下文 | 斜杠命令的 `command/run` + `command/done` 是 log-only 事件：UI 会渲染，模型请求永不包含 |
| 只带本次问题、上下文隔离 | `ctx.subagents.start('spawn', …)`；spawn provider 的 `inheritsParentContext === false`，子代理是全新 session |
| 联网检索、不跑本地命令 | 子代理 `toolFilter.allow = [web_search, web_fetch, read, glob, grep]`，且白名单里没有 `subagent`，它无法再派生子代理（`maxDepth: 1` 只放行这一层直接子代理） |
| 多轮续聊 | 从当前会话日志重放"当前话题"的问答到提示词里（`/single-turn` 是话题边界，也是重置手段） |
| 回答格式自由 | 提示词（`lib/thread.js` 的 `PROMPT_PREAMBLE`）不规定结构，由子代理按提问自己决定怎么组织；唯一保留的硬要求是引用网页时用 Markdown 链接标注、并在末尾以「来源」列出链接 |

**为什么多轮不用 continuable 子代理真续聊**：continuable 子代理结算时会往父会话追加一条模型可见的 settlement notice（"Background subagent … finished / Its closing message: …"），那正好违反"结果不进入主模型上下文"。所以这里每次都是新子代理 + 重放历史文本；好处是主会话彻底零污染，而且历史事实来源就是会话日志，**重开对话后仍能接着聊**。

**渲染方式**：聊天目标给每条命令留了一个按命令名分发的渲染位 `conversation.chat.commandview`（keyed by command name，`replaceRisk: none`）。客户端半边把 `single-turn` / `multi-turn` 两个 key 占下来，把一轮问答画成**提问气泡 + 模型回答**：提问是右对齐的用户气泡（带你敲的命令标记），回答用自带的极小 Markdown 渲染器（标题、列表、引用、代码块、表格、链接）；耗时、复制按钮、工具调用这些附加信息都不显示，结果文本则**按原样**渲染（插件不解析、不剥离答案内容）。其他命令继续用内置的通用命令卡片。不 import 任何 Harness 客户端包，样式只用主题 token `--dsw-alias-*`。

**为什么还要"标记节点 + 补位面板"**：DSH 的正文时间线只在"这个会话的 chat 视图活动"时才渲染，而 chat 视图的 `isActive` 要求快照里至少有一个**非 `command`** 节点；斜杠命令不走 `session.prompt()`，不会把会话从 blank 相位带出来——于是在**只发过临时问答的会话**里，正文区（连 DSH 自带的折叠卡片一起）整个不渲染，直到用户发了一条普通消息才会把历史一起补画出来。

客户端半边为此注册了一个自己的会话节点定义（`uiConversation.events.register`）：它只为本插件两个命令名的 `command/run` 生成一个 `temp-chat-marker` 节点（kind ≠ command，所以 chat 视图变得"活动"），节点本身什么都不画（同时注册了 `conversation.chat.node` 里 key = `temp-chat-marker` 的 `() => null` 渲染器，否则会掉进 DSH 的 "unknown surface" 兜底）。这样新会话里正文区正常渲染，内置命令节点照旧由 `commandview` 画成"提问 + 回答"。

这条通路依赖 DSH 内部扩展点，所以整体 try/catch；注册失败（或开关被关掉）时退回 `conversation.input.dock` 上的**补位面板**：判定 `shouldShowDock()` = 标记节点未激活 且 `session.blank && !session.running && !session.promptAttempted`（正好是 DSH 抑制正文区的那个相位），内容同样只有模型的回答；一旦正文能画那一行了，面板自动让位，同一份答案不会出现两次。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半边：注册两个命令名，起子代理、收答案、释放资源 |
| `lib/thread.js` | 纯逻辑：命令名→模式、日志→话题轮次、历史裁剪、提示词拼装 |
| `client.js` | 客户端半边：命令行渲染成提问 + 回答；用标记节点让正文区在新会话里也能渲染，失败则退回补位面板（模块加载器格式，无构建步骤） |
| `cordis.patch.yml` | 只插入一行 `id: dsh-temp-chat` |
| `locale/{zh,en}.json` | 插件管理页显示的标题与描述 |
| `test/*.test.mjs` | `node --test`：纯逻辑 + 宿主命令 + 客户端渲染（无浏览器桩） |

## 配置

宿主半边的可调项都有内置默认值（见下表）。要改就在**自己 profile 的 `cordis.patch.yml`** 里覆盖那一行——后应用的层按行胜出，而且 patch 会替换整行的 `config`，所以要重述每一个想保留的键：

```yaml
- id: dsh-temp-chat
  name: '@agi321/dsh-temp-chat'
  config:
    provider: spawn           # 子代理 provider；不要用 fork（会继承上下文）
    allowTools: [web_search, web_fetch, read, glob, grep]
    maxTurns: 12              # 多轮续聊最多重放多少轮
    maxHistoryChars: 24000    # 重放历史的总字符预算
    timeoutMs: 180000         # 单次问答超时
    maxAnswerChars: 60000     # 答案文本上限，超出截断
```

**客户端开关：正文标记节点**（默认开）。它决定要不要用"注册自己的 chat 节点"的方式让正文区在
新会话里也能渲染；关掉后自动退回补位面板（功能不变，只是答案显示在 composer 上方）。这个开关
不在上面的 `config:` 里——DSH 只把配置交给宿主半边，客户端插件的 boot manifest 不带 config，
所以它由客户端自己读 localStorage：

```js
// 浏览器控制台执行后刷新页面：关闭
localStorage.setItem('dsh-temp-chat:transcript-marker', 'off');
// 恢复（或删掉该项）
localStorage.setItem('dsh-temp-chat:transcript-marker', 'on');
```

## 已知限制

- 答案只进对话、不进主上下文，因此**主 agent 看不到这些答案**；想让它知道，请把要点贴进正常提问。
- `/multi-turn` 只认最近一次 `/single-turn` 之后的那段话题；想开新话题就直接用 `/single-turn`。
- 每次临时问答都会留下一个子会话日志（和内置 `subagent` 工具的行为一致）；子代理列表里这一层显示为 `temp-chat:单轮` / `temp-chat:续问`。
- 子代理用的是当前会话的模型与 preset。
- 正文渲染与标记节点依赖 DSH 的扩展点（`conversation.chat.commandview`、`uiConversation.events.register`、`conversation.chat.node`），DSH 升级后可能变化；变化的表现是退回补位面板或 DSH 内置的命令卡片，不会白屏。

## 开发

```bash
npm test        # 等价于 node --test "test/**/*.test.mjs"
# 也可以只跑一个文件：
node --test test/thread.test.mjs test/client.test.mjs test/host.test.mjs
```

> Node 25 起 `node --test test/`（目录形式）会被当成模块入口而报 `MODULE_NOT_FOUND`，所以脚本用的是 glob 形式。

## 许可

MIT
