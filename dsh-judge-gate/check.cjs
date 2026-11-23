/**
 * check.cjs — 手动问一句「这次调用会不会被拦」，以及自检零件齐不齐。
 *
 * 用法：
 *   node check.cjs --selfcheck
 *       零件与规则自检：paramcheck 能不能载入、三份契约表在不在、
 *       规则包装了几条、被拒装几条。exit 0 全好 / 1 有问题。
 *
 *   node check.cjs <工具名> key=value [key=value ...]
 *       主判定（paramcheck）与新引擎（规则包）各判一次并排输出。
 *       exit 0 通过 / 1 拦下 / 2 未验（判定不了）。
 *
 *   node check.cjs <工具名> --arg '{"command":"..."}'
 *       参数里带空格、引号、中文时用这个，整段 JSON 传进来更省事。
 *
 * 它只读、不写日志、不挂 guard：问完就退，跟真闸判的是同一份代码。
 */
'use strict';

const path = require('path');
const fs = require('fs');

const SELF_DIR = __dirname;
const LIB = path.join(SELF_DIR, 'lib');
const ENGINE = path.join(SELF_DIR, 'engine');
const RULE_DIRS = [
  path.join(SELF_DIR, 'rules', 'core'),
  path.join(SELF_DIR, 'rules', 'windows-powershell'),
  path.join(SELF_DIR, 'rules', 'dsh-host'),
];
if (!process.env.DSH_JUDGE_TOOLS_DIR) process.env.DSH_JUDGE_TOOLS_DIR = LIB;

// 条目级启用名单（2026-11-23 加）：只想判目录里点名的几条时用它。
//   node check.cjs pwsh "command=…" --only J8,J12
//   node check.cjs --selfcheck --skip J9
// 要在 load 之前落进环境变量，load 时才读得到；不写＝全开，老行为不变。
function preArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const onlyArg = preArg('--only');
const skipArg = preArg('--skip');
if (onlyArg) process.env.DSH_JUDGE_ONLY = onlyArg;
if (skipArg) process.env.DSH_JUDGE_SKIP = skipArg;

function loadMain() {
  const pc = require(path.join(LIB, 'paramcheck.js'));
  if (typeof pc.check !== 'function') throw new Error('lib/paramcheck.js 没有导出 check()');
  return { check: pc.check, checkText: typeof pc.checkText === 'function' ? pc.checkText : null };
}

function loadEngine() {
  const JE = require(path.join(ENGINE, 'judge.js'));
  const EX = require(path.join(ENGINE, 'expand.js'));
  const rs0 = JE.load(RULE_DIRS, JE.ENV);
  const ex = EX.expandAll(rs0.rules, { dir: LIB });
  const pre = ex.rules.filter((r) => (r.when || 'tool:pre') === 'tool:pre');
  return { JE, loaded: rs0.rules.length, rejected: rs0.rejected, expanded: pre.length, pre,
    filtered: rs0.filtered || [], missing: rs0.missing || [], only: rs0.only || [], skip: rs0.skip || [] };
}

