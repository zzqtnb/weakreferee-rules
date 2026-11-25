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

// 拦截账本：默认指向本项目工作区那份，可用 WR_LEDGER 覆盖
const LEDGER = process.env.WR_LEDGER || 'D:\\deepseek\\工作区\\弱裁判\\拦截.tsv';

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

  const judges = [];
  for (const j of d.judges || []) {
    for (const r of j.rules || []) {
      const packId = r.pack || j.pack || j.id;
      judges.push({
        id: r.id,
        title: r.text || j.title || r.id,
        action: r.action || 'block',
        pack: packId,
        on: isOn(r.id, packId),
        hit: hits.byRule[r.id] || 0,
        tip: hits.byRuleTip[r.id] || 0,
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

  return {
    ok: true,
    judges: uniq,
    packs,
    online: { on: uniq.filter((x) => x.on).length, total: uniq.length },
    packsOn: (installed.packs || []),
    soloOn: (installed.rules || []),
    hits,
    ledgerPath: LEDGER,
    dataDir: DATA,
  };
}

// ---------- 命中统计：从 拦截.tsv 现算，不做快照（快照会和流水各说各话）----------
function readHits() {
  const out = { byRule: {}, byRuleTip: {}, blocked: 0, total: 0, recent: [], lastAt: '', noTag: 0 };
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
      if (out.recent.length < 12) {
        out.recent.push({ at: f[0], tool: f[2], why: f[4].slice(0, 160), ids });
      }
      out.lastAt = f[0];
    }
  }
  out.recent.reverse();
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

// ---------- 页面 ----------
function page() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>判据面板 · 弱裁判</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--line:#262b36;--text:#e6e9ef;--dim:#8b93a1;--on:#3ea675;--off:#3a3f4b;--warn:#c9a227;--bad:#d2544a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  header{position:sticky;top:0;z-index:5;background:rgba(15,17,21,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:18px 24px}
  .hrow{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}
  h1{font-size:17px;margin:0;font-weight:600}
  .big{font-size:26px;font-weight:700;letter-spacing:-.5px}
  .big b{color:var(--on)}
  .sub{color:var(--dim);font-size:13px}
  .bar{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
  button.tab{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:999px;padding:5px 13px;cursor:pointer;font-size:13px}
  button.tab.on{background:#2a3140;border-color:#3d475a}
  input.se{background:var(--card);border:1px solid var(--line);color:var(--text);border-radius:999px;padding:5px 13px;font-size:13px;outline:none;min-width:200px}
  main{padding:20px 24px 64px;display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px}
  .store{font-size:11px;color:var(--dim);margin:6px 0 0;font-family:ui-monospace,Consolas,monospace;opacity:.7;word-break:break-all}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
  .card.off{opacity:.5}
  .crow{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
  .jid{font-family:ui-monospace,Consolas,monospace;font-size:13px;color:var(--dim)}
  .jtitle{font-size:14px;margin:2px 0 0}
  .tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
  .tag.block{color:#e07a70;border-color:#5a2f2b}
  .tag.warn{color:var(--warn);border-color:#4a3f1c}
  .hit{font-size:12px;color:var(--dim)}
  .hit b{color:var(--text);font-variant-numeric:tabular-nums}
  .sw{position:relative;width:42px;height:23px;border-radius:999px;background:var(--off);cursor:pointer;flex:none;transition:background .15s}
  .sw::after{content:"";position:absolute;top:2.5px;left:2.5px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s}
  .sw.on{background:var(--on)}
  .sw.on::after{transform:translateX(19px)}
  .sw.busy{opacity:.5;pointer-events:none}
  section.recent{grid-column:1/-1;margin-top:8px}
  section.recent h2{font-size:14px;font-weight:600;color:var(--dim);margin:0 0 10px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  td{padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}
  td.t{color:var(--dim);white-space:nowrap;font-variant-numeric:tabular-nums;width:150px}
  td.id{font-family:ui-monospace,Consolas,monospace;color:#e07a70;width:1%}
  .foot{grid-column:1/-1;color:var(--dim);font-size:12px;margin-top:16px;line-height:1.8}
  .err{grid-column:1/-1;background:#2a1517;border:1px solid #5a2f2b;color:#f0a9a1;padding:14px;border-radius:10px}
  code{background:#0b0d11;padding:1px 6px;border-radius:5px;font-size:12px}
</style></head>
<body>
<header>
  <div class="hrow">
    <h1>判据面板</h1>
    <div class="big" id="online">在位 <b>—</b></div>
    <div class="sub" id="hint">正在读…</div>
  </div>
  <div class="store" id="store"></div>
  <div class="bar">
    <button class="tab on" data-f="all">全部</button>
    <button class="tab" data-f="on">在位</button>
    <button class="tab" data-f="off">已关</button>
    <input class="se" id="q" placeholder="搜编号或它拦什么…">
  </div>
</header>
<main id="main"></main>
<script>
let S = null, filter = 'all', q = '';

function el(t, c, txt){ const e = document.createElement(t); if(c) e.className = c; if(txt!=null) e.textContent = txt; return e; }

function render(){
  const main = document.getElementById('main');
  main.textContent = '';
  if(!S || !S.ok){ main.appendChild(el('div','err', (S && S.error) || '读不到状态')); return; }

  document.getElementById('online').innerHTML = '在位 <b>' + S.online.on + '</b> / ' + S.online.total;
  const parts = [];
  if(S.packsOn.length) parts.push('包：' + S.packsOn.join('、'));
  if(S.soloOn.length) parts.push('单装：' + S.soloOn.join(' '));
  document.getElementById('hint').textContent = parts.join('　') || '一条都没装，闸不会拦任何东西';
  if(S.hits && S.hits.missing) document.getElementById('hint').textContent += '　（拦截账本没找到：' + S.ledgerPath + '）';
  const st = document.getElementById('store');
  if(st) st.textContent = '开关存在 ' + (S.dataDir || '?') + '　·　改这一份才影响 DSH 实际拦什么';

  let list = S.judges.slice();
  if(filter === 'on') list = list.filter(x => x.on);
  if(filter === 'off') list = list.filter(x => !x.on);
  if(q){ const k = q.toLowerCase(); list = list.filter(x => (x.id + ' ' + x.title).toLowerCase().includes(k)); }

  for(const j of list){
    const card = el('div', 'card' + (j.on ? '' : ' off'));
    const row = el('div','crow');
    const left = el('div');
    left.appendChild(el('div','jid', j.id + '　·　' + (j.pack || '')));
    left.appendChild(el('div','jtitle', j.title));
    const right = el('div'); right.style.display='flex'; right.style.gap='8px'; right.style.alignItems='center';
    const tg = el('span','tag ' + (j.action === 'block' ? 'block' : 'warn'), j.action === 'block' ? '拦下' : '只提示');
    const sw = el('div','sw' + (j.on ? ' on' : ''));
    sw.title = j.on ? '点击卸下这条' : '点击装上这条';
    sw.onclick = () => flip(j.id, !j.on, sw);
    right.appendChild(tg); right.appendChild(sw);
    row.appendChild(left); row.appendChild(right);
    card.appendChild(row);
    const h = el('div','hit');
    h.innerHTML = (j.action === 'block'
      ? '拦过 <b>' + j.hit + '</b> 次'
      : '提示过 <b>' + j.tip + '</b> 次（不拦）');
    card.appendChild(h);
    main.appendChild(card);
  }
  if(!list.length) main.appendChild(el('div','foot','这个筛选下没有判据'));

  const sec = el('section','recent');
  sec.appendChild(el('h2',null,'最近拦下的 ' + ((S.hits && S.hits.recent) ? S.hits.recent.length : 0) + ' 次（全部账本共拦 ' + ((S.hits && S.hits.blocked) || 0) + ' 次）'));
  if(S.hits && S.hits.recent && S.hits.recent.length){
    const tb = el('table');
    for(const r of S.hits.recent){
      const tr = el('tr');
      tr.appendChild(el('td','t', r.at));
      tr.appendChild(el('td','id', (r.ids && r.ids.length) ? r.ids.join(',') : '—'));
      const w = el('td', null, r.why); tr.appendChild(w);
      tb.appendChild(tr);
    }
    sec.appendChild(tb);
  }
  main.appendChild(sec);
  const f = el('div','foot');
  f.innerHTML = '装/卸走的是 <code>judge-packs.cjs</code> 本体，和命令行同一套判断；每次手动开关都记进 <code>data/panel-ledger.jsonl</code>。'
    + '卸下的判据不会消失，随时能打开。改完需要重启 DSH 才生效（闸在启动时载入）。';
  if(S.hits && S.hits.noTag){
    f.innerHTML += '<br>账本里有 <b>' + S.hits.noTag + '</b> 次拦下是改版前记的（那时账本不写判据号），只算进总数、归不到具体某条；'
      + '重启 DSH 之后的新记录才带编号，卡片上的次数从那一刻开始累计。';
  }
  main.appendChild(f);
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

document.querySelectorAll('button.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('button.tab').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); filter = b.dataset.f; render();
});
document.getElementById('q').oninput = (e) => { q = e.target.value.trim(); render(); };

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
