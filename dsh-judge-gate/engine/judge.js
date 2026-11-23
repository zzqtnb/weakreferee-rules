'use strict';
/**
 * 弱裁判 · 判定器（engine/judge.js）v0.1
 *
 * 职责边界（见 交警设计-v0.3 第 7 节）：
 *   包管「查什么」——一条规矩一个 JSON
 *   引擎管「怎么查」——条件类型的实现、多条命中的合并
 * 引擎不认识任何业务，只认识 condition.type。
 *
 * 验收口径：回放 18360 次调用必须复现 403 次命中，
 * 逐判据分布 165/100/91/29/12/5/1（参数形态/J16/J15/J8/J17/J3/J10）。
 */
const fs = require('fs');
const path = require('path');

/* ─────────────────────────────────────────────
 * 一、命令预处理
 * 引号内的字面量抹成等长空格：写操作词只有出现在引号外才算真的写操作。
 * 来源：paramcheck.js maskQuoted()。实测踩过——
 *   Select-String -Pattern 'Out-File|Set-Content' 曾被 J8 误拦。
 * ───────────────────────────────────────────── */
function maskQuoted(s) {
  let out = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) { q = null; out += c; } else out += ' ';
    } else if (c === '"' || c === "'") {
      q = c; out += c;
    } else {
      out += c;
    }
  }
  return out;
}

/* ─────────────────────────────────────────────
 * 二、取值
 * spec 形如 "args.command" / "args.file_path" / "replyText" / "tool"
 * ───────────────────────────────────────────── */
function pick(ctx, spec) {
  let cur = ctx;
  for (const p of String(spec).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/* ─────────────────────────────────────────────
 * 二·五、契约表（给「参数类型不符」用）
 * 表是快照，会落后于插件安装——表里查不到的键一律放过，宁可漏也不误报。
 * ───────────────────────────────────────────── */
let _TOOL_TYPES = null;
function loadToolTypes() {
  if (_TOOL_TYPES) return _TOOL_TYPES;
  const dir = process.env.JUDGE_TOOLS_DIR || path.join(__dirname, '..', 'contract');
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'tool-types.json'), 'utf8'));
    _TOOL_TYPES = (j && j.tools) || {};
  } catch { _TOOL_TYPES = {}; }
  return _TOOL_TYPES;
}

function typeOk(t, v) {
  if (t === 'array') return Array.isArray(v);
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number';
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  return typeof v === t;
}

/* ─────────────────────────────────────────────
 * 三、条件类型表 * 每个返回 true = 命中（这一步该报警）
 * needsIO 的会读文件系统；其余纯内存
 * ───────────────────────────────────────────── */
