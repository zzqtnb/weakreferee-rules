#!/usr/bin/env node
// observe.js —— 判据「观察期」引擎（零模型调用，纯本地）
//
// 它回答一件事：观察期里哪几条判据能升级成直接拦、哪几条该退回。
// 平时不用人看，周末跑一次，只读这一张表。
//
// 数据从哪来（全部由参数指定，仓库里不带任何人的台账）：
//   --ledger   拦截台账（闸写出来的 tsv，必需）
//   --human    人判台账（可选，没有就等于「没人核过」，不给升级资格）
//   --state    生命周期 json（可选，记 since 日期，用来算库龄）
//   --lib      判据库 md（可选，只用来取中文名）
//   --packs    判据包目录（默认仓库里的 packs）
//   --custom   自建包目录（可重复；默认仓库镜像下的 dsh-judge-gate/data/custom）
//   --out      报告输出目录（默认仓库里的 observations）
//
// 门槛（改门槛改这里，别改判据包里的规则）：
//   MIN_HITS     只提醒的判据攒到 10 次真实触发才谈升级
//   MAX_FP_RATE  误报比例超过 10%：不许升级 / 已生效的退回
//   MIN_OBS_DAYS 观察满 30 天且零触发 → 建议撤掉
//   DEDUPE_SEC   同一条判据在 120 秒内反复触发只算一次（防一句话刷出 8 次）
//
// 用法：
//   node tools/observe.js --ledger data/ledger.tsv                 只打印
//   node tools/observe.js --ledger data/ledger.tsv --days 7        只看近 7 天（--all 看全量）
//   node tools/observe.js --ledger data/ledger.tsv --write          写 观察期-<日期>.md 与 观察期.tsv
//   node tools/observe.js --ledger data/ledger.tsv --json           机读
//
// 退出码：0 无需人拍板；1 有「够升级」或「误报超标」待判；2 参数缺失

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const customDirs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--custom' && argv[i + 1]) customDirs.push(argv[i + 1]);
}
// 仓库镜像下也会有一份自建包（有人直接在仓库里跑时用），一并读，按 id 去重
customDirs.push(path.join(REPO, 'dsh-judge-gate', 'data', 'custom'));

const OUT_DIR = val('--out', path.join(REPO, 'observations'));
const P = {
  ledger: val('--ledger', ''),
  lib: val('--lib', ''),
  human: val('--human', ''),
  state: val('--state', ''),
  packs: val('--packs', path.join(REPO, 'packs')),
  custom: customDirs,
  reportDir: OUT_DIR,
  obsTsv: val('--out-tsv', path.join(OUT_DIR, '观察期.tsv'))
};

if (!P.ledger) {
  console.error([
    '缺少 --ledger（拦截台账 tsv）。例：',
    '  node tools/observe.js --ledger data/ledger.tsv --days 7',
    '可选：--human 人判.tsv  --state 生命周期.json  --lib 判据库.md  --packs 判据包目录',
    '      --custom 自建包目录（可重复）  --out 报告目录  --all  --dedupe 120  --write  --json'
  ].join('\n'));
  process.exit(2);
}

const MIN_HITS = 10;
const MAX_FP_RATE = 0.10;
const MIN_OBS_DAYS = 30;
// 连击去重：同一条判据在 DEDUPE_SEC 秒内反复命中，只算「一次事件」。
// 实测 2026-11-27：CROSS-CLAIM-01 在 414 行账本里，413 组相邻命中间隔中位 7 秒——
// 一句「改好了」之后每一步工具调用都命中一次，不当事件去重会把 1 句话算成 8 次命中。
const DEDUPE_SEC = 120;

const DAYS = has('--all') ? 0 : Number(val('--days', '7'));
const DEDUPE_ARG = Number(val('--dedupe', String(DEDUPE_SEC)));
const DEDUPE = Number.isFinite(DEDUPE_ARG) && DEDUPE_ARG >= 0 ? DEDUPE_ARG : DEDUPE_SEC;
const WRITE = has('--write');
const JSONOUT = has('--json');

