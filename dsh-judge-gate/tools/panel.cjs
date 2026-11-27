#!/usr/bin/env node
// panel：判据面板 —— 一个本地网页，把「现在装着哪几条判据、它们各拦过什么、哪条想关掉」摆在一屏里。
//
// 为什么要有它：判据包是「本体装上是空的、装什么由用的人自己挑」，
// 挑的动作原来只有命令行。命令行能装，但看不见全局——不知道现在在位几条、
// 每条拦过几次、关掉一条会不会把闸关成摆设。面板就是补这一块。
//
// 用法：
//   node tools/panel.cjs                 起服务，打印地址
//   node tools/panel.cjs --port 7799     换端口
//   node tools/panel.cjs --open          起完自动开浏览器
//
// 接口：
//   GET  /                 页面
//   GET  /api/state        全部状态（判据 + 在位 + 命中 + 最近拦下）
//   POST /api/toggle       {id, on} 装/卸一条，返回新状态
//   POST /api/action       {id, action} 改这条装上以后多严（block 拦 / warn 只提示 / default 回包里的原值）
//   POST /api/delete       {id} 这条我不要了：从列表与判断里都拿掉（包文件不动，可恢复）
//   POST /api/restore      {id} 把删掉的放回库里
//
// 只绑 127.0.0.1，不对外。没有任何第三方依赖。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PACKS_CLI = path.join(__dirname, 'judge-packs.cjs');

const argv = process.argv.slice(2);
const argVal = (k, dflt) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

// 开关存在哪一份 data 里：默认自身 ../data。但 DSH 真正加载的是运行位那一份，
// 用 --data 或 DSH_JUDGE_DATA 指过去，面板才不会显示一份「没在跑」的清单
const DATA = path.resolve(argVal('--data', process.env.DSH_JUDGE_DATA || path.join(ROOT, 'data')));
const LEDGER_FILE = path.join(DATA, 'panel-ledger.jsonl');
const PORT = Number(argVal('--port', process.env.WR_PANEL_PORT || 7788));

// 拦截账本：默认指向本项目工作区那份，可用 --ledger 或 WR_LEDGER 覆盖
const LEDGER = path.resolve(argVal('--ledger', process.env.WR_LEDGER || path.join(ROOT, '..', '..', '拦截.tsv')));

// ---------- 判据库：catalog 里那批带「判据／例子／边界」的说明条目 ----------
// 说明条目不是判据本身（正则与自测在包里），它回答「这条在查什么、什么该拦什么不该拦」。
// 仓库里放在 <仓库根>\catalog\<域>\<id>.json；插件包同步时会把它带进来一份，运行位也能读。
const CATALOG_CANDIDATES = [
  argVal('--catalog', process.env.WR_CATALOG || path.join(ROOT, 'catalog')),
  path.join(ROOT, '..', 'catalog'),
];
function readCatalog() {
  let dir = null;
  for (const d of CATALOG_CANDIDATES) { try { if (fs.statSync(d).isDirectory()) { dir = d; break; } } catch { /* 下一个 */ } }
  const items = {};
  if (!dir) return { dir: null, items };
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.json') || e.name.endsWith('.schema.json')) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
      if (!j || !j.id) continue;
      items[String(j.id).toUpperCase()] = {
        id: j.id, title: j.title || '', domain: j.domain || '',
        action: j.defaultAction || '', promotedTo: j.promotedTo || '',
        notes: Array.isArray(j.notes) ? j.notes : [],
      };
    }
  };
  walk(dir);
  return { dir, items };
}

// ---------- 判据清单：直接借 judge-packs.cjs 的 --json，不重复实现一遍判断 ----------
function readState() {
  let raw;
  try {
    raw = execFileSync(process.execPath, [PACKS_CLI, 'list', '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, DSH_JUDGE_DATA: DATA },
    });
  } catch (e) {
    return { ok: false, error: '读不到判据清单：' + (e.message || e), judges: [], packs: [], online: null };
  }
  let d;
  try { d = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) {
    return { ok: false, error: '判据清单不是合法 JSON：' + (e.message || e), judges: [], packs: [], online: null };
  }

  // isRuleOn 与 judge-packs.cjs 保持同一套口径（装了包 = 包里每条都在；单条另记）
  const installed = d.installed || { packs: [], rules: [] };
  const rulePacks = new Map();
  for (const p of d.judges || []) {
    for (const r of p.rules || []) if (!rulePacks.has(r.id)) rulePacks.set(r.id, p.pack || p.id);
  }
  const isOn = (id, packId) => {
    if ((installed.rules || []).includes(id)) return true;
    if (packId && (installed.packs || []).includes(packId)) return true;
    const pk = rulePacks.get(id);
    return !!(pk && (installed.packs || []).includes(pk));
  };

  const hits = readHits();
  const cat = readCatalog();
  // 说明条目 ↔ 判据：优先 promotedTo（形如 windows-powershell#WIN-PS1-CJK-01），没有再按同名 id 对
  const catByRule = {};
  for (const k of Object.keys(cat.items)) {
    const c = cat.items[k];
    const rid = (c.promotedTo || '').split('#').pop() || c.id;
    catByRule[String(rid).toUpperCase()] = c;
  }
  const removedSet = new Set((installed.removed || []).map((x) => String(x).toUpperCase()));

  const judges = [];
  for (const j of d.judges || []) {
    for (const r of j.rules || []) {
      const packId = r.pack || j.pack || j.id;
      const gone = removedSet.has(String(r.id).toUpperCase()) || !!r.removed;
      judges.push({
        id: r.id,
        title: r.text || j.title || r.id,
        action: r.action || 'block',
        actionDefault: r.actionDefault || r.action || 'block',
        overridden: !!(r.actionDefault && r.action && r.action !== r.actionDefault),
        pack: packId,
        on: gone ? false : isOn(r.id, packId),
        removed: gone,
        hit: hits.byRule[r.id] || 0,
        tip: hits.byRuleTip[r.id] || 0,
        message: r.message || '',
        fix: r.fix || '',
        severity: r.severity || '',
        cat: catByRule[String(r.id).toUpperCase()] || null,
      });
    }
  }
  // 兜底路径下一条 rule 一个 judge 条目，会有重复 id 的可能，去重取第一个
  const seen = new Set();
  const uniq = judges.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));

  const packs = (d.packs || []).map((p) => ({
    id: p.id, name: p.name, version: p.version,
    rules: (p.ruleIds || []).length,
    on: (installed.packs || []).includes(p.id),
  }));

  const alive = uniq.filter((x) => !x.removed);
  // 判据库里有说明、规则包里还没有对应实现的那几条：只给人看，装不了
  const judgeIds = new Set(uniq.map((x) => String(x.id).toUpperCase()));
  const library = Object.keys(cat.items)
    .map((k) => cat.items[k])
    .filter((c) => {
      const rid = String((c.promotedTo || '').split('#').pop() || c.id).toUpperCase();
      return !judgeIds.has(rid);
    })
    .sort((a, b) => String(a.domain || '').localeCompare(String(b.domain || '')) || String(a.id).localeCompare(String(b.id)))
    .map((c) => ({
      id: c.id,
      title: c.title || c.id,
      domain: c.domain || '',
      message: c.message || '',
      fix: c.fix || '',
      notes: [].concat(c.notes || []),
      promotedTo: c.promotedTo || '',
    }));
  // 判据库全量：这一栏给「翻整份库」用，每条标明闸里有没有对应实现
  const catalogAll = Object.keys(cat.items)
    .map((k) => cat.items[k])
    .map((c) => {
      const rid = String((c.promotedTo || '').split('#').pop() || c.id).toUpperCase();
      return {
        id: c.id,
        title: c.title || c.id,
        domain: c.domain || '',
        message: c.message || '',
        fix: c.fix || '',
        notes: [].concat(c.notes || []),
        promotedTo: c.promotedTo || '',
        ruleId: rid,
        hasRule: judgeIds.has(rid),
      };
    })
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.id.localeCompare(b.id));
  return {
    ok: true,
    judges: uniq,
    catalogAll,
    packs,
    online: { on: alive.filter((x) => x.on).length, total: alive.length, deleted: uniq.length - alive.length },
    catalogDir: cat.dir,
    library,
    packsOn: (installed.packs || []),
    soloOn: (installed.rules || []),
    hits,
    live: readLive(),
    ledgerPath: LEDGER,
    dataDir: DATA,
  };
}

// ---------- 攒着的观察记录：闸每天顺手记的形态次数，只读，不当判据用 ----------
function readLive() {
  const file = path.join(DATA, 'mine-live.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const forms = Object.keys(j && j.forms ? j.forms : {}).map((k) => {
      const v = j.forms[k] || {};
      return {
        key: k,
        title: v.title || k,
        n: v.n || 0,
        noise: !!v.noise,
        rule: v.rule || null,
        note: v.note || '',
        last: Array.isArray(v.last) ? v.last : [],
      };
    }).sort((a, b) => b.n - a.n);
    return { updated: (j && j.updated) || '', forms, path: file };
  } catch {
    return { updated: '', forms: [], path: file };
  }
}