const CONDITION = {
  /* ── 参数形态（core） ── */
  missingKey(p, ctx) {
    const keys = p.keys || [p.key];
    return keys.some(k => pick(ctx, 'args.' + k) === undefined);
  },

  emptyValue(p, ctx) {
    const keys = p.keys || [p.key];
    return keys.some(k => {
      const v = pick(ctx, 'args.' + k);
      return v === '' || v === null || (Array.isArray(v) && v.length === 0);
    });
  },

  missingAnyOf(p, ctx) {
    // p.keys = ["a|b", "c"] 每一组至少中一个
    return (p.keys || []).some(group =>
      !String(group).split('|').some(k => pick(ctx, 'args.' + k) !== undefined));
  },

  wrongKey(p, ctx) {
    return (p.keys || []).some(k => pick(ctx, 'args.' + k) !== undefined);
  },
  extraKey(p, ctx) {
    return (p.paths || []).some(dp => {
      const segs = String(dp).split('.');
      let cur = ctx.args;
      for (const s of segs) {
        if (cur === null || typeof cur !== 'object') return false;
        if (s.endsWith('[]')) {
          const k = s.slice(0, -2);
          if (!Array.isArray(cur[k])) return false;
          cur = cur[k];
        } else {
          if (!(s in cur)) return false;
          cur = cur[s];
        }
      }
      return true;
    });
  },

  typeMismatch(p, ctx) {
    const v = pick(ctx, 'args.' + p.key);
    if (v === undefined || v === null || v === '') return false;
    const ok = t => {
      if (t === 'array') return Array.isArray(v);
      if (t === 'integer') return Number.isInteger(v);
      if (t === 'number') return typeof v === 'number';
      if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
      return typeof v === t;
    };
    if (p.type && !ok(p.type)) return true;
    if (Array.isArray(p.anyOf) && p.anyOf.length) return !p.anyOf.some(ok);
    return false;
  },

  // 通用版：不写死键，按契约表逐个比对这次调用给的参数类型。
  // 表里没声明类型的键直接放过；值为空/缺省不判（缺必填归 missingKey、required 归契约层）。
  argTypeMismatch(p, ctx) {
    const spec = loadToolTypes()[ctx.tool];
    if (!spec) return false;
    const args = ctx.args || {};
    for (const k of Object.keys(args)) {
      const want = spec[k] && spec[k].type;
      if (!want) continue;
      const v = args[k];
      if (v === undefined || v === null || v === '') continue;
      if (!typeOk(want, v)) return true;
    }
    return false;
  },

  /* ── 命令行形态 ── */
  missingFlag(p, ctx) {
    let s = String(pick(ctx, p.in || 'args.command') || '');
    if (p.maskQuoted) s = maskQuoted(s);
    return !(new RegExp(p.flag, 'i')).test(s);
  },

  regexHit(p, ctx) {
    let s = pick(ctx, p.in || 'args.command');
    if (s === undefined || s === null) return false;
    s = String(s);
    if (p.maskQuoted) s = maskQuoted(s);
    return (new RegExp(p.pattern, p.flags || 'i')).test(s);
  },

  regexMiss(p, ctx) {
    const raw = pick(ctx, p.in || 'args.command');
    // 字段根本不存在时不算「miss」——缺字段是「没给」，不是「给了但内容不对」。
    // 不挡这一下，只有 regexMiss 一条条件的规矩会在字段缺失时误命中（借自 RuleWright 的 null 语义）。
    if (raw === undefined || raw === null) return false;
    let s = String(raw);
    if (p.maskQuoted) s = maskQuoted(s);
    return !(new RegExp(p.pattern, p.flags || 'i')).test(s);
  },

  /* ── 文件状态（needsIO） ── */
  fileLacksBom(p, ctx) {
    const b = readHead(ctx, p);
    return b ? !(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) : false;
  },

  fileHasBom(p, ctx) {
    const b = readHead(ctx, p);
    return b ? (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) : false;
  },

  fileAnchorMissing(p, ctx) {
    const r = countAnchor(ctx, p);
    return r ? r.n === 0 : false;
  },

  fileAnchorMultiple(p, ctx) {
    const r = countAnchor(ctx, p);
    if (!r) return false;
    if (ctx.args && ctx.args.replace_all === true) return false;
    return r.n > 1;
  },

  /* ── 时间／路径 ── */
  fileNewerThan(p, ctx) {
    try {
      const a = fs.statSync(pick(ctx, 'args.' + p.key));
      const b = fs.statSync(p.file);
      return a.mtimeMs > b.mtimeMs;
    } catch { return false; }
  },

  fileNewerThanProcessStart(p, ctx) {
    try {
      const f = String(expandEnv(p.file));
      if (f.startsWith('<')) {                    // <dir> 形式：取其下所有文件 mtime 最大值
        const dir = path.dirname(expandEnv(p.dirOf) || '.');
        if (!fs.existsSync(dir)) return false;
        const newest = Math.max(...fs.readdirSync(dir)
          .filter(n => n.endsWith('.js') || n.endsWith('.json'))
          .map(n => fs.statSync(path.join(dir, n)).mtimeMs), 0);
        return newest > processStartMs();
      }
      const st = fs.statSync(f);
      return st.mtimeMs > processStartMs();
    } catch { return false; }
  },

  unknownKey(p, ctx) {
    // 检查「对象里有没有不在白名单内的键」
    // in 支持 "args"（顶层）与 "args.files[]"（数组项层）
    const allowed = p.allowed || [];
    const spec = String(p.in || 'args');
    const args = ctx.args || {};
    if (spec.includes('[]')) {
      const key = spec.replace(/^args\./, '').split('[]')[0];
      const arr = args[key];
      if (!Array.isArray(arr)) return false;
      return arr.some(el => el && typeof el === 'object' &&
        Object.keys(el).some(k => !allowed.includes(k)));
    }
    if (typeof args !== 'object') return false;
    return Object.keys(args).some(k => !allowed.includes(k));
  },

  pathOutside(p, ctx) {    const v = pick(ctx, 'args.' + p.key);
    if (typeof v !== 'string' || !v) return false;
    const roots = (p.roots || []).map(r => path.resolve(r));
    const abs = path.resolve(v);
    return roots.length > 0 && !roots.some(r => abs === r || abs.startsWith(r + path.sep));
  },

  cmdAbsPathWritten(p, ctx) {
    // 从命令里抽出「写操作后面的绝对路径」；捕获组写法：pattern 里第一个括号即路径
    let s = String(pick(ctx, 'args.command') || '');
    if (p.maskQuoted) s = maskQuoted(s);
    const re = new RegExp(p.pattern, p.flags || 'i');
    const m = s.match(re);
    if (!m) return false;
    const target = path.resolve(m[1] || '');
    // anyPath：不比较根目录，只要「写动作 + 绝对路径」就算命中。
    // 用于「动手前先备份」这类提醒——它不管路径在不在工作区里，只要会覆盖就算数。
    if (p.anyPath === true) return true;
    const roots = (p.roots || []).map(r => path.resolve(r));
    return roots.length > 0 && !roots.some(r => target === r || target.startsWith(r + path.sep));
  }
};