const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

// 本地日期（别用 toISOString 的 UTC，会差一天）
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 1. 判据包：档位真源 ----------
function loadPacks() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(P.packs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const d of dirs) {
    const f = path.join(P.packs, d, 'rules.json');
    let j = null;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const arr = Array.isArray(j) ? j : (j.rules || []);
    for (const r of arr) {
      if (!r || !r.id) continue;
      out.push({
        id: r.id,
        pack: d,
        legacy: r.legacyJudge || null,
        title: r.title || r.id,
        action: r.action || '(未写)',
        // 来源维度：model-error＝模型真犯过的错（官方维护）；preference＝用户自己的偏好（只在本机生效）
        origin: r.origin === 'preference' ? 'preference' : 'model-error',
        tier: r.action === 'block' ? '拦下即拒' : (r.action === 'warn' || r.action === 'steer' ? '影子期' : '未知')
      });
    }
  }

  // 自建包：mine 扫出来的、或用户自己加的，同样要进观察期——
  // 不然它们装成 warn 就再没人管，永远等不到转正，也永远退不了场（2026-11-27 修）
  const seen = new Set(out.map((r) => r.id));
  for (const root of P.custom) {
    let subs = [];
    try { subs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const d of subs) {
      const f = path.join(root, d, 'rules.json');
      let j = null;
      try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      const arr = Array.isArray(j) ? j : (j.rules || []);
      for (const r of arr) {
        if (!r || !r.id || seen.has(r.id)) continue;
        seen.add(r.id);
        out.push({
          id: r.id,
          pack: 'custom/' + d,
          custom: true,
          legacy: r.legacyJudge || null,
          title: r.title || r.id,
          action: r.action || '(未写)',
          origin: r.origin === 'preference' ? 'preference' : 'model-error',
          tier: r.action === 'block' ? '拦下即拒' : (r.action === 'warn' || r.action === 'steer' ? '影子期' : '未知')
        });
      }
    }
  }
  return out;
}

