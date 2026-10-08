/**
 * 客户端半边的无浏览器集成测试。
 *
 * 用一个极小的 React 桩 + `window.__ModuleLoader__` 桩加载 client.js，捕获它注册到
 * `conversation.chat.commandview` 的组件，再按真实节点形状渲染并断言输出结构。
 * 树遍历会把函数组件也展开，尽量贴近真实 React 的行为，这样"槽位组件崩溃导致整行
 * 静默空白"这类问题在安装前就能发现。
 *
 * 这里还从 `lib/thread.js` 直接 import 命令名常量：客户端那份清单是手抄的（浏览器
 * 模块不 import 宿主模块），所以要有测试盯着两边不许走散。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  HISTORY_COMMANDS,
  MULTI_TURN,
  SINGLE_TURN,
} from '../lib/thread.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- 桩：React ---------------- */

function createElement(type, props, ...children) {
  return {
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true),
  };
}

const reactStub = {
  createElement,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  // 桩：同步跑一次副作用（丢弃清理函数），这样"要不要取数"这类行为能被断言到。
  useEffect: (fn) => {
    fn();
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  memo: (component) => component,
  Fragment: 'Fragment',
};

/* ---------------- 桩：模块加载器 ---------------- */

let spec;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      spec = definition;
    },
  },
};

await import(pathToFileURL(path.join(here, '..', 'client.js')).href);

const moduleExports = spec.factory((name) => {
  if (name === 'react') return reactStub;
  throw new Error(`unexpected require(${name})`);
});

const internals = moduleExports.__internals;

/* ---------------- 桩：客户端 ctx ---------------- */

/** 默认 remote 桩：历史分页返回给定记录（默认空）。 */
function remoteStub(records) {
  return {
    session: {
      page: async () => ({ records: records ?? [] }),
    },
  };
}

function mountPlugin({ remote = remoteStub(), uiConversation = undefined } = {}) {
  const registered = new Map();
  const markerDefinitions = [];
  return {
    registered,
    markerDefinitions,
    mount() {
      const conversation = uiConversation === undefined
        ? { events: { register: (definition) => { markerDefinitions.push(definition); return () => {}; } } }
        : uiConversation;
      const ctx = {
        get: (key) => (key === 'remote' ? remote : key === 'uiConversation' ? conversation : undefined),
        remote,
        uiConversation: conversation,
        logger: { warn() {} },
        effect: (fn) => {
          const dispose = fn();
          return typeof dispose === 'function' ? dispose : () => {};
        },
        locale: { register: () => () => {} },
        slots: {
          inject: (_key, callback) => callback(),
          register: (options, component) => {
            const cell = options.key ?? ('id:' + options.id);
            registered.set(cell, component);
            return () => registered.delete(cell);
          },
        },
      };
      moduleExports.apply(ctx);
      return registered;
    },
  };
}

/** 一个最小的 localStorage 桩。 */
function storageStub(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** 在临时安装的 localStorage 下跑一段逻辑。 */
function withStorage(entries, fn) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storageStub(entries), configurable: true });
  try {
    return fn();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', previous);
  }
}

/**
 * 展开函数组件后的宿主节点列表（文本与元素混排）。
 *
 * @param {any} node - createElement 树。
 * @returns {any[]} 展开结果。
 */
function flatten(node) {
  if (node === null || node === undefined || node === false || node === true) return [];
  if (Array.isArray(node)) return node.flatMap((child) => flatten(child));
  if (typeof node === 'string' || typeof node === 'number') return [node];
  if (typeof node !== 'object') return [];
  if (typeof node.type === 'function') return flatten(node.type(node.props));
  return [node, ...(node.children ?? []).flatMap((child) => flatten(child))];
}

/** 找出所有满足条件的宿主节点。 */
function findAll(tree, predicate) {
  return flatten(tree).filter((node) => typeof node === 'object' && node !== null && node.type !== undefined && predicate(node));
}

/** 取出树里所有文本，拼成一个便于断言的大字符串。 */
function textOf(tree) {
  return flatten(tree).filter((node) => typeof node === 'string').join('\n');
}

