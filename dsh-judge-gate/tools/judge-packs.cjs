#!/usr/bin/env node
// judge-packs：判据市场与安装。
//   本体装上是空的；判据要用户自己挑 —— 挑整包（别人整理的清单）或挑单条。
// 用法：
//   node judge-packs.js list              看市场（按包分组，标出已装）
//   node judge-packs.js status            我现在装了什么
//   node judge-packs.js add core          装一个包
//   node judge-packs.js add J8 J16        只装两条
//   node judge-packs.js remove J9         卸一条 / 卸一个包
//   node judge-packs.js action WIN-BAT-CJK-01 block   装上以后让它真拦（block|warn|default）
//   node judge-packs.js --json            机器读
//   node judge-packs.js export            把包和说明按版本号导成发布目录（不动 data/）
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JUDGES = path.join(ROOT, 'judges');
const PACKS = path.join(ROOT, 'packs');
const DATA = process.env.DSH_JUDGE_DATA || path.join(ROOT, 'data');
const STORE = path.join(DATA, 'judges-installed.json');

function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return dflt; }
}
function readStore() {
  const s = readJson(STORE, { packs: [], rules: [] });
  // actions：装上了以后用多严（{规则号: 'block'|'warn'}）。与 packs/rules 同一份文件，
  // 但只覆盖、不改包里的 rules.json —— 包升级不会把用户的选择冲掉。
  const actions = {};
  const a = (s && s.actions) || {};
  for (const k of Object.keys(a)) {
    const v = String(a[k] || '').toLowerCase();
    if (v === 'block' || v === 'warn') actions[String(k).toUpperCase()] = v;
  }
  return {
    packs: Array.isArray(s.packs) ? s.packs : [],
    rules: Array.isArray(s.rules) ? s.rules : [],
    actions,
    // removed：用户明确不要的条目。与 rules 里「没装」不同——那是没挑，这是挑过又扔了。
    removed: Array.isArray(s.removed) ? s.removed.map((x) => String(x).toUpperCase()) : [],
  };
}
function writeStore(s) {
  fs.mkdirSync(DATA, { recursive: true });
  const uniq = (a) => [...new Set(a.map((x) => String(x).trim()).filter(Boolean))];
  const actions = {};
  for (const k of Object.keys((s && s.actions) || {})) {
    const v = String(s.actions[k] || '').toLowerCase();
    if (v === 'block' || v === 'warn') actions[String(k).toUpperCase()] = v;
  }
  const removed = uniq(((s && s.removed) || []).map((x) => String(x).toUpperCase()));
  fs.writeFileSync(STORE, JSON.stringify({ packs: uniq(s.packs), rules: uniq(s.rules), actions, removed }, null, 2), 'utf8');
}

function judges() {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(JUDGES, { withFileTypes: true }); } catch { ents = []; }
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const j = readJson(path.join(JUDGES, e.name), null);
    if (!j || !j.id || String(j.id).startsWith('_')) continue;
    const rules = (j.rules || []).map((r) => ({
      id: r.id,
      action: j.defaultAction || r.action || 'block',
      text: r.title || j.title || '',
      appliesTo: r.appliesTo || {},
      message: r.message || j.message || '',
      fix: r.fix || j.fix || '',
      severity: r.severity || j.severity || '',
      legacyJudge: r.legacyJudge || '',
    }));
    out.push({ id: j.id, title: j.title || '', order: j.order || 0, rules });
  }
  if (out.length) { out.sort((a, b) => a.order - b.order); return out; }

  // 插件包里没带 judges/ 源文件时，从编译产物 rules/<包>/rules.json 兜底（这才是实际在装的东西）
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(ROOT, 'rules'), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    const arr = readJson(path.join(ROOT, 'rules', d.name, 'rules.json'), []);
    for (const r of arr) {
      out.push({
        id: r.id, title: r.title || r.id, order: 1000, pack: d.name,
        rules: [{
          id: r.id, action: r.action || 'block', text: r.title || '', appliesTo: r.appliesTo || {},
          message: r.message || '', fix: r.fix || '', severity: r.severity || '', legacyJudge: r.legacyJudge || '',
          // 生成器（CORE-PARAMS-GEN）要带出来：它靠 expand 展开 PARAM-* 一族，自己不可判，
          // 不带这个标记会被 status 当成「生效但零命中」的一条判据。
          generator: r.generator || null,
        }],
      });
    }
  }
  // 自建包：data/custom/<包名>/rules.json（mine 草案装进来的地方）
  try {
    const CUSTOM = path.join(DATA, 'custom');
    for (const d of fs.readdirSync(CUSTOM, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const arr = readJson(path.join(CUSTOM, d.name, 'rules.json'), []);
      for (const r of arr) {
        out.push({
          id: r.id, title: r.title || r.id, order: 2000, pack: d.name, custom: true,
          rules: [{
            id: r.id, action: r.action || 'warn', text: r.title || '', appliesTo: r.appliesTo || {},
            message: r.message || '', fix: r.fix || '', severity: r.severity || '', legacyJudge: r.legacyJudge || '',
          }],
        });
      }
    }
  } catch { /* 没有自建包 */ }
  return out;
}

