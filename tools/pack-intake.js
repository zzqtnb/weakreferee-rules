#!/usr/bin/env node
/**
 * pack-intake.js — 外来判据包准入检查
 *
 * 用法：
 *   node tools/pack-intake.js <目录>           检查目录下所有 .json，出报告
 *   node tools/pack-intake.js <目录> --quiet   只输出结论行
 *
 * 立场：上传不设门槛，这一关只决定「能不能进库」。
 * 拦的是机器这一侧能判的东西：结构齐不齐、证据能不能重跑、写成规则能不能真判。
 * 判不了的（这条错值不值得管）留给人。
 *
 * 退出码：0 全部通过 / 1 有不合格 / 2 用法错误
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SECTIONS = [
  { key: '判据：', name: '判据' },
  { key: '例子', name: '例子' },
  { key: '边界：', name: '边界' },
  { key: '已测', name: '已测' },
];

function checkOne(fp, dirName) {
  const errs = [];
  const warns = [];
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    return { ok: false, errs: ['不是合法 JSON：' + e.message], warns, obj: null };
  }

  // 1 文件名 = id
  const base = path.basename(fp, '.json');
  if (!obj.id) errs.push('缺 id 字段');
  else if (obj.id !== base) errs.push('文件名（' + base + '）与 id（' + obj.id + '）不一致');

  // 2 domain 与目录名一致
  if (!obj.domain) errs.push('缺 domain 字段');
  else if (obj.domain !== dirName) errs.push('domain（' + obj.domain + '）与所在目录（' + dirName + '）不一致');

  // 3 基本字段
  for (const k of ['title', 'audience', 'message', 'fix']) {
    if (!obj[k]) errs.push('缺 ' + k + ' 字段');
  }
  if (!Array.isArray(obj.audience) || obj.audience.length === 0) errs.push('audience 必须是非空数组');

  // 4 四段式
  const notes = Array.isArray(obj.notes) ? obj.notes : [];
  if (notes.length === 0) errs.push('notes 为空，四段式没写');
  for (const s of SECTIONS) {
    const has = notes.some((n) => typeof n === 'string' && n.indexOf(s.key) === 0);
    if (!has) errs.push('notes 缺「' + s.name + '」段（段首必须是「' + s.key + '」）');
  }

  // 5 已测段必须点到模型名，且至少一个「犯过」
  const tested = notes.find((n) => typeof n === 'string' && n.indexOf('已测') === 0);
  if (tested) {
    const hasModel = /(qwen|deepseek|glm|kimi|doubao|gpt|claude|gemini|seed|llama|mistral|yi-|ernie|hunyuan)/i.test(tested);
    const hasHit = /犯过|犯：|会犯/.test(tested);
    if (!hasModel) errs.push('已测段没写具体模型名（要写哪家、哪个型号）');
    if (!hasHit) errs.push('已测段没有「犯过」的记录——一个模型都没犯过的判据不收（这是准入线）');
  }

  // 6 证据可重跑：testedOn 至少一条 result=犯，且带 scenario 与 excerpt
  const ev = obj.evidence || {};
  const ton = Array.isArray(ev.testedOn) ? ev.testedOn : [];
  if (ton.length === 0) {
    errs.push('evidence.testedOn 为空：要写至少一条实测记录（model / result / scenario / excerpt / date）');
  } else {
    const hits = ton.filter((t) => t && t.result === '犯');
    if (hits.length === 0) errs.push('evidence.testedOn 里没有 result=「犯」的记录');
    for (const t of hits) {
      const who = t.model || '（未写模型）';
      if (!t.scenario || String(t.scenario).trim().length < 10) errs.push(who + '：缺 scenario（当时让它做什么，写不下 10 个字就没法重跑）');
      if (!t.excerpt || String(t.excerpt).trim().length < 5) errs.push(who + '：缺 excerpt（模型原话里犯错的那几句）');
      if (!t.date) warns.push(who + '：没写日期，以后没法判断是不是老模型的结论');
    }
  }

  // 7 若声明能判（有 condition 或 promotedTo），必须带正反例
  const claimsJudge = obj.condition || obj.promotedTo;
  if (claimsJudge) {
    const st = obj.selfTest;
    const cases = Array.isArray(st) ? st : (st && Array.isArray(st.cases) ? st.cases : []);
    if (cases.length === 0) errs.push('声明了能判（有 condition/promotedTo），但 selfTest 一个用例都没有');
    else {
      const hasBlock = cases.some((c) => c && (c.expect === 'block' || c.expect === 'hit'));
      const hasPass = cases.some((c) => c && (c.expect === 'pass' || c.expect === 'ok'));
      if (!hasBlock) errs.push('selfTest 缺「该拦」用例');
      if (!hasPass) errs.push('selfTest 缺「不该拦」用例——只有正例说明不了它不误伤');
    }
  }

  // 8 动作类与证据级别的关系（与 validate.js 同口径）
  const lvl = ev.level;
  const act = obj.defaultAction || obj.action;
  if (lvl === '推断' && (act === 'block' || act === '拦截')) errs.push('证据级别是「推断」却要拦下——推断级最多提醒');
  if (ev.falsePositiveRisk === 'high' && act === 'block') errs.push('误拦风险标了 high 却要拦下');

  return { ok: errs.length === 0, errs, warns, obj, tested };
}

function main() {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('用法：node tools/pack-intake.js <目录> [--quiet]');
    process.exit(2);
  }
  const root = path.resolve(target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error('目录不存在：' + root);
    process.exit(2);
  }

  const files = [];
  for (const d of fs.readdirSync(root)) {
    const sub = path.join(root, d);
    if (fs.statSync(sub).isDirectory()) {
      for (const f of fs.readdirSync(sub)) if (f.endsWith('.json')) files.push({ fp: path.join(sub, f), dir: d });
    } else if (d.endsWith('.json')) {
      files.push({ fp: sub, dir: path.basename(root) });
    }
  }

  if (files.length === 0) {
    console.log('目录里没有 .json 条目：' + root);
    process.exit(0);
  }

  const results = files.map((f) => Object.assign({ name: path.basename(f.fp, '.json'), dir: f.dir }, checkOne(f.fp, f.dir)));
  const pass = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);

  if (!quiet) {
    console.log('外来判据包准入检查：' + root);
    console.log('共 ' + results.length + ' 条，通过 ' + pass.length + '，不合格 ' + fail.length + '\n');
    for (const r of results) {
      console.log((r.ok ? '通过  ' : '不合格 ') + r.name + (r.obj && r.obj.title ? '（' + r.obj.title + '）' : ''));
      for (const e of r.errs) console.log('   × ' + e);
      for (const w of r.warns) console.log('   ! ' + w);
    }
    if (pass.length) {
      console.log('\n可以入库的：' + pass.map((r) => r.name).join('、'));
      console.log('入库动作：把对应 .json 移到 catalog/<domain>/，再跑 node tools/validate.js 与 node tools/gen-index.js');
    }
    if (fail.length) {
      console.log('\n不合格的留在隔离区，让对方按上面列出的条目补齐后重交；补齐前不进库。');
    }
  } else {
    console.log('共 ' + results.length + ' 条，通过 ' + pass.length + '，不合格 ' + fail.length);
  }

  process.exit(fail.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { checkOne };
