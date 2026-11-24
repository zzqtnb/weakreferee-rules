// paramcheck.js — 判据 J3 的唯一实现（事前闸与事后审计共用）
// 2026-11-19 抽出来：两个脚本各写一份约束判断，已经害过一次（read_image 写成 path → 3 次误报）。
// 五型可判：arguments 不是合法 JSON / 缺必填键 / 必填键为空 / 缺必填之一 / 形近错键 / 多余键（additionalProperties）
"use strict";
const fs = require("fs");
const path = require("path");

const TABLE_FILE = path.join(__dirname, "tool-params.json");
const T = JSON.parse(fs.readFileSync(TABLE_FILE, "utf8"));

// 生成表（schema-scan.js 从会话日志的 request/header 里抽的全量工具 schema）
// 手写表职责变小：只保留「schema 比逻辑松」的补丁（如 compress 的 content 没标 required）
const GEN_FILE = path.join(__dirname, "tool-schema.json");
let GEN = { tools: {} };
if (fs.existsSync(GEN_FILE)) {
  try { GEN = JSON.parse(fs.readFileSync(GEN_FILE, "utf8")); } catch { GEN = { tools: {} }; }
}

// 键的类型与枚举（schema-types.js 抽的）：tool -> {键: {type, enum?, anyOf?}}
// 2026-11-19 加：跨 API 变异测出「类型错 0/564、枚举越界 0/29」两型全漏，先做影子模式（只提示不拦）。
const TYPES_FILE = path.join(__dirname, "tool-types.json");
let TYPES = { tools: {} };
if (fs.existsSync(TYPES_FILE)) {
  try { TYPES = JSON.parse(fs.readFileSync(TYPES_FILE, "utf8")); } catch { TYPES = { tools: {} }; }
}
const TYPES_BLOCK = process.env.DSH_JUDGE_TYPES === "block";   // 影子模式开关：默认只提示
// J5 影子期开关（2026-11-20）：默认只提示不拦。档案回放没法验它——回放拿的是文件此刻的内容，
// 而历史调用对应的是当时的内容，文件后来改过就必然「找不到」，1300 次「误拦」全是这个错位。
// 真误拦率只能在线攒，一周后看 拦截.tsv 里 J5 提示与「改成拦下会不会更糟」。
const J5_BLOCK = process.env.DSH_JUDGE_J5 === "block";

function typeOk(tv, v) {
  if (v === null || v === undefined) return true;      // 空值交给「必填键为空」
  const t = typeof v;
  switch (tv) {
    case "string": return t === "string";
    case "integer": return Number.isInteger(v);
    case "number": return t === "number";
    case "boolean": return t === "boolean";
    case "array": return Array.isArray(v);
    case "object": return t === "object" && !Array.isArray(v);
    default: return true;                                // 未知类型不判
  }
}

const REQ = {};
// 1) 先吃 schema 里的 required（覆盖 195 个工具）
for (const [tool, sc] of Object.entries(GEN.tools || {})) {
  const req = (sc.req || []).slice();
  const anyOf = Array.isArray(sc.anyOf) ? sc.anyOf.map(g => g.slice()) : [];
  // 2026-11-20 改：原来只在 req/anyOf 非空时登记，把「没有必填键」误判成「未收录→未验」（76 个工具）。
  // 没有必填键≠没有约束——这种工具任何 args 都不会因缺键失败，语义上就该判通过。
  if (sc && sc.hasSchema !== false) REQ[tool] = { req, anyOf, src: "schema" };
}
// 2) 再用手写表取并集（手写表比 schema 严时不丢）
for (const [tool, list] of Object.entries(T.req || {})) {
  const req = [], anyOf = [];
  for (const k of list) {
    if (k.startsWith("@any:")) anyOf.push(k.slice(5).split("|"));
    else req.push(k);
  }
  const cur = REQ[tool] || { req: [], anyOf: [], src: "hand" };
  for (const k of req) if (!cur.req.includes(k)) cur.req.push(k);
  for (const g of anyOf) cur.anyOf.push(g);
  cur.src = REQ[tool] ? "schema+hand" : "hand";
  REQ[tool] = cur;
}
// 二选一（anyOf）里的键不该同时算必填：schema 的 required 只写组里一个时，两者叠起来会把
// 「给第二个键」的正常调用判成缺第一个。注意 web_fetch 不属于这类——那是手写表凭空多写了
// 工具不支持的 urls，已改正为 req=[url] + 形近错键 urls（工具真实 props 只有 url）。
for (const t of Object.keys(REQ)) {
  const e = REQ[t];
  if (!e.anyOf.length || !e.req.length) continue;
  const inAny = new Set(e.anyOf.reduce((acc, g) => acc.concat(g), []));
  e.req = e.req.filter(k => !inAny.has(k));
}
const WRONGKEY = T.wrongkey || {};
const FORBID = T.forbid || {};

