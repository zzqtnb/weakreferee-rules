// 包管理器：装之前先体检 + 跑自测，不过就不让装
//
// 设计要点
//   1. 逐条隔离自测 —— 只装这一条跑，别的规矩不许干扰（否则 shouldPass 可能被别人拦下）
//   2. 用 judgeRaw 不用 judge —— 自测验「规矩写得对不对」，不是验「本环境适不适用」，
//      走 judge 会让不适用的包全部跳过而「全过」
//   3. needFs 的规矩不假装跑过 —— 明说「需集成验证」，既不阻塞安装也不谎报通过
//   4. 拒装理由说人话 —— 「第 3 条规矩自测没过：该拦的例子没拦住」比 "case[0] failed" 有用
const fs = require('fs');
const path = require('path');
const J = require('./judge.js');

const FIELD_OF_TOOL = {
  write: a => ({ file_path: a.file_path, content: a.content }),
  edit: a => ({ file_path: a.file_path, old_string: a.old_string, new_string: a.new_string }),
  web_fetch: a => ({ url: a.url, urls: a.urls }),
};

function toolOf(rule) {
  const a = rule.appliesTo || {};
  const t = a.tools || (a.tool ? [a.tool] : null);
  if (!t || t.includes('*')) return '*';
  return t[0];
}

function mkCall(rule, args, extra) {
  const call = {
    when: rule.when || 'tool:pre',
    tool: (extra && typeof extra.tool === 'string' && extra.tool) || toolOf(rule),
    args: args || {},
  };
  // 跨调用判据的用例要自带「前几次调用」：不给就永远判不出来，
  // 于是这类规则在静态校验里只能写「缺该拦的用例」，等于没人测它。
  if (extra && Array.isArray(extra.history)) call.history = extra.history;
  if (extra && typeof extra.at === 'number') call.at = extra.at;
  if (extra && typeof extra.replyText === 'string') call.replyText = extra.replyText;
  return call;
}

// ── 单条规矩自测 ──────────────────────────────
function selftestRule(rule) {
  const st = rule.selfTest || {};
  const cases = Array.isArray(st.cases) ? st.cases : [];
  const out = { id: rule.id, ran: 0, failed: [], needFs: !!st.needFs, noCases: cases.length === 0 && !st.needFs };

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (!c || typeof c !== 'object' || !c.args || !c.expect) {
      out.failed.push({ i, why: '用例格式不对：要 {args, expect:"block"|"pass"}' });
      continue;
    }
    out.ran++;
    const hits = J.judgeRaw(mkCall(rule, c.args, c), [rule]);

    const errored = hits.find(h => h.error);
    if (errored) {
      out.failed.push({ i, why: '条件执行抛错：' + errored.error, args: c.args, expect: c.expect });
      continue;
    }
    const hit = hits.length > 0;
    if (c.expect === 'block' && !hit) {
      out.failed.push({ i, why: '该拦的例子没拦住', args: c.args });
    } else if (c.expect === 'pass' && hit) {
      out.failed.push({ i, why: '该放行的例子被拦了', args: c.args });
    }
  }
  return out;
}

// ── 整包自测 ──────────────────────────────────
function selftestPack(packDir) {
  const rules = readPackRules(packDir);
  const details = [];
  let ran = 0, bad = 0;
  const needFs = [], untested = [];

  for (const r of rules) {
    if (r.generator) continue;                     // 生成器声明不是规矩，自测由展开后覆盖
    const d = selftestRule(r);
    details.push(d);
    ran += d.ran;
    if (d.failed.length) bad++;
    if (d.needFs) needFs.push(r.id);
    if (d.noCases) untested.push(r.id);
  }

  return {
    pack: path.basename(packDir),
    rules: rules.filter(r => !r.generator).length,
    casesRan: ran,
    failedRules: details.filter(d => d.failed.length),
    needFs,
    untested,
    ok: bad === 0,
    details,
  };
}

function readPackRules(packDir) {
  // pack.json 是包的元数据（rules 字段是条数，不是数组），不参与规则读取
  const files = fs.readdirSync(packDir).filter(f => f.endsWith('.json') && f.toLowerCase() !== 'pack.json');
  const out = [];
  for (const f of files) {
    const p = path.join(packDir, f);
    let j;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
      out.push({ id: '(坏文件) ' + f, selfTest: {}, condition: null, __error: String(e.message) });
      continue;
    }
    const arr = Array.isArray(j) ? j : (Array.isArray(j.rules) ? j.rules : []);
    for (const r of arr) out.push(r);
  }
  return out;
}

