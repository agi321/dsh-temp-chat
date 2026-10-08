import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HISTORY_COMMANDS,
  MAX_QUESTION_CHARS,
  MULTI_TURN,
  SINGLE_TURN,
  buildPrompt,
  collectTurns,
  currentThread,
  normalizeQuestion,
  renderTurn,
  trimThread,
  turnMode,
} from '../lib/thread.js';

/** 造一条 command/run 事件。 */
const runEvent = (commandId, cmdName, args) => ({
  type: 'command/run',
  data: { commandId, name: cmdName, args },
});

/** 造一条 command/done 事件。 */
const doneEvent = (commandId, kind, text) => ({
  type: 'command/done',
  data: { commandId, kind, text },
});

test('collectTurns pairs run and done, skipping failures and foreign commands', () => {
  const events = [
    runEvent('c1', SINGLE_TURN, '问题一'),
    doneEvent('c1', 'success', '答案一'),
    runEvent('c2', 'btw', '别管我'),
    doneEvent('c2', 'success', '不该出现'),
    runEvent('c3', MULTI_TURN, '问题三'),
    doneEvent('c3', 'error', '炸了'),
    runEvent('c4', MULTI_TURN, '问题四'),
    doneEvent('c4', 'success', '   '),
    doneEvent('c9', 'success', '孤立事件'),
  ];

  assert.deepEqual(collectTurns(events), [
    { mode: SINGLE_TURN, question: '问题一', answer: '答案一' },
  ]);
});

test('collectTurns tolerates junk input and keeps event order', () => {
  assert.deepEqual(collectTurns(undefined), []);
  assert.deepEqual(collectTurns([null, {}, { type: 'command/done' }]), []);
  const turns = collectTurns([
    runEvent('a', SINGLE_TURN, 'q1'),
    doneEvent('a', 'success', 'a1'),
    runEvent('b', MULTI_TURN, 'q2'),
    doneEvent('b', 'success', 'a2'),
  ]);
  assert.deepEqual(turns.map((turn) => turn.question), ['q1', 'q2']);
});

test('turnMode maps the two command names onto their modes', () => {
  assert.deepEqual(
    [...HISTORY_COMMANDS].sort(),
    [MULTI_TURN, SINGLE_TURN].sort(),
    '只有 /single-turn 与 /multi-turn 参与话题折叠',
  );

  assert.equal(turnMode(SINGLE_TURN), SINGLE_TURN, '/single-turn 属于单轮');
  assert.equal(turnMode(MULTI_TURN), MULTI_TURN, '/multi-turn 属于多轮');
  assert.equal(turnMode('compact'), null, '别的命令不属于本插件');
  assert.equal(turnMode('temp-chat'), null, '改名前的旧名不再被认');
  assert.equal(turnMode(undefined), null);
});

test('the removed short aliases are no longer recognized', () => {
  for (const name of ['st', 'mt']) {
    assert.equal(turnMode(name), null, `/${name} 已下线，不应再被认领`);
  }

  const turns = collectTurns([
    runEvent('a', 'st', 'q1'),
    doneEvent('a', 'success', 'a1'),
    runEvent('b', 'mt', 'q2'),
    doneEvent('b', 'success', 'a2'),
    runEvent('c', SINGLE_TURN, 'q3'),
    doneEvent('c', 'success', 'a3'),
  ]);
  assert.deepEqual(turns.map((turn) => turn.question), ['q3'], '旧别名的历史轮次被忽略');

  const thread = [
    { mode: MULTI_TURN, question: 'old', answer: 'a' },
    { mode: SINGLE_TURN, question: 'new', answer: 'b' },
    { mode: MULTI_TURN, question: 'new2', answer: 'c' },
  ];
  assert.deepEqual(currentThread(thread).map((turn) => turn.question), ['new', 'new2']);
});

test('currentThread slices from the most recent /single-turn', () => {
  const turns = [
    { mode: SINGLE_TURN, question: 'old', answer: 'a' },
    { mode: MULTI_TURN, question: 'old2', answer: 'b' },
    { mode: SINGLE_TURN, question: 'new', answer: 'c' },
    { mode: MULTI_TURN, question: 'new2', answer: 'd' },
  ];
  assert.deepEqual(currentThread(turns).map((turn) => turn.question), ['new', 'new2']);
  assert.deepEqual(currentThread([]).length, 0);
});

