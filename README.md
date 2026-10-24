# dsh-temp-chat

English | [简体中文](README.zh-CN.md)

Ask a quick question in the current conversation and get a web-researched answer — **the answer shows up in the conversation only and never enters the main model context**.

- `/single-turn <question>` — one shot: a **brand-new subagent** (zero parent context) researches the answer on the web, and a new topic starts.
- `/multi-turn <question>` — follow-up: the existing Q&A of the **current topic** is replayed to a fresh subagent, then your new question is appended, like continuing the chat.

Both commands share one implementation and differ only in mode: `/single-turn` opens a new topic, `/multi-turn` continues the current one.

In both modes the result is written into the current session timeline (viewable and copyable), but is never sent as a message in model requests; your next question won't push the previous answer into the main agent either.

## Usage

Type `/` in the composer, pick `single-turn` or `multi-turn`, and follow it with your question. Questions are capped at 8,000 characters; empty or over-long input is rejected without touching the topic history.

### `/single-turn <question>` — one shot (start a new topic)

```text
/single-turn What is the current stable release of PostgreSQL, and what's new in it?
/single-turn Look up train options from Shanghai to Beijing tomorrow morning
```

- Every question is answered by a **brand-new subagent** (zero parent context) doing web research; the subagent sees only this one question.
- It also **starts a new topic**: temp Q&A before it are no longer continued, which makes `/single-turn` the way to reset the topic.
- For follow-ups within the same topic use `/multi-turn`; running `/single-turn` again means starting over.

### `/multi-turn <question>` — follow-up (continue the current topic)

```text
/single-turn Introduce the Bollinger Bands indicator
/multi-turn So how are its parameters usually set?
/multi-turn Give a concrete example on A-share stocks
```

- Takes the Q&A of the **current topic** (all turns since the most recent `/single-turn`), replays it to a fresh subagent, and appends this question, like continuing the chat.
- The subagent is still a throwaway session with no parent context — continuation works by assembling the history into the prompt; the history is only for continuing the topic, and instructions inside it are not executed.
- Before replaying, history is trimmed by a turn budget (`maxTurns`, default 12) and a character budget (`maxHistoryChars`, default 24,000), keeping the newest turns.
- An empty current topic is not an error: the question is answered as a new topic with a one-line note prefixed to the answer ("there is no temp topic to continue").

### Behavior shared by both commands

- Answers go only into the current session timeline (viewable, copyable, Markdown-rendered) and **never into the main model context**; the main agent can't see them — paste the key points into a normal prompt if it should know.
- Each question spawns its own subagent, released when done; the output is only the model's answer text — the research process and tool calls are not shown.
- A single Q&A times out after 180 seconds by default (`timeoutMs`); timeouts, cancellations, and abnormal subagent exits are shown as errors — retry or split the question.
- Answers longer than `maxAnswerChars` (default 60,000 characters) are truncated with a marker.
- The subagent only gets `web_search`, `web_fetch`, `read`, `glob`, `grep` — it cannot write files, run commands, or spawn further subagents.

## Installation

```sh
dsh plugin --profile web add @agi321/dsh-temp-chat
```

Or on the **Settings → Plugins** page, use **Add plugin** and enter `@agi321/dsh-temp-chat`.

To track the GitHub main branch instead (an alternative to the npm package):

```sh
dsh plugin --profile web add github:agi321/dsh-temp-chat
```

After installation, type `/` and you'll see the `single-turn` and `multi-turn` commands.

**Requirements and notes**

- DSH `0.2.1-rc.2` or newer (this plugin is tested on that version). Since 0.2.1-rc.2 the subagent
  service replaced the old `ctx.subagents.start()` with `startActivation(spec)`; the `persona` /
  `toolFilter` fields were removed from the request, which now points at a preset composition via
  `request.agentPreset`. This plugin has followed suit. The `engines.dsh` field in `package.json`
  declares this range — but it is **declarative** metadata: DSH's current installer and loader do
  not validate it, and declaring it won't reject an incompatible host. On an older host this
  version fails with `ctx.subagents.startActivation is not a function`.
