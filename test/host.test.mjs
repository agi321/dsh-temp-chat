/**
 * 宿主半边的测试：用假 ctx 驱动真实注册出来的命令处理器。
 * 覆盖上下文隔离、历史重放、preset 组合（角色 + 工具白名单）、超时/失败/取消等分支。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, PRESET_ID, apply } from '../index.js';
import { MULTI_TURN, SINGLE_TURN } from '../lib/thread.js';

const COMPLETED = {
  stopReason: 'completed',
  output: [
    { type: 'reasoning', text: '不该被取用' },
    { type: 'text', text: '答案：' },
    { type: 'text', text: '今天晴。' },
  ],
};

/** 取 preset 定义里某个 id 的行。 */
const row = (definition, id) => definition.plugins.find((plugin) => plugin.id === id);

/**
 * 造一个够用的宿主 ctx。
 *
 * @param {object} [options] - 桩行为开关。
 * @returns {{ctx: any, registered: Map<string, any>, runs: any[], presets: any[], agent: any}} 测试夹具。
 */
function createFixture(options = {}) {
  const registered = new Map();
  const runs = [];
  const presets = [];
  const sessionEvents = options.sessionEvents ?? [];
  const providerName = options.providerName ?? DEFAULT_CONFIG.provider;
  const queryFails = options.queryFails === true;
  const sessionSnapshot = options.sessionSnapshot;

  const agent = {
    id: 'session-test',
    session: {
      header: { id: 'session-test' },
      ...(sessionSnapshot === undefined ? {} : { snapshotEvents: () => sessionSnapshot }),
    },
  };

  const ctx = {
    logger: { info() {}, warn() {} },
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    commands: {
      register: (definition) => {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    },
    subagents: {
      getProvider: (name) => (name === providerName
        ? { name, ...(options.providerCaps === undefined ? {} : { capabilities: options.providerCaps }) }
        : undefined),
      list: () => [providerName],
      // 0.2.1-rc.2 起的权威入口：startActivation(spec)，spec = { provider, label, request, signal, delivery }。
      startActivation: async (spec) => {
        runs.push(spec);
        if (options.startThrows !== undefined) throw options.startThrows;
        return {
          childId: 'child-1',
          result: Promise.resolve(options.result ?? COMPLETED),
          dispose: async () => {
            if (options.disposeThrows === true) throw new Error('dispose failed');
          },
        };
      },
    },
    get: (key) => {
      if (key === 'agentPresets') {
        return {
          register: async (definition) => {
            presets.push(definition);
            if (options.registerThrows !== undefined) throw options.registerThrows;
            return async () => {
              const index = presets.indexOf(definition);
              if (index >= 0) presets.splice(index, 1);
            };
          },
        };
      }
      if (key !== 'sessionQuery') return undefined;
      if (options.noQuery === true) return undefined;
      return {
        observeSession: async () => {
          if (queryFails) throw new Error('query exploded');
          return { events: sessionEvents, [Symbol.dispose]: () => {} };
        },
      };
    },
  };

  return { ctx, registered, runs, presets, agent };
}

/** 注册插件并取回某个命令的 handler。 */
function setup(options, config) {
  const fixture = createFixture(options);
  apply(fixture.ctx, config);
  return { ...fixture, ctx: fixture.ctx };
}

const invoke = (handler, rawInput, overrides = {}) => handler({
  agent: overrides.agent,
  rawInput,
  attachments: [],
  commandId: 'cmd-1',
  signal: overrides.signal ?? new AbortController().signal,
});

test('apply registers exactly the two command names and no short alias', () => {
  const { registered } = setup();
  assert.deepEqual(
    [...registered.keys()].sort(),
    [MULTI_TURN, SINGLE_TURN].sort(),
    '只注册 /single-turn 与 /multi-turn，/st 与 /mt 已下线',
  );
  for (const commandName of [MULTI_TURN, SINGLE_TURN]) {
    const definition = registered.get(commandName);
    assert.equal(typeof definition.description, 'string');
    assert.equal(typeof definition.input.hint, 'string');
    assert.equal(typeof definition.handler, 'function');
  }
  for (const alias of ['st', 'mt']) {
    assert.equal(registered.has(alias), false, `/${alias} 不应再被注册`);
  }
});

/**
 * DSH 的命令名文法与解析（抄自安装包 `@deepseek-ai/dsh-commands/lib/types/index.js`）：
 *   COMMAND_NAME   = /^[a-z][a-z0-9_-]*$/u
 *   parseCommand() = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u
 * 抄一份是为了在没有 DSH 运行时的地方也能挡住"别名写了非法字符/大小写"这类改动。
 */
const DSH_COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;
const dshParseCommand = (line) => {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line);
  return match === null ? undefined : { name: match[1], rawInput: line.slice(match[0].length) };
};