/** 文本行里是否恰好有这一行（命令标记是独立的一小块文本）。 */
const hasLine = (tree, line) => textOf(tree).split('\n').includes(line);

// 命令名不翻译：chip 直接拼 `/${name}`，所以词条表里不再有 chip.* 项。
// 留着它们反而是隐患——代码若某天又去查 'chip.temp'，断言拿到的会是词条名本身。
const t = (key, params) => {
  const table = {
    'status.running': '正在联网检索…',
    'error.empty': '没有返回内容。',
    'error.unavailable': '结果不可用（渲染失败），以下是原始内容。',
    'dock.title': '临时问答',
    'dock.rounds': `${params?.count ?? 0} 轮`,
    'dock.hide': '收起',
    'dock.show': '展开',
    'dock.expand': '展开答案',
    'dock.collapse': '收起答案',
    'dock.noQuestion': '（无提问文本）',
    'dock.reload': '刷新',
    'dock.error': '读取失败',
    'dock.noRemote': '宿主 remote 不可用',
  };
  return table[key] ?? key;
};

let commandSeq = 0;
const renderNode = (component, node) => {
  commandSeq += 1;
  return component({ node, t, sessionId: 'session-test' });
};

/** 渲染一次 dock 槽位（props 形状与宿主 composer 传进来的一致）。 */
const renderDock = (component, session, input) => component({ session, input, t });

const settled = (name, args, text, commandId) => ({
  kind: 'command',
  commandId: commandId ?? `cmd-${commandSeq}`,
  name,
  args,
  outcome: { kind: 'success', text },
});

/* ---------------- 用例 ---------------- */

test('client half claims every command name the host recognizes, plus its dock and marker', () => {
  assert.deepEqual(moduleExports.inject, ['slots', 'locale', 'remote', 'remote.session', 'uiConversation']);
  const registered = mountPlugin().mount();
  assert.deepEqual(
    [...registered.keys()].sort(),
    ['id:local-temp-chat', internals.MARKER_KIND, ...HISTORY_COMMANDS].sort(),
    '每个命令名一个正文行渲染位 + 补位面板 + 标记节点渲染器',
  );
});

test('the client-side command list stays in lockstep with lib/thread.js', () => {
  // client.js 跑在浏览器模块加载器里，不 import 宿主模块，只能手抄一份命令名清单。
  // 抄漏一个会让那一行掉回通用折叠卡片，所以这里对着清单比。
  const registered = mountPlugin().mount();
  const claimed = [...registered.keys()].filter((key) => key !== 'id:local-temp-chat' && key !== internals.MARKER_KIND);
  assert.deepEqual(claimed.sort(), [...HISTORY_COMMANDS].sort());
  for (const name of [SINGLE_TURN, MULTI_TURN]) {
    assert.equal(claimed.includes(name), true, `${name} 必须有渲染位`);
  }
  for (const alias of ['st', 'mt']) {
    assert.equal(claimed.includes(alias), false, `/${alias} 已下线，客户端不该再占位`);
  }
});

test('running state shows the question bubble and a searching line', () => {
  const component = mountPlugin().mount().get(SINGLE_TURN);
  const tree = renderNode(component, { kind: 'command', commandId: 'cmd-run', name: SINGLE_TURN, args: '今天有什么新闻？', outcome: null });
  const text = textOf(tree);
  assert.ok(hasLine(tree, `/${SINGLE_TURN}`), '提问气泡上带命令标记');
  assert.match(text, /今天有什么新闻？/);
  assert.match(text, /正在联网检索…/);
  assert.equal(findAll(tree, (node) => node.type === 'button').length, 0, '运行中不给按钮');
});