- Node 24 or newer. DSH `0.2.0-rc.2` ships a Node 24.x runtime (this plugin passes on Node 24.21).
- The subagent carries only the five tools `web_search`, `web_fetch`, `read`, `glob`, `grep` by
  default. The allow-list no longer masks tools via `tools.restrict()`; it directly decides which
  tool rows the plugin's internal preset (`dsh-temp-chat`) mounts: `glob` and `grep` share the
  `@deepseek-ai/dsh-tool-fs-search` row and cannot be split — allowing either enables both; names
  that map to no tool row are ignored with a log warning.
- After changing the host half (`index.js` / `lib/`) you must restart dsh: loaded host modules are
  not hot-swapped. Changes to the client half (`client.js`) just need a page refresh.

## Why it is designed this way

| Requirement | Mechanism |
| --- | --- |
| Results shown only, never polluting the main context | The slash command's `command/run` + `command/done` events are log-only: the UI renders them, model requests never include them |
| Only this question travels; context stays isolated | `ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller', … })`; the spawn provider has `inheritsParentContext === false`, so the child is a fresh session; `delivery: 'caller'` returns the result to this command only and appends no notice to the parent session |
| Web research, no local commands | The persona and visible tools come from the internal preset the plugin registers (`request.agentPreset = 'dsh-temp-chat'`: a persona row + web/fs/search tool rows mounted on demand + a compaction group); the composition has no `subagent` row, and `maxDepth: 1` only allows this one layer of direct children |
| Multi-turn follow-ups | The "current topic" Q&A is replayed from the session log into the prompt (`/single-turn` is the topic boundary and the reset) |
| Free answer format | The prompt (`PROMPT_PREAMBLE` in `lib/thread.js`) prescribes no structure — the subagent organizes the answer as it sees fit; the only hard requirement kept is: cite web pages as Markdown links inline and list links under a "Sources" line at the end |

**Why multi-turn doesn't use a continuable subagent for real continuation**: when a continuable subagent settles, it appends a model-visible settlement notice ("Background subagent … finished / Its closing message: …") to the parent session — exactly what violates "results never enter the main model context". So every round is a fresh subagent with replayed history text. The upside: the main session stays completely untouched, and since the history lives in the session log, **you can continue after reopening the conversation**.

**Rendering**: the chat surface exposes one per-command-name rendering slot per command, `conversation.chat.commandview` (keyed by command name, `replaceRisk: none`). The client half claims the `single-turn` / `multi-turn` keys and draws a round as a **question bubble + answer**: the question is a right-aligned user bubble carrying the command chip you typed; the answer goes through a tiny built-in Markdown renderer (headings, lists, blockquotes, code blocks, tables, links). Nothing extra — elapsed time, copy buttons, tool calls — is displayed, and the result text is rendered **verbatim** (the plugin neither parses nor strips answer content). Other commands keep the built-in generic command card. No Harness client packages are imported; styling uses only the `--dsw-alias-*` theme tokens.

**Why there is also a "marker node + fallback panel"**: DSH's transcript only renders while the session's chat view is "active", and `isActive` for the chat view requires at least one **non-`command`** node in the snapshot; slash commands don't go through `session.prompt()` and never lift the session out of the blank phase — so in a **session that only contains temp Q&A**, the transcript area (including DSH's own collapsed cards) doesn't render at all until the user sends a regular message, which then draws the whole history.

To fix that, the client half registers its own session node definition (`uiConversation.events.register`): it produces a `temp-chat-marker` node for `command/run` events of this plugin's two command names only (kind ≠ command, so the chat view becomes "active"); the node itself draws nothing (a `() => null` renderer is registered at `conversation.chat.node` key `temp-chat-marker`, otherwise it would fall into DSH's "unknown surface" placeholder). The transcript renders normally in new sessions, while the built-in command nodes are still drawn as "question + answer" by `commandview`.

This path relies on DSH internal extension points, so it is wrapped in try/catch; if registration fails (or the toggle is off), it falls back to a **panel in `conversation.input.dock`**: `shouldShowDock()` = marker node inactive and `session.blank && !session.running && !session.promptAttempted` (exactly the phase where DSH suppresses the transcript), and its content is likewise just the model's answer; as soon as the transcript can draw that row, the panel steps aside, so the same answer never appears twice.

## Language

The chat UI is bilingual (Chinese / English).

