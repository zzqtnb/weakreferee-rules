'use strict';
/**
 * scan：亲友版体检。
 *
 * 干的活：找本机 AI 客户端留下的历史记录 → 把里面的工具调用按现有判据重判一遍
 * → 出一页人话报告（看了多少次操作、几次踩坑、每类怎么改、各附一条脱敏例子）。
 *
 * 三条底线：
 *   1. 只读文件。不改记录、不写回、不联网。
 *   2. 判据不在这里。重判走 judge.js，和 replay 同一套，数字能对上。
 *   3. 报告里不出现真名、完整路径、学号这类东西。路径只留文件名，引号里的中文换成"…"。
 */
const fs = require('fs');
const path = require('path');
const J = require(path.join(__dirname, 'judge.js'));
const M = require(path.join(__dirname, 'mine.js'));

const SNIPPET = 90;
const DAY = 86400000;

/* ─────────────────────────────────────────────
 * 一、去哪找记录（探到再读，路径全部按环境变量算）
 * ───────────────────────────────────────────── */
function candidates() {
  const e = process.env;
  const home = e.USERPROFILE || '';
  const app = e.APPDATA || '';
  const loc = e.LOCALAPPDATA || '';
  const list = [];
  const add = (label, p) => { if (p) list.push({ label, dir: p }); };

  add('DSH 会话记录', e.DSH_HOME ? path.join(e.DSH_HOME, 'sessions') : '');
  add('DSH 会话记录', home ? path.join(home, '.dsh', 'sessions') : '');
  add('Claude Code 记录', home ? path.join(home, '.claude', 'projects') : '');
  add('Codex 记录', home ? path.join(home, '.codex', 'sessions') : '');
  add('Continue 记录', home ? path.join(home, '.continue') : '');
  add('LM Studio 记录', home ? path.join(home, '.lmstudio') : '');

  /* 编辑器插件：只认会留工具调用记录的那几个子目录，整个 globalStorage 别碰——
   * 里面几千个 json 全是插件自己的缓存，扫它只会慢，不会多出一条调用 */
  const editors = [
    app ? path.join(app, 'Code') : '',
    app ? path.join(app, 'Cursor') : '',
    app ? path.join(app, 'Windsurf') : '',
    app ? path.join(app, 'Trae') : '',
    loc ? path.join(loc, 'Programs', 'Microsoft VS Code', 'data', 'user-data') : '',
  ].filter(Boolean);
  const plugins = [
    path.join('User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'),
    path.join('User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks'),
    path.join('User', 'globalStorage', 'continue.continue'),
  ];
  for (const base of editors) for (const p of plugins) add('编辑器插件记录', path.join(base, p));

  add('Cherry Studio 记录', app ? path.join(app, 'CherryStudio', 'Data') : '');
  add('Chatbox 记录', app ? path.join(app, 'xyz.chatboxapp.app') : '');
  add('Jan 记录', app ? path.join(app, 'Jan', 'data') : '');
  return list;
}

