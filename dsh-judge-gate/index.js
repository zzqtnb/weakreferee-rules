/**
 * dsh-judge-gate — 弱裁判的事前闸（Host 半边）。
 *
 * 干的事只有一件：在每次工具调用真正执行之前，拿包内自带的参数约束表
 * （<插件目录>/lib/paramcheck.js，判据 J3 的唯一实现）核一遍形态，
 * 拦下就返回拒绝理由，让模型在没有发出去的时候就收到「缺哪个键」。
 *
 * 为什么用 guard 而不是 pre-execute 监听器：
 *   ctx.tools.guard() 是同步的、单调的守卫——返回字符串即拒绝，后续监听器
 *   无法把拒绝翻成允许。判据就该是这个性质：能判的不用等人点头。
 *   同步也意味着它能在毫秒级跑完（实测脚本形态 45–60 ms 含进程启动，
 *   进程内直接 require 后是微秒级），不会拖慢任何调用。
 *
 * 2026-11-22 自包含改造（为了能给别人装）：
 *   原来四处写死本机绝对路径（paramcheck、日志、新引擎、契约表目录），换台机器
 *   既找不到也不报错，继续「通过」——静默失效比拦错更贵。现在全部以本文件所在
 *   目录（__dirname 等价物）为基准，运行零件随包发：lib/ engine/ rules/。
 *
 * 三条安全约定（每一条都对应一次踩过的坑）：
 *   1. 自己崩了要放行，不能把工具调用卡死——所有异常一律 return undefined。
 *      闸的价值上限是「少犯错」，代价下限不能是「用不了」。
 *   2. 只有「拦下」才拒绝；「未验」（表里没收录这个工具）与「通过」都不拦。
 *      未验不闸是这套东西的立身之本：分不出「我不懂」和「没问题」时别装懂。
 *   3. 每一次判定都写一行 tsv，不管拦没拦——不然「闸是不是开着」这件事
 *      只能靠记性，那正是跳过死的入口。日志路径按「配置 > 环境变量 > 包内 data/ >
 *      DSH_HOME > 家目录 > 临时目录」逐个试写，全写不进去才降级并在日志里喊一声。
 *
 * 配置（在 profile 的 cordis.patch.yml 里按 id: judge-gate 覆盖，本机不必写）：
 *   paramcheckPath  参数约束表路径，默认 <包>/lib/paramcheck.js
 *   logPath         tsv 日志路径（时间/通道/工具/三态/理由/耗时ms），默认自动挑一个写得进的
 *   enforce         true＝拦下即拒；false＝只记不拦（影子模式，先用它验一版）
 *   skip            永不接管的工具名列表
 */

import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

export const name = 'judge-gate';

// 2026-11-19 18:30 加：本机所有用到 ctx.tools 的插件都声明了这个（dsh-cad:15、
// dsh-cite:16、dsh-ffmpeg:17），只有我们没写。实测现象是「模块被 import、apply 从未调用」，
// 与「依赖声明缺失导致宿主不去实例化」完全吻合，故先补齐再验。
export const inject = ['tools'];

// ── 包内零件位置：一切相对本文件，不认任何本机绝对路径 ─────────────────
const SELF_PATH = fileURLToPath(import.meta.url);
const SELF_DIR = dirname(SELF_PATH);
const LIB_DIR = join(SELF_DIR, 'lib');          // paramcheck.js + 三份契约表
const ENGINE_DIR = join(SELF_DIR, 'engine');    // 规则包版引擎（旁路用）
const RULE_DIRS = [                             // 三包规则：core / windows-powershell / dsh-host
  join(SELF_DIR, 'rules', 'core'),
  join(SELF_DIR, 'rules', 'windows-powershell'),
  join(SELF_DIR, 'rules', 'dsh-host'),
];

// 规则包 DSH-STALE-JUDGE-01 的条件里引用了 {DSH_JUDGE_TOOLS_DIR}；装载时校验
// 「引用的环境变量必须已设置」，不设就整条被拒装（实测 13/14，静默少一条）。
// 它指的是契约表所在目录，随包就是 lib/。
if (!process.env.DSH_JUDGE_TOOLS_DIR) process.env.DSH_JUDGE_TOOLS_DIR = LIB_DIR;