/* 路径里的 {ENV_VAR} 用环境变量展开。
 * 目的：规矩包不能写死本机安装位置，否则换台电脑就失效——
 * 而「换台电脑还能用」正是这类包存在的理由。
 * 2026-11-23：支持 {ENV_VAR|BUILTIN} 写法。变量没设时用内建位置兜底，
 * 而不是让整条规则在装载阶段被拒——拒装的后果是「装上看着好好的，什么都不拦」。 */
const BUILTIN = {
  SELF_DIR: path.join(__dirname, '..'),
  SELF_LIB: path.join(__dirname, '..', 'lib'),
};

function expandEnv(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\{([A-Z][A-Z0-9_]*)(?:\|([A-Z][A-Z0-9_]*))?\}/g, (m, k, dflt) => {
    if (process.env[k]) return process.env[k];
    if (dflt && BUILTIN[dflt]) return BUILTIN[dflt];
    return m;
  });
}

let __procStart = null;
function processStartMs() {
  if (__procStart === null) __procStart = Date.now() - Math.round(process.uptime() * 1000);
  return __procStart;
}

function readHead(ctx, p) {
  const fp = pick(ctx, 'args.' + (p.key || 'file_path'));
  if (typeof fp !== 'string' || !fp) return null;
  try {
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(3);
    const n = fs.readSync(fd, buf, 0, 3, 0);
    fs.closeSync(fd);
    return n >= 3 ? buf : null;
  } catch { return null; }
}

function countAnchor(ctx, p) {
  const fp = pick(ctx, 'args.' + (p.key || 'file_path'));
  const needleRaw = pick(ctx, 'args.' + (p.needle || 'old_string'));
  if (typeof fp !== 'string' || typeof needleRaw !== 'string' || !needleRaw) return null;
  try {
    const st = fs.statSync(fp);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
    const txt = fs.readFileSync(fp).toString('utf8');
    if (txt.includes('\uFFFD')) return null;          // 不是 utf8，字面比较不可信，放过
    const norm = s => s.replace(/\r\n/g, '\n');
    const hay = norm(txt), needle = norm(needleRaw);
    let n = 0, from = 0;
    while (n <= 50) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      n++; from = i + needle.length;
    }
    return { n, lines: hay.split('\n').length, bytes: st.size };
  } catch { return null; }
}

/* ─────────────────────────────────────────────
 * 四、判定：一条规矩 → 命中与否
 * condition 三种形态：{type,...} | {all:[...]} | {any:[...]}
 * ───────────────────────────────────────────── */
function evalCond(c, ctx) {
  if (!c) return false;
  if (Array.isArray(c.all)) return c.all.every(x => evalCond(x, ctx));
  if (Array.isArray(c.any)) return c.any.some(x => evalCond(x, ctx));
  // not：取反一个子条件。没有它只能表达「全部满足」和「任一满足」，
  // 表达不了「不含 X」这类最常见的排除项（借自 RuleWright 的 group/NOT）。
  if (c.not) return !evalCond(c.not, ctx);
  const fn = CONDITION[c.type];
  if (!fn) throw new Error('未知条件类型: ' + c.type);   // 内核不认识 → 必须炸，不许默默放行
  return fn(c, ctx) === true;
}

