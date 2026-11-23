'use strict';
/* 回放：把历史调用按现有判据重判一遍，给出「这套规矩在你的环境里能拦多少」。
 * 它不判断对错，只把拦截率算给你看；觉得某条判据太吵就加忽略，或者去改判据。 */
const path = require('path');
const J = require(path.join(__dirname, 'judge.js'));

function replay(calls, rules) {
  const stat = {
    calls: 0, blocked: 0, warned: 0, passed: 0, errored: 0,
    byRule: {}, byTool: {}, samples: [],
  };
  for (const c of calls) {
    if (!c || !c.tool) continue;
    stat.calls += 1;
    let hits;
    try {
      hits = J.judge({ when: 'tool:pre', tool: c.tool, args: c.args || {} }, rules);
    } catch (e) {
      stat.errored += 1;
      continue;
    }
    const adj = J.adjudicate(hits);
    stat.byTool[c.tool] = (stat.byTool[c.tool] || 0) + 1;
    if (adj.action === 'block') stat.blocked += 1;
    else if (adj.action === 'warn' || adj.action === 'steer') stat.warned += 1;
    else if (adj.action === 'error') stat.errored += 1;
    else stat.passed += 1;

    for (const h of adj.hits) {
      const id = h.ruleId ? h.ruleId : ('判不了:' + (h.error || 'unknown'));
      stat.byRule[id] = (stat.byRule[id] || 0) + 1;
    }
    if (adj.action === 'block' && stat.samples.length < 5) {
      let a = '';
      try { a = JSON.stringify(c.args).slice(0, 160); } catch { a = String(c.args); }
      stat.samples.push({ tool: c.tool, rules: adj.hits.map(h => h.ruleId).join(','), args: a });
    }
  }
  stat.blockRate = stat.calls ? stat.blocked / stat.calls : 0;
  return stat;
}

function rank(stat, n) {
  return Object.entries(stat.byRule)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n || 8);
}

module.exports = { replay, rank };