function selfcheck() {
  const need = [
    'lib/paramcheck.js',
    'lib/tool-params.json',
    'lib/tool-schema.json',
    'lib/tool-types.json',
    'lib/package.json',
    'engine/package.json',
    'engine/judge.js',
    'engine/expand.js',
    'rules/core/rules.json',
    'rules/windows-powershell/rules.json',
    'rules/dsh-host/rules.json',
  ];
  let bad = 0;
  for (const rel of need) {
    const fp = path.join(SELF_DIR, rel);
    const ok = fs.existsSync(fp);
    if (!ok) bad++;
    console.log((ok ? 'OK   ' : 'MISS ') + rel + (ok ? '  ' + fs.statSync(fp).size + ' B' : ''));
  }
  try {
    const m = loadMain();
    console.log('主判定 paramcheck: 可载入（check' + (m.checkText ? ' + checkText' : '') + '）');
  } catch (e) {
    bad++;
    console.log('主判定 paramcheck: 载入失败 ' + e.message);
  }
  try {
    const e = loadEngine();
    console.log('规则包: 装 ' + e.loaded + ' 条，展开后 ' + e.expanded + ' 条，拒装 ' + e.rejected.length + ' 条');
    if (e.only.length || e.skip.length) {
      console.log('  名单: ' + (e.only.length ? '只装 ' + e.only.join('、') : '不限')
        + (e.skip.length ? '，排除 ' + e.skip.join('、') : '') + '，没装 ' + e.filtered.length + ' 条');
    }
    if (e.missing.length) {
      bad++;
      console.log('  ⚠ 名单里这些没找到: ' + e.missing.join('、') + '（名字写错了，或者不在包里）');
    }
    for (const r of e.rejected) console.log('  拒装 ' + r.id + ' ← ' + r.errors.join('; '));
  } catch (e) {
    bad++;
    console.log('规则包: 载入失败 ' + e.message);
  }
  console.log(bad ? '自检未过：缺 ' + bad + ' 项' : '自检通过');
  return bad ? 1 : 0;
}

function parseArgs(argv) {
  let tool = '';
  let json = null;
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--arg') { json = argv[++i]; continue; }
    if (a.startsWith('--')) continue;
    if (!tool) { tool = a; continue; }
    const eq = a.indexOf('=');
    if (eq < 0) { args[a] = true; continue; }
    args[a.slice(0, eq)] = a.slice(eq + 1);
  }
  if (json) {
    try { return { tool, args: JSON.parse(json) }; } catch (e) { throw new Error('--arg 不是合法 JSON: ' + e.message); }
  }
  return { tool, args };
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*/, ''));
    return 0;
  }
  if (argv[0] === '--selfcheck') return selfcheck();

  const { tool, args } = parseArgs(argv);
  if (!tool) { console.log('没给工具名。用法见 node check.cjs --help'); return 2; }

  const out = { tool, args, main: null, engine: null };

  // 主判定（真闸用的那份）
  try {
    const m = loadMain();
    const r = m.check(tool, args, false);
    let status = r.status;
    let notes = r.notes || '';
    let judge = 'J3';
    if (status !== '拦下' && m.checkText) {
      const r2 = m.checkText(tool, args);
      if (r2 && r2.notes) {
        notes = notes ? notes + '；' + r2.notes : r2.notes;
        if (r2.status === '拦下') { status = '拦下'; judge = r2.judge || 'J3'; }
      }
    }
    out.main = { status, judge, notes };
  } catch (e) {
    out.main = { status: '错误', judge: '-', notes: e.message };
  }

  // 新引擎（规则包，默认只旁路对照）
  try {
    const e = loadEngine();
    const hits = e.JE.judge({ when: 'tool:pre', tool, args }, e.pre);
    const v = e.JE.adjudicate(hits);
    out.engine = {
      action: (v && v.action) || 'pass',
      rules: hits.map((h) => (h.ruleId || (h.rule && h.rule.id) || '?') + ':' + (h.action || '?')),
    };
  } catch (e) {
    out.engine = { action: '错误', rules: [e.message] };
  }

  console.log('工具    : ' + tool);
  console.log('主判定  : ' + out.main.status + (out.main.judge !== 'J3' || out.main.status === '拦下' ? ' [' + out.main.judge + ']' : '') +
    (out.main.notes ? ' ' + out.main.notes : ''));
  console.log('新引擎  : ' + out.engine.action + (out.engine.rules.length ? ' [' + out.engine.rules.join(' ') + ']' : ''));
  const a = out.main.status === '拦下';
  const b = out.engine.action === 'block';
  console.log('一致    : ' + (a === b ? '是（都' + (a ? '拦' : '放') + '）' : '否（主判定' + (a ? '拦' : '放') + '、新引擎' + (b ? '拦' : '放') + '）'));

  if (a || b) return 1;
  return out.main.status === '未验' ? 2 : 0;
}

process.exit(main());
