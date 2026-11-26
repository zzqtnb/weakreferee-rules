#!/usr/bin/env node
// 结构校验器：只查"写得对不对"，不查"判得准不准"
//
// 判定引擎不在本仓库（它只认 condition.type，不进规则包），所以这里做的是格式守门：
//   · 字段齐不齐、枚举值合不合法、条件类型认不认识
//   · 每条规矩有没有「该拦」和「不该拦」两个自测用例
//   · 包元数据与规矩条数对不对得上
//
// 用法：
//   node tools/validate.js                校验 packs/ 下所有包
//   node tools/validate.js packs/core     只校验一个包
//
// 退出码：0 全过 / 1 有问题

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const WHEN = ['session:start', 'turn:start', 'completion:pre', 'tool:pre', 'tool:post', 'file:post', 'turn:end', 'session:end'];
const ACTION = ['block', 'warn', 'steer', 'default'];
const KIND = ['core', 'platform', 'model', 'host', 'scene', 'cross-call'];
const SEVERITY = ['S', 'A', 'B', 'C'];
const CONDITION = [
  'missingKey', 'emptyValue', 'missingAnyOf', 'wrongKey', 'extraKey', 'typeMismatch', 'argSet',
  'argTypeMismatch',
  'missingFlag', 'regexHit', 'regexMiss', 'fileLacksBom', 'fileHasBom',
  'fileAnchorMissing', 'fileAnchorMultiple', 'fileNewerThan', 'fileNewerThanProcessStart', 'fileExistsBefore',
  'unknownKey', 'pathOutside', 'cmdAbsPathWritten',
  'noCallSince', 'callCountSince', 'calledSince', 'argRepeat',
  'failRepeat', 'failCountSince', 'claimUnbacked',
  'claimCmdUnbacked', 'obligationPending',
];

const problems = [];
const notices = [];

function err(where, msg) { problems.push(`${where}: ${msg}`); }

// ── 条件递归检查 ──────────────────────────────
function checkCondition(where, c, depth) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) { err(where, 'condition 必须是对象'); return; }
  if (c.all !== undefined || c.any !== undefined) {
    const key = c.all !== undefined ? 'all' : 'any';
    if (!Array.isArray(c[key]) || c[key].length === 0) { err(where, `${key} 必须是非空数组`); return; }
    if (depth > 5) { err(where, '条件嵌套超过 5 层'); return; }
    c[key].forEach((sub, i) => checkCondition(`${where}.${key}[${i}]`, sub, depth + 1));
    return;
  }
  if (c.not !== undefined) {
    if (depth > 5) { err(where, '条件嵌套超过 5 层'); return; }
    checkCondition(`${where}.not`, c.not, depth + 1);
    return;
  }
  if (!c.type) { err(where, '叶子条件缺 type'); return; }
  if (!CONDITION.includes(c.type)) { err(where, `未知条件类型 ${c.type}`); return; }
  if (c.type === 'regexHit' || c.type === 'regexMiss') {
    const pat = c.pattern;
    if (typeof pat !== 'string' || !pat) { err(where, `${c.type} 缺 pattern`); return; }
    if (pat.length > 500) { err(where, `正则超过 500 字符（${pat.length}）`); }
    try { new RegExp(pat); } catch (e) { err(where, `正则编译失败：${e.message}`); }
    // 疑似灾难性回溯
    if (/\((?:[^()|]*[+*]|[^()|]{2,})\)\s*[+*{]/.test(pat)) err(where, `正则疑似灾难性回溯：${pat}`);
  }
}

