#!/usr/bin/env node
'use strict';
/**
 * 弱裁判 · 文档页生成器（tools/gen-docs.js）
 *
 * 为什么要有这个文件：
 *   docs/index.html 是给人看的门面，早先是手写的，判据从 34 条涨到 38 条之后
 *   页面上还写着「4 个包、34 条」，cross-call 还写「3 条」——门面数字和真身对不上，
 *   第一个来看的人就会觉得这项目自己都没在核事实。
 *
 * 做什么：
 *   只改 docs/index.html 里「会变的部分」，其余版式一字不动：
 *     1) 开头那句 lead 里的「N 个包、M 条判据」
 *     2) 每个 section 的 <span class="n">N 条</span>
 *     3) 每个 section 的 note 句「N 条里 X 条会拦下，Y 条只提示不拦截。」
 *     4) 每个 section 的表格行（按 packs 现读生成；已有的「累计命中」数字原样保留）
 *
 * 用法：
 *   node tools/gen-docs.js            # 干跑，只报会改什么
 *   node tools/gen-docs.js --apply    # 落盘（先写 .bak-<时间戳>）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs', 'index.html');
const PACKS = path.join(ROOT, 'packs');
const APPLY = process.argv.includes('--apply');

// 包清单不再写死：按 packs/ 下的目录现读，再用 pack.json 的 loadOrder 排
// （2026-11-27 加了 browser / doc-suite / publish 三包，写死的名单会把新包漏在页面外）
function packNames() {
  return fs.readdirSync(PACKS)
    .filter((n) => fs.existsSync(path.join(PACKS, n, 'rules.json')))
    .sort((a, b) => {
      const la = loadMeta(a).loadOrder ?? 99;
      const lb = loadMeta(b).loadOrder ?? 99;
      return la - lb || a.localeCompare(b);
    });
}

function loadMeta(name) {
  const f = path.join(PACKS, name, 'pack.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}

function loadPack(name) {
  const f = path.join(PACKS, name, 'rules.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const ACTION_LABEL = { block: ['block', '拦下'], warn: ['warn', '只提示'], steer: ['warn', '只提醒'] };

function rowHtml(r, legacyHits) {
  const [cls, label] = ACTION_LABEL[r.action] || ['warn', '只提示'];
  const hits = legacyHits.has(r.id) ? legacyHits.get(r.id) : '—';
  const idCell = esc(r.id) + (r.legacyJudge ? `<span class="legacy">${esc(r.legacyJudge)}</span>` : '');
  return [
    '<tr>',
    `        <td class="id">${idCell}</td>`,
    `        <td class="t">${esc(r.title)}</td>`,
    `        <td class="m">${esc(r.message)}</td>`,
    `        <td class="f">${esc(r.fix || '—')}</td>`,
    `        <td class="a ${cls}">${label}</td>`,
    `        <td class="h">${esc(hits)}</td>`,
    '      </tr>'
  ].join('\n');
}

/** 从现有 tbody 里摘出「编号 → 累计命中」的数字，重排表格时不丢真数据 */
function existingHits(tbody) {
  const m = new Map();
  const re = /<td class="id">([^<]+)(?:<span[^>]*>[^<]*<\/span>)?<\/td>[\s\S]*?<td class="h">([^<]*)<\/td>/g;
  let x;
  while ((x = re.exec(tbody)) !== null) {
    const id = x[1].trim();
    const h = x[2].trim();
    if (id && h && h !== '—') m.set(id, h);
  }
  return m;
}