test('currentThread falls back to every turn when no /single-turn exists', () => {
  const turns = [{ mode: MULTI_TURN, question: 'q', answer: 'a' }];
  assert.deepEqual(currentThread(turns), turns);
});

test('trimThread keeps the newest turns inside both budgets', () => {
  const turns = [1, 2, 3, 4].map((n) => ({ mode: MULTI_TURN, question: `q${n}`, answer: `a${n}` }));
  assert.deepEqual(trimThread(turns, { maxTurns: 2 }).map((turn) => turn.question), ['q3', 'q4']);
  // 每个 turn 的 size 都是 4 个字符：q1+a1。
  assert.deepEqual(trimThread(turns, { maxHistoryChars: 9 }).map((turn) => turn.question), ['q3', 'q4']);
  // 预算再小也保留最新一轮，否则续聊失去意义。
  assert.deepEqual(trimThread(turns, { maxHistoryChars: 1 }).map((turn) => turn.question), ['q4']);
  assert.deepEqual(trimThread([], { maxTurns: 3 }), []);
});

test('buildPrompt isolates a one-shot question and replays a thread for follow-ups', () => {
  const oneShot = buildPrompt({ mode: SINGLE_TURN, question: '今天有什么新闻？' });
  assert.match(oneShot, /## 本次提问（只回答这一个）/);
  assert.match(oneShot, /今天有什么新闻？/);
  assert.doesNotMatch(oneShot, /此前的临时话题/);

  const history = [{ mode: SINGLE_TURN, question: 'q1', answer: 'a1' }];
  const followUp = buildPrompt({ mode: MULTI_TURN, question: '再展开说说', history });
  assert.match(followUp, /## 此前的临时话题/);
  assert.match(followUp, /### 第 1 轮/);
  assert.match(followUp, /用户：q1/);
  assert.match(followUp, /你的回答：a1/);
  assert.match(followUp, /## 本轮新提问（只回答这一个）/);
  assert.ok(followUp.indexOf('a1') < followUp.indexOf('再展开说说'), '历史必须排在新问题之前');

  // 没有历史时退化成单轮形态，不应出现空的"历史"小节。
  const empty = buildPrompt({ mode: MULTI_TURN, question: 'q', history: [] });
  assert.doesNotMatch(empty, /此前的临时话题/);
  assert.match(empty, /## 本次提问（只回答这一个）/);
});

test('buildPrompt decides by mode alone, whatever command name produced it', () => {
  const history = [{ mode: SINGLE_TURN, question: 'q1', answer: 'a1' }];

  const followUp = buildPrompt({ mode: MULTI_TURN, question: '接着问', history });
  assert.match(followUp, /此前的临时话题/, '多轮模式带历史');
  assert.match(followUp, /## 本轮新提问（只回答这一个）/);

  assert.doesNotMatch(buildPrompt({ mode: SINGLE_TURN, question: '直接问', history }), /此前的临时话题/, '单轮模式不带历史');
});

test('buildPrompt leaves the answer format to the model but still demands sources', () => {
  const prompt = buildPrompt({ mode: SINGLE_TURN, question: '介绍一下宋词' });

  assert.doesNotMatch(prompt, /先给结论|再给要点/, '不再指定「结论 + 要点」的固定结构');
  assert.match(prompt, /由你判断/, '格式交给子代理自己决定');
  assert.match(prompt, /来源/, '来源仍然必须保留');
  assert.match(prompt, /\[标题\]\(https:\/\/…\)/, '来源链接的写法仍然是 Markdown 链接');
});

test('renderTurn numbers the turn and keeps both sides verbatim', () => {
  assert.equal(renderTurn({ question: 'q', answer: 'a' }, 3), '### 第 3 轮\n用户：q\n你的回答：a');
});

test('normalizeQuestion trims, rejects empty input, and caps the length', () => {
  assert.deepEqual(normalizeQuestion('  你好  '), { ok: true, question: '你好' });
  assert.deepEqual(normalizeQuestion('   '), { ok: false, reason: 'empty' });
  assert.deepEqual(normalizeQuestion(undefined), { ok: false, reason: 'empty' });
  assert.deepEqual(normalizeQuestion('x'.repeat(MAX_QUESTION_CHARS)), { ok: true, question: 'x'.repeat(MAX_QUESTION_CHARS) });
  assert.deepEqual(normalizeQuestion('x'.repeat(MAX_QUESTION_CHARS + 1)), { ok: false, reason: 'too-long' });
});