test('settled answer renders as a chat turn: question bubble + markdown answer', () => {
  const component = mountPlugin().mount().get(SINGLE_TURN);
  const answer = [
    '## 结论',
    '这是 **要点** 与 `inline`。',
    '',
    '- 第一项',
    '- 第二项',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    '参考 [来源](https://example.com/a) 与 https://example.com/b。',
    '',
    '| 项目 | 值 |',
    '| --- | --- |',
    '| 甲 | 1 |',
  ].join('\n');
  const tree = renderNode(component, settled(SINGLE_TURN, '问题', answer));

  assert.equal(findAll(tree, (node) => node.type === 'strong').length, 1);
  const code = findAll(tree, (node) => node.type === 'code' && String(node.children[0]).includes('const answer'));
  assert.equal(code.length, 1, '保留围栏代码块');
  const links = findAll(tree, (node) => node.type === 'a');
  assert.deepEqual(links.map((node) => node.props.href), ['https://example.com/a', 'https://example.com/b']);
  assert.equal(links[0].props.target, '_blank');
  assert.equal(links[0].props.rel, 'noopener noreferrer');
  assert.deepEqual(findAll(tree, (node) => node.type === 'td').map((cell) => cell.children[0]), ['甲', '1']);
  assert.equal(findAll(tree, (node) => node.type === 'li').length, 2);

  // 提问行：用户气泡里带命令标记 + 原文
  const text = textOf(tree);
  assert.ok(hasLine(tree, `/${SINGLE_TURN}`));
  assert.match(text, /问题/);
  assert.match(text, /结论/);

  // 用户气泡右对齐，答案用宿主正文排版
  assert.ok(findAll(tree, (node) => node.props?.style?.alignItems === 'flex-end').length > 0, '提问行右对齐');
  assert.ok(
    findAll(tree, (node) => node.props?.style?.lineHeight === 'calc(22px + var(--dsh-content-font-delta, 0px))').length > 0,
    '正文用宿主内容排版变量',
  );
  assert.equal(findAll(tree, (node) => node.type === 'button').length, 0, '不再有复制按钮等额外控件');
});

test('each command name renders its own chip, and no alias chip survives', () => {
  const registered = mountPlugin().mount();

  const viaSingle = renderNode(registered.get(SINGLE_TURN), settled(SINGLE_TURN, '问题', '答案'));
  assert.ok(hasLine(viaSingle, `/${SINGLE_TURN}`));
  assert.doesNotMatch(textOf(viaSingle), /\/multi-turn/);
  assert.doesNotMatch(textOf(viaSingle), /\/st\b/, '短别名已下线，不应再出现');
  assert.doesNotMatch(textOf(viaSingle), /\/mt\b/);

  const viaMulti = renderNode(registered.get(MULTI_TURN), settled(MULTI_TURN, '接着问', '好的'));
  assert.ok(hasLine(viaMulti, `/${MULTI_TURN}`));
  assert.doesNotMatch(textOf(viaMulti), /\/single-turn/);
  assert.doesNotMatch(textOf(viaMulti), /\/mt\b/, '短别名已下线，不应再出现');
});

test('a command name missing from the event still yields a sensible chip', () => {
  const component = mountPlugin().mount().get(SINGLE_TURN);
  const tree = renderNode(component, { kind: 'command', commandId: 'cmd-noname', args: '问题', outcome: { kind: 'success', text: '答案' } });
  assert.ok(hasLine(tree, `/${SINGLE_TURN}`), '名字缺失时退回主名，至少能看出是单轮还是多轮');
});

test('the row carries no retrieval process, tool calls, duration or copy chrome', () => {
  const component = mountPlugin().mount().get(SINGLE_TURN);
  const commandId = 'cmd-plain';
  const running = renderNode(component, { kind: 'command', commandId, name: SINGLE_TURN, args: '厦门有什么好玩的', outcome: null });
  assert.doesNotMatch(textOf(running), /耗时|复制|检索过程|web_search/);

  const done = renderNode(component, settled(SINGLE_TURN, '厦门有什么好玩的', '鼓浪屿和环岛路值得一去。', commandId));
  const text = textOf(done);
  assert.match(text, /鼓浪屿和环岛路值得一去。/);
  assert.doesNotMatch(text, /耗时|复制|检索过程|工具调用|web_search/);
});