function existing(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    let st;
    try { st = fs.statSync(c.dir); } catch { continue; }
    if (!st.isDirectory() && !st.isFile()) continue;
    let key = c.dir.toLowerCase();
    try { key = fs.realpathSync(c.dir).toLowerCase(); } catch { /* 用原串当键 */ }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/* ─────────────────────────────────────────────
 * 二、脱敏：给亲友看的例子，路径只留文件名，引号里的中文全换掉
 * ───────────────────────────────────────────── */
function baseName(p) {
  const seg = String(p).split(/[\\/]+/).filter(Boolean);
  return seg.length ? seg[seg.length - 1] : '';
}

function maskPaths(s) {
  return s
    .replace(/[A-Za-z]:[\\/][^"'\s;|&<>)]*/g, (m) => { const b = baseName(m); return b ? '…\\' + b : '…'; })
    .replace(/\\\\[^"'\s;|&<>)]*/g, (m) => { const b = baseName(m); return b ? '…\\' + b : '…'; });
}

function maskCmd(s) {
  let t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  /* 引号里带中文的整段换掉：命令的结构（工具名、参数、重定向）是要看的，正文不是 */
  t = t.replace(/(["'])[^"']*[\u3400-\u9fff][^"']*\1/g, '"…"');
  t = maskPaths(t);
  t = t.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '…@…');
  t = t.replace(/\d{6,}/g, '…');
  const user = process.env.USERNAME || '';
  if (user) t = t.split(user).join('…');
  if (t.length > SNIPPET) t = t.slice(0, SNIPPET) + '…';
  return t;
}

function maskPathArg(p) {
  const b = baseName(p || '');
  return b ? '…\\' + b : '…';
}

function sampleOf(call) {
  const a = call.args || {};
  const tool = String(call.tool || '');
  if (tool === 'pwsh' || tool === 'bash') {
    const c = maskCmd(a.command);
    return c ? '命令：' + c : '';
  }
  if (tool === 'write') return '写文件：' + maskPathArg(a.file_path || a.path);
  if (tool === 'edit') return '改文件：' + maskPathArg(a.file_path || a.path);
  if (tool === 'web_fetch') {
    let host = '';
    try { host = new URL(String(a.url || '')).host; } catch { host = ''; }
    return host ? '抓网页：' + host : '';
  }
  const brief = maskCmd(JSON.stringify(a));
  return brief ? tool + '：' + brief : '';
}

/* ─────────────────────────────────────────────
 * 三、坑的类别（ruleId → 亲友能听懂的一类事）
 * ───────────────────────────────────────────── */
const CATS = [
  {
    key: 'enc',
    rules: ['WIN-ENC-01'],
    name: '写文件时没说用哪种编码',
    fix: '写文件时加上 -Encoding utf8。中文用 > 直接重定向到文件最容易乱码，改成 Out-File -Encoding utf8。',
  },
  {
    key: 'ps1-cjk',
    rules: ['WIN-PS1-CJK-01', 'WIN-PS1-BOM-EDIT-01'],
    name: '往 PowerShell 脚本里写中文，文件头标记会丢',
    fix: '改 .ps1 别用普通编辑，改成一条命令：读全文、替换、再用 UTF8Encoding($true) 写回，写完看前三个字节是不是 239,187,191。',
  },
  {
    key: 'rm',
    rules: ['WIN-RMDIR-01'],
    name: '一次删一整层文件夹前没先试跑',
    fix: '删之前先加 -WhatIf 跑一遍，看清要删哪些；或者先把清单存成文件再删。',
  },
  {
    key: 'bat',
    rules: ['WIN-BAT-CJK-01'],
    name: '往 .bat 里写中文',
    fix: '批处理里只写英文。非要有中文，就在第一行加 chcp 65001，中文放到单独的文本文件里让 bat 去读。',
  },
  {
    key: 'autovar',
    rules: ['WIN-AUTOVAR-CMD-01', 'WIN-PS1-AUTOVAR-01'],
    name: '给 PowerShell 自己的变量重新赋值',
    fix: '变量名带自己的前缀，比如 $myHome，别用 $home、$pid、$args 这些，占了会让后面的命令行为乱掉。',
  },
  {
    key: 'irreversible',
    rules: ['WIN-IRREVERSIBLE-01'],
    name: '格式化、改服务这类动作前没留退路',
    fix: '先导出一份能还原的东西（注册表、服务设置、任务设置），再动手。',
  },
  {
    key: 'mirror',
    rules: ['WIN-MIRROR-01'],
    name: '整层复制或清空之前没看有没有目录链接',
    fix: '先列一遍目标，看到「链接」类型的目录就只删链接本身，别跟着进去。',
  },
  {
    key: 'backup',
    rules: ['SCENE-BACKUP-01'],
    name: '用命令改文件之前没先备份',
    fix: '改之前先把原文件复制一份，或者挪进回收站，改坏了能拿回来。',
  },
  {
    key: 'https',
    rules: ['CORE-HTTPS-01'],
    name: '抓网页用了 http',
    fix: '把 http:// 换成 https://。',
  },
];

const RULE_CAT = {};
for (const c of CATS) for (const r of c.rules) RULE_CAT[r] = c.key;
const CAT_BY_KEY = {};
for (const c of CATS) CAT_BY_KEY[c.key] = c;

/* 工具自己内部的流程提醒：照样计数，但不进「你的坑」那张榜 */
const INTERNAL_RULES = ['DSH-ANCHOR-01', 'DSH-STALE-JUDGE-01', 'CORE-PARAMS-GEN'];

/* ─────────────────────────────────────────────
 * 四、判一遍（与 replay 同一套判法与口径）
 * ───────────────────────────────────────────── */
function analyze(calls, rules) {
  const stat = { calls: 0, blocked: 0, warned: 0, passed: 0, errored: 0, byRule: {}, byTool: {}, samples: [] };
  const cats = new Map();
  const ts = [];
  let pitCalls = 0;
  let internalCalls = 0;
  let internalHits = 0;
  let flagged = 0;

  for (const c of calls) {
    if (!c || !c.tool) continue;
    stat.calls += 1;
    if (typeof c.t === 'number' && c.t > 0) ts.push(c.t);
    let hits;
    try {
      hits = J.judge({ when: 'tool:pre', tool: c.tool, args: c.args || {} }, rules);
    } catch (e) {
      stat.errored += 1;
      continue;
    }
    const adj = J.adjudicate(hits);
    stat.byTool[c.tool] = (stat.byTool[c.tool] || 0) + 1;
    if (adj.action === 'block') stat.blocked += 1;
    else if (adj.action === 'warn' || adj.action === 'steer') stat.warned += 1;
    else if (adj.action === 'error') stat.errored += 1;
    else stat.passed += 1;

    for (const h of adj.hits) {
      const id = h.ruleId ? h.ruleId : ('判不了:' + (h.error || 'unknown'));
      stat.byRule[id] = (stat.byRule[id] || 0) + 1;
    }
    if (adj.action === 'block' && stat.samples.length < 5) stat.samples.push({ tool: c.tool });

    // 分类按**全部命中**算，不看裁决后的 top 一条：别人客户端的记录常缺参数，
    // PARAM-MISSING 优先级更高，只看 top 会把内容类的坑盖掉，报告就成了「一次没踩坑」。
    if (adj.action !== 'pass') flagged += 1;
    const keys = new Set();
    let internal = 0;
    for (const h of hits) {
      if (h.ruleId && RULE_CAT[h.ruleId]) keys.add(RULE_CAT[h.ruleId]);
      if (h.ruleId && INTERNAL_RULES.includes(h.ruleId)) internal += 1;
    }
    internalHits += internal;

    if (keys.size) {
      pitCalls += 1;
      for (const k of keys) {
        const o = cats.get(k) || { n: 0, sample: '' };
        o.n += 1;
        if (!o.sample) o.sample = sampleOf(c);
        cats.set(k, o);
      }
    } else if (adj.action !== 'pass') {
      internalCalls += 1;
    }
  }

  stat.blockRate = stat.calls ? stat.blocked / stat.calls : 0;

  let span = null;
  if (ts.length) {
    let mn = ts[0];
    let mx = ts[0];
    for (const t of ts) { if (t < mn) mn = t; if (t > mx) mx = t; }
    span = { from: mn, to: mx, days: Math.max(0, Math.round((mx - mn) / DAY)) };
  }

  const rows = [...cats.entries()]
    .map(([k, v]) => ({ key: k, name: CAT_BY_KEY[k].name, fix: CAT_BY_KEY[k].fix, n: v.n, sample: v.sample }))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));

  return {
    stat, span, rows, pitCalls, internalCalls, internalHits,
    reconcile: { ok: pitCalls + internalCalls === flagged, pit: pitCalls, internal: internalCalls, flagged, blockedWarned: stat.blocked + stat.warned },
  };
}

/* ─────────────────────────────────────────────
 * 五、报告
 * ───────────────────────────────────────────── */
function ymd(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function scrub(text) {
  let t = text;
  let n = 0;
  const user = process.env.USERNAME || '';
  const comp = process.env.COMPUTERNAME || '';
  for (const s of [user, comp]) {
    if (!s || s.length < 3) continue;
    const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    t = t.replace(re, () => { n += 1; return '…'; });
  }
  t = t.replace(/[A-Za-z]:[\\/][^"'\s;|&<>)]*/g, (m) => { const b = baseName(m); n += 1; return b ? '…\\' + b : '…'; });
  return { text: t, count: n };
}

function render(r) {
  const L = [];
  if (r.empty) {
    L.push('弱裁判 · 历史体检');
    L.push('');
    L.push('没找到能读的记录。');
    L.push('');
    L.push('这不是工具坏了。常见的原因有两个：');
    L.push('  1. 你平时只在手机或网页上聊天。那种对话里没有「操作记录」，扫出来就是 0。');
    L.push('  2. 电脑上有 AI 工具，但记录放在别的地方，这次没探到。');
    L.push('');
    L.push('接着可以这样：');
    L.push('  · 知道记录在哪个文件夹：weakreferee scan "那个文件夹"');
    L.push('  · 手里有导出好的 json：格式像 [{"tool":"pwsh","args":{"command":"..."}}]，把文件路径给它');
    L.push('  · 只是想把 AI 给的命令问一遍：双击 傻瓜模式.bat，选 1，一次粘一条');
    L.push('');
    L.push('（这次找过的地方：' + (r.probed.length ? r.probed.join('、') : '没有可找的位置') + '）');
    return L.join('\n');
  }

  const s = r.stat;
  L.push('弱裁判 · 历史体检');
  L.push('只翻你自己的记录，不改一个字，也不上传任何东西。');
  L.push('');
  L.push('看了 ' + s.calls + ' 次操作，来自 ' + r.filesRead + ' 份记录'
    + (r.files > r.filesRead ? '（另有 ' + (r.files - r.filesRead) + ' 份读不了，跳过了）' : '') + '。');
  if (r.span) {
    L.push('时间跨度：' + ymd(r.span.from) + ' 到 ' + ymd(r.span.to)
      + (r.span.days > 0 ? '，中间 ' + r.span.days + ' 天。' : '，同一天。'));
  } else {
    L.push('记录里没有时间，跨多少天看不出来。');
  }
  L.push('');
  if (!r.rows.length) {
    L.push('一次坑都没踩到。');
    L.push('这不是工具坏了：多数人的记录里，正常操作本来就占绝大多数。');
  } else {
    L.push('踩了坑的 ' + r.pitCalls + ' 次（一次操作同时踩两种只算一次）。按类型排：');
    L.push('');
    const top = r.rows.slice(0, 5);
    top.forEach((x, i) => {
      L.push((i + 1) + '. ' + x.name + ' —— ' + x.n + ' 次');
      L.push('   下次怎么改：' + x.fix);
      if (x.sample) L.push('   你记录里的一条：' + x.sample);
    });
    if (r.rows.length > top.length) {
      const rest = r.rows.slice(top.length);
      L.push('');
      L.push('还有 ' + rest.length + ' 类，最多的 ' + rest[0].n + ' 次，没往下列。');
    }
  }
  L.push('');
  if (r.internalCalls > 0) {
    L.push('另有 ' + r.internalCalls + ' 次是工具自己的流程提醒（比如改文件前先确认原文还在、工具版本没更新这类），不算你的坑。');
  }
  L.push('这些只是提醒，不改你的记录，不上传任何内容。');
  return L.join('\n');
}

/* ─────────────────────────────────────────────
 * 六、入口
 * ───────────────────────────────────────────── */
function scan(opts) {
  const rules = opts.rules || [];
  const given = opts.target ? String(opts.target) : '';
  let sources;
  if (given) {
    const p = path.resolve(process.cwd(), given);
    sources = existing([{ label: '你指定的位置', dir: p }]);
    if (!sources.length) {
      return {
        empty: true, probed: [], files: 0, filesRead: 0,
        stat: { calls: 0, blocked: 0, warned: 0, passed: 0, errored: 0, byRule: {}, byTool: {}, samples: [] },
        span: null, rows: [], pitCalls: 0, internalCalls: 0, internalHits: 0,
        reconcile: { ok: true, pit: 0, internal: 0, flagged: 0, blockedWarned: 0 },
        notFound: p,
      };
    }
  } else {
    sources = existing(candidates());
  }

  /* 默认全读：数字要能和 replay 对上，砍文件就等于换了个口径。
   * 机器慢或目录特别大时才用 --max-files 限量，报告里会写「另有 N 份跳过了」。 */
  const perDir = opts.maxFiles > 0 ? opts.maxFiles : 0;
  const calls = [];
  let files = 0;
  let filesRead = 0;
  const probed = [];
  for (const s of sources) {
    probed.push(s.label);
    let got;
    try { got = M.collectCalls(s.dir, perDir); } catch { continue; }
    files += got.files;
    filesRead += got.filesRead;
    if (got.calls.length) calls.push(...got.calls);
  }

  const r = analyze(calls, rules);
  const out = Object.assign({}, r, {
    files, filesRead, probed,
    rulesLoaded: rules.length,
    empty: r.stat.calls === 0,
  });
  out.report = render(out);
  const sc = scrub(out.report);
  out.report = sc.text;
  out.scrubbed = sc.count;
  return out;
}

module.exports = { scan, render, analyze, sampleOf, maskCmd, maskPaths, scrub, CATS, candidates, existing };
