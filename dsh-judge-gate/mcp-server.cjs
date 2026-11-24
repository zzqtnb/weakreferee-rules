#!/usr/bin/env node
/**
 * mcp-server.cjs — 把弱裁判包成一个 MCP 服务器（stdio），给没有 DSH 的客户端用。
 *
 * 用法（Claude Code / Cursor / 任何支持 MCP 的客户端）：
 *   command: node
 *   args:    ["<这个文件的绝对路径>"]
 *
 * 提供的工具：
 *   judge_check   判一次工具调用：{ tool: "pwsh", arguments: { command: "..." } }
 *                 拦下时 isError=true，并把判据编号放进返回文本
 *   judge_packs   看这台机器装了哪些判据包、展开多少条（清单空＝空转，这是设计）
 *   judge_rules   列出已装的判据编号与一句话说明，方便人挑
 *
 * 语义跟插件一致：只判「参数形态」，不判一件事该不该做；清单空着不拦任何东西。
 * 判定代码用的是同一份 lib/paramcheck.js 与 engine/*，不是另写一套。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const SELF_DIR = __dirname;
const LIB = path.join(SELF_DIR, 'lib');
const ENGINE = path.join(SELF_DIR, 'engine');
const DATA_DIR = process.env.DSH_JUDGE_DATA || path.join(SELF_DIR, 'data');
const SERVER_INFO = { name: 'weakreferee', version: '0.1.0' };

if (!process.env.DSH_JUDGE_TOOLS_DIR) process.env.DSH_JUDGE_TOOLS_DIR = LIB;

let cachedMain = null;
function loadMain() {
  if (cachedMain) return cachedMain;
  const pc = require(path.join(LIB, 'paramcheck.js'));
  if (typeof pc.check !== 'function') throw new Error('lib/paramcheck.js 没有导出 check()');
  cachedMain = { check: pc.check, checkText: typeof pc.checkText === 'function' ? pc.checkText : null };
  return cachedMain;
}

function installedList() {
  const fp = path.join(DATA_DIR, 'judges-installed.json');
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8').replace(/^\uFEFF/, ''));
    return {
      file: fp,
      packs: Array.isArray(raw.packs) ? raw.packs : [],
      rules: Array.isArray(raw.rules) ? raw.rules : [],
    };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { file: fp, packs: [], rules: [], missing: true };
    return { file: fp, packs: [], rules: [], error: e.message };
  }
}

// 只装清单里点名的包：清单空就是空转，跟插件一致。
let cachedEngine = null;
function loadEngine() {
  if (cachedEngine) return cachedEngine;
  const inst = installedList();
  if (!inst.packs.length && !inst.rules.length) {
    cachedEngine = { empty: true, list: inst, JE: null, pre: [], loaded: 0, expanded: 0 };
    return cachedEngine;
  }
  const JE = require(path.join(ENGINE, 'judge.js'));
  const EX = require(path.join(ENGINE, 'expand.js'));
  const dirs = inst.packs.map((p) => path.join(SELF_DIR, 'rules', p)).filter((d) => fs.existsSync(d));
  const only = inst.rules.length ? inst.rules : undefined;
  if (only) process.env.DSH_JUDGE_ONLY = only.join(',');
  const rs = JE.load(dirs, JE.ENV);
  const ex = EX.expandAll(rs.rules, { dir: LIB });
  const pre = ex.rules.filter((r) => (r.when || 'tool:pre') === 'tool:pre');
  cachedEngine = { empty: false, list: inst, JE, pre, loaded: rs.rules.length, expanded: pre.length,
    rejected: rs.rejected || [], missing: rs.missing || [] };
  return cachedEngine;
}

function judgeOnce(tool, args) {
  const lines = [];
  let blocked = false;
  const ids = [];

  let main = { status: '未验', judge: '-', notes: '' };
  try {
    const m = loadMain();
    const r = m.check(tool, args, false);
    main = { status: r.status, judge: 'J3', notes: r.notes || '' };
    if (main.status !== '拦下' && m.checkText) {
      const r2 = m.checkText(tool, args);
      if (r2 && r2.notes) {
        main.notes = main.notes ? main.notes + '；' + r2.notes : r2.notes;
        if (r2.status === '拦下') { main.status = '拦下'; main.judge = r2.judge || 'J3'; }
      }
    }
  } catch (e) {
    main = { status: '错误', judge: '-', notes: e.message };
  }
  if (main.status === '拦下') { blocked = true; ids.push(main.judge + (main.notes ? ' ' + main.notes : '')); }

  let eng = { action: 'pass', hits: [] };
  try {
    const e = loadEngine();
    if (e.empty) {
      eng = { action: 'pass', hits: [], note: '判据清单是空的，空转' };
    } else {
      const hits = e.JE.judge({ when: 'tool:pre', tool, args }, e.pre);
      const v = e.JE.adjudicate(hits);
      eng = {
        action: (v && v.action) || 'pass',
        hits: hits.map((h) => (h.ruleId || (h.rule && h.rule.id) || '?') + ':' + (h.action || '?')),
        notes: (hits || []).map((h) => h.why || h.message || h.notes || '').filter(Boolean),
      };
      if (eng.action === 'block') { blocked = true; ids.push(...eng.hits); }
    }
  } catch (e) {
    eng = { action: '错误', hits: [e.message] };
  }

  lines.push('判定：' + (blocked ? '拦下' : main.status === '未验' ? '未验' : '通过'));
  if (ids.length) lines.push('判据：' + ids.join('；'));
  lines.push('主判定：' + main.status + (main.notes ? ' — ' + main.notes : ''));
  lines.push('引擎：' + eng.action + (eng.hits.length ? ' [' + eng.hits.join(' ') + ']' : '') + (eng.note ? '（' + eng.note + '）' : ''));
  if (eng.notes && eng.notes.length) for (const n of eng.notes) if (n) lines.push('说明：' + n);
  if (main.status === '未验' && !blocked) lines.push('提示：这个工具没有必填声明，参数形态没验——不等于通过。');
  if (/description/.test(main.notes || '')) lines.push('说明：这条要求来自 DSH 的 pwsh 工具定义（每次调用必须带 description 讲清要干什么）；你的宿主没这条规定时可以忽略。');

  return { text: lines.join('\n'), blocked, unverified: !blocked && main.status === '未验' };
}

function packsReport() {
  const e = loadEngine();
  const inst = e.list;
  const lines = [];
  lines.push('清单：' + inst.file + (inst.missing ? '（还没建，首次装就是这样）' : inst.error ? '（读取失败：' + inst.error + '）' : ''));
  lines.push('包：' + (inst.packs.length ? inst.packs.join(', ') : '无'));
  lines.push('单独装的条：' + (inst.rules.length ? inst.rules.join(' ') : '无'));
  if (e.empty) {
    lines.push('判据包：0 条 —— 空转（这是设计，判据要自己装）；参数形态的基础判定（缺必填键、形近错键、http 只收 https 等）仍然生效');
  } else {
    lines.push('实际生效 ' + e.loaded + ' 条手写，展开后 ' + e.expanded + ' 条判定，拒装 ' + e.rejected.length + ' 条');
    if (e.missing.length) lines.push('清单里这些没找到：' + e.missing.join('、'));
    for (const r of e.rejected) lines.push('拒装 ' + r.id + ' ← ' + (r.errors || []).join('; '));
  }
  return lines.join('\n');
}

function rulesReport() {
  const e = loadEngine();
  if (e.empty) return '清单是空的，没有已装判据。装法见 AGENTS.md 第 2 步。';
  const items = e.pre.map((r) => {
    const id = r.ruleId || (r.rule && r.rule.id) || r.id || '?';
    const why = r.why || r.message || (r.rule && r.rule.why) || '';
    return id + (why ? '  ' + why : '');
  });
  return '已装判据（展开后 ' + e.expanded + ' 条）：\n' + items.join('\n');
}

const TOOLS = [
  {
    name: 'judge_check',
    description: '在真正执行之前判一次工具调用：参数缺必填键、键名写成形近词、写文本文件漏编码等。只判参数形态，不判该不该做。返回「判定：通过/拦下/未验」与命中的判据编号。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '工具名，例如 pwsh、write、web_fetch' },
        arguments: { type: 'object', description: '这次要传的参数对象（原样，不要改写）' },
      },
      required: ['tool', 'arguments'],
    },
  },
  {
    name: 'judge_packs',
    description: '看这台机器装了哪些判据包、展开成多少条判定。清单为空表示空转（一条都不拦）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'judge_rules',
    description: '列出已装判据的编号与一句话说明，方便人挑要装哪些。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function callTool(name, args) {
  if (name === 'judge_check') {
    const tool = String((args && args.tool) || '');
    const realArgs = (args && args.arguments) || {};
    if (!tool) return { content: [{ type: 'text', text: '缺少 tool 参数' }], isError: true };
    const r = judgeOnce(tool, realArgs);
    return { content: [{ type: 'text', text: r.text }], isError: r.blocked };
  }
  if (name === 'judge_packs') return { content: [{ type: 'text', text: packsReport() }] };
  if (name === 'judge_rules') return { content: [{ type: 'text', text: rulesReport() }] };
  return { content: [{ type: 'text', text: '没有这个工具：' + name }], isError: true };
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === undefined && id === undefined) return;
  if (id === undefined) return; // 通知，不需要回
  try {
    if (method === 'initialize') {
      const asked = (params && params.protocolVersion) || '2024-11-05';
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: asked,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      } });
      return;
    }
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
    if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      let result;
      try { result = callTool(name, args); } catch (e) {
        result = { content: [{ type: 'text', text: '判定时出错：' + e.message }], isError: true };
      }
      send({ jsonrpc: '2.0', id, result });
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: '不支持的方法：' + method } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e && e.message || e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '不是合法 JSON' } }); return; }
  handle(msg);
});
rl.on('close', () => process.exit(0));