// ---------- 2. 判据库：只取名字 ----------
function loadLib() {
  const txt = readText(P.lib);
  const map = new Map();
  if (!txt) return map;
  for (const seg of txt.split(/^## +/m).slice(1)) {
    const head = seg.split(/\r?\n/)[0].trim();
    const m = head.match(/^(J\d{1,2}|[A-Z][A-Z0-9]{1,9}(?:-[A-Z0-9]{2,8}){1,3})\b/);
    if (!m) continue;
    map.set(m[1], head.replace(m[1], '').replace(/^[\s·:：-]+/, '').slice(0, 40));
  }
  return map;
}

// ---------- 3. 人判台账：判错几次 ----------
function loadHuman() {
  const byId = new Map();
  for (const line of readText(P.human).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const c = line.split('\t');
    if (c.length < 3) continue;
    const id = (c[1] || '').trim();
    if (!/^(J\d{1,2}|[A-Z][A-Z0-9-]{2,})/.test(id)) continue;
    const cur = byId.get(id) || { ok: 0, bad: 0 };
    const verdict = (c[c.length - 1] || '') + ' ' + (c[2] || '');
    if (/否|错|误报|human-misreport/.test(verdict)) cur.bad++;
    else if (/采纳|对/.test(verdict)) cur.ok++;
    byId.set(id, cur);
  }
  return byId;
}

// ---------- 4. 拦截账本：按判据编号聚合 ----------
// 账本说明列的形状（2026-11-27 实测）：
//   [J3] CROSS-CLAIM-01：上一条说改好了…      ← 开头的 [J3] 是「类别标签」，不是判据号
//   [WIN-ENC-01,CROSS-CLAIM-01] 写文本文件…    ← 一次触发挂多条判据
//   必填键齐；J14 这一档是「改脚本或判据」…      ← J14 这里是「档位」的散文引用，不是命中
// 所以：先剥掉开头的 [J\d] 类别标签，只取规则号；取不到就算「认不出」，
// 不再退到裸 J 号——实测裸 J 号 1,253 行里绝大多数是档位散文，退回去等于造假命中。
function extractIds(reason) {
  let s = String(reason || '');
  s = s.replace(/^\s*\[J\d{1,2}\]\s*/, '');
  const ids = [];
  const re = /[A-Z][A-Z0-9]{1,9}(?:-[A-Z0-9]{2,12}){1,3}/g;
  let m;
  while ((m = re.exec(s)) !== null) if (!ids.includes(m[0])) ids.push(m[0]);
  return ids;
}

function loadLedger() {
  const txt = readText(P.ledger);
  const empty = { ok: false, rows: 0, total: 0, cutoff: null, agg: new Map(), unattributed: 0, lastTs: null };
  if (!txt) return empty;
  const all = [];
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.split('\t');
    if (c.length < 5) continue;
    const ts = c[0].trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(ts)) continue;
    all.push({ ts, result: (c[3] || '').trim(), reason: c[4] || '' });
  }
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const lastTs = all.length ? all[all.length - 1].ts : null;
  let cutoff = null;
  if (DAYS > 0 && lastTs) {
    const d = new Date(lastTs.replace(' ', 'T'));
    d.setDate(d.getDate() - DAYS);
    const p = (n) => String(n).padStart(2, '0');
    cutoff = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${lastTs.slice(11)}`;
  }
  const agg = new Map();
  const lastTsById = new Map();
  let unattributed = 0;
  let kept = 0;
  for (const r of all) {
    if (cutoff && r.ts < cutoff) continue;
    kept++;
    const ids = extractIds(r.reason);
    if (!ids.length) { unattributed++; continue; }
    const t = Date.parse(r.ts.replace(' ', 'T'));
    const multi = ids.length > 1; // 一行挂多条判据：到底是谁拦下的分不清，不当任何一条的「拦下」算
    for (const id of ids) {
      const cur = agg.get(id) || { hit: 0, block: 0, hint: 0, check: 0, pass: 0, event: 0, total: 0, multiBlock: 0 };
      cur.total++;
      if (r.result === '拦下') { cur.hit++; if (multi) cur.multiBlock++; else cur.block++; }
      else if (r.result === '提示') { cur.hint++; cur.hit++; }
      else if (r.result === '未验') { cur.check++; cur.hit++; }
      else cur.pass++;
      // 连击只算一次事件；超过 DEDUPE 秒才算新事件
      const prev = lastTsById.get(id);
      if (prev == null || !Number.isFinite(t) || t - prev > DEDUPE * 1000) cur.event++;
      if (Number.isFinite(t)) lastTsById.set(id, t);
      agg.set(id, cur);
    }
  }
  // 截断残片归一：账本里见过 WIN-IRREVERS、AGENT-NO-ACCEPTAN 这类被列宽截断的编号，
  // 凡是某编号是另一个更长编号的前缀，就并进长的那个。
  const mergeInto = (dst, src) => {
    for (const k of ['hit', 'block', 'hint', 'check', 'pass', 'event', 'total', 'multiBlock']) dst[k] = (dst[k] || 0) + (src[k] || 0);
    return dst;
  };
  for (const id of [...agg.keys()]) {
    const longer = [...agg.keys()].find((o) => o !== id && o.startsWith(id));
    if (longer) { agg.set(longer, mergeInto(agg.get(longer), agg.get(id))); agg.delete(id); }
  }
  return { ok: true, rows: kept, total: all.length, cutoff, agg, unattributed, lastTs };
}

function libAgeDays() {
  try {
    const j = JSON.parse(readText(P.state));
    if (j.since) return Math.floor((Date.now() - new Date(j.since + 'T00:00:00+08:00').getTime()) / 86400000);
  } catch {}
  return null;
}

// 档位说人话：内部仍用「拦下即拒 / 影子期」做判断，打印时换成直白说法
const TIER_CN = { '拦下即拒': '直接拦', '影子期': '只提醒', '未知': '没写状态', '包外': '包里没有' };
const tierCn = (t) => TIER_CN[t] || t;

// ---------- 合并 ----------
const packs = loadPacks();
const lib = loadLib();
const human = loadHuman();
const led = loadLedger();
const age = libAgeDays();

const addAgg = (a, b) => ({
  hit: a.hit + b.hit, block: a.block + b.block, hint: a.hint + b.hint,
  check: a.check + b.check, pass: a.pass + b.pass,
  event: (a.event || 0) + (b.event || 0), total: (a.total || 0) + (b.total || 0)
});

const rows = packs.map((r) => {
  let a = led.agg.get(r.id) || { hit: 0, block: 0, hint: 0, check: 0, pass: 0, event: 0, total: 0 };
  if (r.legacy && led.agg.has(r.legacy)) a = addAgg(a, led.agg.get(r.legacy));
  // 人判表用的是 ok/bad 两个键，不能拿账本那套 hit/block 相加（旧版这样算出来是 NaN，把误报率全变成 NaN%）
  const hp = human.get(r.id) || { ok: 0, bad: 0 };
  const hq = r.legacy ? (human.get(r.legacy) || { ok: 0, bad: 0 }) : { ok: 0, bad: 0 };
  const h = { ok: (hp.ok || 0) + (hq.ok || 0), bad: (hp.bad || 0) + (hq.bad || 0) };
  const fpRate = a.block > 0 ? h.bad / a.block : null;
  // 没人判过 ≠ 0% 误报：人判表里没有这条的任何记录时，误报率就是「未判」，不给转正资格。
  // （只是 block=0 也算未判；旧版把这两种都当 0% 放行，是假门槛。）
  const hSeen = human.has(r.id) || (r.legacy ? human.has(r.legacy) : false);
  const fpUnknown = !hSeen || fpRate === null;
  const name = lib.get(r.id) || (r.legacy && lib.get(r.legacy)) || r.title;

  let verdict;
  if (r.tier === '影子期') {
    if (a.event >= MIN_HITS && !fpUnknown && fpRate <= MAX_FP_RATE) verdict = '样本够了，可升级成直接拦';
    else if (a.event >= MIN_HITS && !fpUnknown) verdict = `误报的比例 ${(fpRate * 100).toFixed(0)}%，先别升级`;
    else if (a.event >= MIN_HITS) verdict = `次数够（${a.event}）但没人核过对错，先抽 5–10 条看看`;
    else verdict = `继续观察（还差 ${MIN_HITS - a.event} 次）`;
  } else if (r.tier === '拦下即拒') {
    verdict = !fpUnknown && fpRate > MAX_FP_RATE
      ? `已生效但误报了 ${(fpRate * 100).toFixed(0)}%，建议退回只提醒`
      : '已生效，这段时间没出误报';
  } else {
    verdict = '这条没写后果（拦还是只提醒），先补';
  }
  if (age !== null && age >= MIN_OBS_DAYS && a.event === 0 && r.tier !== '拦下即拒') {
    verdict = `放了 ${age} 天一次没触发，可以撤掉`;
  }
  // 自动退场（2026-11-27）：已生效却误报超一成 → 退回草稿；观察满期零命中 → 退回草稿
  // 只出结论，不改包（写包要走 rule-gate 与人工签字）
  if (r.tier === '拦下即拒' && !fpUnknown && fpRate > MAX_FP_RATE) {
    verdict = `已生效但误报了 ${(fpRate * 100).toFixed(0)}%，退回草稿`;
  }
  if (age !== null && age >= MIN_OBS_DAYS && a.event === 0 && r.tier !== '拦下即拒') {
    verdict = `放了 ${age} 天一次没触发，退回草稿`;
  }
  return { id: r.id, legacy: r.legacy, name, pack: r.pack, origin: r.origin || 'model-error', tier: r.tier, hit: a.hit, event: a.event, total: a.total, block: a.block, hint: a.hint, bad: h.bad, ok: h.ok, fpRate, fpUnknown, verdict };
});

// 账本里出现、包里没有的编号（多为包内别名），单列，避免被当成「没命中」
// 别名归一：账本写 WIN-PS1-BOM-EDIT，包里叫 WIN-PS1-BOM-EDIT-01，视为同一条
const normId = (s) => String(s).replace(/-0*\d+$/, '');
const packIds = new Set(packs.flatMap((r) => [r.id, r.legacy].filter(Boolean)).map(normId));
const extra = [...led.agg.entries()].filter(([id]) => !packIds.has(normId(id)))
  .map(([id, a]) => ({ id, name: lib.get(id) || '(判据包里没有这条)', tier: '包外', hit: a.hit, event: a.event || 0, block: a.block, hint: a.hint, bad: 0, ok: 0, fpRate: null, fpUnknown: true, verdict: '账本里有、判据包里没有（别名或旧号）' }))
  .sort((x, y) => y.hit - x.hit);

rows.sort((x, y) => y.hit - x.hit || x.id.localeCompare(y.id, 'en', { numeric: true }));

const promote = rows.filter((r) => r.verdict.startsWith('够格转正'));
const demote = rows.filter((r) => /退回草稿|建议降级|误报率.*超标/.test(r.verdict));
const retire = rows.filter((r) => r.verdict.includes('退回草稿') || r.verdict.includes('建议退役'));
const untiered = rows.filter((r) => r.tier === '未知');
const byOrigin = (o) => rows.filter((r) => r.origin === o);

const windowText = DAYS > 0 ? `近 ${DAYS} 天` : '全量';
const me = byOrigin('model-error');
const pref = byOrigin('preference');
const head = `判据观察期 · ${localDate()}\n` +
  `窗口 ${windowText}｜账本 ${led.rows}/${led.total} 行｜判据 ${packs.length} 条（直接拦 ${rows.filter((r) => r.tier === '拦下即拒').length} / 只提醒 ${rows.filter((r) => r.tier === '影子期').length}）｜库龄 ${age === null ? '未知' : age + ' 天'}/${MIN_OBS_DAYS}\n` +
  `来源：模型错误 ${me.length} 条（生效 ${me.filter((r) => r.tier === '拦下即拒').length}）｜个人偏好 ${pref.length} 条（生效 ${pref.filter((r) => r.tier === '拦下即拒').length}）\n` +
  `门槛：一条判据攒够 ${MIN_HITS} 次（同一条在 ${DEDUPE} 秒内反复触发只算一次）才谈升级成直接拦；误报比例超过 ${(MAX_FP_RATE * 100).toFixed(0)}% 不许升级；没人核过对错的不给升级资格。账本里认不出编号的 ${led.unattributed} 行（多是「通过」，不计入任何判据）`;

if (JSONOUT) {
  console.log(JSON.stringify({
    date: localDate(), window: windowText, ageDays: age, ledgerRows: led.rows, unattributed: led.unattributed,
    counts: { packs: packs.length, promote: promote.length, demote: demote.length, retire: retire.length, untiered: untiered.length, modelError: byOrigin('model-error').length, preference: byOrigin('preference').length },
    promote: promote.map((r) => `${r.id}(${r.hit})`), demote: demote.map((r) => r.id), retire: retire.map((r) => r.id),
    rows, extra
  }, null, 2));
} else {
  console.log(head);
  console.log('');
  const p = (s, n) => String(s).padEnd(n);
  console.log(p('判据', 24) + p('类别', 12) + p('状态', 8) + p('次数', 6) + p('算一次', 8) + p('拦下', 6) + p('只提醒', 8) + '结论');
  for (const r of rows) {
    if (r.hit === 0 && r.tier === '拦下即拒') continue; // 已生效又没命中，不占屏
    console.log(p(r.id, 24) + p(r.origin === 'preference' ? '个人偏好' : '模型错误', 12) + p(tierCn(r.tier), 8) + p(r.hit, 6) + p(r.event, 6) + p(r.block, 6) + p(r.hint, 6) + r.verdict);
  }
  if (extra.length) {
    console.log('');
    console.log('包外编号（账本有、判据包里没有）：' + extra.slice(0, 10).map((r) => `${r.id}(${r.hit})`).join('、'));
  }
  console.log('');
  console.log(`要拍板的：够格转正 ${promote.length} 条｜误报超标 ${demote.length} 条｜建议退役 ${retire.length} 条｜档位缺失 ${untiered.length} 条`);
  if (promote.length) console.log('  转正候选：' + promote.map((r) => `${r.id}(${r.event} 次事件/${r.hit} 行)`).join('、'));
}

if (WRITE) {
  fs.mkdirSync(P.reportDir, { recursive: true });
  const date = localDate();
  const md = [
    `# 观察期转正候选 · ${date}`, '',
    head, '',
    '## 只回答一个问题：哪些可以升级成直接拦', '',
    promote.length ? promote.map((r) => `- **${r.id} ${r.name}**：${r.legacy ? `（对应 ${r.legacy}）` : ''}${r.hit} 次触发、拦下 ${r.block}、只提醒 ${r.hint}、误报 ${r.fpRate === null ? '无记录' : r.bad + ' 次'} → 可把 action 从 warn/steer 改成 block（升级成直接拦）`).join('\n') : '- 这周没有能升级的（次数不够或误报太多）',
    '',
    '## 需要处理的', '',
    demote.length ? demote.map((r) => `- ${r.id}：${r.verdict}`).join('\n') : '- 无误报超标',
    retire.length ? retire.map((r) => `- ${r.id}：${r.verdict}`).join('\n') : '- 没有该撤掉的',
    untiered.length ? untiered.map((r) => `- ${r.id}：包里没 action`).join('\n') : '- 档位齐全',
    '',
    '## 全量读数', '',
    '| 判据 | 类别 | 状态 | 触发次数 | 算几次 | 拦下 | 只提醒 | 误报 | 结论 |', '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.origin === 'preference' ? '个人偏好' : '模型错误'} | ${tierCn(r.tier)} | ${r.hit} | ${r.event} | ${r.block} | ${r.hint} | ${r.fpUnknown ? '未判' : r.bad} | ${r.verdict} |`),
    ...(extra.length ? ['', '包外编号：' + extra.slice(0, 20).map((r) => `${r.id}(${r.hit})`).join('、')] : []),
    '',
    '> 由 `node tools/observe.js --write` 生成，零模型调用。',
    '> 转正是人签的动作：点头后改判据包里那条的 `action`（warn/steer → block），本脚本不改库。'
  ].join('\n');
  const rp = path.join(P.reportDir, `观察期-${date}.md`);
  fs.writeFileSync(rp, md, 'utf8');

  const tsv = ['判据\t别名\t类别\t状态\t触发次数\t算几次\t拦下\t只提醒\t误报\t误报比例\t结论\t更新日期']
    .concat(rows.map((r) => [r.id, r.legacy || '', r.origin === 'preference' ? 'preference' : 'model-error', tierCn(r.tier), r.hit, r.event, r.block, r.hint, r.fpUnknown ? '未判' : r.bad,
      (r.fpUnknown || !isFinite(r.fpRate)) ? '' : (r.fpRate * 100).toFixed(0) + '%', r.verdict, date].join('\t')))
    .join('\n');
  fs.writeFileSync(P.obsTsv, tsv + '\n', 'utf8');
  console.log('');
  console.log(`已写：${rp}（${fs.statSync(rp).size} B）`);
  console.log(`已写：${P.obsTsv}（${fs.statSync(P.obsTsv).size} B）`);
}

process.exit(promote.length || demote.length ? 1 : 0);
