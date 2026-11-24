#!/usr/bin/env node
'use strict';
/**
 * 弱裁判 · 独立命令行（weakreferee-cli.js）v0.1
 *
 * 为什么要有这个文件：
 *   原来的 preflight.js 只做参数形态，写中文 ps1、Set-Content 中文、带 -Encoding 的正常写法
 *   三条全返回「通过：必填键齐」——它不判编码、不判文本写入。这个命令行把整套引擎
 *   （14 条实体规矩 + 生成器展开的 464 条）装起来，判完给你结论和退出码。
 *
 * 用法：
 *   weakreferee check pwsh "command=Out-File a.ps1 -InputObject 中文"
 *   weakreferee check write "file_path=D:\a.ps1" "content=中文"
 *   weakreferee check <工具名> key=value key2=value2 [--json] [--shell powershell-5.1]
 *   weakreferee packs          列出装到的包与条数
 *   weakreferee selftest       自检：装载、忽略三层、mine 草案、记账、脱敏
 *   weakreferee --help
 *
 * 退出码：
 *   0 通过    1 拦下（block）    2 提示（warn/steer）    3 判不了（包没装好、契约表缺失、条件抛错）
 *
 * 两条不可省的防护：
 *   1. 契约表缺失时必须报「参数形态不可判」，绝不能展开 0 条还报通过——那是假通过。
 *   2. 条件执行抛错记进 hits 并单列，算「判不了」不算「通过」。
 */
const fs = require('fs');
const path = require('path');

// 同一套文件在两种布局里都出现过：仓库是 dsh-judge-gate/rules/<包>，
// 便携包（参赛\发布 那份）是 rules/<包>。写死一种，另一种就找不到。
function ruleFileOf(pack) {
  const cands = [
    path.join(__dirname, 'dsh-judge-gate', 'rules', pack, 'rules.json'),
    path.join(__dirname, 'rules', pack, 'rules.json'),
    path.join(__dirname, 'packs', pack, 'rules.json'),
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* 找不到就试下一个 */ }
  }
  return cands[0];
}
const crypto = require('crypto');

/* 仓库布局兼容（2026-11-24）：
 * 发布包里 contract/engine/rules 与这个文件平铺同级；仓库里真身在 dsh-judge-gate 下
 * （契约表在 lib/）。先认平铺，找不到再认仓库布局——两种形态共用同一份代码。 */
const REPO_SUB = path.join(__dirname, 'dsh-judge-gate');
function pickLayoutDir(flatName, subName) {
  const flat = path.join(__dirname, flatName);
  if (fs.existsSync(flat)) return flat;
  const sub = path.join(REPO_SUB, subName);
  if (fs.existsSync(sub)) return sub;
  return flat;
}
const ENGINE_DIR = pickLayoutDir('engine', 'engine');

const VERSION = '0.1.0';

/* ─────────────────────────────────────────────
 * 一、参数预扫描
 * judge.js 的 ENV 在 require 那一刻算一次，--shell 必须在那之前落进环境变量，
 * 否则这个参数形同虚设（本机默认 powershell-5.1，判据里 shell 过滤会一律走默认）。
 * ───────────────────────────────────────────── */
const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function hasFlag(name) { return argv.includes(name); }

/* 项目配置：从当前目录往上找 .weakreferee.json，找到最近的一份就用它。
 * 为什么要往上找：在子目录里跑命令是常态，配置放在项目根才符合直觉。
 * 命令行 > 配置文件 > 默认，逐项覆盖（与 alint 的 effective config 一个思路）。 */
