#!/usr/bin/env node
// judge-packs：判据市场与安装。
//   本体装上是空的；判据要用户自己挑 —— 挑整包（别人整理的清单）或挑单条。
// 用法：
//   node judge-packs.js list              看市场（按包分组，标出已装）
//   node judge-packs.js status            我现在装了什么
//   node judge-packs.js add core          装一个包
//   node judge-packs.js add J8 J16        只装两条
//   node judge-packs.js remove J9         卸一条 / 卸一个包
//   node judge-packs.js --json            机器读
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
  return { packs: Array.isArray(s.packs) ? s.packs : [], rules: Array.isArray(s.rules) ? s.rules : [] };
}
function writeStore(s) {
  fs.mkdirSync(DATA, { recursive: true });
  const uniq = (a) => [...new Set(a.map((x) => String(x).trim()).filter(Boolean))];
  fs.writeFileSync(STORE, JSON.stringify({ packs: uniq(s.packs), rules: uniq(s.rules) }, null, 2), 'utf8');
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
        rules: [{ id: r.id, action: r.action || 'block', text: r.title || '', appliesTo: r.appliesTo || {} }],
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
          rules: [{ id: r.id, action: r.action || 'warn', text: r.title || '', appliesTo: r.appliesTo || {} }],
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
      ? j.rules.map((r) => (isRuleOn(r.id) ? '*' : ' ') + r.id + '(' + r.action + ')')
      : ['（无规则：实现在插件里，只能整体开/关）'];
    console.log(`  ${j.id}  ${j.title}`);
    console.log(`      ${list.join('  ')}`);
  }
  console.log("\n装整包：add <包名>    只装几条：add <判据号 J8>    卸：remove <名字>");
  process.exit(0);
}

if (cmd === 'status') {
  if (json) { console.log(JSON.stringify(STORE_NOW, null, 2)); process.exit(0); }
  const onRules = ALL.flatMap((j) => j.rules).filter((r) => isRuleOn(r.id));
  console.log(`来源：${fs.existsSync(STORE) ? STORE : '（未安装任何判据）'}`);
  console.log(`包：${STORE_NOW.packs.join(', ') || '无'}`);
  console.log(`单独装的条：${STORE_NOW.rules.join(', ') || '无'}`);
  console.log(`实际生效 ${onRules.length} 条${onRules.length ? '：' + onRules.map((r) => r.id).join(' ') : ''}`);
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
    else if (ruleIds.has(n)) { if (!STORE_NOW.rules.includes(n)) STORE_NOW.rules.push(n); added.push('条 ' + n); }
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
  }
  writeStore(STORE_NOW);
  console.log(before === JSON.stringify(STORE_NOW) ? '没有变化' : '已卸：' + names.join('、'));
  console.log('重启 DSH 后生效。');
  process.exit(0);
}

console.error('用法：list | status | add <名字...> | remove <名字...> [--json]');
process.exit(2);
