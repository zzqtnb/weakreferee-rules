'use strict';
/* 生成规则包完整性清单：每个包的 rules.json 哈希与条数写进 rules\manifest.json。
 * 作用只有一个：文件被换过/改过时看得出来。它不是签名，挡不住有意篡改。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error('用法: node gen-manifest.js <rulesDir> [...]');
  process.exit(3);
}

let changed = 0;
for (const dir of dirs) {
  if (!fs.existsSync(dir)) { console.log('跳过（不存在）: ' + dir); continue; }
  const packs = {};
  for (const name of fs.readdirSync(dir)) {
    const pd = path.join(dir, name);
    let st;
    try { st = fs.statSync(pd); } catch { continue; }
    if (!st.isDirectory()) continue;
    const file = path.join(pd, 'rules.json');
    if (!fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    let n = 0;
    try { const j = JSON.parse(buf.toString('utf8')); n = Array.isArray(j) ? j.length : (j.rules || []).length; } catch { n = -1; }
    packs[name] = {
      file: 'rules.json',
      rules: n,
      bytes: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    };
  }
  const out = {
    _说明: '每个包的 rules.json 指纹。改规则要重新生成这份清单，否则加载时会提示不符。它只能发现文件被改动，不是签名。',
    generatedAt: new Date().toISOString(),
    packs,
  };
  const target = path.join(dir, 'manifest.json');
  const text = JSON.stringify(out, null, 2) + '\n';
  const old = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (old !== text) { fs.writeFileSync(target, text, 'utf8'); changed += 1; }
  console.log('写入 ' + target + '：' + Object.keys(packs).length + ' 个包');
}
console.log('完成，更新 ' + changed + ' 份清单');