// ── 单条规矩 ─────────────────────────────────
function checkRule(packName, r, seen) {
  const where = `${packName}/${r.id || '(无 id)'}`;
  if (!r.id) { err(where, '缺 id'); return; }
  if (!/^[A-Z][A-Z0-9-]{2,63}$/.test(r.id)) err(where, 'id 须大写字母开头，仅大写字母/数字/连字符');
  if (seen.has(r.id)) err(where, '同包内 id 重复');
  seen.add(r.id);

  if (!r.title || String(r.title).length < 4) err(where, '缺 title 或太短');
  if (r.when && !WHEN.includes(r.when)) err(where, `when 不是合法时点：${r.when}`);
  if (!ACTION.includes(r.action)) err(where, `action 不合法：${r.action}`);
  if (r.severity && !SEVERITY.includes(r.severity)) err(where, `severity 不合法：${r.severity}`);
  if (r.reversible !== undefined && typeof r.reversible !== 'boolean') err(where, 'reversible 必须是布尔');

  const hasGen = !!r.generator;
  if (hasGen) {
    if (!r.generator.kind) err(where, 'generator 缺 kind');
    if (!Array.isArray(r.generator.emit) || !r.generator.emit.length) err(where, 'generator 缺 emit');
  } else if (!r.condition) {
    err(where, '既没有 condition 也没有 generator');
  } else {
    checkCondition(where, r.condition, 0);
  }

  // 自测：至少一个该拦、一个不该拦
  // （生成器规则不测自身：它在装载时展开成若干条具体规矩，测的是展开结果）
  if (hasGen) {
    notices.push(`${where}: 生成器规则，装载时展开，无自身用例`);
  } else if (r.selfTest && r.selfTest.needFs) {
    notices.push(`${where}: needFs，用例依赖真实文件，静态校验跑不了`);
  } else {
    const cases = (r.selfTest && r.selfTest.cases) || [];
    if (!cases.length) err(where, '没有自测用例');
    else {
      const hasHit = cases.some(c => c.expect === 'block');
      const hasPass = cases.some(c => c.expect === 'pass');
      if (!hasHit) err(where, '自测缺「该拦」的用例');
      if (!hasPass) err(where, '自测缺「不该拦」的用例（只测该拦会写出什么都拦的规矩）');
      cases.forEach((c, i) => {
        if (!c.args || typeof c.args !== 'object') err(`${where}.selfTest[${i}]`, 'args 必须是对象');
        if (!['block', 'pass'].includes(c.expect)) err(`${where}.selfTest[${i}]`, `expect 不合法：${c.expect}（expect 表示期望结果，写 block=期望命中、pass=期望放行，与规则的 action 无关）`);
      });
    }
  }

  // 分发到仓库的规矩应该带证据
  if (!r.evidence || (r.evidence.hits === undefined && !r.evidence.source)) {
    notices.push(`${where}: 没有 evidence（体检报告会把它列进「从没命中过」）`);
  }
}