function packs() {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(PACKS, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const pj = readJson(path.join(PACKS, e.name, 'pack.json'), null);
    if (!pj) continue;
    out.push({ dir: e.name, id: pj.id || e.name, name: pj.name || pj.id || e.name, version: pj.version || '', ruleIds: pj.ruleIds || [], rules: pj.rules || 0 });
  }
  return out;
}

const STORE_NOW = readStore();
const ALL = judges();
const PACKS_NOW = packs();

// 动作覆盖：把用户改过的「严不严」盖到市场清单上，list/status/面板看到的都是生效值；
// 同时留一份包里写的原值（actionDefault），面板才分得清「作者说拦」和「我让它拦」。
for (const j of ALL) {
  for (const r of j.rules) {
    r.actionDefault = r.action;
    const ov = STORE_NOW.actions[String(r.id).toUpperCase()];
    if (ov) r.action = ov;
    r.removed = STORE_NOW.removed.includes(String(r.id).toUpperCase());
  }
}

// 规则 → 它属于哪个 rules 包目录（插件包里没有 packs/ 定义时靠它判断在不在装）
const RULE_PACK = {};
try {
  for (const d of fs.readdirSync(path.join(ROOT, 'rules'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const r of readJson(path.join(ROOT, 'rules', d.name, 'rules.json'), [])) RULE_PACK[r.id] = d.name;
  }
} catch { /* 没有 rules/ 就只按 packs/ 判断 */ }
// 自建包也算归属，不然 status 会把装好的草案报成「没生效」
try {
  for (const d of fs.readdirSync(path.join(DATA, 'custom'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const r of readJson(path.join(DATA, 'custom', d.name, 'rules.json'), [])) RULE_PACK[r.id] = d.name;
  }
} catch { /* 没有自建包 */ }

const isRuleOn = (id) => {
  if (STORE_NOW.removed.includes(String(id).toUpperCase())) return false; // 删掉的不算在位，哪怕包还装着
  if (STORE_NOW.rules.includes(id)) return true;
  for (const p of PACKS_NOW) {
    if (!STORE_NOW.packs.includes(p.id)) continue;
    if (p.ruleIds.includes(id)) return true;
    if (!p.ruleIds.length) return true; // 包没列 ruleIds 视为全装
  }
  const pk = RULE_PACK[id];
  return !!(pk && STORE_NOW.packs.includes(pk));
};

const args = process.argv.slice(2);
const cmd = args[0] || 'status';
const json = args.includes('--json');
const names = args.slice(1).filter((a) => !a.startsWith('--'));

// 导出发布版：把 rules/ 里的包连同判据库说明，按 package.json 的版本号导成发布目录。
// 只读源文件；data/ 里的自用清单（你装的包、调过的三档、删掉的条目）一律不进发布版。
if (cmd === 'export') {
  const iOut = args.indexOf('--out');
  const outArg = iOut > 0 ? args[iOut + 1] : path.join(ROOT, '..', 'release');
  const pkg = readJson(path.join(ROOT, 'package.json'), {});
  const ver = String(pkg.version || '0.0.0');
  const srcRules = path.join(ROOT, 'rules');
  const srcCatalog = path.join(ROOT, '..', 'catalog');
  const man = readJson(path.join(srcRules, 'manifest.json'), { packs: {} });
  const names = Object.keys(man.packs || {});
  if (!names.length) { console.error('rules/manifest.json 里没有包，先跑 node tools/gen-manifest.js rules'); process.exit(2); }
  const crypto = require('crypto');
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  // 返回 { files: 复制了几个文件, entries: 其中几条说明（*.json，不含 schema 与目录页） }
  // skipSchema 顺带跳过 *.bak-* 之类的备份文件，免得安装包里带上一堆改动前的旧文件
  const copyTree = (from, to, skipSchema = true) => {
    const acc = { files: 0, entries: 0 };
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name), b = path.join(to, e.name);
      if (e.isDirectory()) {
        const sub = copyTree(a, b, skipSchema);
        acc.files += sub.files; acc.entries += sub.entries;
      } else if (!(skipSchema && /(schema|\.bak)/i.test(e.name))) {
        fs.copyFileSync(a, b); acc.files += 1;
        if (/\.json$/i.test(e.name)) acc.entries += 1;
      }
    }
    return acc;
  };
  const dest = path.join(path.resolve(outArg), 'v' + ver);
  const tmp = dest + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const entries = [];
  for (const name of names) {
    const from = path.join(srcRules, name, 'rules.json');
    if (!fs.existsSync(from)) { console.error('包里缺 rules.json：' + from); process.exit(1); }
    const buf = fs.readFileSync(from);
    let arr = [];
    try { arr = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')); } catch { console.error('rules.json 不是合法 JSON：' + from); process.exit(1); }
    fs.mkdirSync(path.join(tmp, name), { recursive: true });
    fs.writeFileSync(path.join(tmp, name, 'rules.json'), buf);
    entries.push({ id: name, file: name + '/rules.json', rules: Array.isArray(arr) ? arr.length : 0, bytes: buf.length, sha256: sha(buf) });
  }
  const catalogFiles = fs.existsSync(srcCatalog) ? copyTree(srcCatalog, path.join(tmp, 'catalog')) : { files: 0, entries: 0 };
  // 安装包：让不装 DSH 的人解压就能跑命令行与 MCP。放引擎、契约表、规则、说明与 skill，
  // 不放 node 运行时（那样要九十多兆），所以要求对方自己有 node 22+。
  const packDir = path.join(tmp, 'dsh-judge-gate');
  const packParts = [];
  for (const d of ['engine', 'lib', 'rules', 'tools']) {
    const from = path.join(ROOT, d);
    if (fs.existsSync(from)) {
      const r = copyTree(from, path.join(packDir, d), false);
      packParts.push(d + '/ ' + r.files);
    }
  }
  for (const f of ['check.cjs', 'mcp-server.cjs', 'package.json', 'LICENSE', 'CHANGELOG.md', 'cordis.patch.yml', 'install.ps1']) {
    const from = path.join(ROOT, f);
    if (fs.existsSync(from)) { fs.copyFileSync(from, path.join(packDir, f)); packParts.push(f); }
  }
  // 交付件里的「判据包」是空的：一条都不装，装哪些由用户从判据库自己挑。
  // 理由（2026-11-27 用户定案）：判据库是判据库（说明 + 可挑的规则本体），判据包是判据包（这台机器上真正生效的那份）；
  // 默认把作者这套装进去等于替用户做决定，还会让「装完就拦」变成惊吓。
  fs.mkdirSync(path.join(packDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'data', 'judges-installed.json'), JSON.stringify({ packs: [], rules: [], actions: {}, removed: [] }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(packDir, 'data', 'README.md'), [
    '# 这里是「装了哪些判据」的清单',
    '',
    '发出去时是空的：`packs` 与 `rules` 都是空数组，所以闸一条都不拦。',
    '',
    '要从判据库里挑着装：',
    '',
    '```',
    'node dsh-judge-gate/tools/judge-packs.cjs list              # 看判据库里有哪些（按包分组，带「已装/未装」）',
    'node dsh-judge-gate/tools/judge-packs.cjs add WIN-ENC-01    # 装一条',
    'node dsh-judge-gate/tools/judge-packs.cjs add core          # 或者整包装',
    'node dsh-judge-gate/tools/judge-packs.cjs status            # 看现在实际生效几条',
    '```',
    '',
    '装的记录就写在这个文件里。改完重启 DSH 生效（不装 DSH 用命令行时当场生效）。',
    '',
  ].join('\n'), 'utf8');
  packParts.push('data/ judges-installed.json（空清单）+ README.md');
  let cliOk = false;
  const cliFrom = path.join(ROOT, '..', 'weakreferee-cli.js');
  if (fs.existsSync(cliFrom)) { fs.copyFileSync(cliFrom, path.join(tmp, 'weakreferee-cli.js')); cliOk = true; packParts.push('weakreferee-cli.js'); }
  const skillFrom = path.join(ROOT, '..', 'skills');
  if (fs.existsSync(skillFrom)) {
    const r = copyTree(skillFrom, path.join(tmp, 'skills'), false);
    packParts.push('skills/ ' + r.files);
  }
  const usage = [
    '# 弱裁判 ' + ver + '（不装 DSH 也能用）',
    '',
    '要求：Node.js 22 以上。包里不带 node 运行时，自己装一个就行（`node --version` 看一眼）。',
    '',
    '## 试一条判定',
    '',
    '```',
    'node weakreferee-cli.js check pwsh "command=Out-File a.ps1 -InputObject 中文"',
    '```',
    '',
    '预期最后两行是「判定：拦下」和「[WIN-ENC-01] 写文本文件没带 -Encoding」，退出码 1。',
    '',
    '## 看有哪些判据',
    '',
    '```',
    'node weakreferee-cli.js packs',
    '```',
    '',
    '最后一行应当是「完整性：8 个包与清单一致」，前面是手写条数与展开条数。',
    '',
    '## 装进来的是空包，装什么自己挑',
    '',
    '发出去的包里 `dsh-judge-gate/data/judges-installed.json` 是空的（`packs` 与 `rules` 都是空数组），',
    '也就是说**装完不会拦任何东西**——判据库里有全部判据与说明，装哪条由你决定。',
    '',
    '```',
    'node dsh-judge-gate/tools/judge-packs.cjs list              # 看判据库（按包分组，标「已装/未装」）',
    'node dsh-judge-gate/tools/judge-packs.cjs add WIN-ENC-01    # 装一条',
    'node dsh-judge-gate/tools/judge-packs.cjs add core          # 或整包装',
    'node dsh-judge-gate/tools/judge-packs.cjs status            # 看实际生效几条',
    'node dsh-judge-gate/tools/judge-packs.cjs action WIN-ENC-01 warn   # 装好后调这档严不严（拦 / 提示 / 默认）',
    'node dsh-judge-gate/tools/judge-packs.cjs remove WIN-ENC-01 # 这次不装',
    'node dsh-judge-gate/tools/judge-packs.cjs delete WIN-ENC-01 # 这条我不要了（升级冲不掉，restore 能回来）',
    '```',
    '',
    '装到 DSH 里之后也可以直接点面板（`tools/panel.cjs`）挑，效果一样。',
    '',
    '## 接到任意支持 MCP 的客户端',
    '',
    '在客户端的 MCP 配置里加一段（路径换成你解压的位置）：',
    '',
    '```json',
    '{',
    '  "mcpServers": {',
    '    "weakreferee": {',
    '      "command": "node",',
    '      "args": ["<解压目录>/dsh-judge-gate/mcp-server.cjs"]',
    '    }',
    '  }',
    '}',
    '```',
    '',
    '## 包里有什么',
    '',
    '- `weakreferee-cli.js` 命令行入口：check / packs / list / selftest',
    '- `dsh-judge-gate/` 引擎、规则、契约表、MCP 服务、面板（tools/panel.cjs）',
    '- `catalog/` 判据库说明：每条为什么存在、该拦与不该拦的例子、边界',
    '- `skills/` 给支持 skill 的客户端读的自查说明',
    '- `packs.json` 版本、条数、每个包的哈希，自己核用',
    '',
    '## 想改成自己那套',
    '',
    '规则是纯 JSON，在 `dsh-judge-gate/rules/` 下面。改完跑 `node weakreferee-cli.js packs` 看完整性有没有报错；',
    '嫌某条太严，装到 DSH 里之后在面板上点三档（拦 / 提示 / 默认），或者用 `node dsh-judge-gate/tools/judge-packs.cjs action <编号> warn`。',
    '',
    '## 许可',
    '',
    '程序与规则 AGPL-3.0，文档 CC BY 4.0。',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(tmp, 'README.md'), usage, 'utf8');
  const total = entries.reduce((n, e) => n + e.rules, 0);
  const index = { name: pkg.name || 'dsh-judge-gate', version: ver, generatedAt: new Date().toISOString(), kind: 'portable', requires: 'node>=22', cli: cliOk, totalRules: total, catalogEntries: catalogFiles.entries, catalogFiles: catalogFiles.files, packs: entries, payload: packParts };
  fs.writeFileSync(path.join(tmp, 'packs.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  // 回读：清单能解析、条数与源一致、每包哈希对得上，才算导出成功
  const back = readJson(path.join(dest, 'packs.json'), null);
  const bad = [];
  if (!back) bad.push('packs.json 回读失败');
  else {
    if (back.totalRules !== total) bad.push('总条数对不上');
    for (const e of back.packs || []) {
      const f = path.join(dest, e.file);
      if (!fs.existsSync(f)) { bad.push('缺文件 ' + e.file); continue; }
      const buf = fs.readFileSync(f);
      if (buf.length !== e.bytes || sha(buf) !== e.sha256) bad.push(e.id + ' 哈希对不上');
    }
  }
  if (json) { console.log(JSON.stringify({ dest, index: back, problems: bad }, null, 2)); process.exit(bad.length ? 1 : 0); }
  console.log('导出到 ' + dest);
  for (const e of entries) console.log('  ' + e.id.padEnd(20) + e.rules + ' 条  ' + e.bytes + ' 字节  sha ' + e.sha256.slice(0, 12));
  console.log('合计 ' + total + ' 条判据，判据库说明 ' + catalogFiles.entries + ' 条（' + catalogFiles.files + ' 个文件）');
  console.log('发布清单：' + path.join(dest, 'packs.json'));
  console.log('安装包内容：' + packParts.join(' / '));
  console.log('（data/ 里的自用清单没进这个目录：你装的包、调过的三档、删掉的条目都不在发布版里）');
  if (bad.length) { console.error('\n校验没过：\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log('\n校验：清单可解析、条数与源一致、每包哈希对得上');
  process.exit(0);
}
if (cmd === 'list') {
  if (json) { console.log(JSON.stringify({ packs: PACKS_NOW, judges: ALL, installed: STORE_NOW }, null, 2)); process.exit(0); }
  console.log('判据市场（* = 已装）\n');
  for (const p of PACKS_NOW) {
    const on = STORE_NOW.packs.includes(p.id);
    console.log(`${on ? '*' : ' '} 包 ${p.id}  ${p.name}${p.version ? ' v' + p.version : ''}  ${p.ruleIds.length || p.rules || '?'} 条`);
  }
  console.log('');
  for (const j of ALL) {
    const list = j.rules.length
      ? j.rules.map((r) => (r.removed ? '-' : isRuleOn(r.id) ? '*' : ' ') + r.id + '(' + r.action + (r.action !== r.actionDefault ? '!' : '') + ')')
      : ['（无规则：实现在插件里，只能整体开/关）'];
    console.log(`  ${j.id}  ${j.title}`);
    console.log(`      ${list.join('  ')}`);
  }
  console.log("\n装整包：add <包名>    只装几条：add <判据号 J8>    卸：remove <名字>");
  console.log("不要了：delete <判据号>    恢复：restore <判据号>（* 在位 / - 已删 / 空格 未装）");
  process.exit(0);
}

if (cmd === 'status') {
  if (json) { console.log(JSON.stringify(STORE_NOW, null, 2)); process.exit(0); }
  const onAll = ALL.flatMap((j) => j.rules).filter((r) => isRuleOn(r.id));
  // 生成器（CORE-PARAMS-GEN）不是一条能判的规矩：它靠 expand 展开出 PARAM-* 一族，
  // 自己既没有 condition 也不会进判定。混在手写条数里会让「生效 39 条」虚高一条、
  // 还会在「一条都没命中」的盘点里冒出来当噪声（2026-11-27 盘零命中时发现）。
  const onGen = onAll.filter((r) => r.generator);
  const onRules = onAll.filter((r) => !r.generator);
  console.log(`来源：${fs.existsSync(STORE) ? STORE : '（未安装任何判据）'}`);
  console.log(`包：${STORE_NOW.packs.join(', ') || '无'}`);
  console.log(`单独装的条：${STORE_NOW.rules.join(', ') || '无'}`);
  console.log(`删掉的：${STORE_NOW.removed.join(', ') || '无'}`);
  console.log(`实际生效 ${onRules.length} 条${onRules.length ? '：' + onRules.map((r) => r.id).join(' ') : ''}`);
  if (onGen.length) console.log(`另有生成器 ${onGen.length} 条（不直接判定，靠它展开：${onGen.map((r) => r.id).join(' ')}）`);
  if (!onRules.length) console.log('提示：现在一条都没装，闸不会拦任何东西。先跑 list 看看。');
  process.exit(0);
}

// 判据有两条来路，落点都是同一份清单：
//   人从市场里挑 —— list 看着挑，add 包或单条
//   机器从历史里挑 —— mine 扫自己的会话出草案（mine-rules.json），add --draft 装进 custom 包
if (cmd === 'add' && args.includes('--draft')) {
  const i = args.indexOf('--draft');
  const file = args[i + 1];
  if (!file) { console.error('要给草案文件：add --draft <mine-rules.json>（由 weakreferee mine --write 生成）'); process.exit(2); }
  if (!fs.existsSync(file)) { console.error('找不到文件：' + file); process.exit(2); }
  const drafts = readJson(path.resolve(file), null);
  if (!Array.isArray(drafts)) { console.error('草案文件应是数组（mine --write 的 mine-rules.json）'); process.exit(2); }
  if (!drafts.length) { console.log('草案是空的：这次扫描没有能出规矩的形态，不用装'); process.exit(0); }
  const CUSTOM = path.join(DATA, 'custom', 'mine');
  fs.mkdirSync(CUSTOM, { recursive: true });
  const cf = path.join(CUSTOM, 'rules.json');
  const old = readJson(cf, []);
  const byId = new Map((Array.isArray(old) ? old : []).map((r) => [r.id, r]));
  for (const d of drafts) if (d && d.id) byId.set(d.id, d);
  fs.writeFileSync(cf, JSON.stringify([...byId.values()], null, 2) + '\n', 'utf8');
  if (!STORE_NOW.packs.includes('mine')) STORE_NOW.packs.push('mine');
  writeStore(STORE_NOW);
  console.log(`已装草案 ${drafts.length} 条 → ${cf}（累计 ${byId.size} 条），包 mine 已记进清单`);
  console.log('草案的 action 默认是 warn（只提示不拦）。确认无误后编辑该文件改成 block，再重启 DSH。');
  process.exit(0);
}

if (cmd === 'add') {
  if (!names.length) { console.error('要给名字：add <包名> 或 add <判据号>'); process.exit(2); }
  const packIds = new Set([...PACKS_NOW.map((p) => p.id), ...Object.values(RULE_PACK)]);
  const ruleIds = new Set(ALL.flatMap((j) => j.rules.map((r) => r.id)));
  const added = [], bad = [];
  for (const n of names) {
    if (packIds.has(n)) { if (!STORE_NOW.packs.includes(n)) STORE_NOW.packs.push(n); added.push('包 ' + n); }
    else if (ruleIds.has(n)) {
      // 删过又装回来：先把删除记录撤掉，不然装了还是不在位
      STORE_NOW.removed = STORE_NOW.removed.filter((x) => x !== String(n).toUpperCase());
      if (!STORE_NOW.rules.includes(n)) STORE_NOW.rules.push(n);
      added.push('条 ' + n);
    }
    else bad.push(n);
  }
  writeStore(STORE_NOW);
  console.log(added.length ? '已装：' + added.join('、') : '没有新增');
  if (bad.length) console.log('不认识的：' + bad.join('、') + '（跑 list 看有哪些）');
  console.log('重启 DSH 后生效。');
  process.exit(bad.length ? 1 : 0);
}

if (cmd === 'remove' || cmd === 'rm') {
  if (!names.length) { console.error('要给名字'); process.exit(2); }
  const before = JSON.stringify(STORE_NOW);
  for (const n of names) {
    STORE_NOW.packs = STORE_NOW.packs.filter((x) => x !== n);
    STORE_NOW.rules = STORE_NOW.rules.filter((x) => x !== n);
    delete STORE_NOW.actions[String(n).toUpperCase()]; // 卸下了就不留「多严」的旧选择
  }
  writeStore(STORE_NOW);
  console.log(before === JSON.stringify(STORE_NOW) ? '没有变化' : '已卸：' + names.join('、'));
  console.log('重启 DSH 后生效。');
  process.exit(0);
}

// 删掉一条：不再出现在列表里，也不再参与判断。包文件一个字不动（升级冲不掉），restore 就回来。
// 与 remove 不是一回事——remove 是「这次不装」，delete 是「这条我不要了」。
if (cmd === 'delete' || cmd === 'del') {
  if (!names.length) { console.error('要给判据号：delete <判据号>'); process.exit(2); }
  const allRuleIds = new Set(ALL.flatMap((j) => j.rules.map((r) => String(r.id).toUpperCase())));
  const ok = [], bad = [];
  for (const n of names) {
    const k = String(n).toUpperCase();
    if (!allRuleIds.has(k)) { bad.push(n); continue; }
    if (!STORE_NOW.removed.includes(k)) STORE_NOW.removed.push(k);
    STORE_NOW.rules = STORE_NOW.rules.filter((x) => String(x).toUpperCase() !== k);
    delete STORE_NOW.actions[k];
    ok.push(k);
  }
  writeStore(STORE_NOW);
  console.log(ok.length ? '已删：' + ok.join('、') + '（不再拦、也从列表消失；restore 可恢复）' : '没有新增删除');
  if (bad.length) console.log('不认识的：' + bad.join('、') + '（跑 list 看有哪些）');
  console.log('重启 DSH 后生效。');
  process.exit(bad.length ? 1 : 0);
}

if (cmd === 'restore' || cmd === 'undel') {
  if (!names.length) { console.error('要给判据号：restore <判据号>'); process.exit(2); }
  const up = names.map((n) => String(n).toUpperCase());
  const before = STORE_NOW.removed.length;
  STORE_NOW.removed = STORE_NOW.removed.filter((x) => !up.includes(String(x).toUpperCase()));
  writeStore(STORE_NOW);
  console.log(before === STORE_NOW.removed.length
    ? '没有变化（这些本来就没删）'
    : '已恢复：' + up.join('、') + '（回到库里，按原来的装/卸状态）');
  console.log('重启 DSH 后生效。');
  process.exit(0);
}

// 装上了用多严：action <规则号> block|warn|default，default = 退回包里写的原值。
// 只写进清单的 actions，不动包里的 rules.json —— 包升级不会冲掉。
if (cmd === 'action') {
  const rest = args.slice(1);
  const want = rest.filter((a) => !a.startsWith('--'));
  if (json) {
    const rows = [];
    for (const j of ALL) for (const r of j.rules) {
      if (!r.actionDefault && !STORE_NOW.actions[String(r.id).toUpperCase()]) continue;
      rows.push({ id: r.id, on: isRuleOn(r.id), action: r.action, actionDefault: r.actionDefault || r.action });
    }
    console.log(JSON.stringify({ actions: STORE_NOW.actions, rules: rows }, null, 2));
    process.exit(0);
  }
  if (args.includes('--list')) {
    const changed = Object.keys(STORE_NOW.actions);
    console.log('改过动作的 ' + changed.length + ' 条：');
    if (!changed.length) console.log('  （没有，全部按包里写的来）');
    for (const k of changed) {
      const r = ALL.flatMap((j) => j.rules).find((x) => String(x.id).toUpperCase() === k);
      console.log('  ' + k + '  ' + (r ? r.actionDefault : '?') + ' → ' + STORE_NOW.actions[k] + (r && isRuleOn(r.id) ? '' : '（这条现在没装上）'));
    }
    console.log('\n改法：action <规则号> block|warn|default');
    process.exit(0);
  }
  const allRuleIds = new Set(ALL.flatMap((j) => j.rules.map((r) => String(r.id).toUpperCase())));
  const reset = args.includes('--reset');
  if (!want.length && !reset) {
    const keys = Object.keys(STORE_NOW.actions);
    if (!keys.length) console.log('没改过任何一条的动作：全部按包里写的来。');
    else {
      console.log('改过的：');
      for (const k of keys) console.log('  ' + k + '  → ' + STORE_NOW.actions[k]);
    }
    console.log('改用法：action <规则号> block|warn|default（default 退回包里的原值）');
    process.exit(0);
  }
  const id = String(want[0] || '').toUpperCase();
  if (!id) { console.error('要给规则号，例如 action WIN-BAT-CJK-01 block'); process.exit(2); }
  if (!allRuleIds.has(id)) { console.error('不认识这条：' + id + '（跑 list 看有哪些）'); process.exit(2); }
  const v = String(want[1] || (reset ? 'default' : '')).toLowerCase();
  if (v === 'default' || reset) {
    if (!STORE_NOW.actions[id]) { console.log(id + ' 本来就是包里的默认值，没有变化'); process.exit(0); }
    delete STORE_NOW.actions[id];
    writeStore(STORE_NOW);
    console.log(id + ' 已退回包里的默认动作。重启 DSH 后生效。');
    process.exit(0);
  }
  if (v !== 'block' && v !== 'warn') { console.error('动作只能写 block（拦）或 warn（只提示），收到：' + (v || '空')); process.exit(2); }
  const cur = ALL.flatMap((j) => j.rules).find((x) => String(x.id).toUpperCase() === id);
  if (cur && cur.actionDefault === v) {
    // 写的跟包里一样就别留一条多余的记录：清单里只放真改过的
    delete STORE_NOW.actions[id];
    writeStore(STORE_NOW);
    console.log(id + ' 包里本来就是 ' + v + '，已清掉改动（等于没改）');
    process.exit(0);
  }
  STORE_NOW.actions[id] = v;
  writeStore(STORE_NOW);
  console.log(id + ' → ' + (v === 'block' ? '拦下' : '只提示') + '（已记进清单）；重启 DSH 后生效。');
  process.exit(0);
}

console.error('用法：list | status | add <名字...> | remove <名字...> | delete <规则号> | restore <规则号> | action <规则号> block|warn|default [--list] | export [--out <目录>] [--json]');
process.exit(2);