// 2026-11-20：显式声明「确实没有必填参数」的工具——schema 里 props 非空，但语义上全是可选项。
// 不在这张表里、props 非空又没 required 的工具，一律判未验：不知道哪些必填就别说通过。
const NOREQ = new Set([
  "dsh_browser_snapshot", "dsh_browser_state", "dsh_browser_list_tabs", "dsh_browser_help",
  "dsh_browser_history", "dsh_browser_visited", "dsh_browser_console", "dsh_browser_refresh",
  "dsh_browser_screenshot", "dsh_browser_network", "dsh_browser_dialog", "dsh_browser_session",
  "dsh_browser_doctor", "dsh_browser_a11y", "dsh_browser_wait",
  "office_read", "office_status", "office_save", "working_directory", "automation_list",  // 2026-11-20：唯一参数 all_workspaces 全可选，属真无必填
  // 2026-11-21 补（fp 6cad683bc484 采纳）：schema 有 props 但语义上全可选，逐个核过
  "acp_cache", "cad_doc_new", "dsh_browser_restrict", "dsh_browser_reset_session", "dsh_im_group_history", "fishtalk_deep", "fishtalk_pack", "free_search_test", "list_agents", "office_close", "office_render", "task_board_list",
]);

// 哪些工具的 schema 声明了 additionalProperties:false（多余键才非法）
const CLOSED = {};

// 2026-11-20 加：数组项的属性白名单。schema 的 additionalProperties:false 只在 items 层声明时，
// 顶层 closed 检查看不到 —— 档案回放里 present 的 files[].title / files[].label 共 15 次被判非法，
// 表里只有 forbid 的枚举负数，漏掉一个新名字就再漏一次。这里改成白名单：不在名单里的键一律多余。
const ITEM_PROPS = {
  present: { files: ["path", "description"] },
};
for (const [tool, sc] of Object.entries(GEN.tools || {})) if (sc && sc.closed) CLOSED[tool] = true;

// 支持 "files[].title" 这种一层的数组路径
function hasPath(obj, dotted) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const isArr = p.endsWith("[]");
    const key = isArr ? p.slice(0, -2) : p;
    if (cur === null || typeof cur !== "object") return false;
    if (!(key in cur)) return false;
    cur = cur[key];
    if (isArr) {
      if (!Array.isArray(cur)) return false;
      const rest = parts.slice(i + 1).join(".");
      if (!rest) return cur.length > 0;
      return cur.some(el => hasPath(el, rest));
    }
  }
  return true;
}