test('every registered name is writable as a slash command followed by the question', () => {
  const { registered } = setup();
  for (const [name, definition] of registered) {
    assert.equal(DSH_COMMAND_NAME.test(name), true, `DSH 要求命令名匹配 ${String(DSH_COMMAND_NAME)}：${name}`);
    assert.equal(definition.name, name);
  }

  assert.deepEqual(dshParseCommand('/single-turn 今天天气'), { name: SINGLE_TURN, rawInput: ' 今天天气' });
  assert.deepEqual(dshParseCommand('/multi-turn 接着问'), { name: MULTI_TURN, rawInput: ' 接着问' });
  // 旧短别名在文法上仍是合法命令名，但插件不再注册它们（由上面的用例守住）。
  assert.deepEqual(dshParseCommand('/st 今天天气'), { name: 'st', rawInput: ' 今天天气' });
  assert.deepEqual(dshParseCommand('/mt 接着问'), { name: 'mt', rawInput: ' 接着问' });
  assert.equal(dshParseCommand('/st今天'), undefined, '命令名后面必须是空白');
  assert.equal(dshParseCommand('/Single-Turn x'), undefined, '大写名不是合法命令');
});

test('every registered command describes itself without mentioning a short alias', () => {
  const { registered } = setup();
  assert.match(registered.get(SINGLE_TURN).description, /单轮临时提问/);
  assert.match(registered.get(MULTI_TURN).description, /续接/);
  for (const [name, definition] of registered) {
    assert.doesNotMatch(definition.description, /短别名|\/st\b|\/mt\b/, `${name} 的描述不该再提短别名`);
  }
});

test('language: en registers English palette text, preset name and labels', async () => {
  const { registered, runs, presets, agent } = setup({}, { language: 'en' });
  assert.match(registered.get(SINGLE_TURN).description, /Single-turn temp question/);
  assert.match(registered.get(SINGLE_TURN).input.hint, /question to research/i);
  assert.match(registered.get(MULTI_TURN).description, /Continue the last temp topic/);
  assert.equal(presets[0].name, 'Temp Q&A (plugin internal)');
  const result = await invoke(registered.get(SINGLE_TURN).handler, '今天天气如何？', { agent });
  assert.equal(result.kind, 'success');
  assert.match(runs[0].label, /single-turn/, '强制 en 后，标签连中文提问也用英文');
});

test('language: auto makes per-run notices follow the question language', async () => {
  const options = { providerCaps: { agentPreset: false } };
  const en = setup(options);
  const enResult = await invoke(en.registered.get(SINGLE_TURN).handler, 'What is the weather tomorrow?', { agent: en.agent });
  assert.equal(enResult.kind, 'error');
  assert.match(enResult.text, /does not support agentPreset/);

  const zh = setup(options);
  const zhResult = await invoke(zh.registered.get(SINGLE_TURN).handler, '明天天气如何？', { agent: zh.agent });
  assert.match(zhResult.text, /不支持 agentPreset/);

  const long = setup();
  const longResult = await invoke(long.registered.get(SINGLE_TURN).handler, 'x'.repeat(9000), { agent: long.agent });
  assert.match(longResult.text, /Question too long/, '超长提示同样跟随文本语言');
});

