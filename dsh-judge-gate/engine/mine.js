'use strict';
/**
 * mine：从使用者自己的会话记录里统计「哪种操作形态最常出现、会不会出事」，
 * 并给出草案判据。它不联网，不上传任何东西，报告里只有次数与参数键名，没有命令正文。
 *
 * 输入三种，按扩展名认：
 *   1. DSH 会话文件  session.v4.jsonl.zstd —— 多帧 zstd，按魔数逐帧解压，逐行 JSON
 *   2. 普通 JSONL    每行 {type:'tool/call', data:{name, arguments}}
 *   3. 普通 JSON     数组 [{tool, args}]
 *
 * 判据怎么来的：形态命中次数 ≥ min 才提；草案一律 action=warn，要人改成 block 才算数。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const CJK = /[\u3400-\u9fff\uff00-\uffef]/;
const WRITE_CMD = /\b(Out-File|Set-Content|Add-Content|Export-Csv|Export-Clixml|Tee-Object)\b/i;
const ENC = /-Encoding\b/i;
const REDIR = /(^|[^0-9*>=])>{1,2}\s*("[^"]+\.\w+"|'[^']+\.\w+'|[^\s|;&<>]+\.\w+)/;
const RM_REC = /\bRemove-Item\b[^\n]*\b-Re(c|cu|cur|rec|recu)\w*/i;
const WHATIF = /-WhatIf\b/i;
const AUTOVAR = /\$(home|pid|host|error|input|args|psitem)\s*=/i;
const DANGER = /(\bFormat-Volume\b|\bFormat-Disk\b|\brm\s+-rf\s+\/)/i;
const GIT_DESTRUCTIVE = /\bgit\s+(reset\s+--hard|checkout\s+--\s+\.|restore\s+\.|clean\s+-[a-z]*f)/i;
const GIT_STASH = /\bgit\s+stash\b/i;
const WRITE_VERB_ONE = /\b(Out-File|Set-Content|Add-Content|Export-Csv|Export-Clixml|Tee-Object)\b/gi;

/* 形态 → 现有规矩。值写规则 id；null 表示现在没人管。 */
const MAP = {
  'write-no-encoding': 'WIN-ENC-01',
  'redirect-cjk-no-encoding': 'WIN-ENC-01',
  'autovar-assign': 'WIN-AUTOVAR-CMD-01',
  'write-ps1-cjk': 'WIN-PS1-CJK-01',
  'write-bat-cjk': null,
  'write-text-cjk': null,
  'edit-ps1': 'WIN-PS1-BOM-EDIT-01',
  'rm-recursive': 'WIN-RMDIR-01',
  'danger-verb': 'WIN-IRREVERSIBLE-01',
};

const TITLE = {
  'write-no-encoding': '写文件没指定 -Encoding',
  'redirect-cjk-no-encoding': '重定向写中文没指定 -Encoding',
  'autovar-assign': '给 PowerShell 自动变量赋值',
  'write-ps1-cjk': '往 .ps1 写中文正文',
  'write-bat-cjk': '往 .bat/.cmd 写中文正文',
  'write-text-cjk': '往文本文件写中文正文',
  'edit-ps1': '改 .ps1（可能丢 BOM）',
  'rm-recursive': '递归删除没干跑',
  'danger-verb': '格式化 / 删根这类不可逆动词',
  'edit-long-anchor': 'edit 的锚点超过 2000 字',
  'multi-write-one-cmd': '一条命令里塞三个以上写文件动作',
  'git-destructive': '破坏性 git 动作没先 stash',
  'relative-path': '用相对路径定位文件',
  'repeat-write-same-path': '同一个文件反复改（≥5 次）',
  'no-readback-after-write': '写完三回合内没回读',
};