// ---------- 命中统计：从 拦截.tsv 现算，不做快照（快照会和流水各说各话）----------
function readHits() {
  const out = { byRule: {}, byRuleTip: {}, blocked: 0, total: 0, recent: [], lastAt: '', noTag: 0, byDay: {} };
  let lines;
  try {
    lines = fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/);
  } catch {
    out.missing = true;
    return out;
  }
  for (const ln of lines) {
    if (!ln.trim()) continue;
    const f = ln.split('\t');
    if (f.length < 5) continue;
    const status = f[3];
    if (status !== '拦下' && status !== '提示' && status !== '未验') continue;
    out.total += 1;
    // 2026-11-25 起闸写账本时把判据号并进理由（[J3] …）。老行没有编号，只计入总数。
    const m = f[4].match(/^\[([^\]]+)\]/);
    const ids = m ? m[1].split(/[,，\s]+/).filter(Boolean) : [];
    if (!m && status === '拦下') out.noTag += 1;
    // 拦下与只提示分开算：「只提示」的判据从来不拦，混在一起它永远是 0，看着像没干活
    const bucket = status === '拦下' ? out.byRule : out.byRuleTip;
    for (const id of new Set(ids)) bucket[id] = (bucket[id] || 0) + 1;
    if (status === '拦下') {
      out.blocked += 1;
      // 按天聚合：面板要给「今天拦了几次」和近七天趋势，不能只有总数
      const day = String(f[0]).slice(0, 10);
      if (day) out.byDay[day] = (out.byDay[day] || 0) + 1;
      // 保留最后 12 条（账本按时间追加，从头取会拿到最老的）；末尾再 reverse 成最新在前
      out.recent.unshift({ at: f[0], tool: f[2], why: f[4].slice(0, 160), ids });
      if (out.recent.length > 12) out.recent.pop();
      out.lastAt = f[0];
    }
  }
  // unshift + pop 之后数组已经是「最新在前」，不要再 reverse
  return out;
}

// ---------- 留痕：用户手动动过哪一条，必须落纸，否则闸被关成摆设没人知道 ----------
function note(action, id, extra) {
  // 本地时间，不带时区换算：账本要能跟人看到的钟对上
  const n = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const at = `${n.getFullYear()}-${p2(n.getMonth() + 1)}-${p2(n.getDate())} ${p2(n.getHours())}:${p2(n.getMinutes())}:${p2(n.getSeconds())}`;
  const row = { at, by: '用户手动（面板）', action, id };
  if (extra) row.note = extra;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(LEDGER_FILE, JSON.stringify(row) + '\n', 'utf8');
  } catch { /* 记不上不影响装/卸本身 */ }
}

function toggle(id, on) {
  // 走 judge-packs.cjs 本体，不另写一套装法——两边判断不一致就是两份真相
  const verb = on ? 'add' : 'remove';
  try {
    const out = execFileSync(process.execPath, [PACKS_CLI, verb, id], {
      cwd: ROOT, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, DSH_JUDGE_DATA: DATA },
    });
    note(on ? 'on' : 'off', id);
    return { ok: true, out: out.trim().split(/\r?\n/)[0] };
  } catch (e) {
    return { ok: false, error: (e.stdout || '') + (e.stderr || '') || e.message };
  }
}

// 改「这条装上以后多严」：跟装/卸一样走 judge-packs.cjs 本体（action 子命令），
// 落同一份清单。面板只做入口，不另写一套判断，免得出现两套真相。
function setAction(id, value) {
  const v = String(value || 'default').toLowerCase();
  if (!['block', 'warn', 'default'].includes(v)) return { ok: false, error: '动作只能是 block / warn / default' };
  try {
    const out = execFileSync(process.execPath, [PACKS_CLI, 'action', id, v], {
      cwd: ROOT, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, DSH_JUDGE_DATA: DATA },
    });
    note('action', id, v === 'default' ? '退回包里的默认值' : '改成' + (v === 'block' ? '拦下' : '只提示'));
    return { ok: true, out: out.trim().split(/\r?\n/)[0] };
  } catch (e) {
    return { ok: false, error: (e.stdout || '') + (e.stderr || '') || e.message };
  }
}

// 删掉 / 恢复一条：跟装/卸一样走 judge-packs.cjs 本体，只写本地清单，包文件不动。
function delRule(id, restoreIt) {
  const verb = restoreIt ? 'restore' : 'delete';
  try {
    const out = execFileSync(process.execPath, [PACKS_CLI, verb, id], {
      cwd: ROOT, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, DSH_JUDGE_DATA: DATA },
    });
    note(restoreIt ? 'restore' : 'delete', id);
    return { ok: true, out: out.trim().split(/\r?\n/)[0] };
  } catch (e) {
    return { ok: false, error: (e.stdout || '') + (e.stderr || '') || e.message };
  }
}

// ---------- 试一试：把一条命令丢进引擎判一次，让人当场看见闸怎么反应 ----------
// 只判断、不执行：引擎是纯函数，判完就返回，命令一个字符都不会跑。
// 契约表在哪个目录：包里放 contract\，插件运行位放 lib\，两边都要认
// （缺 tool-params / tool-schema 就展不开参数类判据，508 条会缩水成几十条）
function contractDir() {
  const ok = (d) => fs.existsSync(path.join(d, 'tool-params.json')) && fs.existsSync(path.join(d, 'tool-schema.json'));
  const lib = path.join(ROOT, 'lib');
  if (ok(lib)) return lib;
  return path.join(ROOT, 'contract');
}
let TRY_CACHE = null;
// 缓存指纹：规则文件被手工改过（编辑器保存、覆盖、增删包）也要让缓存失效，
// 否则「试一试」还拿旧规则判，人会以为刚加的那条没生效。
// 走 mtime + 大小（size 兜住同毫秒内改两次），custom 下的包名也进指纹。
function tryStamp(dirs) {
  const parts = [];
  for (const d of dirs) {
    for (const f of ['rules.json', 'pack.json']) {
      try {
        const st = fs.statSync(path.join(d, f));
        parts.push(d + '/' + f + ':' + st.mtimeMs + ':' + st.size);
      } catch { /* 没有这个文件就跳过 */ }
    }
  }
  try {
    for (const pack of fs.readdirSync(path.join(DATA, 'custom'))) parts.push('pack:' + pack);
  } catch { /* 没有 custom 目录 */ }
  return parts.join('|');
}
// 试一试要跟闸用同一批规矩：包里的 + 用户在面板上加的（落在 data\custom\<包>\rules.json）
function tryDirs() {
  const dirs = [path.join(ROOT, 'rules')];
  const base = path.join(DATA, 'custom');
  try {
    for (const pack of fs.readdirSync(base)) {
      const d = path.join(base, pack);
      if (fs.existsSync(path.join(d, 'rules.json'))) dirs.push(d);
    }
  } catch { /* 没有 custom 目录就是只有包里的 */ }
  return dirs;
}
function tryJudge(tool, args) {
  const dirs = tryDirs();
  const stamp = tryStamp(dirs);
  if (!TRY_CACHE || TRY_CACHE.stamp !== stamp) {
    const J = require(path.join(ROOT, 'engine', 'judge.js'));
    const EX = require(path.join(ROOT, 'engine', 'expand.js'));
    const rs = J.load(dirs, J.ENV);
    const ex = EX.expandAll(rs.rules, { dir: contractDir() });
    TRY_CACHE = { J, pre: ex.rules.filter((r) => (r.when || 'tool:pre') === 'tool:pre'), stamp };
  }
  const { J, pre } = TRY_CACHE;
  // 面板只让用户写命令，必填的 description 由这儿补：不然每条都会先命中「参数缺了」，
  // 看不出真正想看的那条动作类判据
  const full = Object.assign({ description: '面板试一试' }, args);
  const hits = J.judge({ when: 'tool:pre', tool, args: full }, pre);
  return {
    ok: true,
    checked: pre.length,
    hits: hits.map((h) => {
      const id = h.ruleId || h.id || '';
      const t = h.title || '';
      return {
        id,
        // title 与 id 相同就没有额外信息，留给前端只显示一次
        title: (t && t !== id) ? t : '',
        action: h.action || 'warn',
        severity: h.severity || '',
        message: h.message || '',
      };
    }),
  };
}

// ---------- 账本全量：按判据 / 状态筛，只读，不改 ----------
// 面板原来只显示最近 12 条拦下，「提示」和「未验」两态根本看不见；这一块把三态都摆出来
function readLedgerRows() {
  const rows = [];
  let lines = [];
  try { lines = fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/); } catch { return rows; }
  for (const ln of lines) {
    if (!ln.trim()) continue;
    const f = ln.split('\t');
    if (f.length < 5) continue;
    const status = f[3];
    if (status !== '拦下' && status !== '提示' && status !== '未验') continue;
    const m = f[4].match(/^\[([^\]]+)\]/);
    const ids = m ? m[1].split(/[,，\s]+/).filter(Boolean) : [];
    rows.push({ at: f[0], tool: f[2], status, ids, why: f[4] });
  }
  return rows;
}