function judge(call, ruleSet) {
  const ctx = { tool: call.tool, args: call.args || {}, replyText: call.replyText, call };
  // 既能收 load() 的返回，也能收裸数组——两个都用过，混用会静默判成「零命中」。
  const when = call.when || 'tool:pre';
  // 取规则三层优先：裸数组 → 按 when+tool 分桶（只过这个工具该管的几条）→ 按 when 分桶 → 全量
  let list;
  if (Array.isArray(ruleSet)) {
    list = ruleSet;
  } else if (ruleSet && ruleSet.byTool && ruleSet.byTool.get(when)) {
    const m = ruleSet.byTool.get(when);
    list = (m.get(call.tool) || []).concat(m.get('*') || []);
  } else if (ruleSet && ruleSet.byWhen && ruleSet.byWhen.get(when)) {
    list = ruleSet.byWhen.get(when);
  } else {
    list = (ruleSet && ruleSet.rules) || [];
  }
  const hits = [];
  for (const r of list) {
    if (!applies(r.appliesTo, ctx)) continue;
    let hit = false;
    try {
      hit = evalCond(r.condition, ctx);
    } catch (e) {
      // 崩了就放行，但必须记账（静默失效比失效更危险）
      hits.push({ ruleId: r.id, action: 'warn', error: String(e.message || e) });
      continue;
    }
    if (hit) hits.push({ ruleId: r.id, action: r.action, severity: r.severity, message: r.message, fix: r.fix, reversible: r.reversible });
  }
  return hits;
}

function applies(a, ctx) {
  if (!a) return true;
  // tool 单值；tools 数组（一条规矩管多个工具，如 J10 同时管 write 与 edit）
  const tools = a.tools || (a.tool ? [a.tool] : null);
  if (tools && !tools.includes('*') && !tools.includes(ctx.tool)) return false;
  if (Array.isArray(a.platform) && !a.platform.includes(ENV.platform)) return false;
  if (Array.isArray(a.shell) && !a.shell.includes(ENV.shell)) return false;
  if (a.commandMatches) {
    const s = String(ctx.args.command || '');
    if (!(new RegExp(a.commandMatches, 'i')).test(maskQuoted(s))) return false;
  }
  if (a.fileMatches) {
    const s = String(ctx.args.file_path || '');
    if (!(new RegExp(a.fileMatches, 'i')).test(s)) return false;
  }
  return true;
}

/* ─────────────────────────────────────────────
 * 五、裁决：多条命中合并
 * block > warn > steer > default；同优先级按 id 字典序（保证可复现）
 * ───────────────────────────────────────────── */
const ORDER = { block: 4, warn: 3, steer: 2, default: 1 };
function adjudicate(hits) {
  if (!hits.length) return { action: 'pass', hits: [], notes: [] };
  const top = hits.reduce((a, b) => (ORDER[b.action] || 0) > (ORDER[a.action] || 0) ? b : a);
  const picked = hits.filter(h => h.action === top.action);
  // 拦下时别把同时命中的低档项扔掉：一次调用踩三处，只报最凶那处，
  // 人要改完重发才看见第二处。notes 把其余的带出来，一次说完。
  const notes = hits.filter(h => (ORDER[h.action] || 0) < (ORDER[top.action] || 0));
  return { action: top.action, hits: picked, notes };
}

/* ─────────────────────────────────────────────
 * 六、装载
 * 四步：扫目录 → 按环境筛 → 合并（同 id 后写覆盖） → 按 when 分组
 * ───────────────────────────────────────────── */
const ENV = {
  platform: process.platform === 'win32' ? 'windows' : process.platform,
  shell: process.env.DSH_JUDGE_SHELL || (process.platform === 'win32' ? 'powershell-5.1' : 'bash'),
  host: process.env.DSH_JUDGE_HOST || 'dsh'
};

/* ─────────────────────────────────────────────
 * 六之二、装机前校验（防坏包）
 * 别人的包永远要当「你没写过的东西」对待：
 *   · 正则编译不过 → 拒装（否则在判定时才炸，且每次调用都炸）
 *   · 正则过长／疑似灾难性回溯 → 拒装（一个 (a+)+ 能把判定器卡死）
 * 来源：RuleWright 的「Accept rules you didn't write」与「MatchesRegex 装载时校验」。
 * ───────────────────────────────────────────── */
