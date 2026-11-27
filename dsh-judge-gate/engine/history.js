'use strict';
/* 会话小本子：跨调用判据的落盘底座（A2，2026-11-25）
 *
 * 引擎本来就有一个进程内环形缓存（judge.js 的 HISTORY），但它活不过进程重启，
 * 命令行、MCP、回放三条路也各看各的。这里把「刚才调了什么」落到磁盘，按会话分文件：
 *   · 只记摘要：工具名、参数指纹、涉及文件、成败、时刻 —— 不记命令全文、不记正文
 *   · 环形 20 条：判「刚才那几次」用不着更长的历史，长了反而更容易误判
 *   · 原子写：先写 .tmp 再 rename，中途崩掉不会留下半个 JSON
 *   · 写失败只打一行 stderr，不影响判定（闸不能因为小本子写不进去就停摆）
 *
 * 为什么不塞进 ledger.js：ledger 记的是「判定结果」（谁命中、拦没拦），
 * 这里记的是「调用事实」（干了什么、成没成）。两件事的读者不同，混在一起以后两边都改不动。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./ledger');

const HISTORY_MAX = 20;

// 参数里值得进小本子的几个键：判「原样重试」「同一文件反复失败」只需要它们。
// 其余参数一律不进——进了就是原文，脱敏再好也是泄露面。
const PICK = ['command', 'file_path', 'path', 'url', 'query', 'pattern', 'name', 'tool', 'code'];

// 进小本子的参数键：只留短标识，command / code 这类正文一律不进（与 PICK 的差别就在这）。
// 为什么不整份 PICK：判据要的是「同一个文件」「同一个网址」，不是命令原文；多存一份正文
// 等于把上面那条「不记命令全文」的设计反着做。（2026-11-27 加，配合 argRepeat 的修复）
const ARGS_KEEP = ['file_path', 'path', 'url', 'query', 'pattern', 'name', 'tool'];

function safeName(session) {
  const raw = String(session || 'default');
  // 中文会话名洗完会变成一串下划线，两个不同的名字能撞成同一个文件——
  // 撞了就等于把别人的历史读进来，跨调用判据会据此误报。后缀一段短哈希钉死唯一性。
  const ascii = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 40) || 's';
  const h = crypto.createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 8);
  return ascii + '-' + h;
}

function pathFor(dir, session) {
  return path.join(dir, safeName(session) + '.json');
}

// 参数指纹：只取 PICK 里的键、按键名排序、值先脱敏再截断。
// 同样的调用在任何一台机器上得到同样的指纹——回放与在线判定才对得上。
function fingerprint(tool, args) {
  const a = args && typeof args === 'object' ? args : {};
  const slim = {};
  for (const k of PICK.slice().sort()) {
    if (a[k] === undefined || a[k] === null) continue;
    const v = String(a[k]);
    slim[k] = L.scrubLong(v.length > 400 ? v.slice(0, 400) : v);
  }
  const raw = String(tool || '?') + '\u0001' + JSON.stringify(slim);
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 16);
}

function slimArgs(args) {
  const a = args && typeof args === 'object' ? args : {};
  const out = {};
  for (const k of ARGS_KEEP) {
    if (a[k] === undefined || a[k] === null) continue;
    const v = String(a[k]);
    out[k] = L.scrubLong(v.length > 200 ? v.slice(0, 200) : v);
  }
  return Object.keys(out).length ? out : undefined;
}

function entryOf(call, ok) {
  const args = (call && call.args) || {};
  const target = args.file_path || args.path || args.url || '';
  return {
    tool: String((call && call.tool) || '?'),
    fp: fingerprint(call && call.tool, args),
    target: target ? L.scrubLong(String(target)).slice(0, 200) : '',
    // 跨调用判据（argRepeat / failRepeat）要按某个参数值比对；老条目没有这个字段，
    // 判定侧按 target 兜底，所以老本子照样能读。
    args: slimArgs(args),
    ok: ok === true ? true : (ok === false ? false : null),
    at: Date.now(),
  };
}

function readRaw(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j.entries) ? j.entries : [];
  } catch { return []; }   // 不存在、坏文件、半截 JSON 一律当空——小本子是辅助，不拿它当事实来源
}

function writeAtomic(file, entries) {
  const tmp = file + '.tmp';
  const body = JSON.stringify({ session: path.basename(file, '.json'), max: HISTORY_MAX, updatedAt: new Date().toISOString(), entries }, null, 0);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, body + '\n', 'utf8');
  fs.renameSync(tmp, file);   // 同盘 rename 是原子的：读的一方要么看到旧的，要么看到新的
}

/* 追加一条。返回值给验收用：{ok, dropped, kept} —— 不做「成功返回 true」这种看不见内容的回执。 */
function append(dir, session, call, ok) {
  const file = pathFor(dir, session);
  const before = readRaw(file);
  const entries = before.concat([entryOf(call, ok)]);
  const dropped = Math.max(0, entries.length - HISTORY_MAX);
  const kept = entries.slice(-HISTORY_MAX);
  try {
    writeAtomic(file, kept);
    return { ok: true, file, dropped, kept: kept.length, fp: kept[kept.length - 1].fp };
  } catch (e) {
    process.stderr.write('[history] 写小本子失败: ' + e.message + '\n');
    return { ok: false, file, error: String(e.message || e), dropped: 0, kept: before.length };
  }
}

/* 取最近 n 条（升序，最旧的在前），直接能喂给 judgeEx 的 call.history。 */
function recent(dir, session, n) {
  const all = readRaw(pathFor(dir, session));
  return n ? all.slice(Math.max(0, all.length - n)) : all;
}

/* 回填成败：闸在调用前先记一条（ok=null，还不知道成没成），结果事件到了再按指纹回填那一条。
 * 为什么不在结果事件里直接 append：那个事件挂在 agent 作用域，恢复的会话可能挂不上
 * （2026-11-25 实测：重启后新进程一行都没记）。调用前那一下一定跑得到，所以「事实」以它为准，
 * 「成败」是补记，不是另记一条——另记一条会让同一次调用在历史里出现两遍，跨调用判据会自己数自己。
 * 回填不到就明说原因（empty / no-open），不假装写成。 */
function markResult(dir, session, fp, ok) {
  const file = pathFor(dir, session);
  const before = readRaw(file);
  if (!before.length) return { ok: false, reason: 'empty', file };
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const e = before[i];
    if (e && e.fp === fp && e.ok === null) {
      e.ok = ok === true;
      try {
        writeAtomic(file, before.slice(-HISTORY_MAX));
        return { ok: true, file, index: i, value: e.ok };
      } catch (err) {
        process.stderr.write('[history] 回填成败失败: ' + err.message + '\n');
        return { ok: false, file, error: String(err.message || err) };
      }
    }
  }
  return { ok: false, reason: 'no-open', file };
}

function reset(dir, session) {
  try { fs.unlinkSync(pathFor(dir, session)); return true; } catch { return false; }
}

module.exports = { append, recent, reset, markResult, pathFor, fingerprint, entryOf, HISTORY_MAX, PICK, ARGS_KEEP };
