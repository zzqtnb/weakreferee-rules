#!/usr/bin/env node
/**
 * notes —— 仓库版的「阉割错误库」：只收机器能查的错
 *
 * 用途（对外发布也能用，不依赖任何本机机制、不调模型）：
 *   每次会话结束时，把这一轮里「模型确实犯了、而且能写成对工具参数的断言」的错记一条；
 *   同一条反复出现就累加计数；攒够次数、正反例齐全，再走人的签字变成判据草案。
 *
 * 收的判据（三条硬门槛，缺一条不收）：
 *   1) 能写成一个针对工具参数的断言（condition 对象，不是一段描述）
 *   2) 带正反两个用例（该拦 / 该放），能自测
 *   3) 能说清是哪次真事（symptom 一句话，不是「我觉得」）
 *
 * 子命令：
 *   list                      列出候选（按次数倒序）
 *   add <file.json|->         从文件或标准输入加候选（数组或单条）
 *   merge                     把重复的并成一条（同工具 + 同类型 + 标题相似 ≥ 0.8）
 *   promote <id> [--confirm]  生成判据草案到 drafts/（不带 --confirm 只打印）
 *   drop <id> [--reason 说明] 丢掉一条
 *   report                    出周报（Markdown）
 *
 * 设计取舍（照 2026-11-27 定下的口径）：
 *   - 不引模型、不做语义合并：同工具 + 同错型 + 字符二元组相似度 ≥ 0.8 才算同一条
 *   - 不自动写进 packs：promote 只产草案，人签（--confirm）才算数
 *   - 归不了类的错不要塞进来：那不是机器能查的，写成守则文档比塞进这里有用
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const NOTES_DIR = path.join(ROOT, 'notes');
const STORE = path.join(NOTES_DIR, 'candidates.json');
const DRAFTS = path.join(ROOT, 'drafts');
const SIM_MERGE = 0.8;      // 标题相似度达到这个值才算同一条
const PROMOTE_AT = 3;       // 出现几次才允许起草

const TYPES = ['param-missing', 'param-wrong', 'param-extra', 'bad-json',
  'encoding', 'path', 'dangerous-cmd', 'claim-unbacked', 'cross-call', 'other'];

function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }

/* 引擎认哪些条件类型：不写死清单，直接从来包里现取——
   写死的清单会随引擎升级腐坏，而「现有判据用过什么类型」就是引擎当前能力的证据。 */
function collectTypes() {
  const set = new Set();
  const dirs = [path.join(ROOT, 'packs'), path.join(ROOT, 'dsh-judge-gate', 'rules')];
  for (const base of dirs) {
    let subs = [];
    try { subs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const d of subs) {
      const f = path.join(base, d.name, 'rules.json');
      if (!fs.existsSync(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        const arr = Array.isArray(j) ? j : (j.rules || []);
        for (const r of arr) if (r.condition && r.condition.type) set.add(r.condition.type);
      } catch { /* 单个包坏了不影响别处 */ }
    }
  }
  return set;
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (!Array.isArray(j.candidates)) j.candidates = [];
    return j;
  } catch {
    return { version: 1, updatedAt: nowIso(), candidates: [] };
  }
}

function save(db) {
  db.updatedAt = nowIso();
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const tmp = STORE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, STORE);
}

