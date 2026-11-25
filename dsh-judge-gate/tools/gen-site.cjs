// gen-site：把 rules/ 下的判据包编译成一张静态索引页（docs/index.html）。
// 为什么要有它：包里的条数、编号、命中数天天在变，手抄一版第二天就假了。
// 这里只读 rules/<包>/rules.json，页面内容全部现算，改完规则重跑一次即可。
//
// 用法：node tools/gen-site.js        写到 docs/index.html
//       node tools/gen-site.js --check 只核对产物是否与源一致，不写盘（退出码 1 = 过期）

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RULES_DIR = path.join(ROOT, 'rules');

// 产物落到哪：GitHub Pages 只认仓库根的 docs/，而仓库里插件在 dsh-judge-gate/ 这一层，
// 所以有外层仓库时写到 <仓库根>\docs\，便携包里没有那层就写回插件自己的 docs/。
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const IN_REPO = fs.existsSync(path.join(REPO_ROOT, 'packs', 'manifest.json'));
const OUT_DIR = IN_REPO ? path.join(REPO_ROOT, 'docs') : path.join(ROOT, 'docs');
const OUT = path.join(OUT_DIR, 'index.html');

// 包的人话说明写在这里，不塞进 rules.json：规矩是数据，说明是文案
const PACK_TEXT = {
  core: {
    name: 'core',
    what: '通用规矩，跟哪台机器无关。协议写错、参数形态不对、交付物里留着占位符、没核就写「已验证」、引用没打开过的网址。',
    note: '任何装了这套东西的机器都适用。',
  },
  'dsh-host': {
    name: 'dsh-host',
    what: '只管 DSH 这个宿主。改文件前锚点还在不在、判定结果是不是比代码还旧（改了判据没重启）、动文件前有没有留底。',
    note: '换个工具宿主就不适用，所以单独成包。',
  },
  'windows-powershell': {
    name: 'windows-powershell',
    what: 'Windows 和 PowerShell 上会真出事的那一类。写文本文件漏编码、给自动变量赋值、往 .ps1 里写中文丢 BOM、递归删除不带 -WhatIf、DELETE 不带 WHERE、往系统盘写东西。',
    note: '这台机器上踩过的错，不是网上抄的清单。',
  },
  'cross-call': {
    name: 'cross-call',
    what: '单次调用看不出来、要连着看才发现的。同一条命令失败过又原样重发、同一个文件连着两次没过、嘴上说改好了但记录里没那次写。',
    note: '要读调用历史，装之前先确认宿主留了记录。',
  },
};

const ACTION_TEXT = { block: '拦下', warn: '只提示', steer: '只提示' };