/* 出草案用的条件模板：只给「有明确危害且现在没人管」的形态 */
const TEMPLATES = {
  'write-bat-cjk': {
    id: 'MINE-BAT-CJK-01',
    title: '往 .bat/.cmd 里写中文，命令提示符下会乱码',
    appliesTo: { tool: 'write' },
    condition: {
      all: [
        { type: 'regexHit', in: 'args.file_path', pattern: '\\.(bat|cmd)$' },
        { type: 'regexHit', in: 'args.content', pattern: '[\\u3400-\\u9fff\\uff00-\\uffef]' },
      ],
    },
    action: 'warn',
    severity: 'S',
    message: '.bat/.cmd 里写中文，cmd 默认按本地代码页解析，中文会变乱码或直接报错',
    fix: '批处理文件写成纯 ASCII；必须输出中文时，在文件开头加 chcp 65001 并把正文单独放文本文件',
    reversible: true,
    cases: [
      { note: '该拦', tool: 'write', args: { file_path: 'D:\\tmp\\run.bat', content: 'echo 中文测试' }, expect: 'block' },
      { note: '该放', tool: 'write', args: { file_path: 'D:\\tmp\\run.bat', content: 'echo hello' }, expect: 'pass' },
    ],
  },
  'multi-write-one-cmd': {
    id: 'MINE-MULTIWRITE-01',
    title: '一条命令里同时改三个以上文件',
    appliesTo: { tool: 'pwsh' },
    condition: {
      all: [
        {
          type: 'regexHit',
          in: 'args.command',
          pattern: '(?:Out-File|Set-Content|Add-Content|Export-Csv|Tee-Object)[\\s\\S]*?;[\\s\\S]*?(?:Out-File|Set-Content|Add-Content|Export-Csv|Tee-Object)[\\s\\S]*?;[\\s\\S]*?(?:Out-File|Set-Content|Add-Content|Export-Csv|Tee-Object)',
        },
      ],
    },
    action: 'warn',
    severity: 'S',
    message: '一条命令里做了三处以上写文件动作，坏了定位不到是哪一处，也不方便只回滚其中一个',
    fix: '拆成多条命令，一条只改一个文件；批量替换先落清单，再逐条执行',
    reversible: true,
    cases: [
      { note: '该提示', tool: 'pwsh', args: { command: "Set-Content -Path a.txt -Value 'x' -Encoding UTF8; Set-Content -Path b.txt -Value 'y' -Encoding UTF8; Set-Content -Path c.txt -Value 'z' -Encoding UTF8" }, expect: 'block' },
      { note: '该放', tool: 'pwsh', args: { command: "Set-Content -Path a.txt -Value 'x' -Encoding UTF8" }, expect: 'pass' },
      { note: '该放：两条', tool: 'pwsh', args: { command: "Set-Content -Path a.txt -Value 'x' -Encoding UTF8; Set-Content -Path b.txt -Value 'y' -Encoding UTF8" }, expect: 'pass' },
    ],
  },
};

/* 没人管但不该出判据的形态，说清为什么不提，别让它看起来像漏了 */
const WHY_NO_RULE = {
  'write-text-cjk': 'write 工具自己按 UTF-8 落盘，中文不会乱码，写多少条都不该拦',
  'no-readback-after-write': '写完三回合不回读在真实记录里绝大多数是正常流程（写完就交付、或改用别的方式验证），当判据会大面积误拦；只作观察指标',
  'repeat-write-same-path': '同一个文件改五次以上在长文档反复打磨里是常态，硬拦会挡住正常迭代；只作观察指标',
  'relative-path': 'DSH 里相对路径按工作目录解析，属正常用法，不构成过错',
};

function frames(buf) {
  const offs = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) { offs.push(i); i = buf.indexOf(MAGIC, i + 4); }
  const out = [];
  let bad = 0;
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { out.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end))); } catch { bad++; }
  }
  return { text: Buffer.concat(out).toString('utf8'), frames: offs.length, bad };
}

function listFiles(target) {
  const st = fs.statSync(target);
  if (st.isFile()) return [{ p: target, size: st.size }];
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jsonl\.zstd|jsonl|json)$/i.test(e.name)) files.push({ p, size: fs.statSync(p).size });
    }
  })(target);
  files.sort((a, b) => b.size - a.size);
  return files;
}