test('the answer is rendered verbatim (nothing is stripped from the result text)', () => {
  const component = mountPlugin().mount().get(SINGLE_TURN);
  const raw = [
    '## 结论',
    '答案正文。',
    '',
    '---',
    '',
    '**🔍 检索过程**（共 1 次工具调用）',
    '',
    '- `web_search` 「厦门 旅游」 · 0.9s',
    '- `web_fetch` https://example.com/x · 失败',
  ].join('\n');
  const text = textOf(renderNode(component, settled(SINGLE_TURN, '厦门有什么好玩的', raw)));

  assert.match(text, /答案正文。/);
  assert.match(text, /检索过程/, '结果文本原样显示；插件不再为旧格式做任何剥离');
  assert.match(text, /web_search/);
  assert.match(text, /example\.com\/x/);
});

test('error outcome renders the failure text without throwing', () => {
  const component = mountPlugin().mount().get(SINGLE_TURN);
  const tree = renderNode(component, {
    kind: 'command',
    commandId: 'cmd-err',
    name: SINGLE_TURN,
    args: '问题',
    outcome: { kind: 'error', text: '子代理未正常结束（error）。\n第二行' },
  });
  const text = textOf(tree);
  assert.match(text, /子代理未正常结束/);
  assert.match(text, /第二行/);
  assert.equal(findAll(tree, (node) => node.type === 'button').length, 0);
});

test('the ChatNode shape (state under .data) still renders the answer', () => {
  const component = mountPlugin().mount().get(SINGLE_TURN);
  const state = settled(SINGLE_TURN, '包在 data 里的问题', '包在 data 里的答案');
  const tree = renderNode(component, { key: 'ctx', kind: 'command', anchorSeq: 3, data: state });
  const text = textOf(tree);
  assert.match(text, /包在 data 里的问题/);
  assert.match(text, /包在 data 里的答案/);
  assert.doesNotMatch(text, /正在联网检索…/, '不能因为形状不同就永远显示运行中');
});

test('a throwing getter degrades to visible plain text instead of a blank row', () => {
  const component = mountPlugin().mount().get(SINGLE_TURN);
  const outcome = { kind: 'success' };
  Object.defineProperty(outcome, 'text', {
    enumerable: true,
    get() {
      throw new Error('boom');
    },
  });
  const tree = renderNode(component, { kind: 'command', commandId: 'cmd-boom', name: SINGLE_TURN, args: '问题还在', outcome });
  const text = textOf(tree);
  assert.match(text, /问题还在/);
  assert.ok(text.trim().length > 0, '兜底必须仍然有内容');
  assert.ok(findAll(tree, (node) => node.type === 'pre').length > 0, '兜底用纯文本 pre 呈现');
});

test('malformed command states never throw', () => {
  const component = mountPlugin().mount().get(SINGLE_TURN);
  const fixtures = [
    {},
    undefined,
    null,
    'nonsense',
    { kind: 'command', name: SINGLE_TURN },
    { kind: 'command', name: SINGLE_TURN, args: null, outcome: { kind: 'success' } },
    { kind: 'command', name: SINGLE_TURN, args: 'x', outcome: { kind: 'success', text: '' } },
    { kind: 'command', name: SINGLE_TURN, args: 'x', outcome: { kind: 'success', text: '```\n未闭合的代码块' } },
    { kind: 'command', name: SINGLE_TURN, args: 'x', outcome: { kind: 'success', text: '| a |\n| --- |\n| 1 |' } },
    { kind: 'command', name: SINGLE_TURN, args: 'x', outcome: { kind: 'success', text: '> 引用\n\n---\n\n1. 一\n2. 二' } },
    { kind: 'command', name: SINGLE_TURN, args: 'x', outcome: { kind: 'success', text: '#'.repeat(6) + ' 深标题\n~~删除~~ _斜_ __粗__' } },
    { kind: 'command', name: SINGLE_TURN, args: 'x', outcome: { kind: 'success', text: 'a'.repeat(5000) } },
    { kind: 'command', name: 'temp-chat', args: 'x', outcome: { kind: 'success', text: '改名前的名字也不许崩' } },
  ];
  for (const fixture of fixtures) {
    assert.doesNotThrow(() => renderNode(component, fixture), `fixture: ${JSON.stringify(fixture)}`);
  }
});

