'use strict';
/* 带成败的回放：只有「这次调用成没成」才知道「是不是又原样重试了一次」。
 * 会话日志里 tool/call 是调用、tool/result 带 isError 是结果，两边用 callId 对上；
 * 对不上的调用直接丢掉，不猜成败——猜出来的成败会把误报变成「看起来有依据」。 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAGIC = Buffer.from('28b52ffd', 'hex');

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.jsonl\.zstd$/i.test(e.name)) out.push({ p, size: fs.statSync(p).size });
  }
  return out;
}

function textOf(file) {
  const buf = fs.readFileSync(file);
  const offs = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) { offs.push(i); i = buf.indexOf(MAGIC, i + 4); }
  const parts = [];
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end))); } catch { /* 坏帧跳过 */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

/* 一份会话 → 时间顺序的调用序列，losing 的条目带 ok 与 at */
function traceOfFile(file) {
  const calls = new Map();
  const results = new Map();
  let order = 0;
  for (const ln of textOf(file).split('\n')) {
    if (!ln.trim()) continue;
    let o;
    try { o = JSON.parse(ln); } catch { continue; }
    order += 1;
    if (o.type === 'tool/call' && o.data && o.data.name) {
      let a = o.data.arguments;
      if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
      calls.set(o.data.callId || ('seq' + o.seq), {
        tool: o.data.name, args: a || {}, at: typeof o.time === 'number' ? o.time : 0, order,
      });
    } else if (o.type === 'tool/result' && o.data) {
      const id = o.data.toolCallId || (o.data.message && o.data.message.toolCallId);
      const msg = o.data.message || o.data;
      let failed = null;
      if (typeof msg.isError === 'boolean') failed = msg.isError;
      else if (msg.result && typeof msg.result.isError === 'boolean') failed = msg.result.isError;
      if (id) results.set(id, { failed, at: typeof o.time === 'number' ? o.time : 0 });
    }
  }
  const trace = [];
  let orphan = 0;
  for (const [id, c] of calls) {
    const r = results.get(id);
    if (!r) { orphan += 1; continue; }
    trace.push({
      tool: c.tool, args: c.args, ok: r.failed === null ? null : !r.failed,
      at: c.at || r.at, order: c.order,
    });
  }
  trace.sort((a, b) => a.order - b.order);
  for (const t of trace) delete t.order;
  return { trace, calls: calls.size, orphan };
}

function readTrace(target, maxFiles) {
  const files = walk(target, []).sort((a, b) => b.size - a.size).slice(0, maxFiles || 400);
  const sessions = [];
  let calls = 0, orphan = 0;
  for (const f of files) {
    let t;
    try { t = traceOfFile(f.p); } catch { continue; }
    if (!t.trace.length) continue;
    sessions.push(t.trace);
    calls += t.calls;
    orphan += t.orphan;
  }
  return { files: files.length, sessions: sessions.length, calls, orphan, traces: sessions };
}

/* 按时间顺序喂历史，跑跨调用判据。窗口固定 20 条，跟插件里一致。 */
function replayTrace(traces, rules, J, windowSize) {
  const win = windowSize || 20;
  const stat = { calls: 0, hit: 0, skipped: 0, byRule: {}, samples: [] };
  for (const trace of traces) {
    let hist = [];
    for (const c of trace) {
      stat.calls += 1;
      let ex;
      try {
        ex = J.judgeEx({ when: 'tool:pre', tool: c.tool, args: c.args || {}, history: hist.slice(-win), at: c.at }, rules);
      } catch { ex = { hits: [], skipped: [] }; }
      stat.skipped += (ex.skipped || []).length;
      for (const h of ex.hits || []) {
        stat.hit += 1;
        stat.byRule[h.ruleId] = (stat.byRule[h.ruleId] || 0) + 1;
        if (stat.samples.length < 20) {
          stat.samples.push({
            rule: h.ruleId, tool: c.tool, at: c.at,
            arg: JSON.stringify(c.args || {}).replace(/\s+/g, ' ').slice(0, 100),
          });
        }
      }
      hist.push({ tool: c.tool, args: c.args, ok: c.ok, at: c.at });
      if (hist.length > win * 2) hist = hist.slice(-win);
    }
  }
  return stat;
}

module.exports = { readTrace, replayTrace, traceOfFile };