function readPacks() {
  if (!fs.existsSync(RULES_DIR)) return [];
  return fs
    .readdirSync(RULES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((id) => {
      const file = path.join(RULES_DIR, id, 'rules.json');
      if (!fs.existsSync(file)) return null;
      let rules = [];
      try {
        const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        rules = Array.isArray(parsed) ? parsed : parsed.rules || [];
      } catch (e) {
        rules = [];
        console.error(`跳过 ${id}：rules.json 读不出来（${e.message}）`);
      }
      return { id, rules, text: PACK_TEXT[id] || { name: id, what: '', note: '' } };
    })
    .filter(Boolean)
    .filter((p) => p.rules.length);
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function stamp() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}`;
}

function render(packs) {
  const total = packs.reduce((a, p) => a + p.rules.length, 0);
  const blocks = packs
    .map((p) => {
      const rows = p.rules
        .map((r) => {
          const hits = (r.evidence && r.evidence.hits) || 0;
          const act = ACTION_TEXT[r.action] || r.action || '';
          return `<tr>
        <td class="id">${esc(r.id)}${r.legacyJudge ? `<span class="legacy">${esc(r.legacyJudge)}</span>` : ''}</td>
        <td class="t">${esc(r.title || '')}</td>
        <td class="m">${esc(r.message || '')}</td>
        <td class="f">${esc(r.fix || '')}</td>
        <td class="a ${esc(r.action)}">${esc(act)}</td>
        <td class="h">${hits ? esc(hits) : '—'}</td>
      </tr>`;
        })
        .join('\n');
      const blocked = p.rules.filter((r) => r.action === 'block').length;
      return `<section id="${esc(p.id)}">
    <h2>${esc(p.text.name)} <span class="n">${p.rules.length} 条</span></h2>
    <p class="what">${esc(p.text.what)}</p>
    <p class="note">${esc(p.text.note)}　${p.rules.length} 条里 ${blocked} 条会拦下，${p.rules.length - blocked} 条只提示不拦截。</p>
    <div class="cmd"><code>node tools/judge-packs.cjs add ${esc(p.id)}</code><button data-cmd="node tools/judge-packs.cjs add ${esc(p.id)}">复制</button></div>
    <table>
      <thead><tr><th>编号</th><th>它看什么</th><th>命中时说什么</th><th>怎么改</th><th>后果</th><th>累计命中</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>弱裁判 · 判据包索引</title>
<style>
  :root{--bg:#14161a;--card:#1b1e23;--line:#2a2f36;--text:#e6e8ea;--dim:#98a0aa;--warn:#d3b15a;--red:#e07a70}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  header{padding:40px 28px 20px;max-width:1080px;margin:0 auto}
  h1{font-size:24px;margin:0 0 12px}
  .lead{color:var(--dim);max-width:760px}
  .lead b{color:var(--text)}
  main{max-width:1080px;margin:0 auto;padding:0 28px 80px}
  section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin:18px 0}
  h2{font-size:18px;margin:0 0 8px}
  h2 .n{font-size:12px;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:1px 8px;margin-left:6px;font-weight:400}
  .what{margin:0 0 6px}
  .note{margin:0 0 12px;color:var(--dim);font-size:13px}
  .cmd{display:flex;align-items:center;gap:10px;background:#121417;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:0 0 14px}
  .cmd code{font-family:ui-monospace,Consolas,monospace;font-size:13px;flex:1}
  .cmd button{background:#262b32;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--dim);font-weight:500;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:7px 8px;border-bottom:1px solid #23272d;vertical-align:top}
  td.id{font-family:ui-monospace,Consolas,monospace;white-space:nowrap}
  .legacy{color:var(--dim);font-size:11px;margin-left:5px;opacity:.7}
  td.m{color:#cfd4da}
  td.f{color:var(--dim)}
  td.a{white-space:nowrap}
  td.a.block{color:var(--red)}
  td.a.warn{color:var(--warn)}
  td.h{text-align:right;font-variant-numeric:tabular-nums;color:var(--dim);white-space:nowrap}
  footer{max-width:1080px;margin:0 auto;padding:0 28px 60px;color:var(--dim);font-size:12px}
  footer a{color:#8fb3d9}
  @media(max-width:720px){td.f,th:nth-child(4){display:none}}
</style>
</head>
<body>
<header>
  <h1>弱裁判 · 判据包索引</h1>
  <p class="lead">这是一套装在 AI 和工具之间的检查。每次 AI 要动手之前，先把这次调用的参数过一遍判据：<b>能当场判死的拦下，判不了的说未验，不确定的只提醒</b>。一共 ${packs.length} 个包、${total} 条判据，装哪几条由用的人自己定，规矩以 JSON 存在本地，能读、能改、能带走。</p>
  <p class="lead">最后那列「累计命中」是作者机器上记过的次数，写在每条规则的 evidence 里，含改判据之前的历史。它不是实时数——实时数在本地那份面板里，按判据编号现算，只算改了记账格式之后的记录。0 次的分两种：还没到过那个场景，或者刚加上还没跑够。</p>
</header>
<main>
${blocks}
</main>
<footer>
  <p>本页由 <code>tools/gen-site.js</code> 从 <code>rules/</code> 自动生成，生成时间 ${stamp()}。条数、编号、命中数都取自源文件，改完规则重跑一次即可。</p>
  <p>安装：把仓库放进 DSH 的插件目录，或在命令行里 <code>node tools/judge-packs.cjs add &lt;包名&gt;</code>；<code>list</code> 看现在装着什么，<code>remove &lt;包名&gt;</code> 卸掉。</p>
</footer>
<script>
document.querySelectorAll('.cmd button').forEach(function (b) {
  b.addEventListener('click', function () {
    var t = b.getAttribute('data-cmd');
    var done = function () { b.textContent = '已复制'; setTimeout(function () { b.textContent = '复制'; }, 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(done, done);
    else done();
  });
});
</script>
</body>
</html>
`;
}

const packs = readPacks();
if (!packs.length) {
  console.error('rules/ 下没读到任何判据包');
  process.exit(2);
}
const html = render(packs);
const total = packs.reduce((a, p) => a + p.rules.length, 0);

if (process.argv.includes('--check')) {
  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const same = old === html;
  console.log(`核对：${same ? '产物与源一致' : '产物已过期，重跑一次'}`);
  console.log(`包 ${packs.length} 个，判据 ${total} 条`);
  process.exit(same ? 0 : 1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log(`写出 ${OUT}`);
console.log(`包 ${packs.length} 个，判据 ${total} 条，${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KB`);