/* ---------------- 补位面板（正文渲染不出来时才出现） ---------------- */

/** 临时把"标记节点是否已注册"设成给定值（apply 之后默认是 true）。 */
function withMarkerActive(active, fn) {
  const previous = internals.markerState.active;
  internals.markerState.active = active;
  try {
    return fn();
  } finally {
    internals.markerState.active = previous;
  }
}

test('the dock only claims the slot while the transcript cannot render', () => {
  withMarkerActive(false, () => {
    assert.equal(internals.shouldShowDock({ blank: true, running: false, promptAttempted: false }), true, 'blank 会话需要补位');
    assert.equal(internals.shouldShowDock({ blank: false, running: false, promptAttempted: false }), false, '有普通回合后正文自己能画，让位');
    assert.equal(internals.shouldShowDock({ blank: true, running: true, promptAttempted: false }), false, '运行中相位是 active');
    assert.equal(internals.shouldShowDock({ blank: true, running: false, promptAttempted: true }), false, '有过 prompt 尝试相位是 engaging');
    assert.equal(internals.shouldShowDock(undefined), false);
    assert.equal(internals.shouldShowDock(null), false);
  });
  withMarkerActive(true, () => {
    assert.equal(
      internals.shouldShowDock({ blank: true, running: false, promptAttempted: false }),
      false,
      '标记节点已经把正文区拉起来，面板必须让位（否则同一份答案出现两次）',
    );
  });
});

test('the dock reads the session page only when it is the one showing the answer', async () => {
  const calls = [];
  const remote = { session: { page: async (...args) => { calls.push(args); return { records: [] }; } } };
  const component = mountPlugin({ remote }).mount().get('id:local-temp-chat');

  withMarkerActive(false, () => {
    renderDock(component, { sessionId: 's1', blank: false, running: false, promptAttempted: false }, { draft: '' });
    assert.equal(calls.length, 0, '正文能渲染时不去读宿主数据');

    renderDock(component, { sessionId: 's1', blank: true, running: false, promptAttempted: false }, { draft: '' });
    assert.equal(calls.length, 1, '需要补位时才读一次');
  });
  assert.deepEqual(calls[0][0].address, { kind: 'session', sessionId: 's1' });
  assert.equal(calls[0][0].throughSeq, -1);
  assert.ok(calls[0][1] instanceof AbortSignal, '带上取消信号');
});

test('the dock stays out of the way when there is nothing to show', () => {
  assert.equal(internals.renderDockFrame({ status: 'ready', turns: [], error: '' }, t), null, '没有轮次就不占位');
  const failed = internals.renderDockFrame({ status: 'error', turns: [], error: 'boom' }, t);
  assert.match(textOf(failed), /读取失败/);
  assert.match(textOf(failed), /boom/, '失败原因必须显示出来，不能静默');
});

test('the dock renders each turn with its own chip, answer and collapse state', () => {
  const state = {
    status: 'ready',
    error: '',
    turns: [
      { key: 'a', name: SINGLE_TURN, mode: SINGLE_TURN, question: '第一问', answer: '第一答', running: false, failed: false },
      { key: 'b', name: MULTI_TURN, mode: MULTI_TURN, question: '厦门值得去吗', answer: '结论：值得一去。', running: false, failed: false },
    ],
  };
  const tree = internals.renderDockFrame(state, t, {});
  const text = textOf(tree);
  assert.match(text, /临时问答/);
  assert.match(text, /2 轮/);
  assert.match(text, /厦门值得去吗/);
  assert.match(text, /结论：值得一去。/);
  assert.match(text, /第一问/, '旧轮保留提问行');
  assert.doesNotMatch(text, /第一答/, '旧轮默认折叠');
  assert.ok(hasLine(tree, `/${MULTI_TURN}`), '面板里也显示命令标记');
  assert.deepEqual(findAll(tree, (node) => node.type === 'a').map((node) => node.props.href), []);
});