test('an English /multi-turn cold start answers with the English note', async () => {
  const { registered, runs, agent } = setup({ sessionEvents: [] });
  const result = await invoke(registered.get(MULTI_TURN).handler, 'any topic to continue?', { agent });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /^> Note: there is no temp topic to continue/);
  assert.match(runs[0].label, /temp-chat:follow-up/);
});

test('the no-provider error lists the available providers in the question language', async () => {
  const { registered, agent } = setup({ providerName: 'spawn' }, { provider: 'fork' });
  const en = await invoke(registered.get(SINGLE_TURN).handler, 'which provider is used?', { agent });
  assert.match(en.text, /provider "fork" is not registered/);
  assert.match(en.text, /Available: spawn/);
});

test('/single-turn runs one activation against the internal preset with an isolated prompt', async () => {
  const { registered, runs, presets, agent } = setup();
  const result = await invoke(registered.get(SINGLE_TURN).handler, '  今天天气如何？  ', { agent });

  assert.equal(result.kind, 'success');
  assert.equal(result.text, '答案：今天晴。', '结果就是模型的回答，不带任何过程信息');
  assert.doesNotMatch(result.text, /检索过程|工具调用|web_search/);
  assert.equal(runs.length, 1);
  const spec = runs[0];
  assert.equal(spec.provider, DEFAULT_CONFIG.provider);
  assert.equal(spec.delivery, 'caller', '结果只交给调用方，不能往父会话追加完成通告');
  assert.equal(spec.request.agentPreset, PRESET_ID, '角色与工具范围由 preset 组合决定');
  assert.equal(spec.request.persona, undefined, '旧 persona 字段已随 start() 一起移除');
  assert.equal(spec.request.toolFilter, undefined, '旧 toolFilter 字段已随 start() 一起移除');
  assert.equal(spec.request.maxDepth, 1, '子代理自身 depth 为 1；给 0 会直接抛 SubagentDepthError');
  assert.equal(spec.request.parent, agent);
  assert.ok(spec.signal instanceof AbortSignal, '必须交出取消信号');
  assert.match(spec.request.prompt[0].text, /今天天气如何？/);
  assert.doesNotMatch(spec.request.prompt[0].text, /此前的临时话题/, '单轮模式不得带历史');

  // persona 与白名单应体现在注册的 preset 定义里。
  assert.equal(presets.length, 1, '每次 apply 只注册一个 preset');
  const definition = presets[0];
  assert.equal(definition.id, PRESET_ID);
  assert.match(row(definition, 'persona').config.prefix, /联网检索助手/);
  assert.deepEqual(row(definition, 'tool-web').config, { search: true, fetch: true, searchTimeoutMs: 60000 });
  assert.deepEqual(row(definition, 'tool-fs').config, { read: true, readImage: false, write: false, edit: false });
  assert.ok(row(definition, 'tool-fs-search') !== undefined, 'glob/grep 走 dsh-tool-fs-search 行');
  assert.ok(row(definition, 'compaction') !== undefined, '长检索会话要保留压缩行');
});

test('a custom persona from config lands in the preset row', async () => {
  const { presets } = setup({}, { persona: '你是定制角色。' });
  assert.equal(row(presets[0], 'persona').config.prefix, '你是定制角色。');
});

test('a provider without agentPreset support is refused with a clear hint', async () => {
  const { registered, runs, agent } = setup({ providerCaps: { agentPreset: false, depthLimit: true } });
  const result = await invoke(registered.get(SINGLE_TURN).handler, '问题', { agent });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /不支持 agentPreset/);
  assert.match(result.text, /spawn/);
  assert.equal(runs.length, 0);
});

