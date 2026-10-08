/**
 * dsh-temp-chat 客户端半边。
 *
 * 聊天目标给每条命令留了一个按命令名分发的渲染位：
 * `conversation.chat.commandview`（keyed by command name，replaceRisk: none）。
 * 这里把本插件的两个命令名（`single-turn` / `multi-turn`）都占下来，
 * 把一次临时问答渲染成**正文里的一轮对话**：右边是你问的话（带你敲的那个命令名），
 * 下面是子代理的 Markdown 答案。除了模型的回答不再显示别的东西——没有检索过程、
 * 没有工具调用、没有耗时与复制按钮，也不再有输入框上方的气泡（结果已经落在正文里）。
 * 其余命令继续用内置通用卡片。
 *
 * 只依赖浏览器模块表里的 `react`，不 import 任何 Harness 客户端包：
 * 样式一律走主题 token（`--dsw-alias-*` 与宿主同款的 `--dsh-content-*`），
 * Markdown 由本文件内的小渲染器实现。
 *
 * 两条硬约束：
 * 1. 内容只来自 `command/done`（log-only 事件），所以答案不会进入主模型上下文；
 * 2. 渲染绝不抛异常——插槽在组件抛错时会让这一格"退位"并静默回退成内置折叠行，
 *    所以这里整体 try/catch，最差也退化成纯文本，保证永远看得见内容。
 *
 * @module @agi321/dsh-temp-chat/client
 */

