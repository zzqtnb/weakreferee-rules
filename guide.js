#!/usr/bin/env node
'use strict';
/**
 * 弱裁判 · 傻瓜模式（guide.js）v0.1
 *
 * 为什么要有这个文件：
 *   weakreferee-cli.js 要人自己拼 "command=Out-File D:\a.ps1 -InputObject 中文" 这种句子，
 *   亲戚朋友不会敲，引号加在哪都记不住。这里把「背命令」换成「按提示回答」：
 *   菜单选一项、把东西粘进去、直接出人话结论。
 *
 * 判定逻辑一个字都不在这里：
 *   全部走 weakreferee-cli.js --json 的子进程，保证判据只有一份。
 *   改了引擎或规矩包，这里自动跟上，不会出现两套判法打架。
 *
 * 用法：双击 傻瓜模式.bat，或在包目录里 node guide.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

const CLI = path.join(__dirname, 'weakreferee-cli.js');

/* 输入层自己管。
 * 不用 readline/promises 的 question：它遇上「输入比提问先读完」（管道、重定向、
 * 手快贴了一整段）就会把 promise 挂死，进程静默退出——看着像程序崩了，其实什么都没打印。
 * 这里改成按行排队：有排队行就直接取，读完了（EOF）就返回 null 让主循环收摊。 */
const lines = [];
let inputEnded = false;
let waiting = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (l) => {
  if (waiting) {
    const done = waiting;
    waiting = null;
    done(l);
  } else {
    lines.push(l);
  }
});
rl.on('close', () => {
  inputEnded = true;
  if (waiting) {
    const done = waiting;
    waiting = null;
    done(null);
  }
});

const ACTION = {
  pass: '结论：没问题，可以放心执行',
  block: '结论：这条会被拦下，先别执行',
  warn: '结论：不拦，但先做一步再执行',
  steer: '结论：不拦，但换个写法更稳',
  error: '结论：判不了（有条规矩执行出错）',
};

/* 问一句，输入结束（管道/EOF）时返回 null，让主循环收摊 */
function ask(q) {
  process.stdout.write(q);
  if (lines.length) return Promise.resolve(String(lines.shift()).trim());
  if (inputEnded) return Promise.resolve(null);
  return new Promise((res) => {
    waiting = (l) => res(l === null ? null : String(l).trim());
  });
}

/* 调命令行拿 JSON。判据只在那一边，这里只负责问与说 */
function check(tool, params) {
  const r = spawnSync(process.execPath, [CLI, 'check', tool, ...params, '--json'], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  if (!out) {
    console.log('  查不了：' + ((r.stderr || '').trim() || ('程序退出码 ' + r.status)));
    return null;
  }
  try {
    return JSON.parse(out);
  } catch (e) {
    console.log('  查不了：返回内容读不懂');
    return null;
  }
}

/* 把 JSON 翻成人话。规矩编号留着，方便回头追是哪条 */
function report(data) {
  if (!data) return;
  const hits = data.hits || [];
  console.log('');
  console.log('  ' + (ACTION[data.action] || ('结论：' + data.action)));
  if (!hits.length) {
    console.log('  说完就走：一条规矩都没碰着（这次查了 ' + data.load.rules + ' 条）');
  } else {
    hits.forEach((h, i) => {
      if (h.error) {
        console.log('  ' + (i + 1) + '. 有条规矩坏了，这件事没判成：' + h.error);
        return;
      }
      console.log('  ' + (i + 1) + '. ' + (h.message || ''));
      if (h.fix) console.log('     怎么改：' + h.fix);
      console.log('     规矩编号 ' + h.ruleId + '（想深究就用 weakreferee check 再看一遍）');
    });
  }
  if (data.load.contractMissing) console.log('  注意：包里的参数表缺了，「参数对不对」这一块没查');
  if (data.load.rejected) console.log('  注意：有 ' + data.load.rejected + ' 条规矩没装进来');
  console.log('');
}

async function checkPwsh() {
  console.log('');
  console.log('  把要执行的 PowerShell 命令粘进来，一行，回车结束');
  console.log('  例：Out-File D:\\a.ps1 -InputObject 中文');
  const cmd = await ask('  命令：');
  if (!cmd) return;
  report(check('pwsh', ['command=' + cmd]));
}

async function checkWrite() {
  console.log('');
  console.log('  要往哪个文件里写？（随便给个路径，不会真的写）');
  const p = await ask('  文件路径：');
  if (!p) return;
  console.log('  要写进去的内容是什么？');
  const c = await ask('  内容：');
  if (c === null) return;
  report(check('write', ['file_path=' + p, 'content=' + c]));
}

async function checkTool() {
  console.log('');
  console.log('  工具名，比如 web_fetch、pwsh、write');
  const tool = await ask('  工具名：');
  if (!tool) return;
  console.log('  参数一行一个，写成 键=值，空行结束');
  console.log('  例：url=https://example.com');
  const params = [];
  for (;;) {
    const line = await ask('  参数：');
    if (line === null) break;
    if (!line) break;
    params.push(line);
  }
  if (!params.length) {
    console.log('  一个参数都没给，先不查了');
    return;
  }
  report(check(tool, params));
}

/* 第 4 项：体检。翻一遍本机 AI 工具留下的操作记录，出一页人话报告。
 * 判定与统计全在 weakreferee-cli.js scan 里，这里只负责问一句、把结果铺开、顺手存一份。 */
async function scanHistory() {
  console.log('');
  console.log('  这一步翻你电脑上 AI 工具留下的操作记录，看哪些操作踩过坑、下次怎么改');
  console.log('  只读，不改你的东西，也不上网');
  console.log('  不知道记录在哪的直接回车，它自己去常见位置找');
  const p = await ask('  记录文件夹或 json 文件（直接回车让它自己找）：');
  const args = ['scan'];
  if (p) args.push(p);
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const text = (r.stdout || '').trim();
  if (!text) {
    console.log('  跑不起来：' + ((r.stderr || '').trim() || ('程序退出码 ' + r.status)));
    console.log('  把上面这行发给写它的人');
    return;
  }
  console.log('');
  console.log(text.split('\n').map((l) => '  ' + l).join('\n'));
  console.log('');

  const desk = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : '';
  if (desk) {
    const d = new Date();
    const name = '弱裁判体检报告-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0')
      + String(d.getDate()).padStart(2, '0') + '.txt';
    try {
      fs.writeFileSync(path.join(desk, name), '\uFEFF' + text + '\n', 'utf8');
      console.log('  这份报告在桌面上也存了一份：' + name);
    } catch (e) {
      console.log('  桌面上存不了，上面这份照着看就行');
    }
  }
  console.log('');
}

