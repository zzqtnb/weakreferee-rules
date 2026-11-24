/* ─────────────────────────────────────────────
 * 记账器（Ledger）
 *
 * 两件事：
 *   1. 每一次「被规矩碰到」的调用落一行，供事后查账
 *   2. 落盘之前先脱敏 —— 判据要看命令原文，原文里可能有密钥
 *
 * 为什么不静默丢异常：静默失效比失效更危险。
 *   历史上 162 次「判据改了没重启」，闸跑的是旧代码、一声不响，全部记成「通过」。
 *   那 162 次如果都落一行账，一眼就能看出来。
 * ───────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');

/* ── 一、脱敏 ──
 * 原则：宁可多抹，不可漏抹。
 * 抹掉的记一个标记，不丢字段 —— 不然事后不知道这里原本有东西。
 */
const SCRUB = [
  // Authorization: Bearer xxx / Basic xxx
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, '$1 ***'],
  // sk-xxx / ak-xxx 一类厂商密钥
  [/\b(sk|pk|ak|rk)-[A-Za-z0-9_\-]{12,}/g, '$1-***'],
  // key=value / "key": "value" 形态（敏感键名；允许键名带引号，JSON 里就是这样）
  [/\b["']?(api[_-]?key|apikey|access[_-]?key|secret[_-]?key|secret|token|password|passwd|pwd|passphrase)["']?\s*[:=]\s*["']?[^\s"'`,;&|)]{3,}/gi, '$1=***'],
  // URL 里的敏感 query
  [/[?&](token|key|sig|signature|auth|access_token)=[^&\s"']+/gi, '?$1=***'],
  // 连接串里的密码。注意密码本身可能含 @（mysql://root:P@ss@host），
  // 所以要一路吃到最后一个 @，再把第一个 : 之后整段抹掉
  [/(:\/\/[^\s\/]+)(@)/g, (m, auth, at) => {
    // auth 形如 "://user:pass"，从下标 1 开始找（跳过开头的 ":"），否则会命中协议后的冒号
    const i = auth.indexOf(':', 1);
    return i < 0 ? m : auth.slice(0, i + 1) + '***' + at;
  }],
];

function scrub(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const [re, rep] of SCRUB) out = out.replace(re, rep);
  return out;
}

/* 长随机串单独处理：只在「看着像密钥」时抹（大小写混合或纯十六进制，且 ≥40 位） */
function scrubLong(tok) {
  if (typeof tok !== 'string' || tok.length < 40) return tok;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(tok)) return tok;
  const hasUpper = /[A-Z]/.test(tok), hasLower = /[a-z]/.test(tok), hasDigit = /[0-9]/.test(tok);
  if (!((hasUpper && hasLower) || /^[0-9a-f]{40,}$/i.test(tok))) return tok;
  return tok.slice(0, 4) + '***' + tok.slice(-4);
}

/* 把对象里所有字符串都过一遍（参数可能是嵌套的） */
function scrubDeep(v, depth) {
  depth = depth || 0;
  if (depth > 6) return '[too-deep]';
  if (typeof v === 'string') return scrubLong(scrub(v));
  if (Array.isArray(v)) return v.map(x => scrubDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) {
      // 键名本身就敏感：值整段抹掉，但保留长度信息
      if (/^(api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|pwd|authorization)$/i.test(k)) {
        o[k] = '***';
      } else {
        o[k] = scrubDeep(v[k], depth + 1);
      }
    }
    return o;
  }
  return v;
}

/* ── 二、落一行 ──
 * 一行一条 JSON（JSONL）：追加便宜、损坏只影响一行、grep 得动。
 */
function record(ledgerPath, entry) {
  const line = {
    ts: entry.ts || nowIso(),
    session: entry.session || '',
    turn: entry.turn == null ? null : entry.turn,
    when: entry.when || 'tool:pre',
    tool: entry.tool || '',
    rules: Array.isArray(entry.rules) ? entry.rules : (entry.rules ? [entry.rules] : []),
    action: entry.action || 'pass',
    reason: scrub(String(entry.reason || '')).slice(0, 300),
    target: scrub(String(entry.target || '')).slice(0, 200),
    reversible: entry.reversible === true,
    args: entry.args ? scrubDeep(entry.args) : undefined,
    error: entry.error ? scrub(String(entry.error)).slice(0, 300) : undefined,
  };
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(ledgerPath, JSON.stringify(line) + '\n', 'utf8');
    return true;
  } catch (e) {
    // 记账失败不能影响判定（闸不能因为账本写不进去就停摆），但必须让人知道
    process.stderr.write('[ledger] 写账本失败: ' + e.message + '\n');
    return false;
  }
}

/* ── 三、读回来出报告 ── */
function readAll(ledgerPath) {
  // 传错东西时宁可炸，也不能静默返回空数组（空统计看着像「没记过账」）
  if (typeof ledgerPath !== 'string') {
    throw new TypeError('readAll 要的是记账文件路径（字符串），收到 ' + (Array.isArray(ledgerPath) ? '数组' : typeof ledgerPath));
  }
  if (!fs.existsSync(ledgerPath)) return [];
  const out = [];
  for (const ln of fs.readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!ln) continue;
    try { out.push(JSON.parse(ln)); } catch { /* 坏行跳过，不影响整体 */ }
  }
  return out;
}