test('a failing preset registration surfaces as a command error and retries next time', async () => {
  const { registered, runs, agent } = setup({ registerThrows: new Error('preset boom') });
  const result = await invoke(registered.get(SINGLE_TURN).handler, '问题', { agent });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /preset boom/);
  assert.equal(runs.length, 0, 'preset 没注册成功就不该起子代理');
});

test('/single-turn ignores an existing thread and starts a fresh topic', async () => {
  const sessionEvents = [
    { type: 'command/run', data: { commandId: 'a', name: SINGLE_TURN, args: '第一个问题' } },
    { type: 'command/done', data: { commandId: 'a', kind: 'success', text: '第一个答案' } },
  ];
  const { registered, runs, agent } = setup({ sessionEvents });
  const result = await invoke(registered.get(SINGLE_TURN).handler, '另起一问', { agent });

  assert.equal(result.kind, 'success');
  assert.equal(runs.length, 1);
  const prompt = runs[0].request.prompt[0].text;
  assert.match(prompt, /另起一问/);
  assert.doesNotMatch(prompt, /第一个答案/, '单轮模式不重放历史');
  assert.match(runs[0].label, /单轮/);
});

test('/multi-turn replays the current thread from the session log', async () => {
  const sessionEvents = [
    { type: 'command/run', data: { commandId: 'a', name: SINGLE_TURN, args: '第一个问题' } },
    { type: 'command/done', data: { commandId: 'a', kind: 'success', text: '第一个答案' } },
    { type: 'command/run', data: { commandId: 'b', name: MULTI_TURN, args: '追问' } },
    { type: 'command/done', data: { commandId: 'b', kind: 'success', text: '追问答案' } },
  ];
  const { registered, runs, agent } = setup({ sessionEvents });
  const result = await invoke(registered.get(MULTI_TURN).handler, '第三个问题', { agent });

  assert.equal(result.kind, 'success');
  const prompt = runs[0].request.prompt[0].text;
  assert.match(prompt, /此前的临时话题/);
  assert.match(prompt, /用户：第一个问题/);
  assert.match(prompt, /你的回答：第一个答案/);
  assert.match(prompt, /用户：追问/);
  assert.match(prompt, /## 本轮新提问（只回答这一个）\n\n第三个问题/);
  assert.ok(prompt.indexOf('追问答案') < prompt.indexOf('第三个问题'));
});

test('/multi-turn continues the thread started by /single-turn', async () => {
  const sessionEvents = [
    { type: 'command/run', data: { commandId: 'a', name: SINGLE_TURN, args: '第一问' } },
    { type: 'command/done', data: { commandId: 'a', kind: 'success', text: '第一答' } },
  ];
  const { registered, runs, agent } = setup({ sessionEvents });
  const result = await invoke(registered.get(MULTI_TURN).handler, '第二问', { agent });

  assert.equal(result.kind, 'success');
  assert.doesNotMatch(result.text, /没有可续接/, '/single-turn 开的话题 /multi-turn 能续上');
  const prompt = runs[0].request.prompt[0].text;
  assert.match(prompt, /用户：第一问/);
  assert.match(prompt, /你的回答：第一答/);
  assert.match(runs[0].label, /续问/);
});

test('a log written before the rename is ignored, so /multi-turn reports no thread', async () => {
  const sessionEvents = [
    { type: 'command/run', data: { commandId: 'a', name: 'temp-chat', args: '老话题问题' } },
    { type: 'command/done', data: { commandId: 'a', kind: 'success', text: '老话题答案' } },
  ];
  const { registered, runs, agent } = setup({ sessionEvents });
  const result = await invoke(registered.get(MULTI_TURN).handler, '新问题', { agent });

  assert.equal(result.kind, 'success');
  assert.match(result.text, /没有可续接的临时话题/, '插件还在开发阶段，不做旧命令名的兼容');
  assert.doesNotMatch(runs[0].request.prompt[0].text, /老话题答案/);
});

test('/multi-turn starts a new thread and says so when there is no history', async () => {
  const { registered, runs, agent } = setup({ sessionEvents: [] });
  const result = await invoke(registered.get(MULTI_TURN).handler, '冷启动问题', { agent });

  assert.equal(result.kind, 'success');
  assert.match(result.text, /^> 提示：当前没有可续接的临时话题/);
  assert.match(result.text, /答案：今天晴。/);
  assert.doesNotMatch(runs[0].request.prompt[0].text, /此前的临时话题/);
});

test('/multi-turn falls back to the live session snapshot when sessionQuery is absent', async () => {
  const sessionSnapshot = [
    { type: 'command/run', data: { commandId: 'a', name: SINGLE_TURN, args: '老问题' } },
    { type: 'command/done', data: { commandId: 'a', kind: 'success', text: '老答案' } },
  ];
  const { registered, runs, agent } = setup({ noQuery: true, sessionSnapshot });
  const result = await invoke(registered.get(MULTI_TURN).handler, '新问题', { agent });

  assert.equal(result.kind, 'success');
  assert.doesNotMatch(result.text, /没有可续接/, '有历史时不该提示冷启动');
  assert.match(runs[0].request.prompt[0].text, /老答案/);
});

test('config from the patch overrides the allowlist and history budget', async () => {
  const sessionEvents = [1, 2, 3].map((n) => ([
    { type: 'command/run', data: { commandId: `c${n}`, name: SINGLE_TURN, args: `q${n}` } },
    { type: 'command/done', data: { commandId: `c${n}`, kind: 'success', text: `a${n}` } },
  ])).flat();

  const { registered, runs, presets, agent } = setup({ sessionEvents }, {
    allowTools: ['web_search'],
    maxTurns: 1,
    timeoutMs: 1234,
  });
  await invoke(registered.get(MULTI_TURN).handler, 'nq', { agent });

  const definition = presets[0];
  assert.deepEqual(row(definition, 'tool-web').config, { search: true, fetch: false, searchTimeoutMs: 60000 });
  assert.equal(row(definition, 'tool-fs'), undefined, '不允许 fs 工具时不挂 tool-fs 行');
  assert.equal(row(definition, 'tool-fs-search'), undefined, 'glob/grep 未被允许就不挂检索行');
  const prompt = runs[0].request.prompt[0].text;
  assert.match(prompt, /a3/);
  assert.doesNotMatch(prompt, /a2/, 'maxTurns=1 只保留最新一轮');
  assert.doesNotMatch(prompt, /a1/);
});

test('empty and over-long questions are rejected before any child starts', async () => {
  const { registered, runs, agent } = setup();
  const handler = registered.get(SINGLE_TURN).handler;

  const empty = await invoke(handler, '   ', { agent });
  assert.equal(empty.kind, 'error');
  assert.match(empty.text, /请输入要问的内容/);
  assert.match(empty.text, /\/single-turn 今天有什么新闻？/, '示例回显用户实际敲的命令名');

  const tooLong = await invoke(handler, '问'.repeat(9000), { agent });
  assert.equal(tooLong.kind, 'error');
  assert.match(tooLong.text, /提问过长/);

  assert.equal(runs.length, 0);
});

test('the empty-question hint echoes the command that was typed', async () => {
  const { registered, agent } = setup();
  const viaMulti = await invoke(registered.get(MULTI_TURN).handler, '  ', { agent });
  assert.equal(viaMulti.kind, 'error');
  assert.match(viaMulti.text, /\/multi-turn 今天有什么新闻？/);
});

test('a missing provider is reported with the available ones', async () => {
  const { registered, agent } = setup({ providerName: 'spawn' }, { provider: 'fork' });
  const result = await invoke(registered.get(SINGLE_TURN).handler, '问题', { agent });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /provider「fork」未注册/);
  assert.match(result.text, /spawn/);
});