function callsFromFile(f) {
  const calls = [];
  const ext = f.p.toLowerCase();
  if (ext.endsWith('.jsonl.zstd')) {
    const r = frames(fs.readFileSync(f.p));
    for (const ln of r.text.split('\n')) {
      if (!ln.trim()) continue;
      let o;
      try { o = JSON.parse(ln); } catch { continue; }
      if (o && o.type === 'tool/call' && o.data && o.data.name) {
        let a = o.data.arguments;
        if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
        calls.push({ tool: o.data.name, args: a || {} });
      }
    }
    return calls;
  }
  const text = fs.readFileSync(f.p, 'utf8');
  if (ext.endsWith('.json')) {
    let arr;
    try { arr = JSON.parse(text); } catch { return calls; }
    if (!Array.isArray(arr)) return calls;
    for (const r of arr) if (r && r.tool) calls.push({ tool: r.tool, args: r.args || r.arguments || {} });
    return calls;
  }
  for (const ln of text.split('\n')) {
    if (!ln.trim()) continue;
    let o;
    try { o = JSON.parse(ln); } catch { continue; }
    if (o && o.type === 'tool/call' && o.data && o.data.name) {
      let a = o.data.arguments;
      if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
      calls.push({ tool: o.data.name, args: a || {} });
    } else if (o && o.tool) {
      calls.push({ tool: o.tool, args: o.args || {} });
    }
  }
  return calls;
}

/* 只把调用取出来，不做统计。suggest 要用它把别人的判据在自己的历史上回放 */
function collectCalls(target, maxFiles) {
  if (!target || !fs.existsSync(target)) {
    const e = new Error('找不到这个路径：' + target);
    e.code = 'NODIR';
    throw e;
  }
  let files = listFiles(target);
  if (maxFiles > 0) files = files.slice(0, maxFiles);
  const calls = [];
  let read = 0;
  for (const f of files) {
    try {
      const cs = callsFromFile(f);
      if (cs.length) { calls.push(...cs); read++; }
    } catch { /* 单个文件坏了不影响整体 */ }
  }
  return { calls, files: files.length, filesRead: read };
}

function featuresOf(call) {  const out = [];
  const { tool, args } = call;
  if (tool === 'pwsh' || tool === 'bash') {
    const cmd = String(args.command || '');
    if ((WRITE_CMD.test(cmd) || REDIR.test(cmd)) && !ENC.test(cmd)) out.push('write-no-encoding');
    if (REDIR.test(cmd) && CJK.test(cmd) && !ENC.test(cmd)) out.push('redirect-cjk-no-encoding');
    if (RM_REC.test(cmd) && !WHATIF.test(cmd)) out.push('rm-recursive');
    if (AUTOVAR.test(cmd)) out.push('autovar-assign');
    if (DANGER.test(cmd)) out.push('danger-verb');
    const wv = (cmd.match(WRITE_VERB_ONE) || []).length;
    if (wv >= 3) out.push('multi-write-one-cmd');
    if (GIT_DESTRUCTIVE.test(cmd) && !GIT_STASH.test(cmd)) out.push('git-destructive');
  }
  const fp = String(args.file_path || '');
  if (tool === 'write' && CJK.test(String(args.content || ''))) {
    if (/\.ps1$/i.test(fp)) out.push('write-ps1-cjk');
    else if (/\.(bat|cmd)$/i.test(fp)) out.push('write-bat-cjk');
    else if (/\.(md|txt|json|csv|log|yml|yaml|ini|xml)$/i.test(fp)) out.push('write-text-cjk');
  }
  if (tool === 'edit' && /\.ps1$/i.test(fp)) out.push('edit-ps1');
  if ((tool === 'edit' || tool === 'write') && args.old_string && String(args.old_string).length > 2000) out.push('edit-long-anchor');
  if (fp && !/^([A-Za-z]:[\\/]|\\\\|\/|~)/.test(fp)) out.push('relative-path');
  return out;
}