function queryHits(rule, status, limit) {
  const rows = readLedgerRows();
  const counts = { 拦下: 0, 提示: 0, 未验: 0 };
  const ruleCount = {};
  for (const r of rows) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    for (const id of new Set(r.ids)) ruleCount[id] = (ruleCount[id] || 0) + 1;
  }
  let hit = rows;
  if (status && counts[status] !== undefined) hit = hit.filter((r) => r.status === status);
  if (rule) hit = hit.filter((r) => r.ids.some((id) => id.toUpperCase().includes(rule.toUpperCase())));
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  const out = hit.slice(-n).reverse().map((r) => ({
    at: r.at, tool: r.tool, status: r.status, ids: r.ids,
    why: String(r.why).replace(/^\[[^\]]*\]\s*/, '').slice(0, 400)
  }));
  const rulesTop = Object.keys(ruleCount)
    .map((k) => ({ id: k, n: ruleCount[k] }))
    .sort((a, b) => b.n - a.n);
  return { ok: true, total: rows.length, matched: hit.length, counts, rules: rulesTop, rows: out };
}

// ---------- 加一条自己的规矩：写进 data\custom\mine\rules.json（mine 包） ----------
// 只做「加法」，不碰已有条目；写前校验编号、正则、工具名，写后回读一遍再报成功
function addRule(payload) {
  const MINE = path.join(DATA, 'custom', 'mine', 'rules.json');
  let arr = [];
  try {
    const raw = fs.readFileSync(MINE, 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    if (Array.isArray(j)) arr = j;
  } catch { /* 没有就新建 */ }

  const id = String(payload.id || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9-]{2,40}$/.test(id)) return { ok: false, error: '编号只能是大写字母、数字和短横线，2～40 位' };
  if (arr.some((r) => String(r.id).toUpperCase() === id)) return { ok: false, error: '这个编号已经存在了，换一个' };

  const tool = String(payload.tool || 'pwsh');
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(tool)) return { ok: false, error: '工具名不像话（小写字母、数字、下划线）' };

  const pattern = String(payload.pattern || '');
  if (!pattern) return { ok: false, error: '还没写要检查的样子' };
  try { new RegExp(pattern); } catch (e) { return { ok: false, error: '正则写错了：' + e.message }; }

  const action = payload.action === 'block' ? 'block' : 'warn';
  const target = tool === 'pwsh' ? 'args.command' : 'args.content';
  const rule = {
    id,
    title: String(payload.title || id),
    when: 'tool:pre',
    appliesTo: { tool },
    condition: { type: 'regexHit', target, pattern },
    action,
    severity: 'C',
    message: String(payload.message || ('命中自己加的规矩 ' + id)),
    evidence: { source: '面板上手动添加 ' + new Date().toISOString().slice(0, 10) },
    selfTest: { cases: [] }
  };
  arr.push(rule);
  try {
    fs.mkdirSync(path.dirname(MINE), { recursive: true });
    fs.writeFileSync(MINE, JSON.stringify(arr, null, 2) + '\n', 'utf8');
    // 回读一遍：写盘回执不算数，能解析出这条才算
    const back = JSON.parse(fs.readFileSync(MINE, 'utf8'));
    if (!back.some((r) => r.id === id)) return { ok: false, error: '写进去了但回读没找到这条' };
    TRY_CACHE = null; // 规则变了，下一次判定要重新编译
    return { ok: true, id, count: back.length, path: MINE };
  } catch (e) {
    return { ok: false, error: '写盘失败：' + e.message };
  }
}