function check(name, args, badJson) {
  const schema = REQ[name];
  if (!schema) return { status: "未验", notes: "该工具无参数约束表（未收录），机器判不了，不猜" };
  if (badJson) return { status: "拦下", notes: "arguments 不是合法 JSON" };
  if (NOREQ.has(name) && schema.req.length === 0 && schema.anyOf.length === 0) {
    return { status: "通过", notes: "该工具无必填参数（已显式登记）" };
  }
  const a = args || {};
  const missing = schema.req.filter(k => !(k in a));
  const empty = schema.req.filter(k => k in a && (a[k] === "" || a[k] === null || (Array.isArray(a[k]) && !a[k].length)));
  const anyOfFail = schema.anyOf.filter(g => !g.some(k => k in a));
  const wrong = (WRONGKEY[name] || []).filter(k => k in a);
  const extra = (FORBID[name] || []).filter(p => hasPath(a, p));
  const notes = [];
  // 多余键（自动）：schema 声明 additionalProperties:false 的工具，凡是它没声明的键一律多余
  const sc = (GEN.tools || {})[name];
  if (sc && sc.closed && Array.isArray(sc.props)) {
    const unknown = Object.keys(a).filter(k => !sc.props.includes(k));
    for (const k of unknown) if (!extra.includes(k)) extra.push(k + "（schema 未声明）");
  }
  // 数组项层的多余键（ITEM_PROPS 白名单）
  const ip = ITEM_PROPS[name];
  if (ip) {
    for (const [arrKey, allowed] of Object.entries(ip)) {
      const arr = a[arrKey];
      if (!Array.isArray(arr)) continue;
      arr.forEach((el, i) => {
        if (el === null || typeof el !== "object") return;
        for (const k of Object.keys(el)) {
          if (!allowed.includes(k)) {
            const tag = `${arrKey}[${i}].${k}（只认 ${allowed.join("/")}）`;
            if (!extra.includes(tag)) extra.push(tag);
          }
        }
      });
    }
  }
  if (missing.length) notes.push("缺必填键: " + missing.join(","));
  if (empty.length) notes.push("必填键为空: " + empty.join(","));
  if (anyOfFail.length) notes.push("缺必填之一: " + anyOfFail.map(g => g.join("|")).join("; "));
  if (wrong.length) notes.push("形近错键: " + wrong.join(","));
  if (extra.length) notes.push("多余键（该工具不声明此属性）: " + extra.join(","));

  // 类型 / 枚举（影子模式：默认只提示，不参与拦下）
  const specs = (TYPES.tools || {})[name] || {};
  const warn = [];
  for (const [k, spec] of Object.entries(specs)) {
    if (!(k in a)) continue;
    const v = a[k];
    if (v === null || v === undefined || v === "") continue;
    if (spec.type && spec.type !== "anyOf" && !typeOk(spec.type, v)) {
      warn.push(`类型不符: ${k} 应为 ${spec.type}，实际 ${Array.isArray(v) ? "array" : typeof v}`);
    }
    if (Array.isArray(spec.anyOf) && spec.anyOf.length && !spec.anyOf.some(t => typeOk(t, v))) {
      warn.push(`类型不符: ${k} 应为 ${spec.anyOf.join("|")}`);
    }
    if (Array.isArray(spec.enum) && spec.enum.length && !spec.enum.includes(v)) {
      warn.push(`值不在枚举内: ${k}`);
    }
  }
  if (warn.length && TYPES_BLOCK) notes.push(...warn);

  if (notes.length) return { status: "拦下", notes: notes.join("；"), warns: warn };
  if (warn.length) return { status: "通过", notes: "提示（J3-type）: " + warn.join("；"), warns: warn };
  // 2026-11-20 改：schema 里「有参数、但没声明 required」的工具（48 个，如 dsh_browser_click 的 target|x|y、
  // weather 的 location），闸根本不知道哪个必填，判「通过」等于假通过——比未验更糟（未验会进分布表，假通过什么都不留）。
  // 真无参的工具（props 也为空，30 个）不受影响，继续判通过。
  if (schema.req.length === 0 && schema.anyOf.length === 0
      && sc && Array.isArray(sc.props) && sc.props.length > 0) {
    return { status: "未验", notes: `schema 有 ${sc.props.length} 个参数但未声明必填键，机器判不了，不猜`, warns: warn };
  }
  return { status: "通过", notes: "必填键齐", warns: [] };
}