function loadProjectConfig() {
  if (hasFlag('--no-config')) return { path: null, data: {}, disabled: true };
  let dir = process.cwd();
  for (;;) {
    const p = path.join(dir, '.weakreferee.json');
    if (fs.existsSync(p)) {
      try {
        // 记事本 / PowerShell 改配置常留一个 BOM，不剥掉 JSON.parse 会直接报错
        const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
        const data = JSON.parse(raw);
        return { path: p, data: data && typeof data === 'object' ? data : {} };
      } catch (e) {
        return { path: p, data: {}, error: '配置文件不是合法 JSON（' + p + '）：' + e.message };
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return { path: null, data: {} };
    dir = up;
  }
}
const CFG = loadProjectConfig();
const cfgVal = (k) => (CFG.data && CFG.data[k] !== undefined ? CFG.data[k] : undefined);

const optShell = flagValue('--shell') || cfgVal('shell');
if (optShell) process.env.DSH_JUDGE_SHELL = optShell;

/* 契约表目录必须在 require 引擎之前定好并导出成环境变量：
 * dsh-host 包的 DSH-STALE-JUDGE-01 规矩里引用了 {DSH_JUDGE_TOOLS_DIR}，
 * 装载时校验「引用的环境变量必须已设置」，没设就直接拒装——它不会报错，
 * 只会安静少一条判据（实测：装载数从 463 掉到 462，差的就是它）。 */
/* 配置文件里的相对路径按配置文件所在目录算，命令行给的按当前目录算——
 * 否则在子目录里跑命令时，配置里的 "rules": "./packs" 会解析到错的层。 */
function cfgPath(k) {
  const v = cfgVal(k);
  if (typeof v !== 'string' || !v) return undefined;
  const base = CFG.path ? path.dirname(CFG.path) : process.cwd();
  return path.resolve(base, v);
}

function pickContractDir() {
  const given = flagValue('--contract') || cfgPath('contract');
  if (given) return path.resolve(given);
  const local = pickLayoutDir('contract', 'lib');
  if (fs.existsSync(path.join(local, 'tool-params.json'))
    || fs.existsSync(path.join(local, 'tool-schema.json'))) return local;
  const fallback = process.env.JUDGE_TOOLS_DIR
    || process.env.DSH_JUDGE_TOOLS_DIR
    || null;
  if (fallback && (fs.existsSync(path.join(fallback, 'tool-schema.json'))
    || fs.existsSync(path.join(fallback, 'tool-params.json')))) return fallback;
  return null;
}
const CONTRACT_DIR = pickContractDir();
if (CONTRACT_DIR) {
  if (!process.env.JUDGE_TOOLS_DIR) process.env.JUDGE_TOOLS_DIR = CONTRACT_DIR;
  // 规矩里写的就是这个名字，别改成别的：改名等于把那条判据静默关掉
  if (!process.env.DSH_JUDGE_TOOLS_DIR) process.env.DSH_JUDGE_TOOLS_DIR = CONTRACT_DIR;
}

/* 条目级启用名单（2026-11-23 加）：只想装目录里点名的几条时用它。
 *   node weakreferee-cli.js packs --only J8,J12
 *   node weakreferee-cli.js check pwsh "command=…" --only J8
 * 也可以在 .weakreferee.json 里写 "only": ["J8","J12"] 或 "skip": ["J9"]。
 * 两个名字都认：包内 id（WIN-ENC-01）与给人看的号（J8）。不写＝全开，老行为不变。 */
const onlyArg = flagValue('--only') || cfgVal('only');
const skipArg = flagValue('--skip') || cfgVal('skip');
if (onlyArg) process.env.DSH_JUDGE_ONLY = Array.isArray(onlyArg) ? onlyArg.join(',') : String(onlyArg);
if (skipArg) process.env.DSH_JUDGE_SKIP = Array.isArray(skipArg) ? skipArg.join(',') : String(skipArg);

const ENG = ENGINE_DIR;
const J = require(path.join(ENG, 'judge.js'));
const LED = require(path.join(ENG, 'ledger.js'));
const PACK = require(path.join(ENG, 'packmgr.js'));
const EXP = require(path.join(ENG, 'expand.js'));
const SCH = require(path.join(ENG, 'schema.js'));

/* ─────────────────────────────────────────────
 * 二、找规则包与契约表
 * ───────────────────────────────────────────── */
function resolveRulesDir() {
  const given = flagValue('--rules') || cfgPath('rules');
  if (given) return path.resolve(given);
  const local = pickLayoutDir('rules', 'rules');
  if (fs.existsSync(local)) return local;
  return null;
}

function resolveContractDir() {
  if (CONTRACT_DIR) return CONTRACT_DIR;
  const given = flagValue('--contract');
  if (given) return path.resolve(given);
  return null;
}

function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}
/* 完整性清单：rules\manifest.json 记着每个包 rules.json 的指纹与条数。
 * 只解决「文件被人换过/改过，你还以为跑的是原来那套」这一件事。
 * 它不是签名——有意篡改可以连清单一起改，真要防得住得做签名，留给后面。 */
function checkIntegrity(rulesDir, packs) {
  const out = { manifest: false, checked: 0, mismatched: [], unknown: [] };
  const mp = path.join(rulesDir, 'manifest.json');
  if (!fs.existsSync(mp)) return out;
  out.manifest = true;
  let man;
  try { man = JSON.parse(fs.readFileSync(mp, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { out.error = 'manifest.json 不是合法 JSON：' + e.message; return out; }
  const list = (man && man.packs) || {};
  for (const dir of packs) {
    const name = path.basename(dir);
    const entry = list[name];
    if (!entry) { out.unknown.push(name); continue; }
    const h = sha256File(path.join(dir, entry.file || 'rules.json'));
    out.checked += 1;
    if (!h || h !== entry.sha256) out.mismatched.push(name);
  }
  return out;
}

function loadAll() {
  const rulesDir = resolveRulesDir();
  if (!rulesDir || !fs.existsSync(rulesDir)) {
    return { error: '找不到规则包目录。用 --rules <目录> 指定，或把 rules/ 放在本文件旁边' };
  }
  const packs = fs.readdirSync(rulesDir)
    .map(n => path.join(rulesDir, n))
    .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  if (!packs.length) return { error: rulesDir + ' 下面没有包目录' };

  const rs = J.load(packs, J.ENV);
  const integrity = checkIntegrity(rulesDir, packs);
  const contractDir = resolveContractDir();
  const hasContractFiles = !!contractDir && (
    fs.existsSync(path.join(contractDir, 'tool-schema.json'))
    || fs.existsSync(path.join(contractDir, 'tool-params.json')));
  let ex = { rules: rs.rules, report: { generators: 0, emitted: 0 } };
  let contractMissing = false;

  if (hasContractFiles) {
    ex = EXP.expandAll(rs.rules, { dir: contractDir });
  } else {
    // 没有契约表时 expandAll 仍会跑，但读空表 → 0 条参数规矩。
    // 那种「0 条」看起来和「全过」一模一样，必须显式区分开。
    contractMissing = rs.rules.some(r => r.generator);
    ex = EXP.expandAll(rs.rules, { dir: path.join(__dirname, '__no_contract__') });
  }
  // 有生成器、却一条没产出：同样说明契约表没读到（目录在但文件空/名字不对）
  if (rs.rules.some(r => r.generator) && (ex.report.emitted || 0) === 0) contractMissing = true;

  return {
    rulesDir, contractDir, packs,
    handwritten: rs.rules.length,
    expanded: ex.rules.length,
    rules: ex.rules,
    rejected: rs.rejected || [],
    generators: ex.report.generators || 0,
    emitted: ex.report.emitted || 0,
    unverified: ex.report.unverified || [],
    contractMissing,
    integrity,
    filtered: rs.filtered || [],
    missing: rs.missing || [],
    only: rs.only || [],
    skip: rs.skip || [],
  };
}

/* ─────────────────────────────────────────────
 * 三、参数解析：check <工具> key=value ...
 * 只按第一个 = 切，值里的 = 原样保留（命令里常见 --opt=1）
 * ───────────────────────────────────────────── */
function parseArgs(pairs) {
  const args = {};
  for (const s of pairs) {
    const i = s.indexOf('=');
    if (i < 0) return { error: '参数要写成 key=value：' + s };
    const k = s.slice(0, i);
    let v = s.slice(i + 1);
    if (!k) return { error: '键名是空的：' + s };
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v === 'null') v = null;
    else if (/^[\[{]/.test(v)) {
      try { v = JSON.parse(v); } catch { /* 不是 JSON 就按字符串 */ }
    }
    args[k] = v;
  }
  // 相对路径统一成绝对：文件类判据要真的 open，拿 cwd 赌会判出「文件不存在 → 放过」
  for (const k of ['file_path', 'path']) {
    if (typeof args[k] === 'string' && args[k] && !/^[A-Za-z]:[\\/]/.test(args[k]) && !args[k].startsWith('\\\\')) {
      args[k] = path.resolve(args[k]);
    }
  }
  return { args };
}

/* ─────────────────────────────────────────────
 * 三点五、忽略：三条通道
 *   1. 配置文件 ignore.rules —— 按规则编号关掉整条（gitleaks allowlist 的「按规则」那档）
 *   2. 配置文件 ignore.fingerprints —— 只关掉这一条命中（按「工具+参数+规则」算指纹）
 *   3. --ignore-rule <编号>[,编号] —— 命令行临时覆盖
 * 被忽略的命中必须念出来：静默吞掉的检查，跟没做一样。
 * 执行出错的命中不参与忽略——那是「没判」，不是「误报」。
 * ───────────────────────────────────────────── */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function fingerprint(tool, args, ruleId) {
  return crypto.createHash('sha1')
    .update(tool + '\u0000' + stableStringify(args) + '\u0000' + ruleId)
    .digest('hex').slice(0, 12);
}

function collectIgnore() {
  const rules = new Set();
  const fps = new Set();
  const cfgIgnore = (CFG.data && CFG.data.ignore) || {};
  for (const r of (Array.isArray(cfgIgnore.rules) ? cfgIgnore.rules : [])) if (r) rules.add(String(r));
  for (const f of (Array.isArray(cfgIgnore.fingerprints) ? cfgIgnore.fingerprints : [])) if (f) fps.add(String(f));
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--ignore-rule') continue;
    const v = argv[i + 1];
    if (!v) continue;
    for (const one of String(v).split(',')) if (one.trim()) rules.add(one.trim());
  }
  return { rules, fingerprints: fps, fromConfig: !!CFG.path };
}

function applyIgnore(hits, tool, args, ig) {
  const kept = [], dropped = [];
  for (const h of hits) {
    if (h.error) { kept.push(h); continue; }
    const byRule = !!(h.ruleId && ig.rules.has(String(h.ruleId)));
    const byFp = !!(h.ruleId && ig.fingerprints.has(fingerprint(tool, args, h.ruleId)));
    if (byRule || byFp) dropped.push({ ruleId: h.ruleId, message: h.message, ignoredBy: byRule ? 'rule' : 'fingerprint' });
    else kept.push(h);
  }
  return { kept, dropped };
}

/* ─────────────────────────────────────────────
 * 四、输出
 * ───────────────────────────────────────────── */
const ACTION_CN = { block: '拦下', warn: '提示', steer: '建议', pass: '通过' };

function printHits(hits, action) {
  const out = [];
  out.push('判定：' + (ACTION_CN[action] || action));
  for (const h of hits) {
    if (h.error) {
      out.push('  [' + h.ruleId + '] 这条规矩执行出错，判不了：' + h.error);
      continue;
    }
    out.push('  [' + h.ruleId + '] ' + (h.message || ''));
    if (h.fix) out.push('     怎么改：' + h.fix);
  }
  return out.join('\n');
}

function printFooter(st) {
  const L = [];
  L.push('装载 ' + st.handwritten + ' 条判据（展开 ' + st.expanded + ' 条规则）');
  if (st.unverified && st.unverified.length) L.push('  · ' + st.unverified.length + ' 个工具无必填声明，参数形态未验（不算通过）');
  if (st.rejected && st.rejected.length) L.push('  ⚠ 拒装 ' + st.rejected.length + ' 条：' + st.rejected.map(r => r.id).join(', '));
  return L.join('\n');
}

/* ─────────────────────────────────────────────
 * 五、子命令
 * ───────────────────────────────────────────── */
function cmdCheck(args) {
  const jsonOut = hasFlag('--json');
  const st = loadAll();
  if (st.error) {
    console.error('失败：' + st.error);
    return 3;
  }

  const tool = args[0];
  if (!tool) { console.error('用法：weakreferee check <工具名> key=value ...'); return 3; }
  const parsed = parseArgs(args.slice(1));
  if (parsed.error) { console.error('失败：' + parsed.error); return 3; }

  /* pwsh 的契约里 description 是必填键，但命令行场景没有这个概念：
   * 不代填的话每条检查都会被 PARAM-MISSING:description 拦下，把真正的编码问题淹掉。
   * 只代填这一个键，且必须念出来——不能让它看起来像用户自己给了。 */
  const filled = [];
  if (tool === 'pwsh' && parsed.args.description === undefined) {
    parsed.args.description = '(命令行代填) ' + String(parsed.args.command || '').slice(0, 40);
    filled.push('description');
  }

  const ig = collectIgnore();
  let hits = [], crashed = null;
  try {
    hits = J.judge({ when: 'tool:pre', tool, args: parsed.args }, st.rules);
  } catch (e) {
    crashed = String(e.message || e);
  }
  // 先忽略、再定档：一条命中要是被配置按规则/指纹关掉了，就不该再算进 block
  const ign = crashed ? { kept: [], dropped: [] } : applyIgnore(hits, tool, parsed.args, ig);
  hits = ign.kept;
  const adj = crashed ? { action: 'error', hits: [] } : J.adjudicate(hits);
  const errHits = hits.filter(h => h.error);

  // 记账可选：默认不写，避免命令行跑一次就污染账本
  const ledgerPath = flagValue('--ledger') || cfgPath('ledger');
  if (ledgerPath) {
    LED.record(path.resolve(ledgerPath), {
      session: 'cli', when: 'tool:pre', tool, args: parsed.args,
      rules: adj.hits.map(h => h.ruleId),
      action: adj.action,
      reason: adj.hits.map(h => h.message).join(' / '),
      target: parsed.args.file_path || parsed.args.command || '',
      reversible: adj.hits.length ? adj.hits.every(h => h.ruleId && false) : false,
    });
  }

  if (jsonOut) {
    console.log(JSON.stringify({
      version: VERSION,
      tool,
      args: parsed.args,
      action: crashed ? 'error' : adj.action,
      hits: adj.hits.map(h => ({ ruleId: h.ruleId, action: h.action, message: h.message, fix: h.fix, error: h.error })),
      errorHits: errHits.map(h => ({ ruleId: h.ruleId, error: h.error })),
      ignored: ign.dropped,
      load: {
        rules: st.expanded, handwritten: st.handwritten, emitted: st.emitted,
        rejected: st.rejected.length, contractDir: st.contractDir, contractMissing: st.contractMissing,
        filled,
        env: J.ENV,
      },
    }, null, 2));
  } else {
    if (crashed) {
      console.log('判定：判不了（引擎抛错）');
      console.log('  ' + crashed);
    } else {
      console.log(printHits(adj.hits, adj.action));
    }
    if (ign.dropped.length) {
      console.log('（已忽略 ' + ign.dropped.length + ' 条：'
        + ign.dropped.map(d => d.ruleId + (d.ignoredBy === 'fingerprint' ? '(指纹)' : '')).join(', ') + '）');
    }
    console.log(printFooter(st));
    if (filled.length) console.log('注：命令行场景代填了 ' + filled.join(',') + '（真调用必须自己给）');
    if (st.contractMissing) {
      console.log('⚠ 契约表缺失：只装了手写规矩，参数形态一条都没展开——这时「通过」不代表参数没问题');
    }
    if (errHits.length) console.log('⚠ 有 ' + errHits.length + ' 条规矩执行出错，这些是「没判」，不是「通过」');
  }

  if (crashed) return 3;
  if (st.contractMissing) return 3;          // 判不了就别给 0
  if (adj.action === 'block') return 1;
  if (adj.action === 'warn' || adj.action === 'steer') return 2;
  return 0;
}

/* 回放：把历史调用按现有判据重判一遍，告诉你这套规矩在你这里能拦多少 */
function cmdReplay(argv) {
  const pos = splitArgs(argv.slice(1));
  const def = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'sessions') : '.';
  const target = pos[0] || def;
  const maxFiles = parseInt(flagValue('--max-files') || '0', 10) || 0;

  const st = loadAll();
  if (st.error) { console.error('失败：' + st.error); return 3; }
  const M = require(path.join(ENGINE_DIR, 'mine.js'));
  const RP = require(path.join(ENGINE_DIR, 'replay.js'));

  let got;
  try { got = M.collectCalls(target, maxFiles); }
  catch (e) {
    if (e && e.code === 'NODIR') {
      console.error('失败：找不到 ' + target + '（给一个目录，或 jsonl / json 数组文件）');
      return 3;
    }
    console.error('失败：' + (e && e.message ? e.message : e));
    return 3;
  }

  const r = RP.replay(got.calls, st.rules);
  const top = RP.rank(r, 8);
  if (hasFlag('--json')) {
    console.log(JSON.stringify({
      version: VERSION, target, files: got.files, filesRead: got.filesRead,
      stat: r, top: RP.rank(r, 20),
    }, null, 2));
    return st.rejected.length ? 2 : 0;
  }

  console.log('看了 ' + got.filesRead + ' 份记录（共 ' + got.files + ' 份），' + r.calls + ' 次调用');
  console.log('拦下 ' + r.blocked + ' 次（' + (r.blockRate * 100).toFixed(2) + '%），提示 ' + r.warned
    + ' 次，通过 ' + r.passed + ' 次' + (r.errored ? '，判不了 ' + r.errored + ' 次' : ''));
  if (top.length) {
    console.log('');
    console.log('命中最多：');
    for (const pair of top) console.log('  ' + pair[0] + '：' + pair[1] + ' 次');
  }
  if (r.samples.length) {
    console.log('');
    console.log('几条被拦下来的样子：');
    for (const s of r.samples) console.log('  [' + s.rules + '] ' + s.tool + ' ' + s.args);
  }
  console.log('');
  console.log('这些数是这台机器过去发生的事，换台机器、换个人不会一样。');
  return st.rejected.length ? 2 : 0;
}

function cmdTrace(argv) {
  const pos = splitArgs(argv.slice(1));
  const def = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'sessions') : '.';
  const target = pos[0] || def;
  const maxFiles = parseInt(flagValue('--max-files') || '0', 10) || 400;
  const ruleArg = flagValue('--rules');
  const ruleFile = ruleArg
    ? path.resolve(ruleArg)
    : ruleFileOf('cross-call');

  let rules;
  try { rules = JSON.parse(fs.readFileSync(ruleFile, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
    console.error('失败：读不到判据 ' + ruleFile + '（' + (e && e.message ? e.message : e) + '）');
    return 3;
  }
  if (!Array.isArray(rules)) rules = rules.rules || [];

  const J = require(path.join(ENGINE_DIR, 'judge.js'));
  const T = require(path.join(ENGINE_DIR, 'trace.js'));
  let got;
  try { got = T.readTrace(target, maxFiles); } catch (e) {
    console.error('失败：找不到 ' + target + '（给一个目录）');
    return 3;
  }
  const r = T.replayTrace(got.traces, rules, J);

  if (hasFlag('--json')) {
    console.log(JSON.stringify({
      version: VERSION, target, rules: ruleFile,
      files: got.files, sessions: got.sessions, calls: got.calls, orphan: got.orphan, stat: r,
    }, null, 2));
    return 0;
  }

  console.log('判据：' + rules.map((x) => x.id).join(', ') + '（' + ruleFile + '）');
  console.log('看了 ' + got.sessions + ' 份会话（共 ' + got.files + ' 份），' + got.calls + ' 次调用');
  console.log('对不上结果的调用 ' + got.orphan + ' 条，已丢掉——成败不明的不算失败也不算成功');
  console.log('命中 ' + r.hit + ' 次' + (r.skipped ? '；显式跳过 ' + r.skipped + ' 次（没历史时不当成通过）' : ''));
  const top = Object.entries(r.byRule).sort((a, b) => b[1] - a[1]);
  if (top.length) {
    console.log('');
    console.log('按判据：');
    for (const p of top) console.log('  ' + p[0] + '：' + p[1] + ' 次');
  }
  if (r.samples.length) {
    console.log('');
    console.log('头几条什么样子：');
    for (const s of r.samples.slice(0, 8)) {
      const when = new Date(s.at).toISOString().replace('T', ' ').slice(0, 19);
      console.log('  [' + s.rule + '] ' + when + ' ' + s.tool + ' ' + s.arg);
    }
  }
  console.log('');
  console.log('这些数是这台机器过去发生的事；命中 0 次不等于判据没用，也不等于判据对。');
  return 0;
}

function cmdPacks() {
  const st = loadAll();
  if (st.error) { console.error('失败：' + st.error); return 3; }
  const L = [];
  L.push('规则包目录：' + st.rulesDir);
  L.push('契约表目录：' + (st.contractDir || '（缺失）'));
  L.push('');
  for (const d of st.packs) {
    let i;
    try { i = PACK.inspect(d); } catch (e) { L.push('  ' + path.basename(d) + '：读不了 ' + e.message); continue; }
    L.push('  ' + i.pack + '：' + i.rules + ' 条，本环境生效 ' + i.appliedHere
      + '，带实测证据 ' + i.withEvidence + '，作用例 ' + i.withCases);
  }
  L.push('');
  L.push('合计：手写 ' + st.handwritten + ' 条 → 展开 ' + st.expanded + ' 条（生成器 ' + st.generators + ' 个，产出 ' + st.emitted + ' 条）');
  if ((st.only && st.only.length) || (st.skip && st.skip.length)) {
    L.push('启用名单：' + (st.only.length ? '只装 ' + st.only.join('、') : '不限') +
      (st.skip.length ? '，排除 ' + st.skip.join('、') : '') +
      '；没装的 ' + (st.filtered || []).length + ' 条');
  }
  if (st.missing && st.missing.length) {
    L.push('⚠ 名单里这几条没找到：' + st.missing.join('、') + '（名字写错了，或者不在这些包里）');
  }
  const it = st.integrity || {};
  let dirty = false;
  if (!it.manifest) {
    L.push('完整性：没有 manifest.json，规则被改过也看不出来');
  } else if (it.error) {
    L.push('⚠ 完整性：' + it.error);
    dirty = true;
  } else if (it.mismatched && it.mismatched.length) {
    L.push('⚠ 完整性：' + it.mismatched.join('、') + ' 与清单不符，这些包的 rules.json 被改过');
    L.push('  改完确认没问题就重新生成清单（node tools/gen-manifest.js rules）');
    dirty = true;
  } else {
    L.push('完整性：' + it.checked + ' 个包与清单一致'
      + (it.unknown && it.unknown.length ? '（另有 ' + it.unknown.length + ' 个不在清单里：' + it.unknown.join('、') + '）' : ''));
  }
  if (st.rejected.length) L.push('⚠ 拒装 ' + st.rejected.length + ' 条：' + st.rejected.map(r => r.id + '(' + r.errors.join(';') + ')').join(', '));
  console.log(L.join('\n'));
  return (st.rejected.length || dirty) ? 2 : 0;
}

/* 自检：命令行自己坏了要能看出来，不能等它在别人机器上假通过 */
function cmdSelftest() {
  const st = loadAll();
  if (st.error) { console.error('失败：' + st.error); return 3; }
  let bad = 0, total = 0;
  const say = (ok, msg) => { total++; if (!ok) bad++; console.log((ok ? '  ok   ' : '  FAIL ') + msg); };

  say(st.expanded > 400, '装载 ' + st.handwritten + ' → ' + st.expanded + ' 条（不足 400 说明生成器没展开）');
  say(!st.contractMissing, '契约表在场：' + (st.contractDir || '缺失'));

  const cases = [
    { name: '写中文 ps1 不带编码 → 拦', want: 'block',
      tool: 'pwsh', args: { command: 'Out-File -FilePath a.ps1 -InputObject "中文内容"', description: 'x' } },
    { name: 'Set-Content 中文不带编码 → 拦', want: 'block',
      tool: 'pwsh', args: { command: 'Set-Content -Path a.txt -Value "中文"', description: 'x' } },
    { name: '带 -Encoding utf8 → 放', want: 'pass',
      tool: 'pwsh', args: { command: 'Set-Content -Path a.txt -Value "中文" -Encoding utf8', description: 'x' } },
    { name: '递归删除不带 -WhatIf → 提示', want: ['warn', 'steer'],
      tool: 'pwsh', args: { command: 'Remove-Item D:\\work\\old -Recurse -Force', description: 'x' } },
    { name: '递归删除带 -WhatIf → 放', want: 'pass',
      tool: 'pwsh', args: { command: 'Remove-Item D:\\work\\old -Recurse -WhatIf', description: 'x' } },
    { name: 'web_fetch 只给 urls 缺 url → 拦', want: 'block',
      tool: 'web_fetch', args: { urls: ['https://a.com'], description: 'x' } },
    { name: '引号里的写操作词 → 放', want: 'pass',
      tool: 'pwsh', args: { command: 'Select-String -Pattern "Out-File" -Path a.txt', description: 'x' } },
  ];
  for (const c of cases) {
    let act = 'ERROR', ids = '-';
    try {
      const hits = J.judge({ when: 'tool:pre', tool: c.tool, args: c.args }, st.rules);
      act = J.adjudicate(hits).action;
      ids = hits.map(h => h.ruleId).join(',') || '-';
    } catch (e) { ids = '抛错:' + e.message; }
    const wants = Array.isArray(c.want) ? c.want : [c.want];
    say(wants.includes(act), c.name + ' → ' + act + ' [' + ids + ']');
  }

  // 忽略：按规则关掉、按指纹只关一条、执行出错的那条不许被吞
  try {
    const fake = [
      { ruleId: 'R-1', action: 'block', message: 'm1' },
      { ruleId: 'R-2', action: 'block', message: 'm2' },
      { ruleId: 'R-3', action: 'block', message: 'm3', error: 'boom' },
    ];
    const ig = { rules: new Set(['R-1']), fingerprints: new Set([fingerprint('t', { a: 1 }, 'R-2')]) };
    const r = applyIgnore(fake, 't', { a: 1 }, ig);
    say(r.dropped.length === 2 && r.kept.length === 1 && r.kept[0].ruleId === 'R-3',
      '忽略：按规则与按指纹各关一条，剩下的那条还在');
    const ig2 = { rules: new Set(['R-1', 'R-2', 'R-3']), fingerprints: new Set() };
    const r2 = applyIgnore(fake, 't', { a: 1 }, ig2);
    say(r2.kept.length === 1 && !!r2.kept[0].error, '忽略：执行出错的命中不被忽略清单吞掉');
    say(fingerprint('t', { b: 2, a: 1 }, 'X') === fingerprint('t', { a: 1, b: 2 }, 'X'),
      '指纹：参数顺序不影响结果');
  } catch (e) {
    say(false, '忽略逻辑抛错：' + e.message);
  }

  // needs：声明依赖 history 的判据，没历史必须显式「跳过」，不许算通过。
  // 三态各验一次，外加一条「空数组 ≠ 有历史」——空数组最容易被人当成「有历史只是空的」。
  try {
    // 路径用本脚本自身：CAT-OVERWRITE-01 的条件里有 fileExistsBefore，
    // 拿 'README.md' 这种相对路径会在「当前目录恰好没有那个文件」的地方判不出来
    // （便携包里就没有 README.md，同一份代码在仓库里过、在包里红）。
    const pre = { when: 'tool:pre', tool: 'write', args: { file_path: __filename, content: '新内容' } };
    const RID = 'CAT-OVERWRITE-01';
    const skippedIds = r => (r.skipped || []).map(x => x.ruleId);
    const hitIds = r => r.hits.map(h => h.ruleId);

    J.resetHistory();   // 前面几条用例已经把进程内历史填满了，不清空测不到「真没历史」这一态
    const noHist = J.judgeEx(pre, st.rules);
    say(!hitIds(noHist).includes(RID) && skippedIds(noHist).includes(RID),
      'needs：没历史 → ' + RID + ' 显式跳过（跳过 ' + (skippedIds(noHist).join(',') || '-') + '）');

    const emptyHist = J.judgeEx({ ...pre, history: [] }, st.rules);
    say(skippedIds(emptyHist).includes(RID), 'needs：空历史数组 ≠ 有历史，仍然跳过');

    const readHist = J.judgeEx({ ...pre, history: [{ tool: 'read', args: { file_path: 'README.md' }, at: Date.now() }] }, st.rules);
    say(!skippedIds(readHist).includes(RID) && !hitIds(readHist).includes(RID),
      'needs：有历史且已读过 → 真判过、没命中，也不许标跳过');

    const pwshHist = J.judgeEx({ ...pre, history: [{ tool: 'pwsh', args: { command: 'Get-Date' }, at: Date.now() }] }, st.rules);
    say(hitIds(pwshHist).includes(RID), 'needs：有历史但没读过 → 判出来');
  } catch (e) { say(false, 'needs 三态抛错：' + e.message); }

  // cross-call：跨调用包三条（看成败、看时间窗，全走外部递进来的 history）
  try {
    const MK = require(path.join(ENGINE_DIR, 'judge.js'));
    const ccRules = require(ruleFileOf('cross-call'));
    const T = 1795000000000; // 固定时间，别让「5 分钟内」随跑的时刻漂
    const run = (args, history) => MK.judgeEx({ when: 'tool:pre', tool: 'pwsh', args, history, at: T }, ccRules);
    const ids = (ex) => (ex.hits || []).map((h) => h.ruleId);

    // ① 原样重试：5 分钟前同一条命令失败过
    const r1 = run({ command: 'npm run build' }, [
      { tool: 'pwsh', args: { command: 'npm run build' }, ok: false, at: T - 60 * 1000 },
    ]);
    say(ids(r1).includes('CROSS-RETRY-01'), 'cross-call：同一条命令失败后又原样发 → 提示');

    // ② 失败在 5 分钟以外：不该报（免得把「隔了一小时重试」也算上）
    const r2 = run({ command: 'npm run build' }, [
      { tool: 'pwsh', args: { command: 'npm run build' }, ok: false, at: T - 30 * 60 * 1000 },
    ]);
    say(!ids(r2).includes('CROSS-RETRY-01'), 'cross-call：失败在半小时前 → 不提示');

    // ③ 上次是成功的：重发同一条不算事
    const r3 = run({ command: 'npm run build' }, [
      { tool: 'pwsh', args: { command: 'npm run build' }, ok: true, at: T - 60 * 1000 },
    ]);
    say(!ids(r3).includes('CROSS-RETRY-01'), 'cross-call：上次成功 → 不提示');

    // ④ 没有成败记录的老条目：不按「假设它失败」乱报
    const r4 = run({ command: 'npm run build' }, [
      { tool: 'pwsh', args: { command: 'npm run build' }, ok: null, at: T - 60 * 1000 },
    ]);
    say(!ids(r4).includes('CROSS-RETRY-01'), 'cross-call：成败未知（ok=null）→ 不提示');

    // ⑤ 死磕的条件本身（CROSS-GRIND-01 本机 0 命中、暂不进包，但条件要有人测）
    const H5 = [
      { tool: 'pwsh', args: { command: 'git push' }, ok: false, at: T - 4 * 60 * 1000 },
      { tool: 'pwsh', args: { command: 'git push' }, ok: false, at: T - 2 * 60 * 1000 },
      { tool: 'pwsh', args: { command: 'git push' }, ok: false, at: T - 60 * 1000 },
    ];
    const C5 = { tool: 'pwsh', args: { command: 'git push' }, history: H5, now: T };
    say(MK.CONDITION.failCountSince({ times: 3, minutes: 10 }, C5) === true,
      'cross-call：同工具连失败三次 → 条件成立（这条判据本机 0 命中，暂不进包）');
    const C5b = { tool: 'pwsh', args: {}, history: [
      { tool: 'pwsh', args: {}, ok: true, at: T - 60 * 1000 },
      { tool: 'pwsh', args: {}, ok: true, at: T - 30 * 1000 },
    ], now: T };
    say(MK.CONDITION.failCountSince({ times: 3, minutes: 10 }, C5b) === false,
      'cross-call：最近都是成功 → 连败条件不成立');

    // ⑥ 同一个文件二十分钟内失败两次（插件小本子只有 target，没有 args）
    const r6 = run({ file_path: 'D:/演示/a.md', content: 'x' }, [
      { tool: 'write', target: 'D:/演示/a.md', ok: false, at: T - 6 * 60 * 1000 },
      { tool: 'write', target: 'D:/演示/a.md', ok: false, at: T - 2 * 60 * 1000 },
    ]);
    say(ids(r6).includes('CROSS-BLIND-01'), 'cross-call：同一文件连败 → 提示（插件小本子只有 target 也算）');

    // ⑦ 插件写的小本子只有指纹、没有参数正文：这一条过去判不出来（取不到 command 就放弃）
    const HSF = require(path.join(ENGINE_DIR, 'history.js'));
    const fpCmd = HSF.fingerprint('pwsh', { command: 'npm run build' });
    const r8 = run({ command: 'npm run build' }, [
      { tool: 'pwsh', fp: fpCmd, target: '', ok: false, at: T - 30 * 1000 },
    ]);
    say(ids(r8).includes('CROSS-RETRY-01'), 'cross-call：小本子只有指纹没有参数正文时也能命中');

    // ⑧ 指纹不同就别报（别把「另一条命令」当成同一条的重发）
    const r9 = run({ command: 'npm run build' }, [
      { tool: 'pwsh', fp: HSF.fingerprint('pwsh', { command: 'npm run test' }), target: '', ok: false, at: T - 30 * 1000 },
    ]);
    say(!ids(r9).includes('CROSS-RETRY-01'), 'cross-call：指纹不同的命令失败过 → 不提示');

    // ⑨ 没历史时三条都显式跳过，不是「判过且没事」
    const r7 = run({ command: 'npm run build' }, []);
    say(r7.skipped.length === ccRules.length, 'cross-call：没有历史时全部显式跳过（' + r7.skipped.length + '/' + ccRules.length + '）');
  } catch (e) { say(false, 'cross-call 用例抛错：' + e.message); }

  // 按判据统计：命中从账本聚合，误报是人标的，建议按三件事给
  try {
    const L2 = require(path.join(ENGINE_DIR, 'ledger.js'));
    const tmpDir = path.join(process.env.TEMP || process.env.TMP || '.', 'wr-stats-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const lp2 = path.join(tmpDir, 'ledger.jsonl');
    const line = (id, action) => JSON.stringify({ ts: L2.nowIso(), tool: 'pwsh', action, rules: [id] });
    fs.writeFileSync(lp2, [line('T-A', 'warn'), line('T-A', 'warn'), line('T-A', 'warn'), line('T-A', 'warn'), line('T-A', 'warn'), line('T-B', 'block')].join('\n') + '\n', 'utf8');
    let rs2 = L2.ruleStats(lp2);
    const a2 = rs2.find((x) => x.id === 'T-A');
    say(a2 && a2.hits === 5 && a2.fps === 0, '统计：账本里 5 行 T-A → 命中记 5、误报 0');
    say(a2 && a2.advice.indexOf('该留') === 0, '统计：命中多、没误报 → 建议留着');
    L2.markFalsePositive(lp2, 'T-A', '这次是有意为之');
    L2.markFalsePositive(lp2, 'T-A', '同上');
    L2.markFalsePositive(lp2, 'T-A', '同上');
    rs2 = L2.ruleStats(lp2);
    const a3 = rs2.find((x) => x.id === 'T-A');
    say(a3 && a3.fps === 3 && a3.advice.indexOf('该降') === 0, '统计：标 3 次误报（占 100%）→ 建议降级');
    say(fs.existsSync(L2.fpFile(lp2)), '误报账落在账本同目录（fp-marks.json）');
    L2.markFalsePositive(lp2, 'T-C', '一次都没命中就被标误报');
    const c3 = L2.ruleStats(lp2).find((x) => x.id === 'T-C');
    say(c3 && c3.hits === 0 && c3.advice.indexOf('该撤') === 0, '统计：只被标误报、从没命中过 → 建议撤');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    say(false, '统计：按判据出建议这一组跑不起来（' + e.message + '）');
  }

  // mine：引擎在、能出草案（不碰使用者的真实数据，临时造三条）
  try {
    const M = require(path.join(ENGINE_DIR, 'mine.js'));
    const tmpM = path.join(__dirname, '_selftest-mine.json');
    fs.writeFileSync(tmpM, JSON.stringify([
      { tool: 'write', args: { file_path: 'a.bat', content: 'echo 中文一' } },
      { tool: 'write', args: { file_path: 'b.bat', content: 'echo 中文二' } },
      { tool: 'write', args: { file_path: 'c.bat', content: 'echo 中文三' } },
    ]), 'utf8');
    let mr;
    try {
      mr = M.mine({ dir: tmpM, min: 3, maxFiles: 0 });
    } finally {
      try { fs.unlinkSync(tmpM); } catch { /* 忽略 */ }
    }
    const d = (mr.drafts || []).find((x) => x.id === 'MINE-BAT-CJK-01');
    const cov = (mr.covered || []).find((x) => x.shape === 'MINE-BAT-CJK-01');
    say(mr.calls === 3 && !d && !!cov && (cov.by || []).indexOf('WIN-BAT-CJK-01') >= 0,
      'mine：3 条 bat 写中文 → 实判发现已有 WIN-BAT-CJK-01，不出重复草案 ' + (cov ? '（covered by ' + cov.by.join(',') + '）' : ''));
    // 规则目录里没有管这件事的判据时，草案要照样出
    const emptyDir = path.join(__dirname, '_selftest-rules-empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    fs.writeFileSync(tmpM, JSON.stringify([
      { tool: 'write', args: { file_path: 'a.bat', content: 'echo 中文一' } },
      { tool: 'write', args: { file_path: 'b.bat', content: 'echo 中文二' } },
      { tool: 'write', args: { file_path: 'c.bat', content: 'echo 中文三' } },
    ]), 'utf8');
    let mr2;
    try {
      mr2 = M.mine({ dir: tmpM, min: 3, maxFiles: 0, rulesDir: emptyDir });
    } finally {
      try { fs.unlinkSync(tmpM); } catch { /* 忽略 */ }
      try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    const d2 = (mr2.drafts || []).find((x) => x.id === 'MINE-BAT-CJK-01');
    say(!!d2 && d2.action === 'warn' && !!d2.selfTest && !!d2.selfTest.cases,
      'mine：规则目录里没人管这件事 → 起草案 ' + (d2 ? d2.id + '（' + d2.action + '）' : '（没出来）'));
  } catch (e) {
    say(false, 'mine 抛错：' + e.message);
  }

  // schema：工具定义转契约表（纯函数，不写盘）
  try {
    const r = SCH.convert({
      tools: [
        { name: 'read_file', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
        { name: 'fetch', inputSchema: { type: 'object', properties: { url: { type: 'string' }, urls: { type: 'array' } }, anyOf: [{ required: ['url'] }, { required: ['urls'] }] } },
      ],
    }, { source: 'selftest' });
    const okReq = Array.isArray(r.params.req.read_file) && r.params.req.read_file[0] === 'file_path';
    const okAny = Array.isArray(r.params.anyOf.fetch) && r.params.anyOf.fetch[0] === 'url|urls';
    const okGen = !!(r.schema.tools.fetch) && JSON.stringify(r.schema.tools.fetch.anyOf) === '[["url","urls"]]';
    say(r.stats.tools === 2 && okReq && okAny && okGen, 'schema：2 个工具定义 → 必填与互斥必填都转对');
  } catch (e) {
    say(false, 'schema 抛错：' + e.message);
  }

  // 记账与脱敏
  const tmp = path.join(__dirname, '_selftest-ledger.jsonl');
  try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  LED.record(tmp, { session: 'cli-selftest', tool: 'pwsh', rules: ['WIN-ENC-01'], action: 'block',
    reason: '测试', args: { command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789" https://x.com?token=abc123' } });
  const raw = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : '';
  say(!/sk-abcdefghijklmnopqrstuvwxyz0123456789|token=abc123/.test(raw), '记账脱敏（密钥不原样落盘）');
  try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch { /* 忽略 */ }

  console.log(bad === 0 ? '\n自检：全部通过（' + total + ' 项）' : '\n自检：失败 ' + bad + ' / ' + total + ' 项');
  return bad === 0 ? 0 : 3;
}

const CONFIG_NAME = '.weakreferee.json';

/* 陌生人第一步：在当前目录落一份配置，之后不用每次敲一长串参数 */
function cmdInit() {
  const target = path.join(process.cwd(), CONFIG_NAME);
  if (fs.existsSync(target)) {
    console.error('已经有一份配置了：' + target);
    console.error('要重建就先把它改名或删掉——不覆盖，免得把你填过的忽略清单冲掉');
    return 3;
  }
  const tpl = {
    '_说明': '命令行 > 这份配置 > 默认值；相对路径按本文件所在目录算',
    'rules': null,
    'contract': null,
    'shell': 'powershell-5.1',
    'ledger': null,
    'ignore': { 'rules': [], 'fingerprints': [] },
  };
  try {
    fs.writeFileSync(target, JSON.stringify(tpl, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.error('写不进去：' + e.message);
    return 3;
  }
  console.log('写好了：' + target);
  console.log('下一步：weakreferee check pwsh "command=..."（不用再带 --rules / --contract）');
  console.log('某条老误报：把规则编号填进 ignore.rules；只想关一条就填指纹（--json 里每条都能算）');
  return 0;
}

/* 配置生效得能看见——改了配置但命令还是老行为，是最难查的那种错 */
function cmdConfig() {
  const L = [];
  L.push('配置文件：' + (CFG.path || '（没找到，用的是默认值）'));
  L.push('规则包目录：' + (resolveRulesDir() || '（缺失）'));
  L.push('契约表目录：' + (resolveContractDir() || '（缺失）'));
  L.push('shell：' + (process.env.DSH_JUDGE_SHELL || 'powershell-5.1'));
  L.push('账本：' + (flagValue('--ledger') || cfgPath('ledger') || '（不记）'));
  const ig = collectIgnore();
  L.push('忽略规则 ' + ig.rules.size + ' 条：' + (Array.from(ig.rules).join(', ') || '无'));
  L.push('忽略指纹 ' + ig.fingerprints.size + ' 条：' + (Array.from(ig.fingerprints).join(', ') || '无'));
  if (!CFG.path) { L.push(''); L.push('要建一份：weakreferee init'); }
  console.log(L.join('\n'));
  return 0;
}

/* fp：人判一条误报。标够 3 次、占比够高，stats 会建议把它降成只提示 */
function cmdFp(args) {
  const positional = splitArgs(args);
  const id = positional[1];
  if (!id) {
    console.error('用法：weakreferee fp <判据号> [--note "为什么是误报"] [--ledger <账本>]');
    return 3;
  }
  const lp = flagValue('--ledger') || cfgPath('ledger') || path.join(process.cwd(), 'judge-ledger.jsonl');
  const r = LED.markFalsePositive(path.resolve(lp), id, flagValue('--note') || '');
  console.log('记下误报：' + r.id + '，这条判据累计 ' + r.n + ' 次');
  console.log('  误报账：' + r.file);
  const me = LED.ruleStats(path.resolve(lp)).find((x) => x.id === r.id);
  if (me) {
    console.log('  目前：命中 ' + me.hits + ' 次、误报 ' + me.fps + ' 次（占 ' + Math.round(me.ratio * 100) + '%）');
    console.log('  建议：' + me.advice);
  }
  return 0;
}

/* stats：一条命令看每条判据的命中与误报，以及该加还是该降 */
function cmdStats(args) {
  const lp = flagValue('--ledger') || cfgPath('ledger') || path.join(process.cwd(), 'judge-ledger.jsonl');
  const file = path.resolve(lp);
  if (!fs.existsSync(file)) {
    console.log('没有账本：' + file);
    console.log('账本要自己开：weakreferee check <工具> key=value --ledger <文件>；插件侧记在拦截.tsv 旁边。');
    return 0;
  }
  const rows = LED.ruleStats(file);
  if (!rows.length) {
    console.log('账本里还没有任何判据命中记录。');
    return 0;
  }
  console.log('账本：' + file);
  console.log('');
  console.log('  命中  误报  占比   判据                      建议');
  for (const x of rows) {
    const pct = (Math.round(x.ratio * 100) + '%').padStart(4);
    console.log('  ' + String(x.hits).padStart(4) + '  ' + String(x.fps).padStart(4) + '  ' + pct + '  ' + x.id.padEnd(24) + '  ' + x.advice);
  }
  const up = rows.filter((x) => x.advice.indexOf('该降') === 0 || x.advice.indexOf('该撤') === 0);
  if (up.length) {
    console.log('');
    console.log('要动的：' + up.map((x) => x.id).join(', ') + '（改动前先跑 selftest）');
  }
  return 0;
}

function cmdMine(args) {
  let eng;
  try {
    eng = require(path.join(ENGINE_DIR, 'mine.js'));
  } catch (e) {
    console.error('失败：找不到 engine/mine.js（' + e.message + '）');
    return 3;
  }
  const positional = splitArgs(args);          // positional[0] 是 'mine'
  const dirArg = positional[1];
  const defDir = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'sessions') : null;
  const target = dirArg || defDir;
  if (!target) {
    console.error('失败：没给目录，也没设 DSH_HOME。用法：weakreferee mine <会话目录或 json 文件>');
    return 3;
  }
  let r;
  try {
    r = eng.mine({
      dir: target,
      min: Number(flagValue('--min') || 3),
      maxFiles: Number(flagValue('--max-files') || 0),
    });
  } catch (e) {
    if (e.code === 'NODIR') {
      console.error('失败：' + e.message);
      console.error('DSH 的会话文件一般在 %DSH_HOME%\\sessions；也可以直接喂一个 json 文件，格式 [{"tool":"pwsh","args":{"command":"..."}}]');
      return 3;
    }
    console.error('失败：' + e.message);
    return 3;
  }

  if (hasFlag('--json')) {
    console.log(JSON.stringify({ source: r.source, files: r.files, filesRead: r.filesRead, calls: r.calls, tools: r.tools, rows: r.rows, drafts: r.drafts }, null, 2));
    return 0;
  }

  console.log(eng.renderReport(r));

  const packDir = flagValue('--pack');
  if (packDir) {
    if (!r.drafts.length) {
      console.log('');
      console.log('没有能出的草案，不写包（次数不到 ' + r.min + ' 次，或这些形态已经有人管）');
    } else {
      const out = path.resolve(packDir);
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'pack.json'), JSON.stringify(r.pack, null, 2) + '\n', 'utf8');
      fs.writeFileSync(path.join(out, 'rules.json'), JSON.stringify(r.drafts, null, 2) + '\n', 'utf8');
      console.log('');
      console.log('已写出包目录：' + out);
      console.log('  里面是 pack.json 与 rules.json，草案 ' + r.drafts.length + ' 条，全部 warn。');
      console.log('  自查：node tools/validate.js ' + out);
      console.log('  装进本机：node dsh-judge-gate/tools/judge-packs.cjs add mined（先把目录放进 dsh-judge-gate/rules/）');
    }
  }

  if (hasFlag('--write')) {
    const outDir = process.cwd();
    const md = path.join(outDir, 'mine-report.md');
    const js = path.join(outDir, 'mine-rules.json');
    fs.writeFileSync(md, '# 弱裁判 mine 报告\n\n```\n' + eng.renderReport(r) + '\n```\n', 'utf8');
    fs.writeFileSync(js, JSON.stringify(r.drafts, null, 2) + '\n', 'utf8');
    console.log('');
    console.log('已写出：');
    console.log('  ' + md);
    console.log('  ' + js + (r.drafts.length ? '' : '（空数组：这次没有能出的草案）'));
    if (r.drafts.length) {
      console.log('');
      console.log('草案默认 action=warn，只提示不拦；确认有用再改成 block，然后放进 rules/ 里一份新包。');
    }
  }
  return 0;
}

/* scan：亲友版体检。找一个 AI 客户端的历史记录，按现有判据重判一遍，出一页人话报告。
 * 与 replay 的区别只在于「说给谁听」：replay 给写判据的人看拦截率，scan 给不懂术语的人看该改哪。 */
function cmdScan(args) {
  let eng;
  try {
    eng = require(path.join(ENGINE_DIR, 'scan.js'));
  } catch (e) {
    console.error('失败：找不到 engine/scan.js（' + e.message + '）');
    return 3;
  }
  const st = loadAll();
  if (st.error) { console.error('失败：' + st.error); return 3; }

  const positional = splitArgs(args);          // positional[0] 是 'scan'
  const target = positional[1];
  let r;
  try {
    r = eng.scan({
      target,
      rules: st.rules,
      maxFiles: Number(flagValue('--max-files') || 0) || 0,
    });
  } catch (e) {
    console.error('失败：' + (e && e.message ? e.message : e));
    return 3;
  }

  if (hasFlag('--json')) {
    console.log(JSON.stringify({
      version: VERSION,
      empty: r.empty,
      files: r.files, filesRead: r.filesRead, probed: r.probed,
      span: r.span, stat: r.stat, rows: r.rows,
      pitCalls: r.pitCalls, internalCalls: r.internalCalls, internalHits: r.internalHits,
      reconcile: r.reconcile, scrubbed: r.scrubbed, rulesLoaded: r.rulesLoaded,
      report: r.report,
    }, null, 2));
    return 0;
  }

  console.log(r.report);

  const outArg = flagValue('--out');
  if (outArg || hasFlag('--write')) {
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const p = path.resolve(process.cwd(), outArg || ('弱裁判体检报告-' + stamp + '.txt'));
    try {
      fs.writeFileSync(p, r.report + '\n', 'utf8');
      console.log('');
      console.log('这份报告也存了一份：' + path.basename(p));
    } catch (e) {
      console.log('');
      console.log('报告存不下来（' + e.message + '），上面这份照样能看');
    }
  }
  return 0;
}

/* suggest：别人给的一条判据，先在你自己的历史上跑一遍——它到底会拦住什么，看得见再决定收不收。
 * 不收的理由常常不是「没命中」，而是「命中的那些其实是对的」。 */
function cmdSuggest(args) {
  const positional = splitArgs(args);
  const fileArg = positional[1];
  if (!fileArg) {
    console.error('用法：weakreferee suggest <规则文件.json> [--from <会话目录或 json>] [--apply <包目录>]');
    return 3;
  }
  const rulePath = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(rulePath)) {
    console.error('失败：找不到这个文件：' + rulePath);
    return 3;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(rulePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error('失败：规则文件不是合法 JSON（' + e.message + '）');
    return 3;
  }
  const incoming = Array.isArray(raw) ? raw : (Array.isArray(raw.rules) ? raw.rules : [raw]);
  const valid = [];
  const bad = [];
  for (const r of incoming) {
    const miss = ['id', 'title', 'when', 'action', 'condition'].filter((k) => !r || r[k] === undefined);
    if (miss.length) bad.push({ id: (r && r.id) || '(无 id)', miss });
    else valid.push(r);
  }
  console.log('规则文件：' + rulePath);
  console.log('  读到 ' + incoming.length + ' 条，可用 ' + valid.length + ' 条' +
    (bad.length ? '，缺字段 ' + bad.length + ' 条' : ''));
  bad.forEach((b) => console.log('    跳过 ' + b.id + '：缺 ' + b.miss.join('/')));
  if (!valid.length) return 3;

  const defDir = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'sessions') : null;
  const target = flagValue('--from') || defDir;
  if (!target) {
    console.error('失败：没给 --from，也没设 DSH_HOME。用法：suggest <规则> --from <会话目录或 json>');
    return 3;
  }
  let eng;
  try {
    eng = require(path.join(ENGINE_DIR, 'mine.js'));
  } catch (e) {
    console.error('失败：找不到 engine/mine.js（' + e.message + '）');
    return 3;
  }
  let data;
  try {
    data = eng.collectCalls(target, Number(flagValue('--max-files') || 0));
  } catch (e) {
    console.error('失败：' + e.message);
    if (e.code === 'NODIR') console.error('DSH 的会话一般在 %DSH_HOME%\\sessions；也能直接喂 [{tool,args}] 的 json');
    return 3;
  }
  console.log('回放数据：' + data.filesRead + ' 份记录、' + data.calls.length + ' 次调用');
  console.log('');

  const wanted = Number(flagValue('--min-hits') || 1);
  const keep = [];
  for (const r of valid) {
    let hits = 0;
    const samples = [];
    for (const c of data.calls) {
      let hs;
      try {
        hs = J.judge({ when: 'tool:pre', tool: c.tool, args: c.args }, [r]);
      } catch (e) {
        hs = [];
      }
      if (hs && hs.length) {
        hits++;
        if (samples.length < 3) {
          const brief = JSON.stringify(c.args || {});
          samples.push(c.tool + ' ' + (brief.length > 140 ? brief.slice(0, 140) + '…' : brief));
        }
      }
    }
    const pct = data.calls.length ? ((hits / data.calls.length) * 100).toFixed(2) : '0.00';
    console.log('  ' + r.id + '  ' + (r.title || ''));
    console.log('    命中 ' + hits + ' / ' + data.calls.length + '（' + pct + '%）' +
      (hits < wanted ? '  ← 低于 --min-hits 的要求，建议先别收' : ''));
    samples.forEach((s, i) => console.log('      ' + (i + 1) + '. ' + s));
    if (!hits) console.log('      （一次都没命中：这条在你这里是死规矩，收进来只是多一份没人看的东西）');
    if (hits) keep.push(r);
  }
  console.log('');
  console.log('怎么判：先看上面几个样例是不是真的有问题。样例都是对的，这条收进来只会烦你自己；');
  console.log('        样例确实会出事，再收——收的动作是加 --apply，写进指定包的 rules.json。');

  const pkgDir = flagValue('--apply');
  if (pkgDir) {
    const p = path.resolve(process.cwd(), pkgDir);
    let target2 = p;
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) target2 = path.join(p, 'rules.json');
    if (!fs.existsSync(target2)) {
      console.error('失败：找不到要写入的 rules.json（' + target2 + '）');
      return 3;
    }
    const arr = JSON.parse(fs.readFileSync(target2, 'utf8'));
    let added = 0;
    let skipped = 0;
    for (const r of keep) {
      if (arr.some((x) => x.id === r.id)) { skipped++; continue; }
      arr.push(r);
      added++;
    }
    fs.writeFileSync(target2, JSON.stringify(arr, null, 2) + '\n', 'utf8');
    console.log('');
    console.log('写入 ' + target2 + '：新增 ' + added + ' 条，跳过已有 ' + skipped + ' 条，现在共 ' + arr.length + ' 条');
    console.log('别忘了跑一次 weakreferee selftest，看有没有写坏。');
  }
  return 0;
}

/* 把任何一家模型的工具定义转成契约表三件套。
 * 判据里那四百多条参数形态是按契约表长出来的，契约表换了，这些判据就跟着换人。*/
function cmdSchema(argv) {
  const pos = splitArgs(argv.slice(1));
  const target = pos[0];
  if (!target) {
    console.error('用法：weakreferee schema <工具定义.json> [--out 目录] [--force]');
    console.error('支持：MCP {tools:[{name,inputSchema}]}、OpenAI {tools:[{function:{name,parameters}}]}、');
    console.error('      Claude {tools:[{name,input_schema}]}、手写 {工具名: schema}');
    return 3;
  }
  const p = path.resolve(process.cwd(), target);
  if (!fs.existsSync(p)) {
    console.error('失败：找不到文件 ' + p);
    return 3;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error('失败：工具定义不是合法 JSON（' + e.message + '）');
    return 3;
  }
  const r = SCH.convert(raw, { source: path.basename(p) });
  if (!r.stats.tools) {
    console.error('失败：没从这份文件里认出任何工具定义。');
    console.error('要的是「工具名 + 参数 schema」，不是对话记录或调用日志。');
    return 3;
  }
  const outDir = path.resolve(process.cwd(), flagValue('--out') || 'contract');
  const files = {
    'tool-params.json': r.params,
    'tool-schema.json': r.schema,
    'tool-types.json': r.types,
  };
  if (!hasFlag('--force')) {
    const existing = fs.existsSync(outDir)
      ? fs.readdirSync(outDir).filter((f) => files[f])
      : [];
    if (existing.length) {
      console.error('失败：' + outDir + ' 里已经有 ' + existing.join('、'));
      console.error('加 --force 覆盖它们，或者用 --out 换个目录。');
      return 3;
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
  const s = r.stats;
  console.log('认出 ' + s.tools + ' 个工具：有必填键的 ' + s.withRequired + ' 个，封闭 schema 的 ' + s.closed + ' 个');
  console.log('类型 ' + s.typedKeys + ' 个键（其中枚举 ' + s.enumKeys + ' 个），形近错键候选涉及 ' + s.wrongkeyTools + ' 个工具');
  console.log('已写入 ' + outDir + '：tool-params.json、tool-schema.json、tool-types.json');
  console.log('下一步：weakreferee check <工具名> key=value --contract "' + outDir + '"');
  return 0;
}

function cmdHelp() {
  console.log([
    '弱裁判命令行 v' + VERSION,
    '',
    '用法：',
    '  weakreferee init                                         在当前目录写一份 .weakreferee.json',
    '  weakreferee check <工具名> key=value [key2=value2 ...]   判一次调用',
    '  weakreferee mine [目录|文件]                             从自己的会话记录里统计形态、出草案判据',
    '  weakreferee scan [目录|文件]                             体检：翻历史记录，出一页人话报告（亲友版）',
    '  weakreferee suggest <规则文件>                           别人给的判据，先在你自己的记录上回放一遍',
    '  weakreferee schema <工具定义.json>                       别的模型的工具定义，转成契约表三件套',
    '  weakreferee replay [目录|文件]                           把历史调用按现有判据重判，看这套规矩能拦多少',
    '  weakreferee trace [目录] [--max-files N] [--rules 文件]    带成败重放：跨调用判据会不会乱报（--rules 默认 cross-call）',
    '  weakreferee packs                                        看装了哪些包、多少条',
    '  weakreferee config                                       看这次实际用的配置（含忽略清单）',
    '  weakreferee selftest                                     自检（装载/冒烟/记账）',
    '',
    '选项：',
    '  --json              输出机器可读 JSON',
    '  --rules <目录>      规则包目录（默认：本文件旁边的 rules/）',
    '  --contract <目录>   工具契约表目录（默认：本文件旁边的 contract/）',
    '  --shell <名字>      判据的 shell 环境（默认 powershell-5.1）',
    '  --ledger <文件>     把这次判定追加记进账本（默认不记）',
    '  --ignore-rule <编号> 临时关掉某条规则（可逗号分隔、可重复）',
    '  --no-config         不读 .weakreferee.json',
    '  --min <次数>        mine：形态命中达到几次才提（默认 3）',
    '  --max-files <个数>  mine：只读最大的前 N 个文件（默认全读）',
    '  --write             mine：把报告与草案写到当前目录；scan：把体检报告存成 txt',
    '  --pack <目录>       mine：把草案直接写成一个可装的包（pack.json + rules.json）',
    '  fp <判据号>         记一次误报（--note 写原因；连 3 次占比够高，stats 会建议降级）',
    '  stats               每条判据的命中与误报，给出该加该降',
    '  --from <目录|文件>  suggest：拿哪份记录回放（默认 %DSH_HOME%\\sessions）',
    '  --min-hits <次数>   suggest：命中少于几次就建议别收（默认 1）',
    '  --apply <包目录>    suggest：把判断过、命中过的规则写进那个包的 rules.json',
    '  --out <目录>        schema：契约表写到哪（默认当前目录下的 contract）；scan：报告写到哪个文件',
    '  --force             schema：目录里已有同名文件时覆盖',
    '',
    '例子：',
    '  weakreferee check pwsh "command=Out-File D:\\a.ps1 -InputObject 中文"',
    '  weakreferee check write "file_path=D:\\a.ps1" "content=中文正文"',
    '  weakreferee check pwsh "command=Remove-Item D:\\old -Recurse" --json',
    '',
    '退出码：0 通过 / 1 拦下 / 2 提示 / 3 判不了',
  ].join('\n'));
  return 0;
}

/* ─────────────────────────────────────────────
 * 六、入口
 * ───────────────────────────────────────────── */
/* 分词：带值的选项连同它的值一起摘掉，剩下的才是位置参数。
 * 不用「过滤 -- 开头的 token」那种写法——它会把值恰好也以 -- 开头的参数误删，
 * 命令里 "--execute" 这类真值就丢了。 */
const VALUED_OPTS = new Set(['--shell', '--rules', '--contract', '--ledger', '--ignore-rule', '--min', '--max-files', '--from', '--apply', '--min-hits', '--out']);
function splitArgs(tokens) {
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (VALUED_OPTS.has(t)) { i++; continue; }      // 连值一起跳过
    if (t.startsWith('--')) continue;
    positional.push(t);
  }
  return positional;
}

function main() {
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return cmdHelp();
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') { console.log(VERSION); return 0; }
  // 配置坏了就停下：拿半份配置继续判，比不判更危险（会按默认值静默跑出「通过」）
  if (CFG.error) { console.error('失败：' + CFG.error); return 3; }
  if (cmd === 'init') return cmdInit();
  if (cmd === 'config') return cmdConfig();
  if (cmd === 'mine') return cmdMine(argv);
if (cmd === 'fp') return cmdFp(argv);
if (cmd === 'stats') return cmdStats(argv);
  if (cmd === 'scan') return cmdScan(argv);
  if (cmd === 'suggest') return cmdSuggest(argv);
  if (cmd === 'schema') return cmdSchema(argv);
  if (cmd === 'replay') return cmdReplay(argv);
  if (cmd === 'trace') return cmdTrace(argv);
  if (cmd === 'check') return cmdCheck(splitArgs(argv.slice(1)));
  if (cmd === 'packs') return cmdPacks();
  if (cmd === 'selftest') return cmdSelftest();
  console.error('不认识的子命令：' + cmd + '（用 --help 看用法）');
  return 3;
}

process.exitCode = main();