// ── J14（2026-11-23 加）：动手前先查自己建的系统。
//    判的是「这一次活属于哪一档，那一档该做的自查做没做」，不是「他有没有查过」。
//    记账放闸自己手里（gate-marks.json），不去读会话存档——闸在 dispatch 前是同步的，
//    看不到历史，但看得到自己上一次写了什么。
//    影子期形态：只写自己的 j14.log，一行一次，**不往拦截.tsv 里添行**——P6 淹过一次账本
//    （7 天 2089 条），同类错误不犯第二次。判据库里 J14 仍记「影子期只记不拦」。
let MARKS_FILE = process.env.DSH_JUDGE_MARKS || join(SELF_DIR, 'data', 'gate-marks.json');
let J14_LOG = process.env.DSH_JUDGE_J14_LOG || join(dirname(MARKS_FILE), 'j14.log');let J6_LOG = process.env.DSH_JUDGE_J6_LOG || join(dirname(MARKS_FILE), 'j6.log');
// J15 影子（2026-11-24 加）：工具返回失败之后，模型有没有当没看见接着干。
//    只记失败的：成功调用占绝大多数，全记会把文件刷成日志垃圾。
//    只记不拦：判断「无视」靠启发式，影子期先看清长什么样，再谈要不要拦。
let J15_LOG = process.env.DSH_JUDGE_J15_LOG || join(dirname(MARKS_FILE), 'j15.log');
// J6 的账只活在这个进程里：按住户进程启动划「本轮」，重启即清空，不落盘。
// 存 Map 不存数组：同一个文件读多次只留最后一次「什么时候看的」。
const J6_INPUTS = new Map();   // path -> { mtime, at }
const J6_WROTE = new Set();    // 本轮写过的目标 path
const J6_SAID = new Set();     // 已经提示过的 path@mtime，同一份旧文件不反复刷
const J6_MAX = 200;
// 输入排除：宿主自己的依赖/装载目录不是业务输入，记进来只会淹掉真信号。
// 可用 DSH_JUDGE_J6_IGNORE 覆盖（分号分隔，小写匹配）。
const J6_IGNORE = (process.env.DSH_JUDGE_J6_IGNORE || '\\node_modules\\;\\resources\\app\\;\\dsh-home\\')
  .split(';').map((s) => s.trim().toLowerCase()).filter(Boolean);
const MARK_TTL_MS = 60 * 60 * 1000;
const MARK_ALIASES = (process.env.DSH_JUDGE_MARK_WORDS || 'know-hit,know.cmd,know')
  .split(',').map((s) => s.trim()).filter(Boolean);
const MARK_FAMILY = [
  ['know-hit', MARK_ALIASES],
  ['check-dup', ['check-dup', 'check.ps1']],
  ['dsh-health', ['dsh-health']],
];
const TIER_NEEDS = { 2: ['know-hit'], 3: ['know-hit', 'check-dup'], 4: ['know-hit', 'check-dup', 'dsh-health'] };
const SOFT_DIR = /(_tmp|经验库|回收站|Temp|temp)[\\/]/;
const SCRIPT_EXT = /\.(ps1|js|cjs|mjs|json)$/i;
const WRITE_VERB = /(Out-File|Set-Content|Add-Content|Tee-Object|Export-Csv|Export-Clixml|Copy-Item|Move-Item|Remove-Item|New-Item|Rename-Item|Compress-Archive|\[IO\.File\]::WriteAll|git (commit|push|reset))/i;

function readMarks() {
  try { return JSON.parse(readFileSync(MARKS_FILE, 'utf8')) || {}; } catch { return {}; }
}

function writeMarks(obj) {
  try {
    mkdirSync(dirname(MARKS_FILE), { recursive: true });
    const tmp = MARKS_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    renameSync(tmp, MARKS_FILE);
    return true;
  } catch { return false; }
}

// 这次调用本身是不是在跑自查工具：是就登记时间戳（先记账，再判这次活）
function markSelfCheck(exec) {
  if ((exec.name || '') !== 'pwsh') return false;
  const a = exec.arguments;
  if (!a || typeof a !== 'object') return false;
  const cmd = String(a.command || a.cmd || '');
  if (!cmd) return false;
  if (/Select-String|findstr|\bgrep\b|Get-Content -Raw.*know-hit/i.test(cmd)) return false;  // 只是提到，不是在跑
  const hit = MARK_FAMILY.filter(([, aliases]) => aliases.some((w) => cmd.includes(w)));
  if (!hit.length) return false;
  const marks = readMarks();
  const t = Date.now();
  for (const [key] of hit) marks[key] = t;
  writeMarks(marks);
  return true;
}