test('an unfinished child surfaces its stop reason and partial text', async () => {
  const result0 = { stopReason: 'max-tokens', output: [{ type: 'text', text: '写了一半' }] };
  const { registered, agent } = setup({ result: result0 });
  const result = await invoke(registered.get(SINGLE_TURN).handler, '问题', { agent });

  assert.equal(result.kind, 'error');
  assert.match(result.text, /未正常结束（max-tokens）/);
  assert.match(result.text, /写了一半/);
});

test('an empty answer and an aborted run both settle as errors', async () => {
  const empty = setup({ result: { stopReason: 'completed', output: [] } });
  const emptyResult = await invoke(empty.registered.get(SINGLE_TURN).handler, '问题', { agent: empty.agent });
  assert.equal(emptyResult.kind, 'error');
  assert.match(emptyResult.text, /没有返回文本答案/);

  const controller = new AbortController();
  controller.abort();
  const aborted = setup({ result: { stopReason: 'aborted', output: [] } });
  const abortedResult = await invoke(aborted.registered.get(SINGLE_TURN).handler, '问题', {
    agent: aborted.agent,
    signal: controller.signal,
  });
  assert.equal(abortedResult.kind, 'error');
  assert.match(abortedResult.text, /已取消/);
});

test('child startup and log-read failures become command errors, not crashes', async () => {
  const startFailed = setup({ startThrows: new Error('tools.restrict() names unknown global tool "web_search"') });
  const startResult = await invoke(startFailed.registered.get(SINGLE_TURN).handler, '问题', { agent: startFailed.agent });
  assert.equal(startResult.kind, 'error');
  assert.match(startResult.text, /unknown global tool/);

  const queryFailed = setup({ sessionEvents: [], queryFails: true });
  const queryResult = await invoke(queryFailed.registered.get(MULTI_TURN).handler, '问题', { agent: queryFailed.agent });
  assert.equal(queryResult.kind, 'error');
  assert.match(queryResult.text, /query exploded/);
});