// ---------- 页面 ----------
function page() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>弱裁判 · 判据面板</title>
<style>
  :root{--bg:#0e1014;--panel:#151920;--card:#181d26;--line:#242a36;--text:#e7eaf0;--dim:#8b93a3;--faint:#5d6675;--on:#3ea675;--warn:#c9a227;--bad:#d2544a;--steer:#4a86c8;--code:#0a0c10}
  body.light{--bg:#f6f7f9;--panel:#ffffff;--card:#ffffff;--line:#e3e6ec;--text:#1b1f27;--dim:#5f6875;--faint:#949caa;--on:#2f8f63;--warn:#a8801a;--bad:#c0483e;--steer:#3d76b4;--code:#f1f3f6}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  header{position:sticky;top:0;z-index:9;background:var(--panel);border-bottom:1px solid var(--line);padding:16px 26px 12px}
  .top{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap}
  .brand{display:flex;align-items:center;gap:12px}
  .logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(140deg,#2f8f63,#1f6b49);color:#fff;display:flex;align-items:center;justify-content:center;font-size:17px}
  h1{font-size:17px;margin:0;font-weight:650;letter-spacing:.3px}
  .tag{font-size:12px;color:var(--dim);margin-top:1px}
  .stats{display:flex;align-items:center;gap:22px;flex-wrap:wrap}
  .stat{display:flex;flex-direction:column;align-items:flex-end;line-height:1.25}
  .stat b{font-size:23px;font-weight:680;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
  .stat span{font-size:11.5px;color:var(--dim)}
  .stat.hot b{color:var(--bad)}
  #theme{background:var(--card);border:1px solid var(--line);color:var(--text);border-radius:9px;width:34px;height:34px;cursor:pointer;font-size:15px}
  .line{font-size:12.5px;color:var(--dim);margin:10px 0 4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--on);flex:none}
  .dot.off{background:var(--faint)}
  .trend{display:flex;align-items:flex-end;gap:5px;height:54px;margin-top:6px}
  .trend .tl{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px;flex:1;max-width:64px;height:100%}
  .trend .tb{width:100%;background:var(--line);border-radius:3px 3px 0 0;min-height:2px}
  .trend .tb.has{background:var(--bad);opacity:.85}
  .trend .td{font-size:10px;color:var(--faint);font-variant-numeric:tabular-nums}
  .bar{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center}
  button.tab{background:var(--card);color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:4px 13px;cursor:pointer;font-size:12.5px;font-family:inherit}
  button.tab.on{background:var(--text);color:var(--bg);border-color:var(--text)}
  input.se{background:var(--card);border:1px solid var(--line);color:var(--text);border-radius:999px;padding:4px 13px;font-size:12.5px;outline:none;min-width:210px;font-family:inherit}
  .store{font-size:11px;color:var(--faint);margin-top:8px;font-family:ui-monospace,Consolas,monospace;cursor:pointer;display:inline-block;border-bottom:1px dotted var(--line)}
  .store.open{color:var(--dim);word-break:break-all;border-bottom-color:transparent;display:block;cursor:default}
  .wrap{padding:22px 26px 70px;max-width:1560px;margin:0 auto}
  section.blk{margin-bottom:26px}
  section.blk>h2{font-size:13px;font-weight:600;color:var(--dim);margin:0 0 12px;letter-spacing:.4px;display:flex;align-items:center;gap:10px}
  section.blk>h2 em{font-style:normal;color:var(--faint);font-weight:400}
  .feed{display:flex;flex-direction:column;gap:8px}
  .fi{display:flex;gap:14px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--bad);border-radius:10px;padding:11px 15px}
  .fi.warn{border-left-color:var(--warn)}
  .fi .ft{font-size:11.5px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap;padding-top:2px;width:88px;flex:none}
  .fi .fb{flex:1;min-width:0}
  .fi .fn{font-size:13.5px;font-weight:560;margin-bottom:2px}
  .fi .fm{font-size:12.5px;color:var(--dim)}
  .fi .fid{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--bad);white-space:nowrap;padding-top:3px}
  details summary{cursor:pointer;font-size:11.5px;color:var(--faint);margin-top:5px;list-style:none}
  details summary::-webkit-details-marker{display:none}
  details summary::before{content:"▸ ";font-size:10px}
  details[open] summary::before{content:"▾ "}
  details code{display:block;margin-top:5px;background:var(--code);padding:8px 10px;border-radius:7px;font-size:11.5px;color:var(--dim);white-space:pre-wrap;word-break:break-all;line-height:1.55}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(372px,1fr));gap:12px}
  .card{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--line);border-radius:11px;padding:13px 16px 11px;display:flex;flex-direction:column;gap:7px}
  .card.b-block{border-left-color:var(--bad)}
  .card.b-warn{border-left-color:var(--warn)}
  .card.b-steer{border-left-color:var(--steer)}
  .card.off{opacity:.46}
  .card.gone{opacity:.5;border-style:dashed}
  .msg{font-size:12.5px;color:var(--dim)}
  .fix{font-size:12px;color:var(--warn)}
  .notes{font-size:11.5px;color:var(--faint);border-left:2px solid var(--line);padding-left:9px;display:flex;flex-direction:column;gap:2px}
  .ops{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:2px}
  .del{font-size:11.5px;color:var(--faint);cursor:pointer;border-bottom:1px dotted var(--line);white-space:nowrap}
  .del:hover{color:var(--bad)}
  button.mini{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:3px 10px;font-size:12px;cursor:pointer;font-family:inherit}
  button.mini:hover{border-color:var(--dim)}
  .crow{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
  .jid{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--faint)}
  .jtitle{font-size:14px;font-weight:560;margin:1px 0 0}
  .tag{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--faint);white-space:nowrap}
  .tag.block{color:var(--bad);border-color:var(--bad)}
  .tag.warn{color:var(--warn);border-color:var(--warn)}
  .hit{font-size:12px;color:var(--dim)}
  .hit b{color:var(--text);font-variant-numeric:tabular-nums;font-size:13px}
  .sw{position:relative;width:42px;height:23px;border-radius:999px;background:var(--line);cursor:pointer;flex:none;transition:background .15s}
  .sw::after{content:"";position:absolute;top:2.5px;left:2.5px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
  .sw.on{background:var(--on)}
  .sw.on::after{transform:translateX(19px)}
  .sw.busy{opacity:.5;pointer-events:none}
  .act{display:flex;border:1px solid var(--line);border-radius:999px;overflow:hidden;flex:none}
  .act b{font-size:11px;font-weight:400;padding:2px 9px;cursor:pointer;color:var(--faint);white-space:nowrap;user-select:none}
  .act b:hover{color:var(--text)}
  .act b.on{background:var(--text);color:var(--bg)}
  .act b.on.blk{background:var(--bad);color:#fff}
  .act b.on.wrn{background:var(--warn);color:#1b1f27}
  .foot{color:var(--faint);font-size:11.5px;line-height:1.85;margin-top:8px}
  .err{background:var(--card);border:1px solid var(--bad);color:var(--bad);padding:16px 18px;border-radius:11px;margin-bottom:14px}
  .empty{background:var(--card);border:1px dashed var(--line);border-radius:11px;padding:26px 22px;text-align:center;color:var(--dim);font-size:13px}
  .empty b{display:block;font-size:14px;color:var(--text);margin-bottom:6px}
  .how{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:16px 18px}
  .how h3{margin:0 0 8px;font-size:13.5px;font-weight:600}
  .how p{margin:0 0 10px;font-size:12.5px;color:var(--dim);line-height:1.75}
  .how pre{margin:0;background:var(--code);border-radius:8px;padding:11px 13px;font-size:11.5px;color:var(--dim);overflow-x:auto;line-height:1.6}
  .how .hintline{font-size:11.5px;color:var(--faint);margin-top:9px}
  .live{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:4px 17px}
  .lv{display:flex;gap:16px;align-items:baseline;padding:9px 0;border-top:1px solid var(--line)}
  .lv:first-child{border-top:0}
  .lv.noise{opacity:.58}
  .lvn{font-size:19px;font-weight:640;min-width:46px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dim);flex:none}
  .lvt{font-size:13.5px}
  .lvs{font-size:11.5px;color:var(--faint);margin-top:2px}
  .checkrow{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
  .checkout{font:12px/1.7 ui-monospace,Consolas,monospace;color:var(--dim);background:var(--code);border-radius:8px;padding:11px 13px;white-space:pre-wrap;margin-top:10px}
  .try{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:15px 17px}
  .tryrow{display:flex;gap:8px}
  .tryrow input{flex:1;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:9px 12px;color:var(--text);font:13px/1.5 ui-monospace,Consolas,monospace;outline:none}
  .tryrow input:focus{border-color:var(--dim)}
  .chips{margin-top:10px;font-size:12px;color:var(--faint)}
  .chip{display:inline-block;font-size:11.5px;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:2px 10px;margin:0 6px 6px 0;cursor:pointer}
  .chip:hover{color:var(--text);border-color:var(--dim)}
  .tryout{margin-top:12px;display:flex;flex-direction:column;gap:8px}
  .verdict{font-size:13px;padding:9px 13px;border-radius:9px;border:1px solid var(--line);line-height:1.6}
  .verdict.pass{border-color:var(--on);background:rgba(62,166,117,.07)}
  .verdict.pass b{color:var(--on)}
  .verdict.stop{border-color:var(--bad);background:rgba(210,84,74,.07)}
  .verdict.stop b{color:var(--bad)}
  .verdict .why{display:block;color:var(--dim);font-size:12px;margin-top:3px}
  .verdict .rid{color:var(--faint);font-size:11px;font-family:ui-monospace,Consolas,monospace;margin-left:7px}
  .ledger{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:14px 16px}
  .bar2{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
  button.tab2{background:transparent;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:3px 12px;cursor:pointer;font-size:12.5px;font-family:inherit}
  button.tab2.on{background:var(--text);color:var(--bg);border-color:var(--text)}
  select.sel2{background:var(--code);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:4px 8px;font-size:12.5px;font-family:inherit;max-width:260px}
  .hits{display:flex;flex-direction:column;gap:6px;max-height:420px;overflow-y:auto}
  .hrow{display:flex;gap:12px;align-items:flex-start;border-top:1px solid var(--line);padding-top:6px}
  .hrow:first-child{border-top:none;padding-top:0}
  .ht{font-size:11.5px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap;width:92px;flex:none;padding-top:2px}
  .hs{font-size:10.5px;border-radius:999px;padding:0 7px;border:1px solid var(--line);white-space:nowrap;flex:none;margin-top:1px}
  .hs.s-拦下{color:var(--bad);border-color:var(--bad)}
  .hs.s-提示{color:var(--warn);border-color:var(--warn)}
  .hs.s-未验{color:var(--dim)}
  .hb{flex:1;min-width:0}
  .hid{font-size:11.5px;color:var(--faint);font-family:ui-monospace,Consolas,monospace}
  .addform{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;margin-top:12px}
  .frow{display:flex;flex-direction:column;gap:4px}
  .frow label{font-size:11.5px;color:var(--faint)}
  .frow input,.frow select{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:7px 10px;color:var(--text);font-size:12.5px;font-family:inherit;outline:none}
  .frow input:focus,.frow select:focus{border-color:var(--dim)}
  .addfoot{grid-column:1/-1;display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:4px}
  .addmsg{font-size:12.5px}
  .shot .del,.shot .sw,.shot .act,.shot #theme,.shot .bar{display:none}
</style></head>
<body>
<header>
  <div class="top">
    <div class="brand">
      <div class="logo"><svg viewBox="0 0 32 32" width="31" height="31" aria-hidden="true"><circle cx="16" cy="4" r="2.1" fill="#fff"/><g stroke="#fff" stroke-width="2.6" stroke-linecap="round"><line x1="4.2" y1="7.6" x2="27.8" y2="7.6"/><line x1="16" y1="6" x2="16" y2="19.4"/></g><path d="M3.2 10.4 H12.6 A4.7 4.7 0 0 1 3.2 10.4 Z" fill="#fff"/><path d="M19.4 10.4 H28.8 A4.7 4.7 0 0 1 19.4 10.4 Z" fill="#fff"/><rect x="8.2" y="20.2" width="15.6" height="2.4" rx="1" fill="#fff" opacity="0.95"/><rect x="9.4" y="23.4" width="13.2" height="2.4" rx="1" fill="#fff" opacity="0.8"/><rect x="10.6" y="26.6" width="10.8" height="2.4" rx="1" fill="#fff" opacity="0.65"/></svg></div>
      <div>
        <h1>弱裁判</h1>
        <div class="tag">AI 动手之前，先看它要干什么</div>
      </div>
    </div>
    <div class="stats">
      <div class="stat hot"><b id="s-today">–</b><span>今天拦下</span></div>
      <div class="stat"><b id="s-week">–</b><span>近七天</span></div>
      <div class="stat"><b id="s-on">–</b><span>在位判据</span></div>
      <button id="theme" title="切换深浅色">☀</button>
    </div>
  </div>
  <div class="line" id="status-line"><span class="dot"></span>正在读…</div>
  <div class="trend" id="trend"></div>
  <div class="bar" id="bar">
    <button class="tab on" data-f="all">全部</button>
    <button class="tab" data-f="on">在用的</button>
    <button class="tab" data-f="lib">判据库</button>
    <button class="tab" data-f="gone">已删</button>
    <input class="se" id="q" placeholder="搜编号、它拦什么、例子…（按 / 聚焦）">
  </div>
  <div class="store" id="store">改动存在哪 · 点开看</div>
</header>
<div class="wrap" id="wrap"></div>
<script>
let S = null, filter = 'all', q = '';
let bStatus = '', bRule = '';
const P = new URLSearchParams(location.search);
if(P.get('theme') === 'light') document.body.classList.add('light');
if(P.get('shot') === '1') document.body.classList.add('shot');
if(P.get('f')) filter = P.get('f');
if(P.get('q')) q = P.get('q');

function el(t, c, txt){ const e = document.createElement(t); if(c) e.className = c; if(txt!=null) e.textContent = txt; return e; }
function esc(s){ return String(s==null?'':s); }
function shortTime(at){
  const m = String(at||'').match(/^(\\d{4})-(\\d{2})-(\\d{2})\\s+(\\d{2}:\\d{2})/);
  if(!m) return String(at||'');
  const today = new Date();
  const p2 = (x)=>String(x).padStart(2,'0');
  const ymd = today.getFullYear()+'-'+p2(today.getMonth()+1)+'-'+p2(today.getDate());
  const d = m[1]+'-'+m[2]+'-'+m[3];
  return d === ymd ? ('今天 '+m[4]) : (m[2]+'-'+m[3]+' '+m[4]);
}
function titleOf(id){
  const j = (S.judges||[]).find(x=>String(x.id).toUpperCase()===String(id).toUpperCase());
  return j ? (j.title||j.id) : id;
}

// 近七天柱状：从 byDay 现算，不落第二份真相
function renderTrend(){
  const box = document.getElementById('trend');
  box.textContent = '';
  const byDay = (S.hits && S.hits.byDay) || {};
  const p2 = (x)=>String(x).padStart(2,'0');
  const days = [];
  for(let i=6;i>=0;i--){
    const d = new Date(); d.setDate(d.getDate()-i);
    const key = d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate());
    days.push({ key, label: (i===0?'今天':(p2(d.getMonth()+1)+'/'+p2(d.getDate()))), n: byDay[key]||0 });
  }
  const max = Math.max(1, ...days.map(d=>d.n));
  for(const d of days){
    const col = el('div','tl');
    const bar = el('div','tb' + (d.n?' has':''));
    bar.style.height = Math.round(2 + (d.n/max)*26) + 'px';
    bar.title = d.label + '：拦下 ' + d.n + ' 次';
    col.appendChild(bar);
    col.appendChild(el('div','td', d.n ? String(d.n) : ''));
    const lab = el('div','td', d.label);
    lab.style.color = 'var(--faint)';
    col.appendChild(lab);
    box.appendChild(col);
  }
}

function render(){
  const wrap = document.getElementById('wrap');
  wrap.textContent = '';
  const bar = document.getElementById('bar');
  const trend = document.getElementById('trend');
  document.getElementById('s-today').textContent = '–';

  if(!S || !S.ok){
    bar.style.display = 'none'; trend.style.display = 'none';
    const e = el('div','err', (S && S.error) ? ('读不到状态：' + S.error) : '读不到状态');
    wrap.appendChild(e);
    const tip = el('div','empty');
    tip.innerHTML = '<b>面板连不上闸的数据</b>这个页面是本地起的服务，读的是同目录下的 rules 与账本。'
      + '<br>先确认没有别的东西占着端口，再看启动窗口里打印的三行路径对不对。';
    wrap.appendChild(tip);
    return;
  }

  // 顶部三个数字
  const byDay = (S.hits && S.hits.byDay) || {};
  const p2 = (x)=>String(x).padStart(2,'0');
  const now = new Date();
  const todayKey = now.getFullYear()+'-'+p2(now.getMonth()+1)+'-'+p2(now.getDate());
  let week = 0;
  for(let i=0;i<7;i++){ const d=new Date(); d.setDate(d.getDate()-i); week += byDay[d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())]||0; }
  document.getElementById('s-today').textContent = byDay[todayKey] || 0;
  document.getElementById('s-week').textContent = week;
  document.getElementById('s-on').textContent = S.online.on + '/' + S.online.total;

  // 一句状态话：先告诉人「它现在在不在干活」
  const st = document.getElementById('status-line');
  st.textContent = '';
  const dot = el('span','dot' + (S.online.on ? '' : ' off'));
  st.appendChild(dot);
  const bits = [];
  if(!S.online.on){
    bits.push('一条判据都没装，闸现在不会拦任何东西');
  }else{
    const last = (S.hits && S.hits.lastAt) ? shortTime(S.hits.lastAt) : '';
    bits.push('闸在跑，' + S.online.on + ' 条判据在位');
    bits.push(last ? ('最近一次拦下是 ' + last) : '这段时间还没拦过东西');
    if(S.hits && S.hits.blocked) bits.push('账本里累计拦下 ' + S.hits.blocked + ' 次');
  }
  if(S.hits && S.hits.missing) bits.push('拦截账本没找到，下面这些次数都是 0');
  st.appendChild(el('span', null, bits.join('　·　')));
  renderTrend();

  // 路径：默认藏，点开才看
  const store = document.getElementById('store');
  store.textContent = '改动存在哪 · 点开看';
  store.className = 'store';
  store.onclick = () => {
    if(store.classList.contains('open')) { store.textContent = '改动存在哪 · 点开看'; store.className='store'; return; }
    store.textContent = (S.dataDir || '?') + '　·　改这一份才影响 DSH 实际拦什么';
    store.className = 'store open';
  };

  // 一、它最近替你挡下的（人话优先）
  const sec1 = el('section','blk');
  const h1 = el('h2');
  h1.textContent = '它最近替你挡下的 ';
  h1.appendChild(el('em', null, (S.hits && S.hits.recent && S.hits.recent.length) ? ('最近 ' + S.hits.recent.length + ' 条') : ''));
  sec1.appendChild(h1);
  const recent = (S.hits && S.hits.recent) || [];
  if(!recent.length){
    const e = el('div','empty');
    e.innerHTML = '<b>这段时间没有拦下过任何调用</b>'
      + '没有拦截有两层意思：可能是你确实没碰到会出事的手，也可能判据没装或账本没找到。'
      + '<br>上面那行状态会告诉你闸在不在跑。';
    sec1.appendChild(e);
  }else{
    const feed = el('div','feed');
    for(const r of recent.slice(0,4)){
      const ids = (r.ids && r.ids.length) ? r.ids : [];
      const main = ids.length ? ids[0] : '';
      const body = String(r.why||'').replace(/^\\[[^\\]]*\\]\\s*/, '');
      const j = (S.judges||[]).find(x=>String(x.id).toUpperCase()===String(main).toUpperCase());
      const item = el('div','fi' + (j && j.action === 'warn' ? ' warn' : ''));
      item.appendChild(el('div','ft', shortTime(r.at)));
      const b = el('div','fb');
      const shownTitle = (j && j.title && j.title !== main) ? j.title : ('参数或动作不合规 · ' + String(r.tool || ''));
      b.appendChild(el('div','fn', shownTitle));
      b.appendChild(el('div','fm', j && j.message ? j.message : body));
      if(r.tool || body){
        const d = el('details');
        d.appendChild(el('summary', null, '原始记录'));
        d.appendChild(el('code', null, (r.tool ? ('工具：' + r.tool + '\\n') : '') + body));
        b.appendChild(d);
      }
      item.appendChild(b);
      if(main && !(j && j.title === main)) item.appendChild(el('div','fid', main));
      feed.appendChild(item);
    }
    sec1.appendChild(feed);
  }
  wrap.appendChild(sec1);

  // 一·五、它在留意什么：观察期攒着的形态，还没写成规矩（数据来自 data\mine-live.json）
  const live = S.live || {};
  const forms = live.forms || [];
  if(forms.length){
    const secL = el('section','blk');
    const hl = el('h2');
    hl.textContent = '它最近在留意什么　';
    const lems = ['观察期：只攒次数，还没写成规矩'];
    if(live.updated) lems.push('更新于 ' + shortTime(live.updated));
    hl.appendChild(el('em', null, lems.join('　·　')));
    secL.appendChild(hl);
    const lbox = el('div','live');
    for(const f of forms.slice(0,8)){
      const row = el('div','lv' + (f.noise ? ' noise' : ''));
      row.appendChild(el('div','lvn', String(f.n)));
      const b = el('div','lvb');
      b.appendChild(el('div','lvt', f.title || f.key));
      const sub = [];
      if(f.rule) sub.push('已经有规矩在管它：' + f.rule);
      else if(f.noise) sub.push('噪音太大，不打算写成规矩');
      else sub.push('观察中，还没写成规矩');
      if(f.note) sub.push(f.note);
      b.appendChild(el('div','lvs', sub.join('　·　')));
      row.appendChild(b);
      lbox.appendChild(row);
    }
    secL.appendChild(lbox);
    wrap.appendChild(secL);
  }

  // 一·六、一键自检：命令行有的两件事，界面上也给个按钮
  const secC = el('section','blk');
  const secCh = el('h2');
  secCh.textContent = '一键自检　';
  secCh.appendChild(el('em', null, '命令行那两条，界面上也能点'));
  secC.appendChild(secCh);
  const cbox = el('div','how');
  const crow = el('div','checkrow');
  const bSelf = el('button','mini','跑一次自检');
  bSelf.onclick = () => runCheck('selftest', bSelf);
  const bPack = el('button','mini','查规则包完整性');
  bPack.onclick = () => runCheck('packs', bPack);
  crow.appendChild(bSelf); crow.appendChild(bPack);
  const ctip = el('span','lvs','自检＝每条规矩的用例能不能按预期响；完整性＝各包的指纹与清单对不对得上');
  crow.appendChild(ctip);
  cbox.appendChild(crow);
  const cout = el('div','checkout');
  cout.id = 'checkOut';
  cout.style.display = 'none';
  cbox.appendChild(cout);
  secC.appendChild(cbox);
  wrap.appendChild(secC);

  // 二、哪些规矩在干活
  let list = S.judges.slice();
  if(filter === 'on') list = list.filter(x => x.on && !x.removed);
  if(filter === 'lib'){
    const byId = new Map(S.judges.map(x => [String(x.id).toUpperCase(), x]));
    list = (S.catalogAll || []).map(c => {
      const rid = String(c.ruleId || c.id).toUpperCase();
      const j = byId.get(rid);
      if(j) return Object.assign({}, j, { dom: c.domain || '', libId: c.id });
      return { id: c.id, title: c.title || c.id, catalogOnly: true, dom: c.domain || '',
        message: c.message || '', fix: c.fix || '', cat: { notes: [].concat(c.notes || []) },
        on: false, removed: false, hit: 0, tip: 0, action: 'block', actionDefault: 'block', pack: '' };
    });
  }
  if(filter === 'gone') list = list.filter(x => x.removed);
  if(q){
    const k = q.toLowerCase();
    list = list.filter(x => {
      const cat = x.cat || {};
      const hay = [x.id, x.title, x.message, x.dom, cat.title, (cat.notes || []).join(' ')].join(' ').toLowerCase();
      return hay.includes(k);
    });
  }
  // 在用的按「干活多少」排，最吵的排前面；其他视图按包名排，读起来像目录
  if(filter === 'on' || filter === 'all'){
    list.sort((a,b) => (b.hit||0)-(a.hit||0) || String(a.pack||'').localeCompare(String(b.pack||'')) || String(a.id).localeCompare(String(b.id)));
  }else{
    list.sort((a,b) => String(a.dom||a.pack||'').localeCompare(String(b.dom||b.pack||'')) || String(a.id).localeCompare(String(b.id)));
  }

  const sec2 = el('section','blk');
  const sec2h = el('h2');
  sec2h.textContent = '这些规矩在管什么　';
  sec2h.appendChild(el('em', null, filter === 'all'
    ? ('共 ' + S.judges.filter(x=>!x.removed).length + ' 条，' + S.online.on + ' 条在位　·　按拦下的次数从多到少排')
    : (list.length + ' 条')));
  sec2.appendChild(sec2h);
  if(!list.length){
    const e = el('div','empty');
    const say = filter === 'lib' ? '判据库里没有符合筛选的条目'
      : filter === 'gone' ? '还没删过任何一条'
      : filter === 'on' ? '一条都没装，闸现在不会拦任何东西'
      : '这个筛选下没有判据';
    e.innerHTML = '<b>' + say + '</b>' + (filter === 'on' ? '切到「判据库」可以挑几条装上。' : '');
    sec2.appendChild(e);
  }else{
    const grid = el('div','grid');
    for(const j of list){
      const blk = j.removed ? '' : (j.action === 'warn' ? ' b-warn' : (j.action === 'steer' ? ' b-steer' : ' b-block'));
      const card = el('div','card' + blk + (j.removed ? ' gone' : (j.on ? '' : ' off')));
      const row = el('div','crow');
      const left = el('div');
      left.appendChild(el('div','jid', j.id + '　·　' + (j.catalogOnly ? ('判据库 · ' + (j.dom || '')) : (j.pack || '')) + (j.removed ? '　·　已删' : '')));
      left.appendChild(el('div','jtitle', j.title));
      const right = el('div'); right.style.display='flex'; right.style.gap='8px'; right.style.alignItems='center';
      if(j.catalogOnly){
        const tag = el('b','mini','还没写成规则');
        tag.title = '判据库里有这一条，规则包里还没有对应的机器判据，所以暂时装不了';
        right.appendChild(tag);
      } else if(j.removed){
        const back = el('button','mini','恢复');
        back.title = '放回库里，按原来的装/卸状态';
        back.onclick = () => act(j.id, 'restore');
        right.appendChild(back);
      } else {
        const cur = j.overridden ? j.action : 'default';
        const actbox = el('div','act');
        for(const pair of [['block','拦','blk'],['warn','提示','wrn'],['default','默认','']]){
          const v = pair[0], label = pair[1], cls = pair[2];
          const b = el('b', (cur === v ? 'on ' : '') + cls, label);
          b.title = v === 'default'
            ? ('按包里写的来：' + (j.actionDefault === 'block' ? '拦下' : '只提示'))
            : (v === 'block' ? '命中就拦下这次调用' : '命中只提示，不拦');
          b.onclick = () => setAct(j, v);
          actbox.appendChild(b);
        }
        const sw = el('div','sw' + (j.on ? ' on' : ''));
        sw.title = j.on ? '点击卸下这条（还留在库里）' : '点击装上这条';
        sw.onclick = () => flip(j.id, !j.on, sw);
        right.appendChild(actbox); right.appendChild(sw);
      }
      row.appendChild(left); row.appendChild(right);
      card.appendChild(row);

      if(j.message) card.appendChild(el('div','msg', j.message));
      if(j.fix) card.appendChild(el('div','fix', '怎么救：' + j.fix));
      if(j.cat && j.cat.notes && j.cat.notes.length){
        const keep = j.cat.notes.filter((n) => /^(例子|边界|已测)/.test(String(n)));
        if(keep.length){
          const box = el('div','notes');
          for(const n of keep) box.appendChild(el('div', null, n));
          card.appendChild(box);
        }
      }

      const ops = el('div','ops');
      const h = el('div','hit');
      if(j.catalogOnly) h.textContent = '闸里还没有这条机器判据，先在这儿看说明';
      else if(j.removed) h.textContent = '已从闸里拿掉';
      else if(j.action === 'block') h.innerHTML = '拦过 <b>' + j.hit + '</b> 次';
      else if(j.action === 'warn') h.innerHTML = '提示过 <b>' + j.tip + '</b> 次（不拦）';
      else h.innerHTML = '拦过 <b>' + j.hit + '</b> 次 · 提示 <b>' + j.tip + '</b> 次';
      if(!j.catalogOnly && !j.removed && j.overridden) h.innerHTML += '　·　<b>你改的</b>（包里是' + (j.actionDefault === 'block' ? '拦下' : '只提示') + '）';
      ops.appendChild(h);
      if(!j.removed && !j.catalogOnly){
        const del = el('b','del','删掉');
        del.title = '这条我不要了：从列表和判断里都拿掉，包文件不动，随时能恢复';
        del.onclick = () => delRule(j);
        ops.appendChild(del);
      }
      card.appendChild(ops);
      grid.appendChild(card);
    }
    sec2.appendChild(grid);
  }
  wrap.appendChild(sec2);

  // 三、账本：三种状态都摆出来，能按判据筛
  const secB = el('section','blk');
  const secBh = el('h2');
  secBh.textContent = '账本　';
  secBh.appendChild(el('em', null, '拦下 / 提示 / 未验三态都在，可以按判据筛'));
  secB.appendChild(secBh);
  const bwrap = el('div','ledger');
  const bbar = el('div','bar2');
  for(const pair of [['全部',''],['拦下','拦下'],['提示','提示'],['未验','未验']]){
    const c = el('button','tab2' + (bStatus === pair[1] ? ' on' : ''), pair[0]);
    c.onclick = () => { bStatus = pair[1]; loadHits(); };
    bbar.appendChild(c);
  }
  const rsel = el('select','sel2');
  rsel.id = 'ruleSel';
  rsel.onchange = () => { bRule = rsel.value; loadHits(); };
  bbar.appendChild(rsel);
  const hc = el('span','lvs','');
  hc.id = 'hitCount';
  bbar.appendChild(hc);
  bwrap.appendChild(bbar);
  const hlist = el('div','hits');
  hlist.id = 'hitList';
  bwrap.appendChild(hlist);
  secB.appendChild(bwrap);
  wrap.appendChild(secB);

  // 四、试一试：不用信我说的，自己丢一条命令进去看
  const secT = el('section','blk');
  const secTh = el('h2');
  secTh.textContent = '试一试　';
  secTh.appendChild(el('em', null, '写一条命令，看闸怎么反应（只判不跑，命令一个字符都不会执行）'));
  secT.appendChild(secTh);
  const tbox = el('div','try');
  const trow = el('div','tryrow');
  const tin = el('input');
  tin.id = 'tryIn';
  tin.placeholder = '比如 Remove-Item $dir -Recurse -Force';
  tin.onkeydown = (e) => { if(e.key === 'Enter') doTry(tin.value); };
  const tgo = el('button','mini','判一下');
  tgo.onclick = () => doTry(tin.value);
  trow.appendChild(tin); trow.appendChild(tgo);
  tbox.appendChild(trow);
  const chips = el('div','chips');
  chips.appendChild(document.createTextNode('常见写法：'));
  const samples = [
    ['递归删一个变量指向的目录', 'Remove-Item $old -Recurse -Force'],
    ['递归删一个字面路径', "Remove-Item -LiteralPath 'D:/proj/_tmp/backup-20261123' -Recurse -Force"],
    ['删掉一张表', 'psql -c "DROP TABLE users"'],
    ['看个时间', 'Get-Date']
  ];
  for(const s of samples){
    const c = el('span','chip', s[0]);
    c.onclick = () => { tin.value = s[1]; doTry(s[1]); };
    chips.appendChild(c);
  }
  tbox.appendChild(chips);
  const tout = el('div','tryout');
  tout.id = 'tryOut';
  tbox.appendChild(tout);
  secT.appendChild(tbox);
  wrap.appendChild(secT);

  // 五、加一条自己的规矩（这是这套东西最不一样的地方，得让人真能加）
  const sec3 = el('section','blk');
  sec3.appendChild(el('h2', null, '想管的事，可以自己加一条'));
  const how = el('div','how');
  how.appendChild(el('h3', null, '规矩是数据，不是代码'));
  how.appendChild(el('p', null, '默认这套只是起点。你被哪条坑过就照着加一条，写进 mine 包，重启 DSH 生效，不用改程序、不用重新编译。下面填完点按钮就存进去了；想看 JSON 长什么样，样例在这儿。'));
  const pre = el('pre');
  // 用实体写反斜杠：模板字符串与 JS 字符串各转义一层，直接在源码里写会显示成两个反斜杠
  pre.innerHTML = '{<br>&nbsp;&nbsp;"id": "MY-RM-RF-01",<br>&nbsp;&nbsp;"when": "tool:pre",'
    + '<br>&nbsp;&nbsp;"appliesTo": { "tool": "pwsh" },'
    + '<br>&nbsp;&nbsp;"condition": { "type": "regexHit", "target": "args.command", "pattern": "rm&#92;&#92;s+-rf" },'
    + '<br>&nbsp;&nbsp;"action": "warn",'
    + '<br>&nbsp;&nbsp;"message": "这条命令一跑就没了，先确认你要删的是哪个目录"<br>}';
  how.appendChild(pre);

  const form = el('form','addform');
  form.onsubmit = (e) => { e.preventDefault(); submitRule(form); };
  const fields = [
    ['id','编号','MY-YYYYMMDD-HHMM'],
    ['title','这条管什么','比如 命令里出现 rm -rf'],
    ['tool','管哪个工具','pwsh / write / 其它工具名'],
    ['pattern','命中什么样子（正则）','比如 rm\\\\s+-rf 或 Delete-Item'],
    ['message','提示语','给人看的一句话，说清怎么改']
  ];
  for(const f of fields){
    const row = el('div','frow');
    row.appendChild(el('label', null, f[1]));
    const inp = el('input');
    inp.name = f[0];
    inp.placeholder = f[2];
    if(f[0] === 'id') inp.value = nextRuleId();
    if(f[0] === 'tool') inp.value = 'pwsh';
    row.appendChild(inp);
    form.appendChild(row);
  }
  const arow = el('div','frow');
  arow.appendChild(el('label', null, '命中之后'));
  const asel = el('select');
  asel.name = 'action';
  for(const pair of [['warn','只提示（先观察一周）'],['block','拦下这次调用']]){
    const o = el('option', null, pair[1]);
    o.value = pair[0];
    asel.appendChild(o);
  }
  arow.appendChild(asel);
  form.appendChild(arow);

  const afoot = el('div','addfoot');
  const sub = el('button','mini','写进我的规矩');
  sub.type = 'submit';
  afoot.appendChild(sub);
  const amsg = el('span','addmsg','');
  amsg.id = 'addMsg';
  afoot.appendChild(amsg);
  form.appendChild(afoot);
  how.appendChild(form);

  how.appendChild(el('div','hintline','「命中什么样子」填的是正则：竖线表示或，\\s 是空白，\\d 是数字。拿不准就先选「只提示」，观察一周再改成拦下。'));
  if(S.packs && S.packs.length){
    how.appendChild(el('div','hintline','现有的规则包：' + S.packs.map(p => p.id + '(' + (p.rules||0) + ')').join('　') ));
  }
  sec3.appendChild(how);
  wrap.appendChild(sec3);

  // 底部：怎么用这套开关
  const f = el('div','foot');
  f.innerHTML = '开关与档位走的是 <code>judge-packs.cjs</code> 本体，和命令行同一套判断；每次手动开关都记进 <code>data/panel-ledger.jsonl</code>。'
    + '　·　三档是「这条装上以后多严」：拦就当场拒掉这次调用，提示只记一笔，默认按作者写的来。'
    + '　·　「删掉」是这条我不要了，包文件一个字不动，随时能恢复。'
    + '　·　改完需要重启 DSH 才生效（闸在启动时载入）。';
  wrap.appendChild(f);

  loadHits();
}

async function act(id, verb){
  try{
    const r = await fetch('/api/' + verb, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({id})});
    const d = await r.json();
    if(!d.ok){ alert('没成功：' + (d.error || '')); return; }
    S = d.state; render();
  }catch(e){ alert('请求失败：' + e.message); }
}