test('the dock shows a running turn as a searching line', () => {
  const state = { status: 'ready', error: '', turns: [{ key: 'a', name: SINGLE_TURN, mode: SINGLE_TURN, question: '厦门有什么好玩的', answer: '', running: true, failed: false }] };
  const text = textOf(internals.renderDockFrame(state, t, {}));
  assert.match(text, /正在联网检索…/);
  assert.match(text, /厦门有什么好玩的/);
});

test('collapsing the dock hides the body but keeps the bar', () => {
  const state = { status: 'ready', error: '', turns: [{ key: 'a', name: SINGLE_TURN, mode: SINGLE_TURN, question: 'QUESTION-X', answer: 'ANSWER-BODY-Y', running: false, failed: false }] };
  const text = textOf(internals.renderDockFrame(state, t, { collapsed: true }));
  assert.match(text, /临时问答/);
  assert.doesNotMatch(text, /QUESTION-X/);
  assert.doesNotMatch(text, /ANSWER-BODY-Y/);
});

test('foldRecords reads the host history page and keeps the current topic', () => {
  const record = (event) => ({ type: 'event', event });
  const records = [
    record({ type: 'turn/start', seq: 0, data: { turn: 1 } }),
    record({ type: 'command/run', seq: 1, data: { commandId: 'old', name: SINGLE_TURN, args: '上一话题' } }),
    record({ type: 'command/done', seq: 2, data: { commandId: 'old', kind: 'success', text: '上一话题答案' } }),
    record({ type: 'command/run', seq: 3, data: { commandId: 'a', name: SINGLE_TURN, args: ' 本话题问题 ' } }),
    record({ type: 'command/done', seq: 4, data: { commandId: 'a', kind: 'success', text: '本话题答案' } }),
    record({ type: 'command/run', seq: 5, data: { commandId: 'b', name: MULTI_TURN, args: '追问' } }),
    { type: 'event', event: { type: 'command/run', seq: 6, data: { commandId: 'c', name: 'compact', args: '' } } },
    { type: 'event', event: { type: 'command/run', seq: 7, data: { commandId: 'd', name: 'temp-chat', args: '改名前的名字' } } },
    { type: 'event', event: { type: 'command/run', seq: 8, data: { commandId: 'e', name: 'st', args: '已下线的短别名' } } },
  ];
  const turns = internals.foldRecords(records);
  assert.deepEqual(turns.map((turn) => turn.key), ['a', 'b'], '只保留最近一次单轮命令起的话题，且忽略别的命令（含旧名与下线的短别名）');
  assert.deepEqual(turns[0], {
    key: 'a',
    name: SINGLE_TURN,
    mode: SINGLE_TURN,
    question: '本话题问题',
    answer: '本话题答案',
    running: false,
    failed: false,
  });
  assert.equal(turns[1].running, true, '只有 run 的那一轮视为运行中');
  assert.equal(turns[1].mode, MULTI_TURN);
  assert.deepEqual(internals.foldRecords(undefined), []);
  assert.deepEqual(internals.foldRecords([{ type: 'event' }, null, 'junk']), []);
});

test('inputSignature changes when the user types or submits', () => {
  const base = internals.inputSignature({ phase: 'idle', draft: '' });
  assert.notEqual(base, internals.inputSignature({ phase: 'idle', draft: '/single-turn 厦门' }));
  assert.notEqual(base, internals.inputSignature({ phase: 'submitting', draft: '' }));
  assert.equal(base, internals.inputSignature({ phase: 'idle', draft: '' }));
  assert.equal(internals.inputSignature(undefined), '');
});

/* ---------------- 正文标记节点（把正文区拉起来）+ 开关 ---------------- */

test('the marker switch reads localStorage and defaults to on', () => {
  assert.equal(internals.markerEnabled(), true, '没有 localStorage 时默认开');
  withStorage({}, () => {
    assert.equal(internals.markerEnabled(), true, '没有该项时默认开');
  });
  for (const value of ['off', '0', 'false', 'no', ' OFF ']) {
    withStorage({ [internals.MARKER_STORAGE_KEY]: value }, () => {
      assert.equal(internals.markerEnabled(), false, `${value} 应当关闭`);
    });
  }
  for (const value of ['on', '1', 'true', 'yes']) {
    withStorage({ [internals.MARKER_STORAGE_KEY]: value }, () => {
      assert.equal(internals.markerEnabled(), true, `${value} 应当打开`);
    });
  }
  withStorage({ [internals.MARKER_STORAGE_KEY]: '没见过的值' }, () => {
    assert.equal(internals.markerEnabled(), true, '无法识别的值退回默认（开）');
  });
});