test('a failing dispose does not lose the answer', async () => {
  const { registered, agent } = setup({ disposeThrows: true });
  const result = await invoke(registered.get(SINGLE_TURN).handler, '问题', { agent });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /今天晴/);
});

test('a missing agent is reported instead of throwing', async () => {
  const { registered } = setup();
  const result = await invoke(registered.get(SINGLE_TURN).handler, '问题', { agent: undefined });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /没有携带 agent/);
});

test('the answer never carries a retrieval process section, whatever the child logged', async () => {
  const result0 = { stopReason: 'completed', output: [{ type: 'text', text: '厦门：鼓浪屿、环岛路。' }] };
  const { registered, agent } = setup({ result: result0 });
  const result = await invoke(registered.get(SINGLE_TURN).handler, '厦门有什么好玩的', { agent });

  assert.equal(result.kind, 'success');
  assert.equal(result.text, '厦门：鼓浪屿、环岛路。', '过程信息不再拼接进结果文本');
  assert.doesNotMatch(result.text, /检索过程|工具调用|web_search|web_fetch|0\.\ds/);
});

test('the replay for /multi-turn feeds earlier answers back verbatim', async () => {
  const sessionEvents = [
    { type: 'command/run', data: { commandId: 'p1', name: SINGLE_TURN, args: '第一轮问题' } },
    { type: 'command/done', data: { commandId: 'p1', kind: 'success', text: '第一轮答案。\n\n第二段。' } },
  ];
  const { registered, runs, agent } = setup({ sessionEvents });
  await invoke(registered.get(MULTI_TURN).handler, '第二轮问题', { agent });

  const prompt = runs[0].request.prompt[0].text;
  assert.match(prompt, /你的回答：第一轮答案。\n\n第二段。/);
  assert.match(prompt, /## 本轮新提问（只回答这一个）\n\n第二轮问题/);
});