async function delRule(j){
  if(!confirm('把 ' + j.id + ' 删掉？\\n\\n删掉后它不再拦任何东西，列表里也看不到；包文件不动，随时能恢复。')) return;
  await act(j.id, 'delete');
}

async function setAct(j, v){
  try{
    const r = await fetch('/api/action', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({id:j.id, action:v})});
    const d = await r.json();
    if(!d.ok){ alert('没成功：' + (d.error || '')); return; }
    S = d.state; render();
  }catch(e){ alert('请求失败：' + e.message); }
}

async function flip(id, on, sw){
  sw.classList.add('busy');
  try{
    const r = await fetch('/api/toggle', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({id, on})});
    const d = await r.json();
    if(!d.ok){ alert('没成功：' + (d.error || '')); sw.classList.remove('busy'); return; }
    S = d.state; render();
  }catch(e){ alert('请求失败：' + e.message); sw.classList.remove('busy'); }
}

async function loadHits(){
  const box = document.getElementById('hitList');
  if(!box) return;
  box.textContent = '读账本…';
  const qs = '?limit=100'
    + (bStatus ? ('&status=' + encodeURIComponent(bStatus)) : '')
    + (bRule ? ('&rule=' + encodeURIComponent(bRule)) : '');
  let d;
  try{ d = await (await fetch('/api/hits' + qs)).json(); }
  catch(e){ box.textContent = '读账本失败：' + e.message; return; }
  if(!d.ok){ box.textContent = '读账本失败：' + (d.error || ''); return; }

  const sel = document.getElementById('ruleSel');
  if(sel){
    sel.textContent = '';
    const all = el('option', null, '按判据筛（共 ' + (d.rules || []).length + ' 条）');
    all.value = '';
    sel.appendChild(all);
    for(const r of (d.rules || [])){
      const o = el('option', null, r.id + '（' + r.n + '）');
      o.value = r.id;
      sel.appendChild(o);
    }
    sel.value = bRule;
  }
  const hc = document.getElementById('hitCount');
  if(hc) hc.textContent = '有反应的共 ' + d.total + ' 条（拦下/提示/未验），当前筛出 ' + d.matched + ' 条，显示最近 ' + d.rows.length + ' 条';

  box.textContent = '';
  if(!d.rows.length){ box.appendChild(el('div','empty','这个筛选下没有记录')); return; }
  for(const r of d.rows){
    const row = el('div','hrow');
    row.appendChild(el('div','ht', shortTime(r.at)));
    row.appendChild(el('div','hs s-' + r.status, r.status));
    const b = el('div','hb');
    b.appendChild(el('div','hid', (r.ids && r.ids.length ? r.ids.join(' ') : '（老记录，没带编号）') + '　·　' + r.tool));
    const dd = el('details');
    dd.appendChild(el('summary', null, '看原文'));
    dd.appendChild(el('code', null, r.why));
    b.appendChild(dd);
    row.appendChild(b);
    box.appendChild(row);
  }
}

