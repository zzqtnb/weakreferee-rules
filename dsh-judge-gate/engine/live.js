'use strict';
/**
 * live：闸每天在跑，顺手把「这次调用属于哪种形态」记一笔。
 *
 * 它不判、不拦、不影响任何一条判据的结果——只累计次数，供人回头看
 * 「有没有哪种毛病反复出现、而现在没人管它」。
 *
 * 三条规矩（都是被审稿人挑出来的）：
 *   1. 调用方必须整段包 try：这里抛一个错，不许连带 33 条判据一起跳过
 *   2. 只记形态名、次数、工具名与一小段脱敏后的样子；不记命令全文
 *   3. 落盘用先写临时文件再改名，不整份回写别人的文件（并发会丢更新）
 */

const fs = require('fs');
const path = require('path');
const { featuresOf, TITLE } = require('./mine.js');

const SNIPPET_MAX = 80;
const FLUSH_EVERY = 50;          // 每累计这么多次落一次盘
const FLUSH_MS = 60 * 1000;      // 或者距上次落盘超过一分钟
const REPEAT_N = 5;              // 同一个文件改到第几次算「反复改」
const PATH_CAP = 500;            // 内存里最多记这么多路径，防止长跑涨内存

/** 常态动作：面板默认折叠起来，不算「值得看」 */
const NOISE = new Set([
  'relative-path',
  'edit-ps1',
  'write-text-cjk',
  'no-readback-after-write',
  'write-no-encoding',
]);

const state = {
  forms: new Map(),
  paths: new Map(),
  pending: 0,
  dirty: false,
  lastFlush: 0,
  file: '',
};

function nowStamp(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

/** 计数落点：跟判据开关放同一份 store 目录，重装插件不会清零 */
function dataFile(opts) {
  if (state.file) return state.file;
  const dir = (opts && opts.dataDir) || process.env.DSH_JUDGE_DATA || path.join(__dirname, '..', 'data');
  state.file = path.join(dir, 'mine-live.json');
  return state.file;
}

/** 脱敏：密钥样式的串、超长无空格串，一律换成标记 */
function scrub(s) {
  let t = String(s == null ? '' : s).replace(/\s+/g, ' ');
  t = t.replace(/(token|secret|password|passwd|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, '$1=[隐去]');
  t = t.replace(/[A-Za-z0-9_\-]{32,}/g, '[长串已隐去]');
  return t.length > SNIPPET_MAX ? t.slice(0, SNIPPET_MAX) + '…' : t;
}

function snippetOf(tool, args) {
  if (!args || typeof args !== 'object') return '';
  if (typeof args.command === 'string') return scrub(args.command);
  if (typeof args.file_path === 'string') {
    const size = args.content ? `（写 ${String(args.content).length} 字）` : '';
    return scrub(args.file_path) + size;
  }
  if (typeof args.path === 'string') return scrub(args.path);
  const keys = Object.keys(args).slice(0, 4).join(',');
  return scrub(keys ? `${tool} ${keys}` : tool);
}

/**
 * 记一次。返回这次命中的形态名数组（没命中给 null）。
 * 调用方拿返回值只能用来打日志，不能拿它改判定结果。
 */
function record(tool, args, opts) {
  if (!tool || typeof tool !== 'string') return null;
  if (!args || typeof args !== 'object') return null;
  const hits = featuresOf({ tool, args }) || [];
  const p = String(args.file_path || args.path || '');
  if (p && (tool === 'write' || tool === 'edit')) {
    const n = (state.paths.get(p) || 0) + 1;
    state.paths.set(p, n);
    if (n === REPEAT_N) hits.push('repeat-write-same-path');
    if (state.paths.size > PATH_CAP) {
      const oldest = state.paths.keys().next().value;
      state.paths.delete(oldest);
    }
  }
  if (!hits.length) return null;
  const snip = snippetOf(tool, args);
  const at = nowStamp();
  for (const h of hits) {
    const o = state.forms.get(h) || { n: 0, tools: {}, last: [] };
    o.n += 1;
    o.tools[tool] = (o.tools[tool] || 0) + 1;
    if (snip) {
      o.last.unshift({ at, s: snip });
      if (o.last.length > 3) o.last.length = 3;
    }
    state.forms.set(h, o);
  }
  state.dirty = true;
  state.pending += 1;
  const due = state.pending >= FLUSH_EVERY || Date.now() - state.lastFlush >= FLUSH_MS;
  if (due) flush(opts);
  return hits;
}

/** 落盘：先写 .tmp 再改名，读的一方永远看到完整文件 */
function flush(opts) {
  if (!state.dirty) return false;
  const file = dataFile(opts);
  const forms = {};
  for (const key of Object.keys(TITLE)) {
    const v = state.forms.get(key);
    if (!v) continue;
    forms[key] = {
      title: TITLE[key] || key,
      n: v.n,
      noise: NOISE.has(key),
      rule: null,
      note: '',
      tools: v.tools,
      last: v.last,
    };
  }
  const payload = { version: 1, updated: nowStamp(), forms };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    state.dirty = false;
    state.pending = 0;
    state.lastFlush = Date.now();
    return true;
  } catch {
    return false;
  }
}

/** 读回给面板用；文件不在就当没攒过 */
function read(opts) {
  const file = dataFile(opts);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return { updated: '', forms: {} };
    return { updated: j.updated || '', forms: j.forms || {} };
  } catch {
    return { updated: '', forms: {} };
  }
}

module.exports = { record, flush, read, dataFile, NOISE, TITLE };
