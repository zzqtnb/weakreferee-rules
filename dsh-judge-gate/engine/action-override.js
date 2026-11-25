'use strict';
/**
 * 动作覆盖（action overrides）
 *
 * 「装哪条」记在 judges-installed.json 的 packs / rules 里；
 * 「装上了用多严」记在同一份的 actions 里：{ "WIN-BAT-CJK-01": "block" }。
 *
 * 为什么单独一层：包里的 rules.json 是作者给的默认值，用户想改严或改松是使用者的选择。
 * 直接改包文件会被下次升级冲掉，也分不清「作者说该拦」和「我让它拦」。
 * 所以覆盖只在这一层生效，包文件一个字不动。
 *
 * 没改过的条目 action 保持包里写的值；写了 "default" 就等于没改（键被删掉）。
 */
const fs = require('fs');
const path = require('path');

const ACTIONS = ['block', 'warn'];

function storeFile(dataDir) {
  return path.join(dataDir || '', 'judges-installed.json');
}

function dataDirOf(explicit) {
  return explicit || process.env.DSH_JUDGE_DATA || path.join(__dirname, '..', 'data');
}

// 读覆盖表：只留合法值，键统一大写（规则号都是大写，写小写也认）
function readOverrides(dataDir) {
  const out = {};
  try {
    const j = JSON.parse(fs.readFileSync(storeFile(dataDir), 'utf8').replace(/^\uFEFF/, ''));
    const a = (j && j.actions) || {};
    for (const k of Object.keys(a)) {
      const v = String(a[k] || '').toLowerCase();
      if (ACTIONS.includes(v)) out[String(k).toUpperCase()] = v;
    }
  } catch { /* 没有清单就是没有覆盖，按包里写的来 */ }
  return out;
}

// 就地覆盖，返回改了几条。没装的条目不关心——多严只在装上之后才有意义。
function apply(rules, dataDir) {
  const ov = readOverrides(dataDirOf(dataDir));
  let n = 0;
  for (const r of rules || []) {
    const k = String((r && r.id) || '').toUpperCase();
    if (!k || !ov[k]) continue;
    if (r.action !== ov[k]) { r.action = ov[k]; n += 1; }
  }
  return n;
}

// 删除清单：用户明确「这条我不要了」。与「卸下」不是一回事——
//   卸下 = 这次不装，库里还留着，随时能再装回来；
//   删除 = 从我的闸里彻底抹掉，列表里看不见，也不再参与判断，但包文件一个字不动，
//          想恢复就 restore，包升级也冲不掉这个决定。
function readRemoved(dataDir) {
  const out = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(storeFile(dataDirOf(dataDir)), 'utf8').replace(/^\uFEFF/, ''));
    const arr = (j && j.removed) || [];
    for (const k of arr) out.add(String(k).toUpperCase());
  } catch { /* 没有清单就是没删过 */ }
  return out;
}

function filterRemoved(rules, dataDir) {
  const rm = readRemoved(dataDir);
  if (!rm.size) return rules;
  return (rules || []).filter((r) => !rm.has(String((r && r.id) || '').toUpperCase()));
}

module.exports = { ACTIONS, readOverrides, readRemoved, apply, filterRemoved, storeFile, dataDirOf };