function mine(opts) {
  const target = opts.dir;
  if (!target || !fs.existsSync(target)) {
    const e = new Error('找不到这个目录：' + target);
    e.code = 'NODIR';
    throw e;
  }
  const min = opts.min || 3;
  const files = listFiles(target);
  const limited = opts.maxFiles > 0 ? files.slice(0, opts.maxFiles) : files;

  const feat = new Map();
  const byTool = new Map();
  let calls = 0, read = 0, unreadable = 0;
  const bump = (key, tool) => {
    const o = feat.get(key) || { n: 0, tools: new Map() };
    o.n++;
    o.tools.set(tool, (o.tools.get(tool) || 0) + 1);
    feat.set(key, o);
  };
  const pathOf = (c) => String((c.args && (c.args.file_path || c.args.path || c.args.notebook_path)) || '');
  for (const f of limited) {
    let list;
    try { list = callsFromFile(f); } catch { unreadable++; continue; }
    read++;
    const pathWrites = new Map();
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      calls++;
      byTool.set(c.tool, (byTool.get(c.tool) || 0) + 1);
      for (const k of featuresOf(c)) bump(k, c.tool);
      const p = pathOf(c);
      if (p && (c.tool === 'write' || c.tool === 'edit')) {
        const n = (pathWrites.get(p) || 0) + 1;
        pathWrites.set(p, n);
        if (n >= 5) bump('repeat-write-same-path', c.tool);
        const win = list.slice(i + 1, i + 4);
        const rb = win.some((x) => pathOf(x) === p && (x.tool === 'read' || x.tool === 'grep' || x.tool === 'pwsh'));
        if (!rb && win.length > 0) bump('no-readback-after-write', c.tool);
      }
    }
  }

  const rows = [];
  for (const k of Object.keys(TITLE)) {
    const o = feat.get(k) || { n: 0, tools: new Map() };
    rows.push({
      key: k,
      title: TITLE[k],
      hits: o.n,
      tools: [...o.tools.keys()],
      coveredBy: MAP[k] || null,
      why: MAP[k] ? null : (WHY_NO_RULE[k] || null),
      hasTemplate: !!TEMPLATES[k],
      suggest: o.n >= min && !MAP[k] && TEMPLATES[k] ? TEMPLATES[k].id : null,
    });
  }
  rows.sort((a, b) => b.hits - a.hits);

  const drafts = [];
  for (const r of rows) {
    if (!r.suggest) continue;
    const t = TEMPLATES[r.key];
    drafts.push({
      id: t.id,
      title: t.title,
      when: 'tool:pre',
      appliesTo: t.appliesTo,
      condition: t.condition,
      action: t.action,
      severity: t.severity,
      message: t.message,
      fix: t.fix,
      reversible: t.reversible,
      selfTest: { cases: t.cases || [] },
      evidence: {
        hits: r.hits,
        source: 'mine：使用者自己的会话记录里统计到 ' + r.hits + ' 次',
      },
      testedOn: { calls, files: read, note: '数据来自使用者本机，不上传' },
    });
  }

  // 出草案前拿现有规则实判一遍：真有判据管着就不出。MAP 是手写的，会漂
  // （2026-11-25 实测：write-bat-cjk 标着 null，可包里早有 WIN-BAT-CJK-01）。
  const covered = [];
  let kept = drafts;
  try {
    const J = require('./judge.js');
    const rulesRoot = opts.rulesDir || path.join(__dirname, '..', 'rules');
    const packsNow = fs.readdirSync(rulesRoot).filter((d) => {
      try { return fs.statSync(path.join(rulesRoot, d)).isDirectory(); } catch { return false; }
    });
    const rs = J.load([rulesRoot], { packs: packsNow, rules: [] });
    kept = [];
    for (const d of drafts) {
      const c = (d.selfTest.cases || []).find((x) => x && x.expect === 'block') || null;
      const ex = c ? J.judgeEx({ when: 'tool:pre', tool: c.tool, args: c.args || {} }, rs) : { hits: [] };
      const others = (ex.hits || []).map((h) => h.ruleId).filter((id) => id !== d.id);
      if (others.length) covered.push({ shape: d.id, by: others });
      else kept.push(d);
    }
  } catch (e) {
    kept = drafts; // 规则加载失败就照旧出草案，别把功能弄没了
             
  }

  return {
    source: target,
    files: files.length,
    filesRead: read,
    unreadable,
    calls,
    tools: [...byTool.entries()].sort((a, b) => b[1] - a[1]),
    rows,
    drafts: kept,
    covered,
    min,
    // 包元信息：装的时候直接读这个，不用再手写一遍
    pack: {
      id: 'mined',
      name: '从自己会话里挖出来的规矩',
      version: '0.1.0',
      kind: 'scene',
      description: '由 weakreferee mine 按本机会话记录生成：只收统计次数够的形态，全部 warn，未在别人环境验证过',
      license: 'CC BY 4.0',
      loadOrder: 40,
      rules: kept.length,
      ruleIds: kept.map((d) => d.id),
      notes: '草稿包：action 一律 warn，要拦自己改 block 并补齐自测；数据来自本机，不外传',
    },
  };
}