async function submitRule(form){
  const msg = document.getElementById('addMsg');
  const btn = form.querySelector('button[type=submit]');
  const data = {};
  new FormData(form).forEach((v, k) => { data[k] = String(v).trim(); });
  if(msg){ msg.textContent = '写着…'; msg.style.color = 'var(--dim)'; }
  if(btn) btn.disabled = true;
  try{
    const r = await fetch('/api/addrule', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(data)});
    const d = await r.json();
    if(msg){
      msg.textContent = d.ok ? ('已经写进 mine 包了（现在共 ' + d.count + ' 条），重启 DSH 后生效') : ('没写成：' + (d.error || ''));
      msg.style.color = d.ok ? 'var(--on)' : 'var(--bad)';
    }
    if(d.ok){
      const idIn = form.querySelector('input[name=id]');
      if(idIn) idIn.value = nextRuleId();
      S = await (await fetch('/api/state')).json();
      render();
    }
  }catch(e){ if(msg){ msg.textContent = '请求失败：' + e.message; msg.style.color = 'var(--bad)'; } }
  if(btn) btn.disabled = false;
}

function nextRuleId(){
  const d = new Date();
  const p2 = (x)=>String(x).padStart(2,'0');
  return 'MY-' + d.getFullYear() + p2(d.getMonth()+1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes());
}