// ── J8 / J9 / J10：从错误库搬过来的三条文本判据（2026-11-20）
// 交接条件（见 经验库\教训去向.json）：只判「写法形态确定」的事，不判语义。
//   J8  pwsh 用 > 重定向或 Out-File/Set-Content/Add-Content 写文本文件却没 -Encoding
//       ——中文会按默认编码落盘，读回来就是乱码（e-m-02，6 天记了 10 条、从未合并）
//   J9  递归删除没带 -WhatIf（e-m-05）。**影子期：只记不拦**，先看一周误拦率再决定要不要拦
//   J10 往 .ps1 里写 PowerShell 自动变量赋值 $input=/$args=/$error=…（e-m-04，只读变量）
//   J11 整目录镜像/清理（robocopy /MIR 或 /PURGE）没先查目录联接（e-mwoezoq9-19：跟随式复制
//       把 junction 指向的真实源码一并清空，30 秒清掉三个插件）。**影子期：只记不拦**
const TEXT_EXT = 'ps1|md|json|txt|csv|log|yml|yaml|xml|ini';
const WRITE_REDIR = new RegExp(`(^|[^0-9*>=])>{1,2}\\s*("[^"]+\\.(?:${TEXT_EXT})"|'[^']+\\.(?:${TEXT_EXT})'|[^\\s|;&<>]+\\.(?:${TEXT_EXT}))`, 'i');
const PS_WRITERS = /\b(Out-File|Set-Content|Add-Content|Export-Csv|Export-Clixml|Tee-Object)\b/i;
const PS_RECURSE = /\b(Remove-Item|rm|ri|del|erase|rd|rmdir)\b[^|;]*(-Recurse\b|\/s\b|-r\b|\/q\s*\/s)/i;
const PS_AUTOVAR = /\$(input|args|error|host|home|pid|matches|this|foreach|psitem)\s*=(?!=)/i;
// 只在「robocopy 作为命令出现」时才算：前面必须是行首/;|&({ 之类，排除 echo "robocopy /MIR" 这种纯文本
const PS_IRREVERSIBLE = /\b(reg\s+(add|delete|import)|New-Service|Set-Service|Remove-Service|Register-ScheduledTask|Unregister-ScheduledTask|Format-Volume|Initialize-Disk|Clear-Disk|vssadmin|wbadmin)\b|\bsc(\.exe)?\s+(create|delete|config)\b|\bschtasks(\.exe)?\s+\/(create|delete)\b|\bnetsh\s+(int|advfirewall|winsock)\s+\w+\s+(set|reset|delete)\b|\bdiskpart\b/i;
const PS_MIRROR = /(?:^|[\r\n;|&({])\s*(?:&|\.\s+)?robocopy\b[^|;\r\n]*\/(MIR|PURGE)\b/i;
// 2026-11-21 修 J8/J9 误报：判据原来在整串命令上跑，看不见引号边界。
// 实测：Select-String -Pattern 'Out-File|Set-Content' 被判成 J8 拦下（命令里根本没有写操作），
// Get-Content x | Select-String 'Remove-Item -Recurse' 被判成 J9。判断前先把引号里的字面量
// 抹成等长空格，动词只在「引号外」才算命令。重定向 WRITE_REDIR 仍用原文（目标常带引号）。
function maskQuoted(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      let j = i + 1, closed = false;
      while (j < s.length) {
        if (s[j] === "'") { if (s[j + 1] === "'") { j += 2; continue; } closed = true; break; }
        j++;
      }
      // 引号没闭合（命令被截断或本来就不是成对引号）：整条退回原文，宁可误报不漏拦
      if (!closed) return s;
      out += ' '.repeat(j - i + 1); i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1, closed = false;
      while (j < s.length) {
        if (s.charCodeAt(j) === 96) { j += 2; continue; }
        if (s[j] === '"') { closed = true; break; }
        j++;
      }
      if (!closed) return s;
      out += ' '.repeat(j - i + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}


// J12（2026-11-20 用户要求「把可逆的补全」）：pwsh 用命令写/删文件时 rewind 抓不到（它只挂 write/edit）。
// 这里在发送前把命令里提到的绝对路径备份一份，出问题能从回收站捞回来。影子期：只备份+提示，不拦。
// 数据目录（备份与标记都落这里）：默认包内 data\，可用环境变量指到别处。
// 2026-11-23 改：原来写死本机绝对路径，别人机器上没有那个盘就静默失效。
const DATA_DIR = process.env.DSH_JUDGE_DATA || path.join(__dirname, "..", "data");
const CMD_BACKUP_ROOT = process.env.DSH_JUDGE_BACKUP || path.join(DATA_DIR, "回收站");
// ── 启用名单（2026-11-23）：插件主判定也认「只装几条」 ──
// 原来名单只作用于规则包引擎，插件拦工具这一侧照旧全开，用户按目录挑了五条也不生效。
// 名单写法与引擎一致：逗号/分号/空格分隔，认 id 也认 legacy 名（J8 或 WIN-ENC-01）。
function parseIdList(v) {
  if (!v) return [];
  if (Array.isArray(v)) v = v.join(',');
  return String(v).split(/[,;\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
}
const ONLY_LIST = parseIdList(process.env.DSH_JUDGE_ONLY);
const SKIP_LIST = parseIdList(process.env.DSH_JUDGE_SKIP);
const ID_ALIAS = {
  J3: ['J3', 'CORE-HTTPS-01', 'CORE-PARAMS-GEN'], J5: ['J5', 'DSH-ANCHOR-01'],
  J8: ['J8', 'WIN-ENC-01'], J9: ['J9', 'WIN-RMDIR-01'],
  J10: ['J10', 'WIN-PS1-AUTOVAR-01'], J11: ['J11', 'WIN-MIRROR-01'],
  J12: ['J12', 'SCENE-BACKUP-01'], J13: ['J13', 'WIN-IRREVERSIBLE-01'],
  J15: ['J15', 'WIN-PS1-CJK-01'], J16: ['J16', 'WIN-PS1-BOM-EDIT-01'],
  J17: ['J17', 'WIN-AUTOVAR-CMD-01'], P6: ['P6', 'DSH-STALE-JUDGE-01'],
  BAT: ['BAT', 'WIN-BAT-CJK-01'],
  // 2026-11-24 补：引擎接入后这七条由引擎判，名单要认它们，否则 J18 这类关不掉
  J18: ['J18', 'WIN-SQL-DELETE-01'], J19: ['J19', 'WIN-GIT-DISCARD-01'],
  J20: ['J20', 'WIN-PERM-OPEN-01'], J21: ['J21', 'WIN-VARPATH-RM-01'],
  J22: ['J22', 'WIN-SQL-DROP-01'], J23: ['J23', 'WIN-LOG-WIPE-01'],
  J24: ['J24', 'CORE-ARGTYPE-01'],
};
function judgeEnabled(id) {
  const raw = String(id || '');
  // 双向找：按判据号（J18）或按规则名（WIN-SQL-DELETE-01）都要能认
  let names = ID_ALIAS[raw];
  if (!names) {
    const key = Object.keys(ID_ALIAS).find((k) => ID_ALIAS[k].includes(raw) || ID_ALIAS[k].includes(raw.toUpperCase()));
    names = key ? ID_ALIAS[key] : [raw.toUpperCase()];
  }
  if (ONLY_LIST.length && !names.some((n) => ONLY_LIST.includes(n))) return false;
  if (names.some((n) => SKIP_LIST.includes(n))) return false;
  return true;
}
function judgeListInfo() {
  return { only: ONLY_LIST.slice(), skip: SKIP_LIST.slice() };
}

const CMD_WRITE_VERBS = /\b(Set-Content|Add-Content|Out-File|Export-Csv|Export-Clixml|Tee-Object|Copy-Item|Move-Item|Rename-Item|Remove-Item|New-Item|Clear-Content)\b|(^|[\s;&|(])(del|erase|rd|rmdir|rm|ri)\s/i;
function snapshotCmdPaths(cmd) {
  let snapErr = null;
  if (!CMD_WRITE_VERBS.test(maskQuoted(cmd))) return null;
  const seen = new Set();
  const re = /[A-Za-z]:[\\/][^\s"'|;<>()\[\]{},*?]+/g;
  let m;
  while ((m = re.exec(cmd))) seen.add(m[0].replace(/[.\\]+$/, ""));
  const saved = [];
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  let dir = null;
  for (const p of seen) {
    if (/_tmp|node_modules|\\回收站\\/i.test(p)) continue;
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
    try {
      if (!dir) {
        dir = path.join(CMD_BACKUP_ROOT, "cmd__" + ts + "__" + Math.random().toString(36).slice(2, 8));
        fs.mkdirSync(dir, { recursive: true });
      }
      const dst = path.join(dir, String(saved.length) + "__" + path.basename(p));
      fs.copyFileSync(p, dst);
      fs.writeFileSync(dst + ".meta.json", JSON.stringify({ source: p, at: new Date().toISOString(), size: st.size }), "utf8");
      saved.push(path.basename(p));
    } catch (e) { snapErr = snapErr || (e && e.message) || "写不进"; }
  }
  if (!saved.length) {
    // 备份失败要说出来：影子期只提示不拦，但「以为备了其实没备」比不备份更坑
    return snapErr ? "J12 想备份但写不进 " + CMD_BACKUP_ROOT + "（" + snapErr + "），这次没备份" : null;
  }
  try { pruneBackups(); } catch {}
  return "J12 命令要改的 " + saved.length + " 个文件已备份到回收站（影子期只备份不拦）：" + saved.slice(0, 3).join(" , ");
}
// 备份保留（2026-11-23）：影子期每次命中都真备份，实测已攒 211 个目录 / 4.5 MB。
// 留最近 200 个、超 30 天的删掉；每 20 次调用清一次，不每次扫盘。
let PRUNE_CALLS = 0;
function pruneBackups() {
  if (++PRUNE_CALLS % 20 !== 0) return;
  try {
    const ents = fs.readdirSync(CMD_BACKUP_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('cmd__'));
    if (!ents.length) return;
    const rows = ents.map((e) => {
      const full = path.join(CMD_BACKUP_ROOT, e.name);
      let mt = 0;
      try { mt = fs.statSync(full).mtimeMs; } catch {}
      return { full, mt };
    }).sort((a, b) => b.mt - a.mt);
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (let i = 0; i < rows.length; i++) {
      const old = i >= 200 || rows[i].mt < cutoff;
      if (!old) continue;
      try { fs.rmSync(rows[i].full, { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

// ── J14：用没用自己建的系统（2026-11-21 加，用户指出「建了不用」） ──
// 影子期：只提示，不拦。先判这次调用属于哪一档，只对「要动正式位置」的档位要求先查，
// 纯讨论轮（只读、写 _tmp）根本走不到这里，天然不会误报。
const GATE_MARKS = process.env.DSH_JUDGE_MARKS || path.join(DATA_DIR, "gate-marks.json");
const J14_WINDOW = 60 * 60 * 1000;   // 一小时内的自查算数

function readMarks() {
  try {
    const o = JSON.parse(fs.readFileSync(GATE_MARKS, "utf8"));
    return (o && typeof o === "object") ? o : {};
  } catch { return {}; }
}
function markTool(kind) {
  try {
    const o = readMarks();
    o[kind] = new Date().toISOString();
    fs.mkdirSync(path.dirname(GATE_MARKS), { recursive: true });
    fs.writeFileSync(GATE_MARKS, JSON.stringify(o), "utf8");
  } catch { }
}
function markFresh(kind) {
  const o = readMarks();
  if (!o[kind]) return false;
  const t = Date.parse(o[kind]);
  return Number.isFinite(t) && (Date.now() - t) < J14_WINDOW;
}
// 命令里出现这几个工具就把「查过了」记下来
function recordCmd(cmd) {
  if (/know-hit|know\.cmd/i.test(cmd)) markTool("know");
  if (/check-dup/i.test(cmd)) markTool("dup");
  if (/dsh-health/i.test(cmd)) markTool("health");
}
// 分档：这一下算哪一档活
function taskTier(name, args) {
  if (name === "present" || name === "dsh_im_return_file") return 3;
  if (name === "office_edit" || name === "novel_write_chapter") return 3;
  if (name === "write" || name === "edit") {
    const tp = String(args.file_path || "").replace(/\//g, "\\");
    if (!tp) return 0;
    if (/_tmp\\/i.test(tp)) return 1;
    if (/经验库\\/i.test(tp)) return 0;
    if (/工具脚本\\/i.test(tp) && /\.(ps1|js|mjs|cjs|json)$/i.test(tp)) return 4;
    if (/交付区\\|自动化报告\\/i.test(tp)) return 3;
    return 2;
  }
  if (name === "pwsh") {
    const c = String(args.command || "");
    const w = new RegExp("(Set-" + "Content|Add-" + "Content|Out-" + "File|WriteAllText|WriteAllLines|Copy-Item|Move-Item|Remove-Item|New-Item)\\b", "i");
    if (w.test(maskQuoted(c))) {
      if (/_tmp/i.test(c)) return 1;
      if (/工具脚本/i.test(c)) return 4;
      return 2;
    }
    return 0;
  }
  return 0;
}
function j14Note(name, args) {
  const tier = taskTier(name, args);
  if (tier < 2) return null;
  const need = [];
  if (!markFresh("know")) need.push("know-hit（先看有没有现成的卡）");
  if (tier >= 3 && !markFresh("dup")) need.push("check-dup（先看有没有别人做过）");
  if (tier >= 4 && !markFresh("health")) need.push("dsh-health（先看现状的数字）");
  if (!need.length) return null;
  const labels = { 2: "动正式位置", 3: "交付/收尾", 4: "改脚本或判据" };
  return {
    status: "提示",
    judge: "J14",
    notes: "J14 这一档是「" + labels[tier] + "」，最近一小时还没查过：" + need.join("；") + "（影子期只提示不拦）",
  };
}

function checkTextInner(name, args) {

  if (!args || typeof args !== 'object') return null;
  if (name === 'pwsh') {
    const cmd = String(args.command || '');
    const masked = maskQuoted(cmd);
    const __snap = judgeEnabled('J12') ? snapshotCmdPaths(cmd) : null;   // J12：先备份再判（名单外不备）
    if (!cmd) return null;
    // J17（2026-11-21）：J10 管的是写进 .ps1 文件里的自动变量赋值，这一条管命令行这一侧。
    // 同一个失手的两端：写脚本时撞 $home/$input/$args，直接下命令行也一样会踩。
    // 注：here-string 里定义函数时 $args/$input 在函数体内是合法的；确属这种写法就落到 .ps1 用 -File 跑。
    if (PS_AUTOVAR.test(masked)) {
      const am = cmd.match(PS_AUTOVAR);
      return {
        status: '拦下',
        judge: 'J17',
        notes: 'J17 命令行里给 PowerShell 自动变量 $' + am[1] + ' 赋值（只读或影响解析）：换带固定前缀的多字名',
      };
    }
    const encOK = /-Encoding\b/i.test(masked);
    if (!encOK && (WRITE_REDIR.test(cmd) || PS_WRITERS.test(masked))) {
      return {
        status: '拦下',
        judge: 'J8',
        notes: 'J8 写文本文件没带 -Encoding（中文会按默认编码落盘，读回来是乱码）：加 -Encoding utf8，或改用 [System.IO.File]::WriteAllText',
      };
    }
    if (PS_RECURSE.test(masked) && !/-WhatIf\b/i.test(masked)) {
      // 影子期：不拦，只把理由记进日志，用来算误拦率
      return { status: '提示', judge: 'J9', notes: 'J9 递归删除未带 -WhatIf（影子期只记不拦）：先落清单或加 -WhatIf 再删' };
    }
    // J13（2026-11-20 用户要求「不可逆的动手前先审查」）：这类命令改的是系统状态，rewind 和回收站都救不回。
    // 影子期只提示：先把回滚材料备好（reg export / 服务定义导出 / 任务 XML），再执行。
    if (PS_IRREVERSIBLE.test(masked)) return { status: '提示', judge: 'J13', notes: 'J13 不可逆动作（影子期只记不拦）：改注册表/服务/计划任务/磁盘/网络配置前，先导出可回滚的备份' };
    if (__snap) return { status: '提示', judge: 'J12', notes: __snap };
    if (PS_MIRROR.test(masked)) {
      // 影子期：只记不拦。robocopy 跟随 junction，镜像一个含联接的目录等于清空链接目标
      return { status: '提示', judge: 'J11', notes: 'J11 整目录镜像/清理未先查目录联接（影子期只记不拦）：先 Get-ChildItem -Force 看目标里有没有 ReparsePoint，有就只删链接不动内容' };
    }
    return null;
  }
  // J5（2026-11-20 从 preflight 手动档搬进闸）：edit 的 old_string 在文件里找不找得到。
  // 档案回放里这一型出现了 4 次，工具每次都等到读文件那一步才报错，白跑一轮。
  // 只判「字面在不在」：文件读不到、不是 utf8、超过 4MB 一律放过，让工具自己报。
  if (name === 'edit') {
    const fp = String(args.file_path || '');
    const oldS = args.old_string;
    const newS = args.new_string;
    if (!fp || typeof oldS !== 'string' || !oldS) return null;
    // J10（2026-11-21 修）：原来只在下面的 write/edit 统一分支里判，可 edit 走的是本分支，
    // 锚点找不到或 statSync 失败时就提前 return null 了，「edit 把 $home= 写进 .ps1」永远拦不到。
    // 这里在 edit 分支入口先判一次，write 仍由下面那段负责。
    if (/\.ps1$/i.test(fp) && typeof newS === 'string') {
      const j10m = newS.match(PS_AUTOVAR);
      if (j10m) {
        return {
          status: '拦下',
          judge: 'J10',
          notes: 'J10 往 .ps1 里写了 PowerShell 自动变量赋值 $' + j10m[1] + '=（只读或影响解析）：换个带前缀的多字名',
        };
      }
    }
    // J16（2026-11-21 实测）：edit 落盘会把 BOM 写掉（带 BOM 的 .ps1 由 73 字节变 70 字节，
    // 连纯 ASCII 替换也一样）。BOM 一掉，Windows PowerShell 5.1 按 GBK 解析中文就整片乱码。
    // 所以带 BOM 的 .ps1 一律不走 edit —— 换整段读改写，写回时显式带 BOM。
    if (/\.ps1$/i.test(fp)) {
      try {
        const j16b = fs.readFileSync(fp);
        if (j16b[0] === 0xEF && j16b[1] === 0xBB && j16b[2] === 0xBF) {
          return {
            status: '拦下',
            judge: 'J16',
            notes: 'J16 这个 .ps1 带 BOM，edit 落盘会把 BOM 去掉（实测 73→70 字节，纯 ASCII 替换也会）：'
              + '改用 pwsh 一次改完 —— $s=[IO.File]::ReadAllText($p) 取全文、字符串替换、'
              + '[IO.File]::WriteAllText($p,$s,(New-Object System.Text.UTF8Encoding($true))) 写回，'
              + '并回读 [IO.File]::ReadAllBytes($p)[0..2] 确认 239,187,191',
          };
        }
      } catch { /* 读不到就不判，交给工具自己报 */ }
    }
    if (typeof newS === 'string' && newS === oldS) {
      return { status: J5_BLOCK ? '拦下' : '提示', judge: 'J5', notes: 'J5 old_string 与 new_string 完全相同（这工具要求两者不同）：要删除就把 new_string 写成空串' };
    }
    let buf;
    try {
      const st = fs.statSync(fp);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
      buf = fs.readFileSync(fp);
    } catch { return null; }
    let txt = buf.toString('utf8');
    if (txt.includes('\uFFFD')) return null;          // 不是 utf8（多半 GBK），字面比较不可信，放过
    const norm = s => s.replace(/\r\n/g, '\n');
    const hay = norm(txt);
    const needle = norm(oldS);
    let n = 0, from = 0;
    while (true) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      n++; from = i + needle.length;
      if (n > 50) break;
    }
    if (n === 0) {
      const lines = hay.split('\n').length;
      return {
        status: J5_BLOCK ? '拦下' : '提示', judge: 'J5',
        notes: `J5 old_string 在 ${fp} 里逐字找不到（当前 ${lines} 行 / ${buf.length} 字节）：先读原文取锚点，别凭记忆拼`,
      };
    }
    if (n > 1 && args.replace_all !== true) {
      return {
        status: J5_BLOCK ? '拦下' : '提示', judge: 'J5',
        notes: `J5 old_string 在 ${fp} 里出现 ${n} 处，而 replace_all 没开（工具要求唯一）：加长锚点或写 replace_all: true`,
      };
    }
    return null;
  }
  // web_fetch 只收 https（档案回放里出现过 http:// 被拒 1 次，报 only https URLs are supported）
  if (name === 'web_fetch') {
    const one = typeof args.url === 'string' ? args.url : '';
    const many = Array.isArray(args.urls) ? args.urls.filter(u => typeof u === 'string') : [];
    const bad = [one, ...many].filter(u => /^http:\/\//i.test(u));
    if (bad.length) {
      return { status: '拦下', judge: 'J3', notes: `只收 https：${bad.slice(0, 2).join(' , ')} 是 http://` };
    }
    return null;
  }  if (name === 'write' || name === 'edit') {
    const target = String(args.file_path || '');
    if (!/\.ps1$/i.test(target)) return null;
    const body = name === 'write' ? String(args.content || '') : String(args.new_string || '');
    const m = body.match(PS_AUTOVAR);
    if (m) {
      return {
        status: '拦下',
        judge: 'J10',
        notes: `J10 往 .ps1 里写了 PowerShell 自动变量赋值 $${m[1]}=（只读或影响解析）：换个带前缀的多字名`,
      };
    }
    // J15（2026-11-21 用户要求「别每次都靠提醒」）：write 落盘的是无 BOM 的 UTF-8，
    // Windows PowerShell 5.1 按 GBK 解析含中文的 .ps1 会整片乱码、报一串假语法错（真机连翻三次）。
    // 只在 write 上拦——edit 那条路由 J5 管（锚点找不到/多处命中都会提示），这里不再重复。
    if (name === 'write' && /[^\x00-\x7F]/.test(body)) {
      return {
        status: '拦下',
        judge: 'J15',
        notes: 'J15 往 .ps1 写中文正文（write 落盘无 BOM，Windows PowerShell 5.1 会按 GBK 解析成乱码、报假语法错）：'
          + '改用 pwsh 一次写完并自查 —— [System.IO.File]::WriteAllText($p,$s,(New-Object System.Text.UTF8Encoding($true)))；'
          + '同一次调用里回读 [System.IO.File]::ReadAllBytes($p)[0..2] 必须是 239,187,191',
      };
    }
    return null;
  }
  return null;
}

// 包装：原判据优先，原判据不管的时候才轮到 J14 兜底提示
function checkTextRaw(name, args) {
  if (!args || typeof args !== 'object') return null;
  if (name === 'pwsh') recordCmd(String(args.command || ''));
  const r = checkTextInner(name, args);
  if (r) return r;
  try { return j14Note(name, args); } catch { return null; }
}

// 名单过滤（2026-11-23）：命中的判据不在启用名单里就当没判到
function checkText(name, args) {
  // 2026-11-24：引擎接管后，这里的 12 条旧判定全部退场（判定只认规则包，一条一件事）。
  // 留下的两样都不是「判定」：备份快照（J12 的副作用）与 J14（跨调用状态，规则表达不了）。
  if (process.env.DSH_JUDGE_ENGINE_PRIMARY === '1') {
    if (!args || typeof args !== 'object') return null;
    try { if (name === 'pwsh') recordCmd(String(args.command || '')); } catch { /* 备份失败不影响判定 */ }
    try {
      const r = j14Note(name, args);
      if (r && r.judge && !judgeEnabled(r.judge)) return null;
      return r;
    } catch { return null; }
  }
  const r = checkTextRaw(name, args);
  if (!r) return null;
  if (r.judge && !judgeEnabled(r.judge)) return null;
  return r;
}

// 参数形态（J3）也受名单管：关掉就整条不判，返回通过而不是假装没收录
function checkGuarded(name, args, badJson) {
  // 2026-11-24：引擎（本体）接管后，这里只留机械能力——JSON 容错解析、备份快照、名单。
  // 判定交给规则包（插件：一条一个，装不装用户定）。引擎加载成功时 index.js 置这个变量；
  // 引擎没起来就不置，退回本文件的旧判定，闸不会变成裸奔。
  if (process.env.DSH_JUDGE_ENGINE_PRIMARY === '1') {
    // 参数不是合法 JSON：引擎也判不了（它要对象），这条必须留在机械层
    if (badJson) {
      return { status: '拦下', judge: 'J3', notes: '工具参数不是合法 JSON（发出去也执行不了），先把 JSON 修好' };
    }
    return { status: '通过', notes: '', judge: undefined };
  }
  if (!judgeEnabled('J3')) return { status: '通过', notes: 'J3 已按名单关闭' };
  return check(name, args, badJson);
}

module.exports = { check: checkGuarded, checkRaw: check, checkText, judgeEnabled, judgeListInfo, parseIdList, REQ, WRONGKEY, FORBID, CLOSED, TABLE_FILE, TYPES, TYPES_BLOCK };