function renderReport(r) {
  const L = [];
  L.push('弱裁判 mine 报告');
  L.push('');
  L.push('数据源：' + r.source);
  L.push('会话/文件：读了 ' + r.filesRead + ' 个（共 ' + r.files + ' 个）' + (r.unreadable ? '，读不了 ' + r.unreadable + ' 个' : ''));
  L.push('工具调用：' + r.calls + ' 次');
  L.push('');
  L.push('用到的工具（前 8）');
  for (const [t, n] of r.tools.slice(0, 8)) L.push('  ' + String(n).padStart(6) + '  ' + t);
  L.push('');
  L.push('容易出事的形态');
  L.push('  命中   会话/工具        形态                          现在谁在管');
  for (const x of r.rows) {
    if (x.hits === 0) continue;
    let who;
    if (x.coveredBy) who = x.coveredBy;
    else if (x.why) who = '没人管，也不该管';
    else if (x.suggest) who = '没人管 → 出草案 ' + x.suggest;
    else if (x.hits >= r.min) who = '没人管，次数够但没有可写的条件模板';
    else who = '没人管，次数不到 ' + r.min + ' 次先不提';
    L.push('  ' + String(x.hits).padStart(5) + '  ' + (x.tools.join('/') || '-').padEnd(14) + '  ' + x.title.padEnd(28) + '  ' + who);
  }
  const whyRows = r.rows.filter((x) => x.why && x.hits > 0);
  if (whyRows.length) {
    L.push('');
    L.push('为什么不给这些形态出判据：');
    for (const x of whyRows) L.push('  ' + x.title + '：' + x.why);
  }
  L.push('');
  if (r.drafts.length) {
    L.push('这次能出的草案：' + r.drafts.length + ' 条（action 全是 warn，要你自己改成 block 才算拦）');
    for (const d of r.drafts) L.push('  ' + d.id + '  ' + d.title + '  命中 ' + d.evidence.hits + ' 次');
  } else {
    L.push('这次没有能出的草案：能被统计的形态都已有规矩管着，或者次数不到 ' + r.min + ' 次');
  }
  L.push('');
  if (r.covered && r.covered.length) {
    L.push('');
    L.push('这几条本来会出草案，实判发现已经有人管（手写对照表会漂，实判不会）：');
    for (const c of r.covered) L.push('  ' + c.shape + ' ← ' + c.by.join(', '));
  }
  L.push('报告里只有次数和工具名，没有命令正文，也没有路径；数据不出本机。');
  return L.join('\n');
}

module.exports = { mine, renderReport, collectCalls, MAP, TITLE, TEMPLATES, featuresOf };