function tierInfo(exec) {
  const name = exec.name || '';
  const a = exec.arguments;
  const isObj = !!a && typeof a === 'object';
  const cmd = isObj ? String(a.command || a.cmd || '') : '';
  const paths = [];
  if (isObj) {
    for (const k of ['file_path', 'path', 'destination', 'output_path', 'outputDir']) {
      if (typeof a[k] === 'string') paths.push(a[k]);
    }
    if (Array.isArray(a.files)) for (const f of a.files) if (f && typeof f.path === 'string') paths.push(f.path);
  }
  // 4 档：改脚本或判据
  if ((name === 'write' || name === 'edit') && paths.some((p) => SCRIPT_EXT.test(p))) return { tier: 4, why: '改脚本/配置' };
  if (name === 'pwsh' && /工具脚本|判据库|rules\.json/.test(cmd) && WRITE_VERB.test(cmd)) return { tier: 4, why: '命令改脚本/判据' };
  // 3 档：交付/收尾
  if (['present', 'dsh_im_return_file', 'office_edit', 'office_save', 'novel_write_chapter'].includes(name)) return { tier: 3, why: '交付/收尾' };
  if ((name === 'write' || name === 'edit') && paths.some((p) => /交付区|自动化报告/.test(p))) return { tier: 3, why: '写交付区/报告' };
  // 2 档：动正式位置（写 _tmp / 经验库 / 回收站 不算）
  if (name === 'pwsh' && WRITE_VERB.test(cmd) && !SOFT_DIR.test(cmd)) return { tier: 2, why: '命令动文件' };
  if ((name === 'write' || name === 'edit') && paths.some((p) => /[\\/]/.test(p) && !SOFT_DIR.test(p))) return { tier: 2, why: '写正式位置' };
  return null;
}

function j14Check(exec) {
  const t = tierInfo(exec);
  if (!t) return null;
  const need = TIER_NEEDS[t.tier] || [];
  if (!need.length) return null;
  const marks = readMarks();
  const now = Date.now();
  const missing = need.filter((k) => !marks[k] || now - marks[k] > MARK_TTL_MS);
  if (!missing.length) return null;
  return { tier: t.tier, why: t.why, missing };
}

function noteJ14(exec, hit) {
  try {
    mkdirSync(dirname(J14_LOG), { recursive: true });
    const a = exec.arguments;
    const brief = a && typeof a === 'object'
      ? String(a.file_path || a.path || a.command || a.instructions || '').replace(/\s+/g, ' ').slice(0, 120)
      : '';
    appendFileSync(J14_LOG, [nowStamp(), exec.name || '?', 'T' + hit.tier, hit.why, hit.missing.join('/'), brief].join('\t') + '\n', 'utf8');
  } catch { /* 记不进去不影响判定 */ }
}


// ── J6 影子：拿现成文件往下做之前，先确认它是这一回的 ─────────────────────────
// 判法：read 时记下文件的 mtime；等到有写动作时，找出「本轮读过、mtime 早于宿主启动、
// 本轮又没重写过」的输入。这种文件多半是上次留下的，用它产出之前该再看一眼。
// 只写 j6.log，不进拦截.tsv，也不拦——它和 J14 一样先看一段时间冤不冤。
function j6TrackFile(p) {
  if (!p || typeof p !== 'string') return;
  if (!/[\\/]/.test(p)) return;                       // 只认带路径的，光文件名判不了
  if (SOFT_DIR.test(p)) return;                        // _tmp / 经验库 / 回收站的输入不算
  if (J6_IGNORE.some((s) => p.toLowerCase().includes(s))) return;  // 宿主自己的依赖/装载目录不算输入
  try {
    const m = statSync(p).mtimeMs;
    if (J6_INPUTS.size >= J6_MAX && !J6_INPUTS.has(p)) {
      const first = J6_INPUTS.keys().next();
      if (!first.done) J6_INPUTS.delete(first.value);
    }
    J6_INPUTS.set(p, { mtime: m, at: Date.now() });
  } catch { /* 文件不在就算了 */ }
}

function j6TrackRead(exec) {
  if ((exec.name || '') !== 'read') return false;
  const a = exec.arguments;
  if (!a || typeof a !== 'object') return false;
  j6TrackFile(a.file_path || a.path);
  return true;
}

function j6TrackWrite(exec) {
  const name = exec.name || '';
  const a = exec.arguments;
  if (!a || typeof a !== 'object') return false;
  if (name === 'write' || name === 'edit') {
    const p = a.file_path || a.path;
    if (typeof p === 'string' && p) J6_WROTE.add(p);
    return true;
  }
  if (name !== 'pwsh') return false;
  const cmd = String(a.command || a.cmd || '');
  // 命令里源和目标长得一样（Copy-Item a b），分不清谁被写，
  // 所以命令只当「有写动作」的信号，目标一律不记：宁可对 Copy-Item a a 误报一次，
  // 也不要把正在用的输入当成「本轮已重写」而放过。只记不拦，这点噪音能忍。
  return WRITE_VERB.test(cmd);
}