const RE_FIELD = { regexHit: 'pattern', regexMiss: 'pattern', missingFlag: 'flag', cmdAbsPathWritten: 'pattern' };

function collectPatterns(c, out) {
  if (!c) return;
  if (Array.isArray(c.all)) { c.all.forEach(x => collectPatterns(x, out)); return; }
  if (Array.isArray(c.any)) { c.any.forEach(x => collectPatterns(x, out)); return; }
  if (c.not) { collectPatterns(c.not, out); return; }
  const f = RE_FIELD[c.type];
  if (f && typeof c[f] === 'string') out.push({ from: c.type, pattern: c[f] });
}

function validateRule(r) {
  const errs = [];
  const pats = [];
  collectPatterns(r.condition, pats);
  if (r.appliesTo) {
    if (r.appliesTo.commandMatches) pats.push({ from: 'appliesTo.commandMatches', pattern: r.appliesTo.commandMatches });
    if (r.appliesTo.fileMatches) pats.push({ from: 'appliesTo.fileMatches', pattern: r.appliesTo.fileMatches });
  }
  for (const p of pats) {
    if (p.pattern.length > 500) errs.push(`${p.from}: 正则过长(${p.pattern.length} 字符)`);
    // 启发式：一个带量词的分组又跟一个量词 —— (a+)+ / (.*)* 这类灾难性回溯的典型形状
    if (/\((?:[^()|]*[+*]|[^()|]{2,})\)\s*[+*{]/.test(p.pattern)) errs.push(`${p.from}: 疑似灾难性回溯`);
    try { new RegExp(p.pattern, 'i'); } catch (e) { errs.push(`${p.from}: 正则编译失败 ${e.message}`); }
  }
  // 规矩里引用的 {环境变量} 必须都设好。设不好会导致 statSync 抛错、
  // 条件静默返回 false —— 那是最坏的失效：装上看着好好的，什么都不拦。
  // 2026-11-23：写成 {VAR|BUILTIN} 的，BUILTIN 存在就算过——包里自带位置比人配变量可靠。
  const refs = [...String(JSON.stringify(r)).matchAll(/\{([A-Z][A-Z0-9_]*)(?:\|([A-Z][A-Z0-9_]*))?\}/g)];
  const seen = new Set();
  for (const [, k, dflt] of refs) {
    if (seen.has(k)) continue;
    seen.add(k);
    if (process.env[k]) continue;
    if (dflt && BUILTIN[dflt]) continue;
    errs.push(dflt ? `环境变量未设置 ${k}，默认 ${dflt} 也不认识` : `环境变量未设置 ${k}`);
  }
  return errs;
}

// 启用名单：只装名单里那几条，或排除某几条。不写就是全开（老行为不变）。
// 来源优先级：调用参数（插件读配置、命令行传参）> 环境变量 > 无。
// 三种分隔都认：逗号、分号、空白；比较时一律大写（规则 id 都是大写，写小写也认）。
function parseIdList(v) {
  if (Array.isArray(v)) v = v.join(',');
  return String(v || '').split(/[,;\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
}

function load(packDirs, env, opts) {
  // 传字符串时按单目录处理。不写这句，for...of 会逐字符迭代，
  // 第一个字符 "D" 被当成盘符根目录扫全盘（2026-11-23 实测撞上 $RECYCLE.BIN 的 EPERM）
  if (typeof packDirs === 'string') packDirs = [packDirs];
  if (!Array.isArray(packDirs)) throw new TypeError('load(packDirs) 需要目录字符串或字符串数组');
  const merged = new Map();
  const rejected = [];
  let scanned = 0;
  for (const dir of packDirs) {
    if (!fs.existsSync(dir)) continue;
    const walk = d => {
      for (const name of fs.readdirSync(d)) {
        const fp = path.join(d, name);
        const st = fs.statSync(fp);
        if (st.isDirectory()) { walk(fp); continue; }
        if (!name.endsWith('.json')) continue;
        // pack.json 是包的元数据：它的 rules 字段是「条数」不是数组，跳过
        if (name.toLowerCase() === 'pack.json') continue;
        let arr;
        try { arr = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
        const list = Array.isArray(arr) ? arr : (Array.isArray(arr.rules) ? arr.rules : []);
        for (const r of list) {
          if (!r || !r.id) continue;
          scanned++;
          const errs = validateRule(r);
          if (errs.length) { rejected.push({ id: r.id, errors: errs }); continue; }
          merged.set(r.id, r);                      // 后写覆盖前写：core → org → user
        }
      }
    };
    walk(dir);
  }
  // 名单过滤：名单外的条目不装，但要记下名字——写了 J99 却装不上，
  // 静默是最坏的失效（2026-11-23 定，同「环境变量没设」那类）。
  // 匹配用两个名字：包里的 id（WIN-ENC-01）和给人看的 legacy 号（J8）。
  // 人看目录记的是 J8，写 J8 就该装上——只认 id 的话名单会静默变空。
  const only = parseIdList((opts && opts.only) || process.env.DSH_JUDGE_ONLY);
  const skip = parseIdList((opts && opts.skip) || process.env.DSH_JUDGE_SKIP);
  const keysOf = r => [r.id, r.legacyJudge].filter(Boolean).map(k => String(k).toUpperCase());
  const hitSet = (r, set) => keysOf(r).some(k => set.has(k));
  const known = new Set();
  for (const r of merged.values()) keysOf(r).forEach(k => known.add(k));
  const filtered = [];
  let rules = [...merged.values()];
  if (only.length) {
    const set = new Set(only);
    rules = rules.filter(r => { const keep = hitSet(r, set); if (!keep) filtered.push(r.legacyJudge || r.id); return keep; });
  }
  if (skip.length) {
    const s = new Set(skip);
    rules = rules.filter(r => { const keep = !hitSet(r, s); if (!keep) filtered.push(r.legacyJudge || r.id); return keep; });
  }
  const missing = only.filter(k => !known.has(k));
  rules = rules.filter(r => applies(r.appliesTo, { tool: '*', args: {} }) || true);
  const byWhen = new Map();
  const byTool = new Map();   // when → tool → rules；调某工具时只取它那桶 + '*' 桶
  for (const r of rules) {
    const w = r.when || 'tool:pre';
    if (!byWhen.has(w)) byWhen.set(w, []);
    byWhen.get(w).push(r);
    if (!byTool.has(w)) byTool.set(w, new Map());
    const m = byTool.get(w);
    const a = r.appliesTo || {};
    const names = a.tools || (a.tool ? [a.tool] : ['*']);
    for (const n of names) {
      if (!m.has(n)) m.set(n, []);
      m.get(n).push(r);
    }
  }
  return { rules, byWhen, byTool, scanned, rejected, filtered, missing, only, skip, env: env || ENV };
}

// 自测用的范围检查：只看「这条规矩管什么」（工具、文件、命令），不看「本机适不适用」
// （platform / shell / host）。
//   · 忽略 platform/shell：否则 Linux 包在 Windows 上被全滤掉，自测「全过」= 假通过
//   · 保留 tool/fileMatches：这是规则语义的一部分，丢了它就测不出「范围写漏了」
//     （真踩过：J10/J15/J16 忘了限定 .ps1，会拦所有含中文的写入）
function appliesScope(a, ctx) {
  if (!a) return true;
  const tools = a.tools || (a.tool ? [a.tool] : null);
  if (tools && !tools.includes('*') && !tools.includes(ctx.tool)) return false;
  if (a.commandMatches) {
    const s = String(ctx.args.command || '');
    if (!(new RegExp(a.commandMatches, 'i')).test(maskQuoted(s))) return false;
  }
  if (a.fileMatches) {
    const s = String(ctx.args.file_path || '');
    if (!(new RegExp(a.fileMatches, 'i')).test(s)) return false;
  }
  return true;
}

function judgeRaw(call, rules) {
  const ctx = { tool: call.tool, args: call.args || {}, replyText: call.replyText, call };
  const hits = [];
  for (const r of rules) {
    if (!appliesScope(r.appliesTo, ctx)) continue;
    try {
      if (evalCond(r.condition, ctx)) hits.push({ ruleId: r.id, action: r.action || 'warn', rule: r });
    } catch (e) {
      // 条件抛错要单独标出来：自测里这算「规矩写坏了」，不能当命中也不算放行
      hits.push({ ruleId: r.id, action: 'warn', error: String(e.message || e), rule: r });
    }
  }
  return hits;
}

module.exports = { judge, judgeRaw, adjudicate, load, parseIdList, maskQuoted, evalCond, CONDITION, ENV, processStartMs };