function main() {
  let html = fs.readFileSync(DOCS, 'utf8');
  const before = html;
  const report = [];

  // 1) 汇总
  const packs = packNames().map((n) => ({ name: n, rules: loadPack(n), meta: loadMeta(n) })).filter((p) => p.rules);
  const total = packs.reduce((s, p) => s + p.rules.length, 0);

  // lead 那句：「一共 4 个包、34 条判据」——两个数字都按现读改
  html = html.replace(/(一共\s*)\d+(\s*个包、)\d+(\s*条判据)/, `$1${packs.length}$2${total}$3`);

  // 2)–4) 每个 section
  for (const p of packs) {
    const secRe = new RegExp(`(<section id="${p.name}">)([\\s\\S]*?)(</section>)`);
    const hit = html.match(secRe);
    if (!hit) {
      // 新包：页面上还没有这一节 —— 按现有版式生成一节，插在 </main> 之前
      const blockN = p.rules.filter((r) => r.action === 'block').length;
      const warnN = p.rules.length - blockN;
      const rows = p.rules.map((r) => rowHtml(r, new Map())).join('\n');
      const where = esc(p.meta.description || '');
      const sec = [
        `<section id="${p.name}">`,
        `    <h2>${p.name} <span class="n">${p.rules.length} 条</span></h2>`,
        `    <p class="what">${where}</p>`,
        `    <p class="note">由 pack.json 的 description 说明。　${p.rules.length} 条里 ${blockN} 条会拦下，${warnN} 条只提示不拦截。</p>`,
        `    <div class="cmd"><code>node tools/judge-packs.cjs add ${p.name}</code><button data-cmd="node tools/judge-packs.cjs add ${p.name}">复制</button></div>`,
        '    <table>',
        '      <thead><tr><th>编号</th><th>它看什么</th><th>命中时说什么</th><th>怎么改</th><th>后果</th><th>累计命中</th></tr></thead>',
        '      <tbody>',
        rows,
        '      </tbody>',
        '    </table>',
        '  </section>',
      ].join('\n');
      if (!html.includes('</main>')) { report.push(`  ! 找不到 </main>，新增 section#${p.name} 放弃`); continue; }
      html = html.replace('</main>', `  ${sec}\n</main>`);
      report.push(`  ${p.name}: ${p.rules.length} 条（拦下 ${blockN} / 只提示 ${warnN}），新增一节`);
      continue;
    }
    let body = hit[2];
    const blockN = p.rules.filter((r) => r.action === 'block').length;
    const warnN = p.rules.length - blockN;

    // 条数徽标
    body = body.replace(/(<span class="n">)\d+(\s*条<\/span>)/, `$1${p.rules.length}$2`);
    // note 句
    body = body.replace(
      /(　)\d+(\s*条里\s*)\d+(\s*条会拦下，)\d+(\s*条只提示不拦截。)/,
      `$1${p.rules.length}$2${blockN}$3${warnN}$4`
    );

    // 表格行
    const tbRe = /(<tbody>)([\s\S]*?)(<\/tbody>)/;
    const tb = body.match(tbRe);
    if (tb) {
      const hits = existingHits(tb[2]);
      const rows = p.rules.map((r) => rowHtml(r, hits)).join('\n');
      body = body.replace(tbRe, `$1\n${rows}\n      $3`);
      report.push(`  ${p.name}: ${p.rules.length} 条（拦下 ${blockN} / 只提示 ${warnN}），表格行重排，保留累计命中 ${hits.size} 个`);
    } else {
      report.push(`  ! section#${p.name} 里没有 <tbody>，只改了条数`);
    }
    html = html.replace(secRe, `$1${body}$3`);
  }

  console.log(`判据包 ${packs.length} 个、共 ${total} 条`);
  report.forEach((l) => console.log(l));

  if (!APPLY) {
    if (html === before) console.log('干跑：文档已经是最新的，没有要改的');
    else console.log(`干跑：将改动 ${before.length} → ${html.length} 字符（加 --apply 落盘）`);
    return;
  }
  if (html === before) { console.log('没有要改的，不落盘'); return; }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  // 备份不再落在 docs/ 下：散落 .bak 会被验收 A15 记账，统一放归档备份（守则 33）
  const bakDir = process.env.DSH_BACKUP_DIR || 'D:/deepseek/归档备份/_自动备份/docs';
  let bak = DOCS + `.bak-${stamp}`;
  try {
    fs.mkdirSync(bakDir, { recursive: true });
    bak = path.join(bakDir, `index.html.bak-${stamp}`);
  } catch { /* 目录建不出来就退回原处，但不静默 */ console.warn('备份目录不可用，退回 docs/ 下'); }
  fs.copyFileSync(DOCS, bak);
  fs.writeFileSync(DOCS, html, 'utf8');
  console.log(`已写 ${DOCS}（${fs.statSync(DOCS).size} B），备份 ${bak}`);
}

main();