function j6Check(exec) {
  if (!J6_INPUTS.size) return null;
  if (!j6TrackWrite(exec)) return null;                // 只有写动作才看得见「产出」
  const out = [];
  for (const [p, v] of J6_INPUTS) {
    if (J6_WROTE.has(p)) continue;                     // 本轮改过它，就是这一回的
    if (v.mtime > BOOT_AT - 2000) continue;            // 启动之后写的，不旧
    const key = p + '@' + Math.round(v.mtime);
    if (J6_SAID.has(key)) continue;
    J6_SAID.add(key);
    out.push({ path: p, mtime: v.mtime });
    if (out.length >= 3) break;
  }
  return out.length ? out : null;
}

function noteJ6(exec, hit) {
  try {
    mkdirSync(dirname(J6_LOG), { recursive: true });
    const a = exec.arguments;
    const target = a && typeof a === 'object'
      ? String(a.file_path || a.path || a.command || '').replace(/\s+/g, ' ').slice(0, 80)
      : '';
    for (const h of hit) {
      appendFileSync(J6_LOG, [nowStamp(), 'T6', h.path, stampOf(h.mtime), exec.name || '?', target].join('\t') + '\n', 'utf8');
    }
  } catch { /* 记不进去不影响判定 */ }
}

const DEFAULTS = {
  paramcheckPath: join(LIB_DIR, 'paramcheck.js'),
  logPath: '',          // 空串＝由 resolveLogPath() 按候选顺序挑第一个写得进的
  enforce: true,
  skip: [],
};

// ── P6 自检（2026-11-20 加）：判据代码比宿主新，说明改了没重启，闸跑的还是旧逻辑。
//    这种失效最阴——它不报错，继续「通过」，你会以为新判据已经上膛。
//    宿主启动时刻用 process.uptime() 倒推，不用查进程表。
//    2026-11-20 23:40 扩：从「只看 paramcheck.js」扩到「判据链上所有启动时读一次的文件」。
//    paramcheck.js 第 9／16／24 行把三个表全在模块加载时读进常量（T/GEN/TYPES），
//    改 json 不重启，跑的同样是旧表——只盯 .js 盯不住这一半。
const BOOT_AT = Date.now() - process.uptime() * 1000;
let staleBlockedKey = '';   // 同一批文件同一 mtime 只拦一次：拦是为了让你看见，不是为了把活卡死
let staleSuppressed = 0;    // 2026-11-23：同 key 再出现不再逐条记（实测 7 天记了 2089 条，淹掉别的判据）

function watchList(paramcheckPath) {
  const dir = dirname(paramcheckPath);
  return [
    { path: paramcheckPath, label: 'paramcheck.js' },
    { path: join(dir, 'tool-params.json'), label: 'tool-params.json' },
    { path: join(dir, 'tool-schema.json'), label: 'tool-schema.json' },
    { path: join(dir, 'tool-types.json'), label: 'tool-types.json' },
    { path: SELF_PATH, label: 'dsh-judge-gate/index.js' },
  ];
}

function probeStale(paramcheckPath) {
  // 一次 statSync 是微秒级，不做缓存：原设计带 5 秒缓存，实测「刚改完、5 秒内发的第一条命令」
  // 判不到，而那一刻正是最该发现的时候。
  const hit = [];
  for (const w of watchList(paramcheckPath)) {
    try {
      const m = statSync(w.path).mtimeMs;
      if (m > BOOT_AT + 2000) hit.push({ path: w.path, label: w.label, mtime: m });
    } catch { /* 文件不存在＝没启用这一份，不算过期 */ }
  }
  if (!hit.length) return null;
  hit.sort((a, b) => b.mtime - a.mtime);
  return hit;
}

function stampOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function oneLine(s, max = 60) {
  const t = String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// ── 日志落点：逐个候选试写，第一个写得进的就是它 ────────────────────────
// 为什么这么做：别人机器上没有本机那个目录，写不进去也不吭声，等于闸在裸奔。
function probeWritable(fp) {
  try {
    mkdirSync(dirname(fp), { recursive: true });
    appendFileSync(fp, '', 'utf8');
    return true;
  } catch { return false; }
}

function resolveLogPath(preferred) {
  const cands = [];
  if (preferred) cands.push(preferred);
  if (process.env.DSH_JUDGE_LOG) cands.push(process.env.DSH_JUDGE_LOG);
  cands.push(join(SELF_DIR, 'data', '拦截.tsv'));                       // 包内，随装随用
  if (process.env.DSH_HOME) cands.push(join(process.env.DSH_HOME, 'logs', 'judge-gate', '拦截.tsv'));
  try { cands.push(join(homedir(), '.dsh-judge-gate', '拦截.tsv')); } catch { /* homedir 取不到就跳过 */ }
  try { cands.push(join(tmpdir(), 'dsh-judge-gate', '拦截.tsv')); } catch { /* 同上 */ }
  for (let i = 0; i < cands.length; i++) {
    if (probeWritable(cands[i])) return { path: cands[i], moved: i > 0, tried: cands };
  }
  return { path: null, moved: true, tried: cands };
}

export function apply(ctx, config) {
  const opts = { ...DEFAULTS, ...(config || {}) };
  const skip = new Set(Array.isArray(opts.skip) ? opts.skip : []);
  // 判据名单（2026-11-23）：插件主判定也按名单走 —— 名单写进 env，paramcheck 加载时读。
  // 注意 opts.skip 是「跳过哪个工具」，判据名单用 only / skipJudges，两者别混。
  if (!process.env.DSH_JUDGE_ONLY && opts.only) {
    process.env.DSH_JUDGE_ONLY = Array.isArray(opts.only) ? opts.only.join(',') : String(opts.only);
  }
  if (!process.env.DSH_JUDGE_SKIP && opts.skipJudges) {
    process.env.DSH_JUDGE_SKIP = Array.isArray(opts.skipJudges) ? opts.skipJudges.join(',') : String(opts.skipJudges);
  }

  // ── 载入判据实现。载不进来不能装没事：第一次调用拦一下并说明原因，之后放行。
  //    （原实现是直接 return，宿主日志里一行 warn，模型侧完全无感——这就是静默失效。）
  let check = null;
  let checkText = null;
  let loadError = '';
  try {
    if (!existsSync(opts.paramcheckPath)) throw new Error(`参数表不存在: ${opts.paramcheckPath}`);
    const pc = createRequire(import.meta.url)(opts.paramcheckPath);
    check = pc.check;
    if (typeof check !== 'function') throw new Error('paramcheck.js 没有导出 check()');
    // 2026-11-20 加：J8/J9/J10 从错误库搬来的文本判据；没导出就当没有，不影响 J3
    checkText = typeof pc.checkText === 'function' ? pc.checkText : null;
  } catch (err) {
    loadError = oneLine(err && err.message ? err.message : err, 200);
    ctx.logger?.warn?.(`[judge-gate] 判据未载入：${loadError}`);
  }

  const logRes = resolveLogPath(opts.logPath);
  const logPath = logRes.path;
  // J14 的三个落点跟账本走：拦截.tsv 在哪，j14.log 与 gate-marks.json 就放隔壁。
  // 这样换机器、换工作区都不用改路径，周报也只要知道账本在哪就能找到这条账。
  if (!process.env.DSH_JUDGE_MARKS && logPath) MARKS_FILE = join(dirname(logPath), 'gate-marks.json');
  if (!process.env.DSH_JUDGE_J14_LOG && logPath) J14_LOG = join(dirname(logPath), 'j14.log');
  if (!process.env.DSH_JUDGE_J6_LOG && logPath) J6_LOG = join(dirname(logPath), 'j6.log');
  if (logPath && logRes.moved) {
    ctx.logger?.warn?.(`[judge-gate] 配置的日志路径写不进，改用 ${logPath}（试过：${logRes.tried.join(' | ')}）`);
  }
  if (!logPath) {
    ctx.logger?.warn?.('[judge-gate] 一个日志落点都写不进去，判定照跑但没有 tsv 账本；试过：' + logRes.tried.join(' | '));
  }

  const log = (row) => {
    if (!logPath) return;
    try {
      appendFileSync(logPath, row.join('\t') + '\n', 'utf8');
    } catch { /* 写不进去不影响判定 */ }
  };

  // ── J15 影子：观测工具结果，只记「失败的那一次」和「失败之后又直接写文件的那一下」。
  //    为什么用 tools/result 而不是 post-execute：result 是只观测的事件，改不了任何东西，
  //    最坏情况是这段代码抛错（已 catch），不可能把调用结果弄坏。
  //    5 MB 滚动：超了改名 .1 再重开，只留一份旧账。
  const J15_MAX = 5 * 1024 * 1024;
  let lastFail = null;   // { tool, at }
  const j15Write = (fields) => {
    try {
      mkdirSync(dirname(J15_LOG), { recursive: true });
      try { if (statSync(J15_LOG).size > J15_MAX) renameSync(J15_LOG, J15_LOG + '.1'); } catch { /* 还没建过 */ }
      appendFileSync(J15_LOG, [nowStamp(), ...fields].join('\t') + '\n', 'utf8');
    } catch { /* 记账坏了不影响干活 */ }
  };
  const resultLooksFailed = (r) => {
    if (!r) return false;
    if (r.isError === true) return true;
    let text = '';
    try {
      if (typeof r.content === 'string') text = r.content;
      else if (Array.isArray(r.content)) text = r.content.map((x) => (x && (x.text || x.content)) || '').join(' ');
      else if (r.value !== undefined) text = JSON.stringify(r.value);
    } catch { text = ''; }
    const t = String(text).trim();
    if (t === '') return true;
    return /(^|\s)Error[:：]|\bnot found\b|no such file|不存在|读取失败/i.test(t.slice(0, 400));
  };
  // 逃生门：设 DSH_JUDGE_J15=0 就完全跳过这段（等于这段代码不存在），不用改文件。
  // 为什么挂在 agent 作用域：dsh-tools 发 tools/result 时用的是 scopeTarget(this, exec.agent)，
  // 广播目标落在 agent 上，插件根 ctx 收不到（2026-11-24 实测：根 ctx 挂上去一行都没记）。
  // 所以两件事都做：现有 agent 挨个挂，之后新来的靠 agent/created。
  if ((process.env.DSH_JUDGE_J15 || '1') !== '0') {
    const onResult = (exec, result) => {
      try {
        if (!resultLooksFailed(result)) return;
        let brief = '';
        try {
          const a = exec && exec.arguments;
          brief = a && typeof a === 'object'
            ? String(a.file_path || a.path || a.command || '').replace(/\s+/g, ' ').slice(0, 80) : '';
        } catch { brief = ''; }
        const msg = result && result.error && result.error.message
          ? String(result.error.message).replace(/\s+/g, ' ').slice(0, 80) : '';
        j15Write(['结果失败', (exec && exec.name) || '?', msg, brief]);
        lastFail = { tool: (exec && exec.name) || '?', at: Date.now() };
      } catch { /* 观测失败不影响调用 */ }
    };
    const attach = (agent) => {
      try {
        const actx = agent && agent.ctx;
        if (!actx || typeof actx.on !== 'function' || actx === ctx) return;
        actx.on('tools/result', onResult);
      } catch { /* 单个 agent 挂不上不影响别的 */ }
    };
    // 软注入：agents 服务在时回调才跑；宿主没有这个服务时整段静默，闸照常工作。
    try {
      ctx.inject(['agents'], (act) => {
        try {
          const live = act.agents && typeof act.agents.list === 'function' ? act.agents.list() : [];
          for (const a of live) attach(a);
        } catch { /* 列不出来就只靠 agent/created */ }
        act.on('agent/created', (payload) => attach(payload && payload.agent));
      });
    } catch (err) {
      ctx.logger?.warn?.(`[judge-gate] J15 观测没注册上：${err && err.message ? err.message : err}（闸照常工作）`);
    }
  }

  // ── 新引擎旁路（2026-11-22 加）：规则包版引擎跟着判一遍，但**不参与判定**。
  //    为什么要旁路而不是直接换：换掉判定者，新引擎一旦有 bug，坏的是「能不能干活」；
  //    旁路只多写一份对照日志，主机的行为一个字都不变，出问题删掉环境变量就回到原样。
  //    开关 DSH_JUDGE_ENGINE=shadow；不设或 off ＝ 这段等于不存在（零开销、零风险）。
  // 2026-11-24 改：从「按 DSH_JUDGE_ENGINE=shadow 才旁路」升为「总是加载、参与判定」。
  // 理由（离线对照 9,162 次真实调用，80 个会话）：只有 paramcheck 拦 0 条、只有引擎拦 94 条
  // → 引擎 21 条是 paramcheck 那 12 条的超集，且多拦的都是真的（写中文 .ps1 不带编码等）。
  // paramcheck 保留两用：① J14 是进程内状态，引擎表达不了；② 引擎加载失败时兜底。
  let engineJudge = null;
  let shadowLog = null;
  {
    try {
      const REQ = createRequire(import.meta.url);
      const JE = REQ(join(ENGINE_DIR, 'judge.js'));
      const EX = REQ(join(ENGINE_DIR, 'expand.js'));
      // 判据从「安装清单」来（2026-11-24 改）：本体装上是空的，用户用 judge-packs 自己挑
      //   data/judges-installed.json = { packs: ["core"], rules: ["J16"] }
      //   环境变量 DSH_JUDGE_PACKS / DSH_JUDGE_RULES 优先（临时试装用）
      const STORE = join(dirname(MARKS_FILE), 'judges-installed.json');
      let inst = null;
      try { inst = JSON.parse(readFileSync(STORE, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 没装就是空的 */ }
      const split = (s) => String(s || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
      const wantPacks = split(process.env.DSH_JUDGE_PACKS).length
        ? split(process.env.DSH_JUDGE_PACKS)
        : (inst && Array.isArray(inst.packs) ? inst.packs : []);
      const wantRules = split(process.env.DSH_JUDGE_RULES).length
        ? split(process.env.DSH_JUDGE_RULES)
        : (inst && Array.isArray(inst.rules) ? inst.rules : []);
      const picked = [];
      const rejectedAll = [];
      for (const d of RULE_DIRS) {
        const packId = d.split(/[\\/]/).pop();
        const on = wantPacks.includes(packId);
        if (!on && !wantRules.length) continue;
        if (!existsSync(d)) continue;
        const one = JE.load([d], JE.ENV);
        if (one.rejected) rejectedAll.push(...one.rejected);
        for (const r of one.rules) {
          if (on || wantRules.includes(r.id) || wantRules.includes(r.legacyJudge)) picked.push(r);
        }
      }
      const rs0 = { rules: picked, rejected: rejectedAll };
      const ex = EX.expandAll(rs0.rules, { dir: LIB_DIR });
      // judge() 的数组分支不认 when，这里先自己筛出 tool:pre 那一批
      const pre = ex.rules.filter((r) => (r.when || 'tool:pre') === 'tool:pre');
      shadowLog = opts.shadowLogPath ||
        join(logPath ? dirname(logPath) : join(SELF_DIR, 'data'), '新引擎对照.tsv');
      engineJudge = (call) => {
        const hits = JE.judge(call, pre);
        const v = JE.adjudicate(hits);
        const ids = hits.map((h) => h.ruleId || (h.rule && h.rule.id) || '?');
        const msgs = hits.map((h) => h.message || (h.rule && h.rule.message) || '').filter(Boolean);
        const fixes = hits.map((h) => h.fix || (h.rule && h.rule.fix) || '').filter(Boolean);
        return { action: (v && v.action) || 'pass', ids, message: msgs[0] || '', fix: fixes[0] || '' };
      };
      ctx.logger?.info?.(
        picked.length
          ? `[judge-gate] 规则引擎已接入判定：装 ${picked.length} 条规则→展开 ${pre.length} 条` +
            `${rejectedAll.length ? `，拒装 ${rejectedAll.length} 条` : ''}，记录 ${shadowLog}`
          : `[judge-gate] 引擎已就绪，但一条判据都没装（装上是空的）。跑 node tools/judge-packs.js list 看看有哪些可装`);
      // 告诉 paramcheck：判定归引擎了，你只做机械活（容错解析/备份/名单）
      process.env.DSH_JUDGE_ENGINE_PRIMARY = '1';
    } catch (err) {
      // 引擎加载失败退回 paramcheck 单轨——少一套判据，但闸还能用
      engineJudge = null;
      ctx.logger?.warn?.(`[judge-gate] 规则引擎未接入（退回 paramcheck 单轨）：${err.message}`);
    }
  }

  let announcedBroken = false;

  ctx.tools.guard((exec) => {
    // 判据没载进来：只拦第一次，把原因原样交给模型，之后放行——不让配置问题把活卡死，
    // 也不让它安静地装成「都通过了」。
    if (!check) {
      if (announcedBroken) return undefined;
      announcedBroken = true;
      log([nowStamp(), 'plugin', exec.name || '?', '错误', oneLine('判据未载入：' + loadError, 120), 0]);
      return `[弱裁判·自检] 闸的判据没载进来：${loadError}（只拦这一次；修好并重启 DSH 即恢复）`;
    }

    let status = '通过';
    let notes = '';
    let judge = 'J3';
    const t0 = Date.now();
    let shadowArgs = null;   // 只有参数是正经对象时才交给旁路；坏 JSON 不参与对照
    let j14Hit = null;       // J14 影子：这次活该查而近一小时没查
    let j6Hit = null;        // J6 影子：这次产出用到的输入，可能是上一回留下的
    try {
      if (skip.has(exec.name)) return undefined;
      const args = exec.arguments;
      // J15 影子：上一条工具结果刚失败，这一下又直接写文件——记一笔「可能无视了失败」，不拦
      try {
        if (lastFail && Date.now() - lastFail.at < 5 * 60 * 1000 && (exec.name === 'write' || exec.name === 'edit')) {
          const tgt = args && typeof args === 'object'
            ? String(args.file_path || args.path || '').replace(/\s+/g, ' ').slice(0, 80) : '';
          j15Write(['疑似无视失败', exec.name, lastFail.tool, tgt]);
          lastFail = null;
        }
      } catch { /* 同上：记不上不影响干活 */ }
      try { markSelfCheck(exec); } catch { /* 记账坏了不影响判定 */ }
      try { j14Hit = j14Check(exec); } catch { j14Hit = null; }      try { j6TrackRead(exec); } catch { /* 记账坏了不影响判定 */ }
      try { j6Hit = j6Check(exec); } catch { j6Hit = null; }
      const badJson = typeof args === 'string';
      if (!badJson && args && typeof args === 'object') shadowArgs = args;
      const stale = probeStale(opts.paramcheckPath);
      if (stale) {
        const key = stale.map((h) => h.label + '@' + Math.round(h.mtime)).join('|');
        const detail = stale.map((h) => h.label + ' 改于 ' + stampOf(h.mtime)).join('、') +
          '，宿主启动于 ' + stampOf(BOOT_AT) + '；重启 DSH 后新判据才生效';
        if (staleBlockedKey === key) {
          // 同一批文件已经报过：不再逐条记，也不再拦——放行且不写账，每隔 50 次留一行汇总
          staleSuppressed += 1;
          if (staleSuppressed % 50 !== 0) return undefined;
          status = '提示';
          notes = `P6 仍在（已静默 ${staleSuppressed} 次）：` + detail;
        } else {
          staleBlockedKey = key;
          staleSuppressed = 0;
          status = '拦下';
          notes = 'P6 改了判据没重启，闸跑的还是旧代码：' + detail;
        }
        judge = 'P6';
      } else {
        const r = check(exec.name, badJson ? null : args, badJson);
        status = r.status;
        notes = r.notes || '';
        if (r.judge) judge = r.judge;
        // 规则引擎全量判定（2026-11-24 接入）：与 paramcheck 取并集，任一 block 即拦。
        if (engineJudge) {
          try {
            const s = engineJudge({
              when: 'tool:pre', tool: exec.name, args: badJson ? null : args,
              platform: 'windows', shell: 'powershell-5.1', host: 'dsh', cwd: process.cwd(),
            });
            if (s && s.action === 'block') {
              // 名单过滤（用户自己的选择优先）：被 skip 的条不拦，只装几条时只拦那几条
              const live = pc.judgeEnabled ? s.ids.filter((id) => pc.judgeEnabled(id)) : s.ids;
              if (live.length) {
                const engNote = s.fix ? `${s.message}（${s.fix}）` : (s.message || live.join(','));
                if (status === '拦下') {
                  notes = notes ? `${notes}；引擎另有 ${live.join(',')}` : `${live.join(',')}：${engNote}`;
                } else {
                  status = '拦下';
                  judge = live.join(',') || judge;
                  notes = engNote;
                }
              }
            }
          } catch (e) { /* 引擎抛错不影响 paramcheck 的结论 */ }
        }
        // 文本判据（J8/J9/J10）：J3 已经拦下就不再叠；「提示」只把理由记进日志、不改判定列
        if (status !== '拦下' && checkText) {
          const r2 = checkText(exec.name, badJson ? null : args);
          if (r2 && r2.notes) {
            notes = notes ? `${notes}；${r2.notes}` : r2.notes;
            if (r2.status === '拦下') {
              status = '拦下';
              judge = r2.judge || 'J3';
            }
          }
        }
      }
    } catch (err) {
      // 判据自己出错＝放行。宁可漏一次，不可把工具全卡死。
      status = '错误';
      notes = oneLine(err && err.message ? err.message : err);
    }
    const ms = Date.now() - t0;
    log([nowStamp(), 'plugin', exec.name || '?', status, oneLine(notes), ms]);
    if (j14Hit) noteJ14(exec, j14Hit);
    if (j6Hit) noteJ6(exec, j6Hit);

    // 旁路对照：主判定已经算完、已经记完账，这里只是并排再看一眼。
    // 任何异常一律吞掉 —— 旁路的价值是「发现不一致」，不是「也能拦」，更不能拖累主判定。
    if (shadowJudge && shadowArgs && !skip.has(exec.name)) {
      const t1 = Date.now();
      let row;
      try {
        const s = shadowJudge({ when: 'tool:pre', tool: exec.name, args: shadowArgs });
        const agree = (status === '拦下') === (s.action === 'block') ? '一致' : '不一致';
        row = [nowStamp(), exec.name || '?', status, s.action, agree,
          oneLine(notes), oneLine(s.notes), Date.now() - t1];
      } catch (err) {
        row = [nowStamp(), exec.name || '?', status, '错误', '旁路失败',
          oneLine(notes), oneLine(err && err.message ? err.message : err), 0];
      }
      if (shadowLog) {
        try {
          appendFileSync(shadowLog, row.join('\t') + '\n', 'utf8');
        } catch { /* 对照日志写不进去，不影响任何判定 */ }
      }
    }

    if (status === '拦下' && opts.enforce) {
      return `[弱裁判·判据${judge}] ${notes}（拦在发送前，改完再发）`;
    }
    return undefined;
  });

  ctx.logger?.info?.(
    `[judge-gate] 已挂上：${opts.enforce ? '拦下即拒' : '影子模式（只记不拦）'}，判据 ${opts.paramcheckPath}，日志 ${logPath || '（无可用落点）'}`);
}