window.__ModuleLoader__.load({
  id: '@agi321/dsh-temp-chat',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    const NS = 'local.temp-chat';
    const SLOT = 'conversation.chat.commandview';

    // 命令名的事实来源是 `lib/thread.js`（客户端不 import 宿主模块，只能抄一份常量），
    // 两边的命令名必须一致。
    const SINGLE_TURN = 'single-turn';
    const MULTI_TURN = 'multi-turn';
    const SINGLE_TURN_COMMANDS = [SINGLE_TURN];
    const MULTI_TURN_COMMANDS = [MULTI_TURN];
    const COMMAND_NAMES = [...SINGLE_TURN_COMMANDS, ...MULTI_TURN_COMMANDS];

    /** 命令名 → 规范模式，与 `lib/thread.js` 的 `turnMode()` 同义。 */
    function turnMode(name) {
      if (SINGLE_TURN_COMMANDS.includes(name)) return SINGLE_TURN;
      if (MULTI_TURN_COMMANDS.includes(name)) return MULTI_TURN;
      return null;
    }

    /**
     * 提问气泡上的命令标记：显示用户敲的那个名字（`/single-turn`、`/multi-turn`）。
     *
     * 命令名不翻译，所以这里不走 locale；名字缺失时（老日志或形状变化）退回模式对应的
     * 命令名，至少让人看出这轮是单轮还是多轮。
     *
     * @param {unknown} name - 命令名（不带斜杠）。
     * @param {unknown} mode - 规范模式。
     * @returns {string} 形如 `/single-turn` 的标记。
     */
    function chipText(name, mode) {
      const label = typeof name === 'string' && name.length > 0
        ? name
        : (mode === MULTI_TURN ? MULTI_TURN : SINGLE_TURN);
      return `/${label}`;
    }

    const zh = {
      'status.running': '正在联网检索…',
      'error.empty': '没有返回内容。',
      'error.unavailable': '结果不可用（渲染失败），以下是原始内容。',
      'dock.title': '临时问答',
      'dock.rounds': '{count} 轮',
      'dock.hide': '收起',
      'dock.show': '展开',
      'dock.expand': '展开答案',
      'dock.collapse': '收起答案',
      'dock.noQuestion': '（无提问文本）',
      'dock.reload': '刷新',
      'dock.error': '读取失败',
      'dock.noRemote': '宿主 remote 不可用（客户端没有注入 remote.session）',
    };
    const en = {
      'status.running': 'Searching the web…',
      'error.empty': 'No content returned.',
      'error.unavailable': 'Result unavailable (render failed); raw content below.',
      'dock.title': 'Temp chat',
      'dock.rounds': '{count} turns',
      'dock.hide': 'Hide',
      'dock.show': 'Show',
      'dock.expand': 'Show answer',
      'dock.collapse': 'Hide answer',
      'dock.noQuestion': '(no question text)',
      'dock.reload': 'Refresh',
      'dock.error': 'Load failed',
      'dock.noRemote': 'Host remote unavailable (remote.session not injected)',
    };

    const TOKEN = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      faint: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      border: 'var(--dsw-alias-border-l1)',
      nested: 'var(--dsw-alias-bg-layer-2)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      // 宿主用户气泡同款（带 alias 兜底，token 改名也不会变成透明底）。
      bubble: 'var(--dsw-specific-bubble, var(--dsw-alias-bg-layer-2))',
      bubbleRadius: 'var(--dsw-radius-xl, 12px)',
      smallRadius: 'var(--dsw-radius-md, 8px)',
    };

    // 与宿主正文一致的排版节奏（宿主用户气泡就用这两个变量）。
    const CONTENT_FONT = 'var(--dsh-content-font-size, 14px)';
    const CONTENT_LEADING = 'calc(22px + var(--dsh-content-font-delta, 0px))';
    const SECONDARY_FONT = 'var(--dsh-content-font-size-secondary, 13px)';
    const SECONDARY_LEADING = 'calc(18px + var(--dsh-content-font-delta-secondary, 0px))';

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    /* ---------------------------------------------------------------- *
     * 极小 Markdown 渲染（标题 / 段落 / 列表 / 引用 / 代码 / 表格 / 行内）
     * ---------------------------------------------------------------- */

    const RE_FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
    const RE_HEADING = /^(#{1,6})\s+(.*)$/;
    const RE_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
    const RE_QUOTE = /^\s*>\s?/;
    const RE_BULLET = /^\s*([-*+])\s+/;
    const RE_ORDERED = /^\s*\d+[.)]\s+/;
    const RE_TABLE_ROW = /^\s*\|(.+)\|\s*$/;
    const RE_TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

    // 行内标记的源码串：每次渲染都新建一个带 g 的实例。绝不能共用带 g 的正则，
    // 因为 inline() 会递归调用自己，共用的 lastIndex 会让外层循环错位甚至死循环。
    const INLINE_SOURCE = [
      '(`[^`\\n]+`)', // 1 inline code
      '(\\*\\*[^\\n]+?\\*\\*)', // 2 bold
      '(__[^\\n]+?__)', // 3 bold alt
      '(\\*[^*\\n]+?\\*)', // 4 italic
      '(_[^\\n]+?_)', // 5 italic alt
      '(~~[^\\n]+?~~)', // 6 strike
      '(!?\\[[^\\]\\n]*\\]\\(\\s*(?:https?:\\/\\/|mailto:)[^)\\s]+\\s*\\))', // 7 link
      '(https?:\\/\\/[^\\s<>()\\[\\]]+)', // 8 bare url
    ].join('|');

    const TRAILING_PUNCT = /[.,;:!?、。，；：！？)）】》]+$/;

    /**
     * 把一段 Markdown 文本渲染成 React 节点数组。
     *
     * @param {string} source - 模型返回的 Markdown 文本。
     * @returns {any[]} React 节点。
     */
    function renderMarkdown(source) {
      const blocks = parseBlocks(String(source ?? ''));
      return blocks.map((block, index) => renderBlock(block, index));
    }

    /** 按行切块。 */
    function parseBlocks(text) {
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const blocks = [];
      let index = 0;
      while (index < lines.length) {
        const line = lines[index];
        const fence = RE_FENCE.exec(line);
        if (fence !== null) {
          const body = [];
          index += 1;
          while (index < lines.length && !RE_FENCE.test(lines[index])) {
            body.push(lines[index]);
            index += 1;
          }
          index += 1;
          blocks.push({ type: 'code', lang: fence[1], text: body.join('\n') });
          continue;
        }
        if (/^\s*$/.test(line)) {
          index += 1;
          continue;
        }
        const heading = RE_HEADING.exec(line);
        if (heading !== null) {
          blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
          index += 1;
          continue;
        }
        if (RE_RULE.test(line)) {
          blocks.push({ type: 'rule' });
          index += 1;
          continue;
        }
        if (RE_QUOTE.test(line)) {
          const body = [];
          while (index < lines.length && RE_QUOTE.test(lines[index])) {
            body.push(lines[index].replace(RE_QUOTE, ''));
            index += 1;
          }
          blocks.push({ type: 'quote', text: body.join('\n') });
          continue;
        }
        if (RE_TABLE_ROW.test(line) && index + 1 < lines.length && RE_TABLE_SEP.test(lines[index + 1]) && lines[index + 1].includes('-')) {
          const rows = [];
          const header = splitRow(line);
          index += 2;
          while (index < lines.length && RE_TABLE_ROW.test(lines[index])) {
            rows.push(splitRow(lines[index]));
            index += 1;
          }
          blocks.push({ type: 'table', header, rows });
          continue;
        }
        if (RE_BULLET.test(line) || RE_ORDERED.test(line)) {
          const ordered = RE_ORDERED.test(line);
          const items = [];
          while (index < lines.length && (RE_BULLET.test(lines[index]) || RE_ORDERED.test(lines[index]))) {
            const itemOrdered = RE_ORDERED.test(lines[index]);
            items.push({
              ordered: itemOrdered,
              text: lines[index].replace(itemOrdered ? RE_ORDERED : RE_BULLET, ''),
            });
            index += 1;
          }
          blocks.push({ type: 'list', ordered, items });
          continue;
        }
        const paragraph = [];
        while (index < lines.length && !/^\s*$/.test(lines[index]) && !isBlockStart(lines[index])) {
          paragraph.push(lines[index]);
          index += 1;
        }
        if (paragraph.length === 0) {
          paragraph.push(lines[index] ?? '');
          index += 1;
        }
        blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
      }
      return blocks;
    }

    /** 这一行是否开启一个新块（用于段落边界）。 */
    function isBlockStart(line) {
      return RE_FENCE.test(line) || RE_HEADING.test(line) || RE_RULE.test(line) || RE_QUOTE.test(line)
        || RE_BULLET.test(line) || RE_ORDERED.test(line) || RE_TABLE_ROW.test(line);
    }

    /** 拆一行表格单元格。 */
    function splitRow(line) {
      const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
      return trimmed.split('|').map((cell) => cell.trim());
    }

    /** 渲染一个块。 */
    function renderBlock(block, key) {
      switch (block.type) {
        case 'code':
          return h('pre', { key, style: codeBlockStyle }, h('code', null, block.text));
        case 'heading':
          return h('div', { key, style: headingStyle(block.level) }, inline(block.text, `h${key}`));
        case 'rule':
          return h('div', { key, style: { height: 1, background: TOKEN.border, margin: '10px 0' } });
        case 'quote':
          return h('div', { key, style: quoteStyle }, inline(block.text, `q${key}`));
        case 'list': {
          const items = block.items.map((item, itemIndex) => h('li', {
            key: itemIndex,
            style: { marginBottom: 2 },
          }, inline(item.text, `li${key}-${itemIndex}`)));
          return block.ordered
            ? h('ol', { key, style: listStyle }, items)
            : h('ul', { key, style: listStyle }, items);
        }
        case 'table':
          return h('table', { key, style: tableStyle }, [
            h('thead', { key: 'head' }, h('tr', null, block.header.map((cell, cellIndex) => h('th', {
              key: cellIndex,
              style: tableCellStyle(true),
            }, inline(cell, `th${key}-${cellIndex}`))))),
            h('tbody', { key: 'body' }, block.rows.map((row, rowIndex) => h('tr', { key: rowIndex }, row.map((cell, cellIndex) => h('td', {
              key: cellIndex,
              style: tableCellStyle(false),
            }, inline(cell, `td${key}-${rowIndex}-${cellIndex}`)))))),
          ]);
        default:
          return h('p', { key, style: { margin: '0 0 8px' } }, inline(block.text, `p${key}`));
      }
    }

    /**
     * 渲染行内标记。
     *
     * @param {string} text - 一行文本。
     * @param {string} keyPrefix - React key 前缀。
     * @returns {any[]} React 节点。
     */
    function inline(text, keyPrefix) {
      const nodes = [];
      const pattern = new RegExp(INLINE_SOURCE, 'g');
      let cursor = 0;
      let seq = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const token = match[0];
        if (token.length === 0) break;
        if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
        const key = `${keyPrefix}-i${seq}`;
        seq += 1;
        if (match[1] !== undefined) {
          nodes.push(h('code', { key, style: inlineCodeStyle }, token.slice(1, -1)));
        } else if (match[2] !== undefined || match[3] !== undefined) {
          nodes.push(h('strong', { key }, inline(token.slice(2, -2), `${key}s`)));
        } else if (match[4] !== undefined || match[5] !== undefined) {
          nodes.push(h('em', { key }, inline(token.slice(1, -1), `${key}e`)));
        } else if (match[6] !== undefined) {
          nodes.push(h('span', { key, style: { textDecoration: 'line-through', opacity: 0.75 } }, token.slice(2, -2)));
        } else if (match[7] !== undefined) {
          const link = parseLink(token);
          nodes.push(h('a', {
            key,
            href: link.href,
            target: '_blank',
            rel: 'noopener noreferrer',
            style: linkStyle,
          }, inline(link.label, `${key}a`)));
        } else {
          const trailing = TRAILING_PUNCT.exec(token);
          const href = trailing === null ? token : token.slice(0, -trailing[0].length);
          nodes.push(h('a', {
            key,
            href,
            target: '_blank',
            rel: 'noopener noreferrer',
            style: linkStyle,
          }, href));
          if (trailing !== null) nodes.push(trailing[0]);
        }
        cursor = match.index + token.length;
      }
      if (cursor < text.length) nodes.push(text.slice(cursor));
      return nodes;
    }

    /** 从 `[label](href)` 取出文字与地址。 */
    function parseLink(token) {
      const split = token.lastIndexOf('](');
      const label = token.slice(token.startsWith('!') ? 2 : 1, split);
      const href = token.slice(split + 2, -1).trim();
      return { label: label.length > 0 ? label : href, href };
    }

    const codeBlockStyle = {
      margin: '0 0 8px',
      padding: '10px 12px',
      background: TOKEN.nested,
      border: `1px solid ${TOKEN.border}`,
      borderRadius: TOKEN.smallRadius,
      overflowX: 'auto',
      fontFamily: MONO,
      fontSize: 12.5,
      lineHeight: 1.55,
      color: TOKEN.text,
      whiteSpace: 'pre',
    };
    const inlineCodeStyle = {
      padding: '1px 4px',
      borderRadius: 4,
      background: TOKEN.nested,
      border: `1px solid ${TOKEN.border}`,
      fontFamily: MONO,
      fontSize: '0.92em',
    };
    const linkStyle = { color: TOKEN.brand, textDecoration: 'underline', wordBreak: 'break-all' };
    const quoteStyle = {
      margin: '0 0 8px',
      padding: '2px 0 2px 10px',
      borderLeft: `3px solid ${TOKEN.border}`,
      color: TOKEN.muted,
    };
    const listStyle = { margin: '0 0 8px', paddingLeft: 22 };
    const tableStyle = { borderCollapse: 'collapse', margin: '0 0 8px', fontSize: 12.5, width: '100%' };

    function tableCellStyle(header) {
      return {
        border: `1px solid ${TOKEN.border}`,
        padding: '4px 8px',
        textAlign: 'left',
        verticalAlign: 'top',
        fontWeight: header ? 600 : 400,
        background: header ? TOKEN.nested : 'transparent',
      };
    }

    function headingStyle(level) {
      const size = level <= 1 ? 15 : level === 2 ? 14 : 13;
      return { margin: '2px 0 6px', fontSize: size, fontWeight: 600, color: TOKEN.text };
    }

    /* ---------------------------------------------------------------- *
     * 一轮问答的渲染
     * ---------------------------------------------------------------- */

    /**
     * 渲染一次临时问答：提问按用户气泡，下面是模型的回答正文。
     *
     * 只显示这两样：命令标记与提问让时间线可读，回答本身就是命令结果里的文本——
     * 检索过程 / 工具调用 / 来源列表都不在结果文本里（宿主侧不再拼接），这里也不再补画。
     *
     * @param {any} props - 槽位属性：`node`（折叠后的命令状态）与 `t`（本插件命名空间）。
     * @returns {any} React 节点。
     */
    function TempChatCommandRow(props) {
      const t = typeof props?.t === 'function' ? props.t : fallbackTranslate;
      // 整段都包在 try 里：插槽在组件抛错时会让这一格"退位"并静默回退成内置折叠行，
      // 绝不能让那一格空掉或变成要点开才知道内容。
      try {
        return renderTurn(props?.node, t);
      } catch (error) {
        logFailure(error);
        try {
          return plainFallback(props?.node, error, t);
        } catch {
          return h('div', { style: { color: TOKEN.muted, fontSize: SECONDARY_FONT } }, t('error.unavailable'));
        }
      }
    }

    /**
     * 组装一轮对话。所有对 node 的读取都发生在这里，读到抛异常的 getter 也会被上层兜住。
     *
     * @param {any} rawNode - 槽位 owner 传来的命令状态。
     * @param {(key: string, params?: Record<string, unknown>) => string} t - 翻译函数。
     * @returns {any} React 节点。
     */
    function renderTurn(rawNode, t) {
      const command = normalizeCommand(rawNode);
      const outcome = command.outcome ?? null;
      const running = outcome === null;
      const failed = outcome !== null && outcome.kind === 'error';
      const text = typeof outcome?.text === 'string' ? outcome.text : '';

      const answer = running
        ? h('div', { style: runningStyle }, t('status.running'))
        : failed
          ? h('pre', { style: errorTextStyle }, text.length > 0 ? text : t('error.empty'))
          : (text.length > 0
            ? renderMarkdown(text)
            : h('div', { style: { color: TOKEN.muted } }, t('error.empty')));

      return h('div', { style: turnStyle }, [
        h('div', { key: 'question', style: questionRowStyle }, h('div', { style: bubbleStyle }, [
          h('div', { key: 'chip', style: chipStyle }, chipText(command.name, command.mode)),
          command.question.length > 0
            ? h('div', { key: 'text', style: questionTextStyle }, command.question)
            : null,
        ])),
        h('div', { key: 'answer', style: answerStyle }, answer),
      ]);
    }

    /**
     * 最差情况的兜底：把能读到的原始文本直接摊开，绝不静默空白。
     *
     * @param {any} rawNode - 槽位 owner 传来的命令状态。
     * @param {unknown} error - 触发兜底的异常。
     * @param {(key: string, params?: Record<string, unknown>) => string} t - 翻译函数。
     * @returns {any} React 节点。
     */
    function plainFallback(rawNode, error, t) {
      // 逐个字段独立读取：某一个字段的 getter 抛错，不能连累其它还能读到的内容。
      const read = (fn) => {
        try {
          return fn();
        } catch {
          return undefined;
        }
      };
      const flat = read(() => (rawNode !== null && typeof rawNode === 'object' ? rawNode : {})) ?? {};
      const inner = read(() => (flat.data !== null && typeof flat.data === 'object' ? flat.data : null)) ?? null;
      const source = read(() => ('outcome' in flat || 'args' in flat || 'name' in flat)) === true ? flat : (inner ?? flat);
      const name = read(() => (typeof source.name === 'string' ? source.name : null)) ?? null;
      const args = read(() => (typeof source.args === 'string' ? source.args : '')) ?? '';
      const answer = read(() => {
        const outcome = source.outcome ?? null;
        return outcome !== null && typeof outcome.text === 'string' ? outcome.text : '';
      }) ?? '';

      const pieces = [];
      if (args.trim().length > 0) pieces.push(`${chipText(name, turnMode(name))} ${args.trim()}`);
      if (answer.length > 0) {
        pieces.push(answer);
      } else {
        pieces.push(t('error.unavailable'));
        const dump = read(() => JSON.stringify(source, null, 2));
        if (typeof dump === 'string' && dump.length > 0) pieces.push(dump.slice(0, 4000));
        else pieces.push(String(error));
      }
      return h('div', { style: { margin: '6px 0 10px' } }, h('pre', { style: plainFallbackStyle }, pieces.join('\n\n')));
    }

    /**
     * 把槽位传来的节点规范化成命令状态。
     *
     * 运行时的 owner 就是命令状态本身（`{name, args, outcome, …}`），但定义表的类型
     * 把它写成 `CommandNode`（即 `{…, data}`）。两种形状都认，避免上游改形状时又变成
     * "永远在转圈"的静默故障。
     *
     * @param {any} node - 原始节点。
     * @returns {{ commandId: string | null, name: string | null, mode: string | null, question: string, outcome: any }} 规范化结果。
     */
    function normalizeCommand(node) {
      const flat = node !== null && typeof node === 'object' ? node : {};
      const inner = flat.data !== null && typeof flat.data === 'object' ? flat.data : null;
      const hasFlatShape = 'outcome' in flat || 'args' in flat || 'name' in flat;
      const source = !hasFlatShape && inner !== null ? inner : flat;
      const name = typeof source.name === 'string' ? source.name : null;
      const args = typeof source.args === 'string' ? source.args : '';
      const outcome = source.outcome ?? null;
      return {
        commandId: typeof source.commandId === 'string' ? source.commandId : null,
        name,
        mode: turnMode(name),
        question: args.trim(),
        outcome,
      };
    }

    /* ---------------------------------------------------------------- *
     * 样式（只用主题 token）
     * ---------------------------------------------------------------- */

    const turnStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      margin: '6px 0 10px',
      minWidth: 0,
    };
    const questionRowStyle = {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 6,
      minWidth: 0,
    };
    const bubbleStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      minWidth: 0,
      maxWidth: 'min(82%, 620px)',
      padding: '8px 14px',
      background: TOKEN.bubble,
      borderRadius: TOKEN.bubbleRadius,
      color: TOKEN.text,
      fontSize: CONTENT_FONT,
      lineHeight: CONTENT_LEADING,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    };
    const chipStyle = {
      fontFamily: MONO,
      fontSize: 11.5,
      lineHeight: '16px',
      color: TOKEN.brand,
      opacity: 0.9,
    };
    const questionTextStyle = { minWidth: 0 };
    const answerStyle = {
      minWidth: 0,
      color: TOKEN.text,
      fontSize: CONTENT_FONT,
      lineHeight: CONTENT_LEADING,
      wordBreak: 'break-word',
    };
    const runningStyle = { color: TOKEN.muted, fontSize: SECONDARY_FONT, lineHeight: SECONDARY_LEADING };
    const errorTextStyle = {
      margin: 0,
      color: TOKEN.error,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      fontFamily: MONO,
      fontSize: 12.5,
      lineHeight: 1.6,
    };
    const plainFallbackStyle = {
      margin: 0,
      padding: '10px 12px',
      background: TOKEN.nested,
      border: `1px solid ${TOKEN.border}`,
      borderRadius: TOKEN.smallRadius,
      color: TOKEN.text,
      fontFamily: MONO,
      fontSize: 12.5,
      lineHeight: 1.6,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      overflowX: 'auto',
    };

    /* ---------------------------------------------------------------- *
     * 正文补位面板（dock）用的样式
     * ---------------------------------------------------------------- */

    const dockStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      padding: '8px 10px',
      border: `1px solid ${TOKEN.border}`,
      borderRadius: TOKEN.smallRadius,
      background: TOKEN.surface,
      minWidth: 0,
    };
    const dockHeadStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      minWidth: 0,
    };
    const dockTitleStyle = {
      fontSize: 12,
      fontWeight: 600,
      color: TOKEN.muted,
    };
    const dockBodyStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      maxHeight: 'min(380px, 45vh)',
      overflowY: 'auto',
      minWidth: 0,
    };
    const dockTurnStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      minWidth: 0,
    };
    const dockTurnHeadStyle = {
      display: 'flex',
      alignItems: 'baseline',
      gap: 6,
      minWidth: 0,
    };
    const dockQuestionStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      color: TOKEN.text,
      fontSize: SECONDARY_FONT,
      lineHeight: SECONDARY_LEADING,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    };
    const dockStatusStyle = {
      fontSize: 11.5,
      color: TOKEN.faint,
    };
    const dockErrorStyle = {
      fontSize: 11.5,
      color: TOKEN.error,
      wordBreak: 'break-word',
    };
    const dockButtonStyle = {
      padding: '1px 8px',
      fontSize: 11.5,
      lineHeight: '18px',
      color: TOKEN.muted,
      background: 'transparent',
      border: `1px solid ${TOKEN.border}`,
      borderRadius: 6,
      cursor: 'pointer',
      flex: '0 0 auto',
    };
    const dockToggleStyle = { ...dockButtonStyle, marginLeft: 'auto' };

    /** 渲染失败时留一条可诊断的痕迹，但不影响用户看到内容。 */
    function logFailure(error) {
      try {
        console.error('[dsh-temp-chat] command row render failed:', error);
      } catch {
        /* console 不可用时忽略 */
      }
    }

    /** 没有 locale 服务时的兜底翻译。 */
    function fallbackTranslate(key, params) {
      const template = zh[key] ?? key;
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    /* ---------------------------------------------------------------- *
     * 正文标记节点：把"只跑过临时问答"的会话的正文区拉起来
     * ---------------------------------------------------------------- *
     *
     * DSH 的正文时间线只在"这个会话的 chat 视图活动"时才渲染，而 chat 视图的
     * `isActive` 要求快照里至少有一个 **非 command** 节点（`dsh-client-ui-chat` 的
     * `chatViewDefinition`）。`/single-turn` 只产生 `command/run` + `command/done`，
     * 于是新建会话里正文区整个不渲染——这一行（连 DSH 自带的折叠卡片）都看不见，
     * 直到用户发了一条普通消息把会话从 blank 相位带出来，才会把历史一起补画出来。
     *
     * 这里注册一个自己的会话节点定义：它只为本插件两个命令名的
     * `command/run` 生成一个 `temp-chat-marker` 节点（kind ≠ command），从而让 chat 视图
     * "活动"，正文区就会渲染，内置的命令节点照常由 `conversation.chat.commandview`
     * 画成"提问 + 回答"。这个节点本身什么都不画（下面注册了 `() => null` 的渲染器；
     * 不注册的话会掉进 DSH 的 JsonBlock("unknown surface") 兜底）。
     *
     * 这是 DSH 的内部扩展点（chat 包自己用的同一套 API），所以：
     *   - 整体 try/catch：注册失败就静默退回"补位面板"；
     *   - 可以用开关关掉（见 `markerEnabled()`），关掉后同样退回补位面板。
     */

    /** 我们自己那个节点在 chat 里的 kind（不能与 DSH 自带的 kind 重名）。 */
    const MARKER_KIND = 'temp-chat-marker';
    /** 节点渲染位：DSH 按节点 kind 在这里分发渲染器。 */
    const MARKER_SLOT = 'conversation.chat.node';
    /** 开关默认值：开。 */
    const MARKER_DEFAULT = true;
    /** localStorage 覆盖键；写 'off'/'0'/'false' 关闭，写 'on'/'1'/'true' 打开。 */
    const MARKER_STORAGE_KEY = 'dsh-temp-chat:transcript-marker';

    /**
     * 标记节点的开关。
     *
     * 为什么不用 patch 里的 `config:`：DSH 只把配置交给 **宿主**半边，客户端插件的
     * boot manifest 里不带 config（`dsh-client-modules` 的 `create({ name: id })`），
     * 官方插件的 host→client 配置走 `settings` + schemastery，而 `link:` 进来的插件
     * 目录解析不到 `@deepseek-ai/schemastery`。所以这里用插件自己的开关：
     * 默认开，需要时在浏览器控制台执行
     *   `localStorage.setItem('dsh-temp-chat:transcript-marker', 'off')` 后刷新页面即可关闭
     * （写 'on' 或删掉该项即恢复）。
     *
     * @returns {boolean} 是否注册标记节点。
     */
    function markerEnabled() {
      try {
        const raw = globalThis.localStorage?.getItem(MARKER_STORAGE_KEY);
        if (typeof raw !== 'string') return MARKER_DEFAULT;
        const value = raw.trim().toLowerCase();
        if (value === '0' || value === 'off' || value === 'false' || value === 'no') return false;
        if (value === '1' || value === 'on' || value === 'true' || value === 'yes') return true;
        return MARKER_DEFAULT;
      } catch {
        return MARKER_DEFAULT;
      }
    }

    /** 标记节点是否已注册成功（决定补位面板要不要上）。 */
    const markerState = { active: false };

    /**
     * 自己的会话节点定义：只认本插件两个命令名的 `command/run`。
     *
     * 形状对齐 chat 包内部的 `chatNode()`：节点必须带 key/kind/id/target/anchorSeq/
     * location/visibility/data，`location` 取自匹配事件的 location（命令事件不带 turn，
     * 会落在会话级）。
     *
     * @returns {any} 交给 `uiConversation.events.register()` 的定义。
     */
    function markerDefinition() {
      return {
        kind: MARKER_KIND,
        target: 'chat',
        match: (event) => {
          if (event.type !== 'command/run') return null;
          if (turnMode(event.data?.name) === null) return null;
          return { id: String(event.data.commandId), role: 'start' };
        },
        start: () => ({}),
        update: (context) => context.state,
        buildViewNode: (context) => {
          const start = context.start ?? context.matches?.[0];
          const anchorSeq = Number.isSafeInteger(start?.event?.seq) ? start.event.seq : 0;
          return {
            key: context.key,
            kind: MARKER_KIND,
            id: context.id,
            target: 'chat',
            anchorSeq,
            location: start?.location ?? { kind: 'unresolved' },
            visibility: 'visible',
            data: {
              commandId: context.id,
              name: start?.event?.data?.name ?? null,
            },
          };
        },
      };
    }

    /* ---------------------------------------------------------------- *
     * 正文补位面板：正文时间线渲染不出来时，才由它显示答案
     * ---------------------------------------------------------------- *
     *
     * 为什么需要它：DSH 的正文时间线只在"这个会话的 chat 视图活动"时才渲染
     * （`dsh-client-ui-chat` 的 chat 视图定义里 `isActive` 要求至少有一个非 command 节点），
     * 而 `/single-turn` 这种斜杠命令不走 `session.prompt()`，不会把会话从 blank 相位带出来，
     * 于是"只发过临时问答"的会话里，正文区（连 DSH 自带的折叠卡片一起）整个不渲染。
     * 挂在 composer 上的这个槽位不受那套判断约束，所以它来补这个空档。
     *
     * 上面那个标记节点能把这个空档补上（正文区变得可渲染）；只有它没注册成功
     * （内部接口变了、或开关被关掉）时，才轮到这个面板出场。
     *
     * 反过来，一旦会话有了普通回合（blank 变 false），正文区就会渲染那一行，
     * 这块面板必须让位，否则同一份答案会出现两次。`shouldShowDock()` 就是这条界线。
     *
     * 数据走只读的 `remote.session.page`（不写会话日志），失败时把原因显示出来，
     * 不静默变成"什么都没显示"。
     */

    const DOCK_SLOT = 'conversation.input.dock';
    const DOCK_ID = 'local-temp-chat';
    /** 面板最多显示当前话题的最近几轮。 */
    const MAX_DOCK_TURNS = 3;
    /** 有轮次在跑时的轮询间隔（只读一次历史分页；跑完就停）。 */
    const POLL_MS = 2500;
    /** 单次挂载内最多轮询多少次，避免任何形式的失控刷屏。 */
    const MAX_POLLS = 24;
    const EMPTY_TURNS = Object.freeze([]);
    /** 一次取多少条消息。 */
    const PAGE_MESSAGES = 240;

    /** apply() 注入的 remote 门面（客户端 → 宿主）。 */
    let remoteApi;

    /**
     * 这块面板该不该出现：标记节点没接手、且正好是 DSH 抑制正文区的那个相位。
     *
     * 正文区的渲染条件是 `!(session.blank && conversationPhase(...) === "blank")`，
     * 而相位只有在"没有普通回合（blank）＋不在运行＋没有过 prompt 尝试"时才是 blank。
     * 斜杠命令不会产生 prompt 尝试，所以只跑过临时问答的会话始终落在这里。
     *
     * @param {any} session - 会话快照（composer 通过 dock 槽位传进来的 props.session）。
     * @returns {boolean} 是否显示面板。
     */
    function shouldShowDock(session) {
      if (markerState.active) return false;
      if (session === null || typeof session !== 'object') return false;
      return session.blank === true && session.running !== true && session.promptAttempted !== true;
    }

    /** 安全取错误信息。 */
    function errorText(error) {
      if (error instanceof Error) return error.message;
      try {
        return String(error);
      } catch {
        return '未知错误';
      }
    }

    /**
     * 把宿主历史分页里的记录折成"当前话题"的轮次。
     *
     * 记录形如 `{ type: 'event', event: SessionEvent }`（也兼容直接给事件对象）。
     *
     * @param {readonly any[]} records - remote.session.page 的 records。
     * @returns {any[]} 由旧到新的轮次。
     */
    function foldRecords(records) {
      const events = [];
      for (const record of records ?? []) {
        const event = record?.type === 'event' ? record.event : (record?.event ?? record);
        if (event !== null && typeof event === 'object' && typeof event.type === 'string') events.push(event);
      }
      const order = [];
      const byId = new Map();
      for (const event of events) {
        const data = event.data;
        if (event.type === 'command/run') {
          const name = data?.name;
          const mode = turnMode(name);
          if (mode === null) continue;
          const id = String(data.commandId);
          if (byId.has(id)) continue;
          const turn = {
            key: id,
            name,
            mode,
            question: typeof data.args === 'string' ? data.args.trim() : '',
            answer: '',
            running: true,
            failed: false,
          };
          byId.set(id, turn);
          order.push(turn);
          continue;
        }
        if (event.type !== 'command/done') continue;
        const turn = byId.get(String(data?.commandId));
        if (turn === undefined) continue;
        turn.answer = typeof data.text === 'string' ? data.text : '';
        turn.failed = data.kind === 'error';
        turn.running = false;
      }
      if (order.length === 0) return EMPTY_TURNS;
      // 只保留"当前话题"：最近一次单轮命令（/single-turn）起；再取最后 MAX_DOCK_TURNS 轮。
      let start = 0;
      for (let index = order.length - 1; index >= 0; index -= 1) {
        if (order[index].mode === SINGLE_TURN) {
          start = index;
          break;
        }
      }
      return order.slice(start).slice(-MAX_DOCK_TURNS);
    }

    /**
     * 读取当前话题的轮次（只读通路，不写会话日志，可以放心多读）。
     *
     * @param {string} sessionId - 当前会话。
     * @param {AbortSignal} signal - 取消信号。
     * @returns {Promise<any[]>} 轮次。
     */
    async function loadTurns(sessionId, signal) {
      const page = remoteApi?.session?.page;
      if (typeof page !== 'function') throw new Error('remote.session.page 不可用');
      const response = await page.call(remoteApi.session, {
        address: { kind: 'session', sessionId },
        throughSeq: -1,
        maxMessages: PAGE_MESSAGES,
      }, signal);
      return foldRecords(response?.records);
    }

    /**
     * 输入状态指纹：用户打字 / 提交都会让它变化，从而触发重新读取（提交后草稿被清空，
     * 正好把"正在检索"的那一轮读出来）。
     *
     * @param {unknown} input - 输入区快照。
     * @returns {string} 指纹。
     */
    function inputSignature(input) {
      if (input === null || typeof input !== 'object') return typeof input === 'string' ? input : '';
      const parts = [];
      for (const key of ['phase', 'status', 'state', 'submitting', 'pending', 'frozen', 'draft', 'text', 'value']) {
        const value = input[key];
        if (typeof value === 'string') parts.push(`${key}:${value.length}`);
        else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}:${String(value)}`);
      }
      return parts.join(',');
    }

    /**
     * 补位面板：正文区渲染不出来时，把当前话题的问答显示在 composer 上方。
     *
     * @param {any} props - 槽位属性（`session`、`input`、`t`）。
     * @returns {any} React 节点。
     */
    function TempChatDock(props) {
      const t = typeof props?.t === 'function' ? props.t : fallbackTranslate;
      const session = props?.session;
      const visible = shouldShowDock(session);
      const sessionId = session?.sessionId ?? props?.sessionId;
      const signature = inputSignature(props?.input);
      const [state, setState] = React.useState({ status: 'loading', turns: EMPTY_TURNS, error: '' });
      const [collapsed, setCollapsed] = React.useState(false);
      const [reload, setReload] = React.useState(0);
      const [polls, setPolls] = React.useState(0);

      const running = state.turns.some((turn) => turn.running);
      const sessionKey = typeof sessionId === 'string' ? sessionId : '';

      // 只在需要补位时取数：挂载 / 会话切换 / 输入变化 / 手动刷新 → 各读一次。
      React.useEffect(() => {
        if (!visible) return undefined;
        if (sessionKey.length === 0 || remoteApi === undefined) {
          setState({ status: 'error', turns: EMPTY_TURNS, error: t('dock.noRemote') });
          return undefined;
        }
        let cancelled = false;
        const controller = new AbortController();
        setState((current) => ({ ...current, status: 'loading' }));
        void loadTurns(sessionKey, controller.signal).then(
          (turns) => {
            if (!cancelled) setState({ status: 'ready', turns, error: '' });
          },
          (error) => {
            if (!cancelled && controller.signal.aborted !== true) {
              setState({ status: 'error', turns: EMPTY_TURNS, error: errorText(error) });
            }
          },
        );
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [visible, sessionKey, signature, reload]);

      // 有轮次在跑时短轮询，跑完即停（上限 MAX_POLLS 次）。
      React.useEffect(() => {
        if (!visible || !running || polls >= MAX_POLLS) return undefined;
        const timer = setTimeout(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          setPolls((value) => value + 1);
          setReload((value) => value + 1);
        }, POLL_MS);
        return () => clearTimeout(timer);
      }, [visible, running, polls]);

      if (!visible) return null;
      try {
        return renderDockFrame(state, t, {
          collapsed,
          onToggle: () => setCollapsed((value) => !value),
          onReload: () => {
            setPolls(0);
            setReload((value) => value + 1);
          },
        });
      } catch (error) {
        logFailure(error);
        return h('div', { style: dockStyle }, h('div', { style: dockErrorStyle }, `${t('dock.title')} · ${errorText(error)}`));
      }
    }

    /**
     * 纯渲染：给定状态画出面板（不碰 hooks，便于测试与推理）。
     *
     * 没有任何轮次、也没有读取错误时返回 null——空白会话不该多出一条常驻细条。
     *
     * @param {{ status: string, turns: any[], error: string }} state - 当前状态。
     * @param {(key: string, params?: Record<string, unknown>) => string} t - 翻译函数。
     * @param {{ collapsed?: boolean, onToggle?: () => void, onReload?: () => void }} handlers - 交互回调。
     * @returns {any} React 节点。
     */
    function renderDockFrame(state, t, handlers = {}) {
      const turns = Array.isArray(state.turns) ? state.turns : EMPTY_TURNS;
      const failed = state.status === 'error';
      if (turns.length === 0) {
        return failed
          ? h('div', { style: dockStyle }, h('div', { style: dockErrorStyle }, `${t('dock.error')}：${state.error}`))
          : null;
      }
      const running = turns.some((turn) => turn.running);
      const status = running ? t('status.running') : t('dock.rounds', { count: turns.length });
      const collapsed = handlers.collapsed === true;
      return h('div', { style: dockStyle }, [
        h('div', { key: 'head', style: dockHeadStyle }, [
          h('span', { key: 'title', style: dockTitleStyle }, t('dock.title')),
          h('span', { key: 'status', style: dockStatusStyle }, status),
          h('button', { key: 'reload', type: 'button', onClick: handlers.onReload, style: dockButtonStyle }, t('dock.reload')),
          h('button', { key: 'toggle', type: 'button', onClick: handlers.onToggle, style: dockToggleStyle }, t(collapsed ? 'dock.show' : 'dock.hide')),
        ]),
        collapsed ? null : h('div', { key: 'body', style: dockBodyStyle }, renderDockBody(state, t)),
      ]);
    }

    /** 面板主体：读取错误行 + 各轮次。 */
    function renderDockBody(state, t) {
      const rows = [];
      if (state.status === 'error') {
        rows.push(h('div', { key: 'error', style: dockErrorStyle }, `${t('dock.error')}：${state.error}`));
      }
      const turns = Array.isArray(state.turns) ? state.turns : EMPTY_TURNS;
      turns.forEach((turn, index) => {
        rows.push(h(DockTurn, { key: turn.key, turn, t, newest: index === turns.length - 1 }));
      });
      return rows;
    }

    /** 一轮：命令标记 + 提问 + 答案（旧轮默认折叠）。 */
    function DockTurn(props) {
      const turn = props.turn;
      const t = props.t;
      const [expanded, setExpanded] = React.useState(props.newest === true);
      const head = h('div', { key: 'head', style: dockTurnHeadStyle }, [
        h('span', { key: 'chip', style: chipStyle }, chipText(turn.name, turn.mode)),
        h('span', { key: 'q', style: dockQuestionStyle }, turn.question.length > 0 ? turn.question : t('dock.noQuestion')),
      ]);
      if (turn.running) {
        return h('div', { style: dockTurnStyle }, [head, h('div', { key: 'run', style: runningStyle }, t('status.running'))]);
      }
      // 只显示模型的回答正文。
      const text = typeof turn.answer === 'string' ? turn.answer : '';
      const answer = turn.failed
        ? h('pre', { style: errorTextStyle }, text.length > 0 ? text : t('error.empty'))
        : (text.length > 0 ? renderMarkdown(text) : h('div', { style: { color: TOKEN.muted } }, t('error.empty')));
      return h('div', { style: dockTurnStyle }, [
        head,
        expanded ? h('div', { key: 'answer', style: answerStyle }, answer) : null,
        h('div', { key: 'foot' }, h('button', {
          key: 'expand',
          type: 'button',
          onClick: () => setExpanded((value) => !value),
          style: dockButtonStyle,
        }, t(expanded ? 'dock.collapse' : 'dock.expand'))),
      ]);
    }

    /* ---------------------------------------------------------------- *
     * 插件装配
     * ---------------------------------------------------------------- */

    /**
     * 客户端入口：注册词条，把本插件两个命令名的渲染位换成行内的一轮问答，
     * 再用标记节点把正文区拉起来（失败或被开关关掉时退回补位面板）。
     *
     * @param {any} ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { zh, en });
        } catch (error) {
          // 同一个命名空间重复注册会抛错（例如热重载竞态）；此时沿用既有词条即可，
          // 不能因为词条问题让整个插件的渲染位失效。
          ctx.logger?.warn?.(`[dsh-temp-chat] locale register skipped: ${String(error)}`);
          return () => {};
        }
      });
      const slots = ctx.slots ?? ctx.get('slots');
      remoteApi = ctx.get('remote') ?? ctx.remote;

      // 标记节点的渲染器：什么都不画（不注册的话 DSH 会掉进 JsonBlock 兜底，露出"unknown surface"）。
      slots.inject(MARKER_SLOT, () => slots.register({ name: MARKER_SLOT, key: MARKER_KIND, locale: NS }, () => null));

      // 标记节点本身：让 chat 视图"活动"，正文区才会渲染。
      ctx.effect(() => {
        if (!markerEnabled()) {
          markerState.active = false;
          return () => {};
        }
        const uiConversation = ctx.uiConversation ?? ctx.get('uiConversation');
        if (typeof uiConversation?.events?.register !== 'function') {
          ctx.logger?.warn?.('[dsh-temp-chat] uiConversation.events.register 不可用，退回补位面板');
          markerState.active = false;
          return () => {};
        }
        try {
          const dispose = uiConversation.events.register(markerDefinition());
          markerState.active = true;
          return () => {
            markerState.active = false;
            if (typeof dispose === 'function') dispose();
          };
        } catch (error) {
          // 内部契约变了：不影响命令行的渲染，只是退回补位面板。
          ctx.logger?.warn?.(`[dsh-temp-chat] 标记节点注册失败，退回补位面板：${String(error)}`);
          markerState.active = false;
          return () => {};
        }
      });

      slots.inject(SLOT, () => {
        const disposers = COMMAND_NAMES.map((key) => slots.register({ name: SLOT, key, locale: NS }, TempChatCommandRow));
        return () => {
          for (const dispose of disposers) dispose();
        };
      });
      slots.inject(DOCK_SLOT, () => slots.register({
        name: DOCK_SLOT,
        id: DOCK_ID,
        order: 5,
        locale: NS,
      }, TempChatDock));
    }

    return {
      // remote 门面按命名空间校验：没声明的属性读取会直接抛，所以 session 必须显式列出。
      // uiConversation 用来注册让正文区变得可渲染的标记节点。
      inject: ['slots', 'locale', 'remote', 'remote.session', 'uiConversation'],
      apply,
      // 仅测试用：纯函数/纯状态，运行时没有任何副作用。
      __internals: {
        shouldShowDock,
        foldRecords,
        inputSignature,
        renderDockFrame,
        renderDockBody,
        markerEnabled,
        markerDefinition,
        markerState,
        MARKER_KIND,
        MARKER_STORAGE_KEY,
      },
    };
  },
});