test('the marker definition claims every name of this plugin and nothing else', () => {
  const definition = internals.markerDefinition();
  assert.equal(definition.kind, internals.MARKER_KIND);
  assert.equal(definition.target, 'chat');
  assert.equal(definition.kind === 'command', false, 'kind 必须不是 command，否则 chat 视图仍然不算活动');

  const run = (name, commandId) => ({ type: 'command/run', seq: 7, data: { name, commandId, args: 'q' } });
  for (const name of [SINGLE_TURN, MULTI_TURN]) {
    assert.deepEqual(definition.match(run(name, 'a')), { id: 'a', role: 'start' }, `${name} 必须认领`);
  }
  assert.equal(definition.match(run('st', 'b')), null, '下线的短别名不认领');
  assert.equal(definition.match(run('mt', 'b2')), null, '下线的短别名不认领');
  assert.equal(definition.match(run('compact', 'c')), null, '别的命令不认领');
  assert.equal(definition.match(run('temp-chat', 'd')), null, '改名前的旧名不认领');
  assert.equal(definition.match(run('single-turn-feed', 'e')), null, '名字前缀相同也不算');
  assert.equal(definition.match({ type: 'command/done', seq: 8, data: { commandId: 'a' } }), null, 'done 不单独建节点');
  assert.equal(definition.match({ type: 'user/message', seq: 9, data: {} }), null);

  assert.deepEqual(definition.start(), {}, 'start 必须返回 state（DSH 会校验 undefined）');
  const context = {
    key: 'k1',
    id: 'a',
    start: { event: { seq: 7, data: { name: SINGLE_TURN } }, location: { kind: 'session' } },
    matches: [],
    state: {},
  };
  const node = definition.buildViewNode(context);
  assert.deepEqual(node, {
    key: 'k1',
    kind: internals.MARKER_KIND,
    id: 'a',
    target: 'chat',
    anchorSeq: 7,
    location: { kind: 'session' },
    visibility: 'visible',
    data: { commandId: 'a', name: SINGLE_TURN },
  }, '节点形状要与 DSH 内部的 chatNode() 一致');
  assert.equal(definition.update(context), context.state, 'update 原样保留 state');
});

test('apply registers the marker by default and skips it when switched off', () => {
  const previous = internals.markerState.active;
  try {
    const on = mountPlugin();
    on.mount();
    assert.equal(on.markerDefinitions.length, 1, '默认开：注册一次');
    assert.equal(internals.markerState.active, true);
    assert.equal(on.registered.has(internals.MARKER_KIND), true, '标记节点的渲染器也注册了（渲染 null）');
    assert.equal(on.registered.get(internals.MARKER_KIND)({}), null);

    withStorage({ [internals.MARKER_STORAGE_KEY]: 'off' }, () => {
      const off = mountPlugin();
      off.mount();
      assert.equal(off.markerDefinitions.length, 0, '开关关闭时不注册');
      assert.equal(internals.markerState.active, false, '关闭后回到"面板顶上"的路径');
    });
  } finally {
    internals.markerState.active = previous;
  }
});

test('a broken uiConversation degrades to the dock instead of throwing', () => {
  const previous = internals.markerState.active;
  try {
    const broken = mountPlugin({ uiConversation: { events: { register: () => { throw new Error('contract changed'); } } } });
    assert.doesNotThrow(() => broken.mount());
    assert.equal(internals.markerState.active, false, '注册失败要保持未激活，好让面板顶上');

    const missing = mountPlugin({ uiConversation: {} });
    assert.doesNotThrow(() => missing.mount());
    assert.equal(internals.markerState.active, false, '服务不可用同样退回面板');
  } finally {
    internals.markerState.active = previous;
  }
});