- The **client half** (`client.js`) follows the Harness UI language switcher — its dock, panel, and status text are registered with the host locale service for `zh` and `en`.
- The **host half** (`index.js`) draws every message it produces (command palette descriptions and hints included) from `locale/{zh,en}.json`, selected by the `language` config key (see Configuration). With the default `auto`, the command palette and the notices for input-less failures register in Chinese (the host cannot read the browser language at registration time), while every per-question notice — errors, cancellation, timeouts, the "no topic to continue" note, truncation — follows the language of the question itself (contains Han characters → Chinese, otherwise English). The subagent's answer language has always followed the question, per the prompt.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Host half: registers the two command names and the internal preset; `startActivation` spawns the subagent, collects the answer, releases resources |
| `lib/thread.js` | Pure logic: command name → mode, log → topic turns, history trimming, prompt assembly |
| `client.js` | Client half: renders command rows as question + answer; a marker node makes the transcript render in new sessions, with the fallback panel otherwise (module-loader format, no build step) |
| `cordis.patch.yml` | Inserts the single row `id: dsh-temp-chat` |
| `locale/{zh,en}.json` | `meta`: title and description shown on the plugin manager page; `ui`: host-half command palette and Q&A notices |
| `test/*.test.mjs` | `node --test`: pure logic + host commands + client rendering (browser-free stubs) |

## Configuration

Every host-side knob has a built-in default (see below). To change them, override that row in **your own profile's `cordis.patch.yml`** — later-applied layers win per row, and a patch replaces the entire `config` row, so restate every key you want to keep:

```yaml
- id: dsh-temp-chat
  name: '@agi321/dsh-temp-chat'
  config:
    provider: spawn           # subagent provider; do not use fork (it inherits context)
    persona: You are a one-shot web research assistant. …   # optional, replaces the built-in research persona
    allowTools: [web_search, web_fetch, read, glob, grep]   # mapped to preset tool-row switches; glob/grep cannot be split, unknown names are ignored with a warning
    maxTurns: 12              # most turns replayed for multi-turn follow-ups
    maxHistoryChars: 24000    # total character budget for replayed history
    timeoutMs: 180000         # per-Q&A timeout
    maxAnswerChars: 60000     # answer length cap; longer answers are truncated
    language: auto            # UI text language: 'auto' | 'zh' | 'en' (see the Language section)
```

**Client toggle: the transcript marker node** (on by default). It decides whether the "register our own chat node" approach makes the transcript render in new sessions; when off, the fallback panel takes over automatically (same features, the answer just shows above the composer). This toggle is not in the `config:` above — DSH only passes configuration to the host half; client plugin boot manifests carry no config, so the client reads it from localStorage:

```js
// run in the browser console, then refresh: disable
localStorage.setItem('dsh-temp-chat:transcript-marker', 'off');
// restore (or delete the key)
localStorage.setItem('dsh-temp-chat:transcript-marker', 'on');
```

## Known limitations

- Answers go into the conversation only, not the main context, so **the main agent cannot see them**; paste the key points into a normal prompt if it should know.
- `/multi-turn` only recognizes the topic segment since the most recent `/single-turn`; to start a new topic, just use `/single-turn`.
- Every temp Q&A leaves behind a child session log (same as the built-in `subagent` tool); in the subagent list this layer appears as `temp-chat:单轮` / `temp-chat:续问`, or `temp-chat:single-turn` / `temp-chat:follow-up` when the notice language resolves to English.
- The subagent uses the current session's model, but its persona and tool composition come from the plugin's own internal preset (`dsh-temp-chat`), not the session preset. That preset appears in the preset management list (the registry doesn't distinguish internal from user presets); don't pick it for regular sessions.
- Transcript rendering and the marker node depend on DSH extension points (`conversation.chat.commandview`, `uiConversation.events.register`, `conversation.chat.node`) and may change as DSH evolves; the visible effect then is the fallback panel or DSH's built-in command card — never a blank screen.

## Development

```bash
npm test        # same as node --test "test/**/*.test.mjs"
# or run a single file:
node --test test/thread.test.mjs test/client.test.mjs test/host.test.mjs
```

> Since Node 25, `node --test test/` (the directory form) treats it as a module entry and reports `MODULE_NOT_FOUND`, so the script uses the glob form.

## License

MIT