/* 第 5 项：扫自己的历史记录，看看哪些错处反复出现（给想看细节的人）。
 * 只读不判：真正的统计与草案都在 weakreferee mine 里，这里只把结果说成人话。 */
async function mineHistory() {
  console.log('');
  console.log('  这一步看的是你自己的历史记录，不是你现在的命令');
  console.log('  它数一数哪些错处反复出现，够多的就建议你单独立一条规矩');
  console.log('  装过 DSH 的：直接回车，它自己去 %DSH_HOME%\\sessions 找');
  console.log('  别的记录：给一个文件夹或一个 json 文件，格式像 [{"tool":"pwsh","args":{"command":"..."}}]');
  const p = await ask('  路径（直接回车用默认）：');
  const args = ['mine', '--json'];
  if (p) args.push(p);
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  if (!out) {
    const err = (r.stderr || '').trim();
    console.log('  扫不了：' + (err || '没找到历史记录'));
    console.log('  换个路径再试，或者先把记录导成一个 json 文件');
    return;
  }
  let d;
  try {
    d = JSON.parse(out);
  } catch (e) {
    console.log('  扫完了，但结果读不懂');
    return;
  }
  console.log('');
  console.log('  看了 ' + d.filesRead + ' 份记录，' + d.calls + ' 次调用');
  const rows = (d.rows || []).filter((x) => x.hits > 0).slice(0, 6);
  if (rows.length) {
    console.log('  反复出现的写法：');
    rows.forEach((x) => {
      const tag = x.coveredBy ? '已经有人管' : (x.suggest ? '没人管' : '不算问题');
      console.log('    ' + String(x.hits).padStart(4) + ' 次  ' + x.title + '（' + tag + '）');
    });
  }
  const drafts = d.drafts || [];
  console.log('');
  if (drafts.length) {
    console.log('  建议给你加 ' + drafts.length + ' 条规矩，先只提示、不拦：');
    drafts.forEach((x, i) => console.log('    ' + (i + 1) + '. ' + x.title));
    console.log('  要留下它们：在命令行敲 weakreferee mine --write，会在当前目录写两个文件');
  } else {
    console.log('  没有要新加的：反复出现的写法，现有规矩已经管着了');
  }
  console.log('');
}

function selfTest() {
  console.log('');
  const r = spawnSync(process.execPath, [CLI, 'selftest'], { encoding: 'utf8' });
  console.log((r.stdout || '').trim());
  if (r.status !== 0) console.log('  自检没过，把上面那几行发给写它的人');
  console.log('');
}

async function main() {
  console.log('');
  console.log('  ═══════════════════════════════════════');
  console.log('   弱裁判 · 傻瓜模式');
  console.log('   替你先看一眼这条命令会不会出事。只看，不动你的文件，不联网');
  console.log('  ═══════════════════════════════════════');
  let first = true;
  for (;;) {
    if (first) {
      console.log('  1  检查一条 PowerShell 命令');
      console.log('  2  检查「往文件里写中文」这件事');
      console.log('  3  检查一条 DSH 工具调用（会点技术才用）');
      console.log('  4  体检：翻一遍历史记录，出一页报告');
      console.log('  5  看看你常犯什么（出建议规矩，进阶）');
      console.log('  9  自检（看这个工具本身好不好）');
      console.log('  0  退出');
      first = false;
    } else {
      console.log('  1 查命令   2 查写中文   3 查工具调用   4 体检   5 长规矩   9 自检   0 退出');
    }
    const c = await ask('  选一个：');
    if (c === null || c === '0') { console.log(''); break; }
    if (!c) continue;
    if (c === '1') await checkPwsh();
    else if (c === '2') await checkWrite();
    else if (c === '3') await checkTool();
    else if (c === '4') await scanHistory();
    else if (c === '5') await mineHistory();
    else if (c === '9') selfTest();
    else console.log('  没这个选项，再选一次');
  }
  rl.close();
  console.log('  收工');
}

main().catch((e) => {
  console.log('  出错了：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