async function runCheck(kind, btn){
  const out = document.getElementById('checkOut');
  if(!out) return;
  out.style.display = 'block';
  out.textContent = '跑着呢…';
  if(btn) btn.disabled = true;
  try{
    const r = await fetch('/api/' + kind, {method:'POST'});
    const d = await r.json();
    const lines = String(d.out || d.error || '没有输出').split(/\\r?\\n/).filter((x) => x.trim());
    out.textContent = '';
    // 只把最后一行（结论）摆在明面上，逐项明细折起来——35 行铺开会把整屏吃掉
    const sum = el('div', null, lines[lines.length - 1] || '没有输出');
    sum.style.color = d.ok ? 'var(--on)' : 'var(--bad)';
    sum.style.fontWeight = '600';
    out.appendChild(sum);
    if(lines.length > 3){
      const more = el('details');
      more.appendChild(el('summary', null, '看全部 ' + lines.length + ' 行'));
      const pre = el('div');
      pre.style.marginTop = '8px';
      pre.style.whiteSpace = 'pre-wrap';
      pre.textContent = lines.slice(0, -1).join('\\n');
      more.appendChild(pre);
      out.appendChild(more);
    }
  }catch(e){ out.textContent = '请求失败：' + e.message; }
  if(btn) btn.disabled = false;
}