// ── 体检报告（装之前先看）──────────────────────
function inspect(packDir) {
  const rules = readPackRules(packDir);
  const real = rules.filter(r => !r.generator);
  const env = J.ENV;

  const perRule = real.map(r => {
    const a = r.appliesTo || {};
    const plat = Array.isArray(a.platform) ? a.platform : null;
    const shell = Array.isArray(a.shell) ? a.shell : null;
    const st = r.selfTest || {};
    const cases = Array.isArray(st.cases) ? st.cases : [];
    return {
      id: r.id,
      legacy: r.legacyJudge || '',
      action: r.action || '',
      appliesHere: (!plat || plat.includes(env.platform)) && (!shell || shell.includes(env.shell)),
      hasEvidence: !!(r.evidence && r.evidence.hits > 0),
      hits: (r.evidence && r.evidence.hits) || 0,
      cases: cases.length,
      needFs: !!st.needFs,
      regexCount: countRegex(r.condition),
    };
  });

  return {
    pack: path.basename(packDir),
    dir: packDir,
    env,
    rules: real.length,
    generatedBy: rules.filter(r => r.generator).map(r => r.id),
    appliedHere: perRule.filter(x => x.appliesHere).length,
    withEvidence: perRule.filter(x => x.hasEvidence).length,
    withCases: perRule.filter(x => x.cases > 0).length,
    // 从没命中过的规矩要单独列出来：可能是多余的，也可能只是还没遇到。
    // 不列出来，包会越装越胖而没人发现有一半规矩在睡觉。
    noEvidence: perRule.filter(x => !x.hasEvidence).map(x => x.id),
    needFs: perRule.filter(x => x.needFs).map(x => x.id),
    noCases: perRule.filter(x => !x.needFs && x.cases === 0).map(x => x.id),
    totalRegex: perRule.reduce((n, x) => n + x.regexCount, 0),
    totalHits: perRule.reduce((n, x) => n + x.hits, 0),
    perRule,
  };
}

function countRegex(c) {
  if (!c) return 0;
  if (Array.isArray(c.all)) return c.all.reduce((n, x) => n + countRegex(x), 0);
  if (Array.isArray(c.any)) return c.any.reduce((n, x) => n + countRegex(x), 0);
  if (c.not) return countRegex(c.not);
  return (c.type === 'regexHit' || c.type === 'regexMiss' || c.type === 'cmdAbsPathWritten') ? 1 : 0;
}

function formatInspection(rep) {
  const L = [];
  L.push('包：' + rep.pack);
  L.push('  规矩 ' + rep.rules + ' 条（其中生成器 ' + rep.generatedBy.length + ' 个：' + (rep.generatedBy.join(', ') || '无') + '）');
  L.push('  当前环境：' + rep.env.platform + ' / ' + rep.env.shell + ' / ' + rep.env.host);
  L.push('  本环境会生效：' + rep.appliedHere + ' / ' + rep.rules + ' 条' + (rep.appliedHere < rep.rules ? '（其余在本机不生效，属正常）' : ''));
  L.push('  带实测证据：' + rep.withEvidence + ' / ' + rep.rules + ' 条（合计命中 ' + rep.totalHits + ' 次）');
  L.push('  带可跑用例：' + rep.withCases + ' 条；需集成验证：' + (rep.needFs.length || 0) + ' 条；一条用例都没有：' + (rep.noCases.length || 0) + ' 条');
  L.push('  正则总数：' + rep.totalRegex);
  if (rep.noCases.length) L.push('  ⚠ 没有用例（装前无法自动验证）：' + rep.noCases.join(', '));
  if (rep.needFs.length) L.push('  ⚠ 需集成验证（要真实文件，装前只能人工核）：' + rep.needFs.join(', '));
  if (rep.noEvidence.length) L.push('  · 从没命中过（可能是多余的，也可能只是还没遇到）：' + rep.noEvidence.join(', '));
  return L.join('\n');
}

// ── 版本比对 ──────────────────────────────────
// 同一批规矩，旧版 vs 新版：新增 / 删除 / 改了判定条件 / 只改了文案
function comparePacks(oldDir, newDir) {
  const A = indexById(readPackRules(oldDir));
  const B = indexById(readPackRules(newDir));
  const added = [], removed = [], changed = [], same = [];

  for (const id of new Set([...A.keys(), ...B.keys()])) {
    const a = A.get(id), b = B.get(id);
    if (a && !b) removed.push(id);
    else if (!a && b) added.push(id);
    else if (JSON.stringify(a.condition) !== JSON.stringify(b.condition) || a.action !== b.action) changed.push(id);
    else same.push(id);
  }
  return { added, removed, changed, same };
}

function indexById(rules) {
  const m = new Map();
  for (const r of rules) if (r && r.id) m.set(r.id, r);
  return m;
}

function formatCompare(diff, oldName, newName) {
  const L = [];
  L.push(oldName + ' → ' + newName);
  L.push('  新增 ' + diff.added.length + '：' + (diff.added.join(', ') || '无'));
  L.push('  删除 ' + diff.removed.length + '：' + (diff.removed.join(', ') || '无'));
  L.push('  判定变了 ' + diff.changed.length + '：' + (diff.changed.join(', ') || '无'));
  L.push('  没动 ' + diff.same.length);
  if (diff.changed.length) L.push('  ⚠ 判定变了的规矩要重跑自测：行为改了，旧用例可能不再成立');
  return L.join('\n');
}

module.exports = { selftestRule, selftestPack, inspect, formatInspection, comparePacks, formatCompare, readPackRules };