/* 字符二元组相似度：中文没有空格，词切分不稳，二元组是零依赖里最稳的一种 */
function bigrams(s) {
  const t = String(s || '').replace(/[\s，。、；：！？,.;:!?"'`（）()【】\[\]]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}
function sim(a, b) {
  const A = bigrams(a); const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function nextId(db) {
  let max = 0;
  for (const c of db.candidates) {
    const m = /^N-(\d+)$/.exec(c.id || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'N-' + String(max + 1).padStart(4, '0');
}

/* 收一条候选前的硬门槛。过不了返回原因，过了返回 null。 */
function reject(n) {
  if (!n || typeof n !== 'object') return '不是对象';
  if (!n.tool || typeof n.tool !== 'string') return '缺 tool（哪个工具上出的错）';
  if (!n.title || typeof n.title !== 'string') return '缺 title（一句话说清这条错长什么样）';
  if (!n.symptom || typeof n.symptom !== 'string') return '缺 symptom（哪次真事，不是「我觉得」）';
  if (!n.condition || typeof n.condition !== 'object' || !n.condition.type) {
    return '缺 condition：这一条能不能被机器查，就看有没有断言对象';
  }
  const known = collectTypes();
  if (known.size && !known.has(n.condition.type)) {
    return `condition.type 引擎不认：${n.condition.type}（现有类型：${[...known].sort().join(' / ')}）`;
  }
  if (!TYPES.includes(n.type || 'other')) return `type 不认识：${n.type}（可用 ${TYPES.join(' / ')}）`;
  const ex = n.selfTest && Array.isArray(n.selfTest.cases) ? n.selfTest.cases : [];
  const hasBlock = ex.some((c) => c.expect === 'block');
  const hasPass = ex.some((c) => c.expect === 'pass');
  if (!hasBlock || !hasPass) return '自测要正反两个用例（一条该拦、一条该放）';
  return null;
}

function normalize(n) {
  const out = {
    id: n.id || '',
    tool: String(n.tool),
    type: n.type || 'other',
    title: String(n.title).trim(),
    symptom: String(n.symptom).trim(),
    condition: n.condition,
    selfTest: n.selfTest,
    origin: n.origin === 'preference' ? 'preference' : 'model-error',
    count: Number(n.count) || 1,
    status: n.status || 'candidate',
    firstSeen: n.firstSeen || nowIso(),
    lastSeen: nowIso(),
    sessions: Array.isArray(n.sessions) ? n.sessions.slice(0, 20) : [],
  };
  if (n.session && !out.sessions.includes(n.session)) out.sessions.push(String(n.session));
  return out;
}

function findSame(db, n) {
  return db.candidates.find((c) => c.tool === n.tool && c.type === n.type
    && c.status !== 'dropped' && sim(c.title, n.title) >= SIM_MERGE);
}

function cmdAdd(argv) {
  const src = argv[1];
  if (!src) { console.error('用法：notes add <file.json|->'); return 3; }
  let raw;
  if (src === '-') raw = fs.readFileSync(0, 'utf8');
  else raw = fs.readFileSync(src, 'utf8');
  raw = raw.replace(/^\uFEFF/, ''); // PowerShell Set-Content -Encoding UTF8 在 5.1 下会带 BOM
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { console.error('不是合法 JSON：' + e.message); return 3; }
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.candidates) ? parsed.candidates : [parsed]);
  const db = load();
  let added = 0; let merged = 0; const bad = [];
  for (const n of list) {
    const why = reject(n);
    if (why) { bad.push((n && n.title ? n.title + '：' : '') + why); continue; }
    const cand = normalize(n);
    const same = findSame(db, cand);
    if (same) {
      same.count += cand.count;
      same.lastSeen = cand.lastSeen;
      if (!same.sessions.includes(cand.session) && cand.session) same.sessions.push(cand.session);
      merged += 1;
    } else {
      cand.id = nextId(db);
      db.candidates.push(cand);
      added += 1;
    }
  }
  if (added || merged) save(db);
  console.log(`新增 ${added} 条、并进已有 ${merged} 条、拒收 ${bad.length} 条`);
  for (const b of bad) console.log('  × ' + b);
  return bad.length && !added && !merged ? 1 : 0;
}

function cmdList(argv) {
  const db = load();
  const asJson = argv.includes('--json');
  const rows = db.candidates
    .filter((c) => !argv.includes('--all') ? c.status !== 'dropped' : true)
    .sort((a, b) => b.count - a.count);
  if (asJson) { console.log(JSON.stringify(rows, null, 2)); return 0; }
  if (!rows.length) { console.log('还没有候选。会话里遇到能机器查的错，用 notes add 记一条。'); return 0; }
  console.log('次数  编号     工具      类型            状态        标题');
  for (const c of rows) {
    console.log(`${String(c.count).padEnd(4)}  ${c.id}  ${String(c.tool).padEnd(8)}  ${String(c.type).padEnd(15)}  ${String(c.status).padEnd(10)}  ${c.title}`);
  }
  console.log(`\n共 ${rows.length} 条（够 ${PROMOTE_AT} 次可起草：${rows.filter((c) => c.count >= PROMOTE_AT).length} 条）`);
  return 0;
}

function cmdMerge() {
  const db = load();
  const kept = []; let merged = 0;
  for (const c of db.candidates) {
    const hit = kept.find((k) => k.tool === c.tool && k.type === c.type && sim(k.title, c.title) >= SIM_MERGE);
    if (hit && hit.id !== c.id) {
      hit.count += c.count;
      hit.lastSeen = c.lastSeen > hit.lastSeen ? c.lastSeen : hit.lastSeen;
      for (const s of c.sessions) if (!hit.sessions.includes(s)) hit.sessions.push(s);
      merged += 1;
    } else kept.push(c);
  }
  if (merged) { db.candidates = kept; save(db); }
  console.log(merged ? `并掉 ${merged} 条重复，剩 ${kept.length} 条` : '没有重复');
  return 0;
}

function ruleFrom(c, pack) {
  const idBase = (c.id || 'note').toUpperCase();
  return {
    pack,
    rule: {
      id: `NOTE-${idBase.replace(/^N-/, '')}`,
      needs: Array.isArray(c.needs) ? c.needs : undefined,
      title: c.title,
      when: c.when || 'tool:pre',
      appliesTo: c.appliesTo || { tools: [c.tool] },
      condition: c.condition,
      action: c.action || 'steer',
      severity: c.severity || 'C',
      message: c.title,
      fix: c.fix || '按这条判据改好再发',
      reversible: true,
      origin: c.origin || 'model-error',
      evidence: { hits: 0, sessions: c.sessions ? c.sessions.length : 0, source: c.symptom },
      selfTest: c.selfTest,
    },
  };
}

function cmdPromote(argv) {
  const id = argv[1];
  const confirm = argv.includes('--confirm');
  const packIdx = argv.indexOf('--pack');
  const pack = packIdx > 0 ? argv[packIdx + 1] : 'core';
  if (!id) { console.error('用法：notes promote <id> [--pack core] [--confirm]'); return 3; }
  const db = load();
  const c = db.candidates.find((x) => x.id === id);
  if (!c) { console.error('没有这条：' + id); return 3; }
  if (c.count < PROMOTE_AT) {
    console.error(`只出现 ${c.count} 次，够 ${PROMOTE_AT} 次再起草（反复出现才说明是模型的老毛病，不是偶发）`);
    return 1;
  }
  const draft = ruleFrom(c, pack);
  const out = path.join(DRAFTS, `${draft.rule.id}.json`);
  if (!confirm) {
    console.log('草案（加 --confirm 才写盘）：' + out);
    console.log(JSON.stringify(draft, null, 2));
    return 0;
  }
  fs.mkdirSync(DRAFTS, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(draft, null, 2) + '\n', 'utf8');
  c.status = 'drafted';
  save(db);
  console.log('已写草案：' + out);
  console.log('下一步（人做）：把它补进 packs/' + pack + '/rules.json，再跑 tools/validate.js 与 selftest');
  return 0;
}

function cmdAbsorb(argv) {
  const from = argv[1]; const into = argv[2];
  if (!from || !into) { console.error('用法：notes absorb <要并掉的> <并进哪条>'); return 3; }
  if (from === into) { console.error('不能并给自己'); return 3; }
  const db = load();
  const a = db.candidates.find((x) => x.id === from);
  const b = db.candidates.find((x) => x.id === into);
  if (!a || !b) { console.error('找不到：' + (!a ? from : into)); return 3; }
  b.count += a.count;
  b.lastSeen = a.lastSeen > b.lastSeen ? a.lastSeen : b.lastSeen;
  for (const s of a.sessions || []) if (!b.sessions.includes(s)) b.sessions.push(s);
  a.status = 'dropped';
  a.droppedBecause = 'absorbed into ' + into;
  save(db);
  console.log(`${from} 并进 ${into}：${into} 现在 ${b.count} 次`);
  return 0;
}

function cmdDrop(argv) {
  const id = argv[1];
  if (!id) { console.error('用法：notes drop <id> [--reason 说明]'); return 3; }
  const i = argv.indexOf('--reason');
  const reason = i > 0 ? argv.slice(i + 1).join(' ') : '';
  const db = load();
  const c = db.candidates.find((x) => x.id === id);
  if (!c) { console.error('没有这条：' + id); return 3; }
  c.status = 'dropped';
  if (reason) c.droppedBecause = reason;
  save(db);
  console.log(`丢掉 ${id}${reason ? '（' + reason + '）' : ''}`);
  return 0;
}

function cmdReport() {
  const db = load();
  const live = db.candidates.filter((c) => c.status !== 'dropped');
  const ready = live.filter((c) => c.count >= PROMOTE_AT && c.status === 'candidate');
  const watching = live.filter((c) => c.count < PROMOTE_AT && c.status === 'candidate');
  const drafted = live.filter((c) => c.status === 'drafted');
  const L = [];
  L.push('# 候选判据周报（' + nowIso().slice(0, 10) + '）');
  L.push('');
  L.push(`一共 ${live.length} 条：可以起草 ${ready.length} 条、还在观察 ${watching.length} 条、已起草待并包 ${drafted.length} 条。`);
  L.push('');
  if (ready.length) {
    L.push('## 够次数了，等你点头');
    L.push('');
    L.push('| 编号 | 次数 | 工具 | 它管什么 | 你回什么 |');
    L.push('|---|---|---|---|---|');
    for (const c of ready) L.push(`| ${c.id} | ${c.count} | ${c.tool} | ${c.title} | 起草 / 再等 / 不要 |`);
    L.push('');
    L.push('回「起草 <编号>」就生成草案；草案不会自己进判据包，还要你确认一次。');
    L.push('');
  }
  if (watching.length) {
    L.push('## 还在观察（次数不够，先不用你管）');
    L.push('');
    for (const c of watching) L.push(`- ${c.id}（${c.count} 次）${c.tool} · ${c.title}`);
    L.push('');
  }
  if (drafted.length) {
    L.push('## 已起草待并包');
    L.push('');
    for (const c of drafted) L.push(`- ${c.id} ${c.title}`);
    L.push('');
  }
  const near = [];
  for (let i = 0; i < watching.length; i += 1) {
    for (let j = i + 1; j < watching.length; j += 1) {
      const a = watching[i]; const b = watching[j];
      if (a.tool !== b.tool || a.type !== b.type) continue;
      const s = sim(a.title, b.title);
      if (s >= 0.5 && s < SIM_MERGE) near.push({ a, b, s });
    }
  }
  if (near.length) {
    L.push('## 看着像同一条，等你合并（我没法自己判断，合并要人看）');
    L.push('');
    L.push('| 两条 | 相似 | 是不是一回事 |');
    L.push('|---|---|---|');
    for (const p of near) L.push(`| ${p.a.id} / ${p.b.id} | ${Math.round(p.s * 100)}% | 是就回「合并 ${p.a.id} 进 ${p.b.id}」 |`);
    L.push('');
    L.push('合并命令：`notes absorb <要并掉的> <并进哪条>`。');
    L.push('');
  }
  if (!live.length) L.push('这一周没攒到机器能查的错。');
  console.log(L.join('\n'));
  return 0;
}

const CMDS = { list: cmdList, add: cmdAdd, merge: cmdMerge, absorb: cmdAbsorb, promote: cmdPromote, drop: cmdDrop, report: cmdReport };

function cli(argv) {
  const sub = (argv && argv[0]) || 'list';
  const fn = CMDS[sub];
  if (!fn) {
    console.error('notes 用法：list | add <file|-> | merge | absorb <from> <into> | promote <id> [--confirm] | drop <id> | report');
    return 3;
  }
  return fn(argv);
}

module.exports = { cli, load, save, sim, PROMOTE_AT, SIM_MERGE };

if (require.main === module) process.exitCode = cli(process.argv.slice(2));