async function doTry(text){
  const out = document.getElementById('tryOut');
  if(!out) return;
  out.textContent = '';
  if(!String(text||'').trim()){ out.appendChild(el('div','verdict','先写一条命令，或者点上面那几个例子')); return; }
  const wait = el('div','verdict','判着呢…');
  out.appendChild(wait);
  try{
    const r = await fetch('/api/try', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({tool:'pwsh', args:{command:String(text)}})});
    const d = await r.json();
    out.textContent = '';
    if(!d.ok){ out.appendChild(el('div','verdict stop','判失败：' + (d.error||''))); return; }
    if(!d.hits || !d.hits.length){
      const v = el('div','verdict pass');
      const b = el('b', null, '放行');
      v.appendChild(b);
      v.appendChild(document.createTextNode('　' + d.checked + ' 条检查过一遍，没有一条认为这条命令有问题'));
      out.appendChild(v);
      return;
    }
    for(const h of d.hits){
      const v = el('div','verdict ' + (h.action === 'block' ? 'stop' : 'pass'));
      const head = h.action === 'block' ? '拦下了' : (h.action === 'steer' ? '提醒一句' : '只提示');
      v.appendChild(el('b', null, head));
      if(h.title) v.appendChild(document.createTextNode('　' + h.title + '　'));
      v.appendChild(el('span','rid', h.id));
      if(h.message) v.appendChild(el('span','why', h.message));
      out.appendChild(v);
    }
  }catch(e){ out.textContent = ''; out.appendChild(el('div','verdict stop','请求失败：' + e.message)); }
}

document.querySelectorAll('button.tab').forEach(b => {
  if(b.dataset.f === filter){ document.querySelectorAll('button.tab').forEach(x=>x.classList.remove('on')); b.classList.add('on'); }
  b.onclick = () => {
    document.querySelectorAll('button.tab').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); filter = b.dataset.f; render();
  };
});
const qi = document.getElementById('q');
qi.value = q;
qi.oninput = (e) => { q = e.target.value.trim(); render(); };
document.addEventListener('keydown', (e) => {
  if(e.key === '/' && document.activeElement !== qi){ e.preventDefault(); qi.focus(); }
});
document.getElementById('theme').onclick = () => {
  document.body.classList.toggle('light');
  document.getElementById('theme').textContent = document.body.classList.contains('light') ? '☾' : '☀';
};

fetch('/api/state').then(r => r.json()).then(d => { S = d; render(); }).catch(e => { S = {ok:false,error:'取状态失败：' + e.message}; render(); });
</script>
</body></html>`;
}

// ---------- 服务 ----------
const server = http.createServer((req, res) => {
  const send = (code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    return send(200, 'text/html; charset=utf-8', page());
  }
  if (req.method === 'GET' && req.url.startsWith('/api/state')) {
    return send(200, 'application/json; charset=utf-8', JSON.stringify(readState()));
  }
  if (req.method === 'POST' && req.url.startsWith('/api/toggle')) {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 4096) req.destroy(); });
    req.on('end', () => {
      let d;
      try { d = JSON.parse(buf || '{}'); } catch { return send(400, 'application/json', JSON.stringify({ ok: false, error: '请求不是合法 JSON' })); }
      if (!d.id) return send(400, 'application/json', JSON.stringify({ ok: false, error: '缺 id' }));
      const r = toggle(String(d.id), !!d.on);
      if (!r.ok) return send(500, 'application/json; charset=utf-8', JSON.stringify(r));
      return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, out: r.out, state: readState() }));
    });
    return undefined;
  }
  if (req.method === 'POST' && req.url.startsWith('/api/action')) {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 4096) req.destroy(); });
    req.on('end', () => {
      let d;
      try { d = JSON.parse(buf || '{}'); } catch { return send(400, 'application/json', JSON.stringify({ ok: false, error: '请求不是合法 JSON' })); }
      if (!d.id) return send(400, 'application/json', JSON.stringify({ ok: false, error: '缺 id' }));
      const r = setAction(String(d.id), d.action);
      if (!r.ok) return send(500, 'application/json; charset=utf-8', JSON.stringify(r));
      return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, out: r.out, state: readState() }));
    });
    return undefined;
  }
  if (req.method === 'POST' && (req.url.startsWith('/api/delete') || req.url.startsWith('/api/restore'))) {
    const restoreIt = req.url.startsWith('/api/restore');
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 4096) req.destroy(); });
    req.on('end', () => {
      let d;
      try { d = JSON.parse(buf || '{}'); } catch { return send(400, 'application/json', JSON.stringify({ ok: false, error: '请求不是合法 JSON' })); }
      if (!d.id) return send(400, 'application/json', JSON.stringify({ ok: false, error: '缺 id' }));
      const r = delRule(String(d.id), restoreIt);
      if (!r.ok) return send(500, 'application/json; charset=utf-8', JSON.stringify(r));
      return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, out: r.out, state: readState() }));
    });
    return undefined;
  }
  if (req.method === 'POST' && req.url.startsWith('/api/try')) {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 65536) req.destroy(); });
    req.on('end', () => {
      let d;
      try { d = JSON.parse(buf || '{}'); } catch { return send(400, 'application/json', JSON.stringify({ ok: false, error: '请求不是合法 JSON' })); }
      const tool = String(d.tool || 'pwsh');
      const args = (d.args && typeof d.args === 'object') ? d.args : { command: String(d.text || '') };
      try {
        return send(200, 'application/json; charset=utf-8', JSON.stringify(tryJudge(tool, args)));
      } catch (e) {
        return send(500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return undefined;
  }
  if (req.method === 'POST' && (req.url.startsWith('/api/selftest') || req.url.startsWith('/api/packs'))) {
    const sub = req.url.startsWith('/api/selftest') ? 'selftest' : 'packs';
    try {
      const out = execFileSync(process.execPath, [path.join(ROOT, 'weakreferee-cli.js'), sub], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
      return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, out: String(out).trim() }));
    } catch (e) {
      const msg = String((e.stdout || '') + (e.stderr || '') || e.message).trim();
      return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, out: msg || '命令跑失败了，但没有输出' }));
    }
  }
  if (req.method === 'GET' && req.url.startsWith('/api/hits')) {
    const q = new URL(req.url, 'http://127.0.0.1').searchParams;
    try {
      return send(200, 'application/json; charset=utf-8', JSON.stringify(
        queryHits(q.get('rule') || '', q.get('status') || '', q.get('limit') || 100)
      ));
    } catch (e) {
      return send(500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: e.message }));
    }
  }
  if (req.method === 'POST' && req.url.startsWith('/api/addrule')) {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 16384) req.destroy(); });
    req.on('end', () => {
      let d;
      try { d = JSON.parse(buf || '{}'); } catch { return send(400, 'application/json', JSON.stringify({ ok: false, error: '请求不是合法 JSON' })); }
      const r = addRule(d);
      return send(r.ok ? 200 : 400, 'application/json; charset=utf-8', JSON.stringify(r));
    });
    return undefined;
  }
  return send(404, 'text/plain; charset=utf-8', '没有这个地址');
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log('判据面板：' + url);
  console.log('判据目录：' + ROOT);
  console.log('开关存储：' + DATA + (fs.existsSync(DATA) ? '' : '（这份还没建，改动会新建）'));
  console.log('拦截账本：' + LEDGER + (fs.existsSync(LEDGER) ? '' : '（没找到）'));
  console.log('要操作 DSH 真正加载的那份，加 --data "<运行位>\\data"');
  console.log('Ctrl+C 关掉');
  if (argv.includes('--open')) {
    try { execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' }); } catch { /* 打不开就自己点 */ }
  }
});