// ── 整包 ─────────────────────────────────────
function checkPack(dir) {
  const name = path.basename(dir);
  const packFile = path.join(dir, 'pack.json');
  const rulesFile = path.join(dir, 'rules.json');

  if (!fs.existsSync(packFile)) { err(name, '缺 pack.json'); return; }
  if (!fs.existsSync(rulesFile)) { err(name, '缺 rules.json'); return; }

  let meta, rules;
  try { meta = JSON.parse(fs.readFileSync(packFile, 'utf8')); } catch (e) { err(`${name}/pack.json`, `JSON 解析失败：${e.message}`); return; }
  try { rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8')); } catch (e) { err(`${name}/rules.json`, `JSON 解析失败：${e.message}`); return; }

  for (const k of ['id', 'name', 'version', 'kind', 'description', 'license', 'rules']) {
    if (meta[k] === undefined) err(`${name}/pack.json`, `缺字段 ${k}`);
  }
  if (meta.kind && !KIND.includes(meta.kind)) err(`${name}/pack.json`, `kind 不合法：${meta.kind}`);
  if (meta.version && !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(meta.version)) err(`${name}/pack.json`, `version 须 1.2.3 形式`);
  if (meta.kind === 'model' && !meta.modelProfile) err(`${name}/pack.json`, 'kind=model 必须带 modelProfile');

  if (!Array.isArray(rules)) { err(`${name}/rules.json`, '顶层必须是数组'); return; }
  if (meta.rules !== undefined && meta.rules !== rules.length) {
    err(`${name}/pack.json`, `rules 写的是 ${meta.rules}，实际 ${rules.length} 条`);
  }
  const seen = new Set();
  rules.forEach(r => checkRule(name, r, seen));
}

// ── 判据库（catalog）──────────────────────────
// 库求全，包求稳。库里的条目允许没有 selfTest，但动作强度受证据等级约束：
//   实测 + 误拦风险 low  → 最多 block
//   文献                → 最多 warn
//   推断                → 最多 steer
//   误拦风险 high        → 最多 steer（不管证据多硬）
// 这条是「库越大越害人」的唯一闸门，不能松。
const DOMAINS = ['params', 'encoding', 'path', 'risky', 'workflow', 'protocol', 'resource'];
const ACTION_RANK = { off: 0, steer: 1, default: 1, warn: 2, block: 3 };
const LEVEL_CAP = { '实测': 'block', '文献': 'warn', '推断': 'steer' };

function capOf(e) {
  // 死线例外（2026-11-22 用户批准破例）：删根目录、格式化磁盘、删整库这类动作
  // 几乎没有正当理由。它们仍然只有文献级依据，但压成"只提示"说不过去，所以允许到 block。
  // 只对显式标了 hardline 的条目生效，不是给整个库开口子。
  if (e.hardline === true) return 'block';
  let cap = LEVEL_CAP[e.evidence.level] || 'steer';
  if (e.falsePositiveRisk === 'high') cap = 'steer';
  if (e.evidence.level === '实测' && e.falsePositiveRisk === 'medium') cap = 'warn';
  return cap;
}

function hasCondRule(e) { return !!(e && (e.condition || e.generator)); }

function checkCatalogEntry(dirName, e, seen) {
  const where = `catalog/${dirName}/${e.id || '(无 id)'}`;
  if (!e.id) { err(where, '缺 id'); return; }
  if (!/^[A-Z][A-Z0-9-]{1,63}$/.test(e.id)) err(where, 'id 须大写字母开头，长度 2–64（J3、P6 这类两位编号也合法）');
  if (seen.has(e.id)) err(where, '库内 id 重复');
  seen.add(e.id);

  if (!e.title || String(e.title).length < 4) err(where, '缺 title 或太短');
  if (!DOMAINS.includes(e.domain)) err(where, `domain 不合法：${e.domain}`);
  if (e.domain !== dirName) err(where, `domain 写的是 ${e.domain}，但放在 catalog/${dirName}/ 下`);
  if (e.when && !WHEN.includes(e.when)) err(where, `when 不合法：${e.when}`);
  if (e.severity && !SEVERITY.includes(e.severity)) err(where, `severity 不合法：${e.severity}`);

  // 三段式（2026-11-23 用户定）：进库的每一条都写四行——判据 / 例子（该拦+不该拦）/ 边界 / 场景例。
  // 别人上传的条目也按这个卡，缺一项就进不了库，不靠看的人自己记得查。
  const noteText = Array.isArray(e.notes) ? e.notes.join('\n') : String(e.notes || '');
  if (!/判据[:：]/.test(noteText)) err(where, 'notes 缺「判据：」一行——这条检查的是什么');
  else if (!/例子/.test(noteText)) err(where, 'notes 缺「例子｜」一行——写一个该拦的、一个不该拦的');
  else if (noteText.includes('该拦') && !noteText.includes('不该拦')) err(where, '例子只有「该拦」，补一条「不该拦」——只测该拦的规则，宽到什么都拦也能全过');
  else if (!/边界[:：]/.test(noteText)) err(where, 'notes 缺「边界：」一行——哪些情况放过');
  // 证据准入线（2026-11-25 用户定，与 pack-intake.js 同一口径）：
  // 至少一个模型真犯过。写得出模型名，本机拦下的写「DSH 模型犯过 N 次」。
  // 纯说明条目（没 condition / generator）只是候选，不卡这条，标 notice。
  {
    // 推断档只当候选，缺模型证据给 notice；实测/文献档或有判定逻辑的必须写出来源。
    const strict = hasCondRule(e) || e.evidence.level !== '推断';
    const testedLine = (Array.isArray(e.notes) ? e.notes : []).find((n) => typeof n === 'string' && n.indexOf('已测') === 0) || '';
    const hasModel = /(qwen|deepseek|glm|kimi|doubao|gpt|claude|gemini|seed|llama|mistral|yi-|ernie|hunyuan|dsh)/i.test(testedLine);
    const hasHit = /犯过|犯：|会犯/.test(testedLine);
    const need = [];
    if (!testedLine) need.push('缺「已测」段（写「已测｜…模型犯过 N 次」）');
    else {
      if (!hasModel) need.push('没写是哪个模型犯的（本机拦下的写「DSH 模型」）');
      if (!hasHit) need.push('没写「犯过」');
    }
    if (need.length) {
      if (strict) err(where, '证据准入线：' + need.join('；') + '——一个模型都没犯过的判据不收');
      else notices.push(where + ': 推断档未实测（' + need.join('；') + '），只当候选');
    }
  }

  if (!e.evidence || !e.evidence.level) { err(where, '缺 evidence.level'); return; }
  if (!['实测', '文献', '推断'].includes(e.evidence.level)) err(where, `evidence.level 不合法：${e.evidence.level}`);
  // level 说的是「依据有多硬」，hits 说的是「这条规矩本身命中几次」，两者可以不一致：
  // 依据是真实事故、但规则是新写的，hits 就是 0。这种要在 source 里写清依据的是什么。
  if (e.evidence.level === '实测' && !e.evidence.hits) {
    notices.push(`${where}: 依据实测但规则本身没命中过（hits=0）——确认 source 写清了依据的是哪次事故`);
  }
  if (e.evidence.level !== '实测' && e.evidence.hits > 0) err(where, '只有实测才能写 hits');

  if (!ACTION_RANK.hasOwnProperty(e.defaultAction)) { err(where, `defaultAction 不合法：${e.defaultAction}`); return; }
  const cap = capOf(e);
  if (ACTION_RANK[e.defaultAction] > ACTION_RANK[cap]) {
    err(where, `动作超上限：${e.evidence.level}+误拦${e.falsePositiveRisk || '未标'} 最多 ${cap}，写的是 ${e.defaultAction}`);
  }

  const hasGen = !!e.generator;
  const hasCond = !!e.condition;
  const docOnly = !hasGen && !hasCond;
  if (hasGen) {
    if (!e.generator.kind) err(where, 'generator 缺 kind');
    if (!Array.isArray(e.generator.emit) || !e.generator.emit.length) err(where, 'generator 缺 emit');
  } else if (hasCond) {
    checkCondition(where, e.condition, 0);
  } else {
    // 纯说明条目（2026-11-23 起）：判定逻辑不复制进库，写在 packs 里，库只讲「检查什么、为什么、怎么救」。
    // 不复制正则就不会出现两份说法；代价是每条必须交代去处，且动作不能凭空比包更硬。
    const notes = Array.isArray(e.notes) ? e.notes.join('') : '';
    if (notes.length < 20) err(where, '纯说明条目必须有 notes（写清检查什么、为什么、怎么救）');
    if (e.defaultAction === 'block' && !e.promotedTo) err(where, '纯说明条目要 block 就必须写 promotedTo（判定在哪条规则里）');
  }

  // 库里允许没有 selfTest，但一旦要 block 就必须有正反例
  if (!hasGen && !docOnly && e.defaultAction === 'block') {
    const st = e.selfTest || {};
    if (st.needFs) {
      // 依赖真实文件的用例静态跑不了，但说明「测过」的意图在——降为提示，但要真环境验一遍
      notices.push(`${where}: block 且依赖真实文件（needFs），静态校验跑不了，须在真环境跑一遍`);
    } else {
      const cases = st.cases || [];
      if (!cases.length) err(where, '要 block 就必须有自测用例');
      else if (!cases.some(c => c.expect === 'pass')) err(where, '要 block 就必须有「不该拦」的用例');
    }
  }
}

function checkCatalog() {
  const catDir = path.join(ROOT, 'catalog');
  if (!fs.existsSync(catDir)) return 0;
  const dirs = fs.readdirSync(catDir).filter(n => {
    if (n === 'models') return false;   // models 是模型档案，不是域
    return fs.statSync(path.join(catDir, n)).isDirectory();
  });
  const seen = new Set();
  let total = 0;
  const perDomain = {};
  let docOnly = 0;
  for (const d of dirs) {
    const dirPath = path.join(catDir, d);
    const entries = [];
    // 布局一：catalog/<域>/rules.json 一个数组装多条（早期写法，继续支持）
    const bundle = path.join(dirPath, 'rules.json');
    if (fs.existsSync(bundle)) {
      try {
        const list = JSON.parse(fs.readFileSync(bundle, 'utf8'));
        if (!Array.isArray(list)) err(`catalog/${d}/rules.json`, '顶层必须是数组');
        else entries.push(...list);
      } catch (e) { err(`catalog/${d}/rules.json`, `解析失败：${e.message}`); }
    }
    // 布局二：catalog/<域>/<ID>.json 一条一个文件（2026-11-23 起为主布局）
    for (const f of fs.readdirSync(dirPath)) {
      if (!f.endsWith('.json') || f === 'rules.json' || f.startsWith('_')) continue;
      const where = `catalog/${d}/${f}`;
      let one;
      try { one = JSON.parse(fs.readFileSync(path.join(dirPath, f), 'utf8')); }
      catch (e) { err(where, `解析失败：${e.message}`); continue; }
      if (Array.isArray(one)) { err(where, '单文件条目应是对象，不是数组（多条请放 rules.json）'); continue; }
      if (one && one.id && f.replace(/\.json$/, '') !== one.id) err(where, `文件名应等于 id（${one.id}）`);
      entries.push(one);
    }
    if (!entries.length) { notices.push(`catalog/${d}/: 目录里没有条目`); continue; }
    perDomain[d] = entries.length;
    total += entries.length;
    entries.forEach((e) => {
      if (!e.generator && !e.condition) docOnly += 1;
      checkCatalogEntry(d, e, seen);
    });
  }
  const empty = DOMAINS.filter(d => !perDomain[d]);
  console.log(`判据库：${total} 条（其中 ${docOnly} 条只说明、判定在 packs 里），分布在 ${Object.keys(perDomain).length}/${DOMAINS.length} 个域`);
  console.log('  ' + DOMAINS.map(d => `${d}=${perDomain[d] || 0}`).join('  '));
  if (empty.length) notices.push(`以下域还是空的：${empty.join('、')}——别人用得多的往往就在空域里`);
  return { total, ids: seen };
}

// ── 模型档案（catalog/models）─────────────────
// 原则：收录 ≠ 编造。给冷门模型建位置是收录；凭空写它有什么短板是编数据。
// 所以这里卡三件事：状态与数据必须一致、未测的模型不许挂条目、引用的东西必须真存在。
const STATUS = ['未测', '部分实测', '已实测'];

function checkModels(catalogIds) {
  const dir = path.join(ROOT, 'catalog', 'models');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== '_template.json');
  const names = new Set(files.map(f => f.replace(/\.json$/, '')));
  const profiles = [];

  for (const f of files) {
    const where = `catalog/models/${f}`;
    let e;
    try { e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (err2) { err(where, `JSON 解析失败：${err2.message}`); continue; }
    profiles.push({ f, e });

    if (f.replace(/\.json$/, '') !== e.model) err(where, `文件名应等于 model（${e.model}）`);
    for (const k of ['model', 'displayName', 'vendor', 'family', 'status']) {
      if (!e[k]) err(where, `缺字段 ${k}`);
    }
    if (e.status && !STATUS.includes(e.status)) err(where, `status 不合法：${e.status}`);

    // 状态与数据必须一致
    if (e.status === '已实测' && !(e.tests && e.tests.calls > 0)) {
      err(where, '标了已实测但 tests.calls 为 0');
    }
    if (e.status === '未测' && e.tests && e.tests.calls > 0) {
      err(where, `标了未测但有 ${e.tests.calls} 次调用记录`);
    }
    // 未测的模型不许挂任何条目：挂了就等于没测就给结论
    if (e.status === '未测' && Array.isArray(e.rules) && e.rules.length) {
      err(where, `未测的模型不许挂条目（现挂 ${e.rules.length} 条）`);
    }

    for (const r of e.rules || []) {
      if (!catalogIds.has(r)) err(where, `引用的条目不存在于判据库：${r}`);
    }
    const inh = e.inheritsFrom || [];
    if (inh.includes(e.model)) err(where, '不能继承自己');
    for (const m of inh) {
      if (!names.has(m)) err(where, `继承的模型档案不存在：${m}`);
    }
  }

  const byStatus = {};
  for (const { e } of profiles) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
  const fams = new Set(profiles.map(p => p.e.family));
  console.log(`模型档案：${profiles.length} 个，${fams.size} 个家族  ` +
    STATUS.map(s => `${s}=${byStatus[s] || 0}`).join('  '));
  if (!byStatus['已实测']) notices.push('还没有一个模型标「已实测」——等 B3 跑完再升');
}

// ── 两处同源规则是否一致 ─────────────────────
function checkMirror() {
  const a = path.join(ROOT, 'packs');
  const b = path.join(ROOT, 'dsh-judge-gate', 'rules');
  if (!fs.existsSync(b)) return 0;
  const ma = path.join(a, 'manifest.json'), mb = path.join(b, 'manifest.json');
  if (!fs.existsSync(ma) || !fs.existsSync(mb)) {
    notices.push('两份 manifest 缺一份，无法比对 packs 与插件包内规则');
    return 0;
  }
  const A = JSON.parse(fs.readFileSync(ma, 'utf8')).packs || {};
  const B = JSON.parse(fs.readFileSync(mb, 'utf8')).packs || {};
  let n = 0;
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const x = A[k], y = B[k];
    if (!x || !y) { err(`镜像/${k}`, '只在一处存在'); continue; }
    if (x.sha256 !== y.sha256 || x.bytes !== y.bytes) {
      err(`镜像/${k}`, `packs 与 dsh-judge-gate/rules 内容不同（${x.bytes}B/${String(x.sha256).slice(0, 12)} vs ${y.bytes}B/${String(y.sha256).slice(0, 12)}）——两处必须一起改`);
    } else n++;
  }
  return n;
}

// ── 入口 ─────────────────────────────────────
const arg = process.argv[2];
const packsDir = path.join(ROOT, 'packs');

let targets;
if (arg) {
  targets = [path.resolve(arg)];   // 只校验指定包，不跑库
} else {
  const cat = checkCatalog();      // 不带参数时连库一起校验
  if (cat) checkModels(cat.ids);
  const same = checkMirror();
  if (same) notices.push(`两处同源规则：${same} 个包逐字节一致`);
  targets = fs.readdirSync(packsDir).map(n => path.join(packsDir, n)).filter(p => fs.statSync(p).isDirectory());
}

if (!targets.length) { console.log('没有找到包目录'); process.exit(1); }

for (const dir of targets) checkPack(dir);

console.log(`校验 ${targets.length} 个包`);
if (notices.length) {
  console.log(`\n提示（不阻断）：${notices.length} 条`);
  notices.forEach(n => console.log('  · ' + n));
}
if (problems.length) {
  console.log(`\n问题：${problems.length} 条`);
  problems.forEach(p => console.log('  ✗ ' + p));
  process.exit(1);
}
console.log('\n结构全部通过');