function report(ledgerPath, opts) {
  if (typeof ledgerPath !== 'string') {
    throw new TypeError('report 要的是记账文件路径（字符串），收到 ' + (Array.isArray(ledgerPath) ? '数组' : typeof ledgerPath) + '；行数组请自己统计，别指望这里');
  }
  opts = opts || {};
  const rows = readAll(ledgerPath).filter(r => {
    if (opts.session && r.session !== opts.session) return false;
    if (opts.tool && r.tool !== opts.tool) return false;
    if (opts.from && r.ts < opts.from) return false;
    if (opts.to && r.ts > opts.to) return false;
    return true;
  });

  const byAction = {}, byRule = {}, byTool = {}, byDay = {};
  for (const r of rows) {
    byAction[r.action] = (byAction[r.action] || 0) + 1;
    byTool[r.tool] = (byTool[r.tool] || 0) + 1;
    const day = String(r.ts).slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    for (const id of (r.rules || ['(无)'])) byRule[id] = (byRule[id] || 0) + 1;
  }
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  return {
    total: rows.length,
    blocked: byAction.block || 0,
    warned: byAction.warn || 0,
    steered: byAction.steer || 0,
    errored: rows.filter(r => r.error).length,
    byAction: top(byAction),
    byRule: top(byRule),
    byTool: top(byTool).slice(0, 10),
    byDay: Object.entries(byDay).sort(),
  };
}

/* 人话版报告：给「会话结束报告」用 */
function formatReport(rep) {
  const L = [];
  L.push('本次共记 ' + rep.total + ' 条');
  if (rep.blocked) L.push('  拦下 ' + rep.blocked + ' 条');
  if (rep.warned) L.push('  提示 ' + rep.warned + ' 条');
  if (rep.steered) L.push('  建议 ' + rep.steered + ' 条');
  if (rep.errored) L.push('  判定过程有错 ' + rep.errored + ' 条（这些是「没能判定」，不是「判定通过」）');
  if (rep.byRule.length) {
    L.push('  按规矩：');
    for (const [k, v] of rep.byRule.slice(0, 8)) L.push('    ' + k + ' × ' + v);
  }
  return L.join('\n');
}

/* ── 三·五、按判据看：命中多少次、被标过几次误报、该留还是该降 ── */
function fpFile(ledgerPath) {
  return path.join(path.dirname(String(ledgerPath)), 'fp-marks.json');
}

/* 误报账：人标的，不自动推断。写坏当空，宁可丢一次标记也不让读崩。 */
function readFp(ledgerPath) {
  const f = fpFile(ledgerPath);
  if (!fs.existsSync(f)) return {};
  try {
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

function markFalsePositive(ledgerPath, ruleId, note) {
  const f = fpFile(ledgerPath);
  const all = readFp(ledgerPath);
  const cur = all[ruleId] || { n: 0, firstAt: null, lastAt: null, notes: [] };
  cur.n = (cur.n || 0) + 1;
  cur.firstAt = cur.firstAt || nowIso();
  cur.lastAt = nowIso();
  if (note) {
    cur.notes = (cur.notes || []).concat([{ at: cur.lastAt, note: scrub(String(note)).slice(0, 120) }]).slice(-10);
  }
  all[ruleId] = cur;
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
  return { id: ruleId, n: cur.n, lastAt: cur.lastAt, file: f };
}

/* 命中从账本聚合；建议只看三件事：误报绝对数、误报占命中的比例、有没有命中过。 */
function ruleStats(ledgerPath) {
  const rows = readAll(ledgerPath);
  const hits = {}, lastHit = {}, byAction = {};
  for (const r of rows) {
    for (const id of (r.rules || [])) {
      hits[id] = (hits[id] || 0) + 1;
      if (!lastHit[id] || String(r.ts) > String(lastHit[id])) lastHit[id] = r.ts;
      byAction[id] = byAction[id] || {};
      const a = r.action || '?';
      byAction[id][a] = (byAction[id][a] || 0) + 1;
    }
  }
  const fp = readFp(ledgerPath);
  const ids = new Set(Object.keys(hits).concat(Object.keys(fp)));
  const out = [];
  for (const id of ids) {
    const h = hits[id] || 0;
    const n = (fp[id] && fp[id].n) || 0;
    const ratio = h > 0 ? n / h : (n > 0 ? 1 : 0);
    let advice = '观察';
    if (n >= 3 && ratio >= 0.3) advice = '该降：误报多，降成只提示或删掉';
    else if (h === 0 && n > 0) advice = '该撤：一次都没命中过，只被标了误报';
    else if (h >= 5 && ratio < 0.1) advice = '该留：命中多、误报少';
    else if (n > 0) advice = '再观察：误报还不够多，先记着';
    out.push({ id, hits: h, fps: n, ratio, lastHit: lastHit[id] || null, byAction: byAction[id] || {}, advice });
  }
  out.sort((a, b) => b.hits - a.hits || b.fps - a.fps);
  return out;
}

function nowIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = pad(Math.floor(Math.abs(off) / 60)), mm = pad(Math.abs(off) % 60);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    + sign + hh + ':' + mm;
}

module.exports = { record, readAll, report, formatReport, ruleStats, markFalsePositive, readFp, fpFile, scrub, scrubDeep, scrubLong, nowIso };
