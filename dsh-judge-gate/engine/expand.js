'use strict';
/**
 * 生成器展开（engine/expand.js）
 *
 * 为什么需要这一步：
 *   「参数形态」这一类判据共 165 次命中、跨 45 个会话，但它不是一条静态规则——
 *   它要对 195 个工具逐个检查「缺必填键／为空／缺必填之一／形近错键／多余键／未声明键」。
 *   手写成几百条 JSON 既不可能维护，也会在工具升级时集体过期。
 *
 * 所以 core 包里放的是「生成器声明」，引擎读工具契约表把它编译成规则。
 * 契约表是**输入数据**，不进包（换了工具集就换一份表，包本身不动）。
 *
 * 逻辑逐行对齐 paramcheck.js 46-92 行的 REQ 构建，保证回放可对账。
 */
const fs = require('fs');
const path = require('path');

const TOOLS_DIR = process.env.JUDGE_TOOLS_DIR || path.join(__dirname, '..', 'contract');

function readJson(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return fallback; }
}

/* NOREQ：显式声明「确实没有必填参数」的工具（照抄 paramcheck.js 73-81 行）
 * 不在这张表里、props 非空又没 required 的工具，一律判「未验」——不知道哪些必填就别说通过。 */
const NOREQ = new Set([
  'dsh_browser_snapshot', 'dsh_browser_state', 'dsh_browser_list_tabs', 'dsh_browser_help',
  'dsh_browser_history', 'dsh_browser_visited', 'dsh_browser_console', 'dsh_browser_refresh',
  'dsh_browser_screenshot', 'dsh_browser_network', 'dsh_browser_dialog', 'dsh_browser_session',
  'dsh_browser_doctor', 'dsh_browser_a11y', 'dsh_browser_wait',
  'office_read', 'office_status', 'office_save', 'working_directory', 'automation_list',
  'acp_cache', 'cad_doc_new', 'dsh_browser_restrict', 'dsh_browser_reset_session',
  'dsh_im_group_history', 'fishtalk_deep', 'fishtalk_pack', 'free_search_test',
  'list_agents', 'office_close', 'office_render', 'task_board_list'
]);

const ITEM_PROPS = { present: { files: ['path', 'description'] } };

function buildContract(dir) {
  const T = readJson(path.join(dir, 'tool-params.json'), {});
  const GEN = readJson(path.join(dir, 'tool-schema.json'), { tools: {} });
  const TYPES = readJson(path.join(dir, 'tool-types.json'), { tools: {} });

  const REQ = {};
  // 1) schema 的 required（195 个工具）
  for (const [tool, sc] of Object.entries(GEN.tools || {})) {
    if (!sc || sc.hasSchema === false) continue;
    REQ[tool] = {
      req: (sc.req || []).slice(),
      anyOf: Array.isArray(sc.anyOf) ? sc.anyOf.map(g => g.slice()) : [],
      src: 'schema'
    };
  }
  // 2) 手写表取并集（手写表比 schema 严时不丢；@any:a|b 表示「至少一个」）
  for (const [tool, list] of Object.entries(T.req || {})) {
    const req = [], anyOf = [];
    for (const k of list) {
      if (String(k).startsWith('@any:')) anyOf.push(String(k).slice(5).split('|'));
      else req.push(k);
    }
    const cur = REQ[tool] || { req: [], anyOf: [], src: 'hand' };
    for (const k of req) if (!cur.req.includes(k)) cur.req.push(k);
    for (const g of anyOf) cur.anyOf.push(g);
    cur.src = REQ[tool] ? 'schema+hand' : 'hand';
    REQ[tool] = cur;
  }
  return { T, GEN, TYPES, REQ, WRONGKEY: T.wrongkey || {}, FORBID: T.forbid || {} };
}

/**
 * 展开生成器
 * @param {object} gen   生成器声明（core 包里那条 CORE-PARAMS-GEN 的 generator 字段）
 * @param {object} opts  { dir, legacyJudge }
 * @returns {{ rules: object[], stats: object }}
 */
function expandContractTable(gen, opts) {
  const dir = (opts && opts.dir) || TOOLS_DIR;
  const legacy = (gen && gen.legacyJudge) || 'PARAM';
  const c = buildContract(dir);
  const rules = [];
  const stats = { tools: 0, missingKey: 0, emptyValue: 0, missingAnyOf: 0, wrongKey: 0, extraKey: 0, unknownKey: 0, itemUnknownKey: 0, unverified: 0, noreq: 0 };
  const unverified = [];

  const mk = (id, cond, extra) => Object.assign({
    id, legacyJudge: legacy, when: 'tool:pre',
    condition: cond, action: 'block', severity: 'B',
    reversible: false
  }, extra || {});

  for (const [tool, spec] of Object.entries(c.REQ)) {
    stats.tools++;
    const hasReq = spec.req.length > 0;
    const hasAny = spec.anyOf.length > 0;

    // 真无必填参数：显式登记过，直接放行（不生成规则）
    if (!hasReq && !hasAny && NOREQ.has(tool)) { stats.noreq++; continue; }

    // schema 有参数但没声明必填键 → 未验。
    // 注意：未验不是规则，不能塞进规则数组——它没有 condition，塞进去会变成
    // 「所有调用都命中一条判不了的规矩」（实测就是这么炸的）。只记账，单独返回名单。
    if (!hasReq && !hasAny) {
      const sc = (c.GEN.tools || {})[tool];
      if (sc && Array.isArray(sc.props) && sc.props.length > 0) {
        stats.unverified++;
        unverified.push({ tool, props: sc.props.length });
        continue;
      }
      stats.noreq++; continue;                     // props 也为空 → 真无参
    }

    if (hasReq) {
      rules.push(mk('PARAM-MISSING:' + tool, { type: 'missingKey', keys: spec.req }, {
        title: '缺必填键', appliesTo: { tool },
        message: tool + ' 缺必填键: ' + spec.req.join(','),
        fix: '按工具签名补齐：' + spec.req.join(', ')
      }));
      stats.missingKey++;

      rules.push(mk('PARAM-EMPTY:' + tool, { type: 'emptyValue', keys: spec.req }, {
        title: '必填键为空', appliesTo: { tool },
        message: tool + ' 必填键为空: ' + spec.req.join(','),
        fix: '空串/null/空数组都算没填，给一个真值'
      }));
      stats.emptyValue++;
    }

    if (hasAny) {
      const groups = spec.anyOf.map(g => g.join('|'));
      rules.push(mk('PARAM-ANYOF:' + tool, { type: 'missingAnyOf', keys: groups }, {
        title: '缺必填之一', appliesTo: { tool },
        message: tool + ' 至少要给: ' + groups.join(' 或 '),
        fix: '这组键里至少填一个'
      }));
      stats.missingAnyOf++;
    }

    const wk = c.WRONGKEY[tool];
    if (Array.isArray(wk) && wk.length) {
      rules.push(mk('PARAM-WRONG:' + tool, { type: 'wrongKey', keys: wk }, {
        title: '形近错键', appliesTo: { tool },
        message: tool + ' 收到形近错键: ' + wk.join(','),
        fix: '按工具签名改用正确键名'
      }));
      stats.wrongKey++;
    }

    const fb = c.FORBID[tool];
    if (Array.isArray(fb) && fb.length) {
      rules.push(mk('PARAM-EXTRA:' + tool, { type: 'extraKey', paths: fb }, {
        title: '多余键', appliesTo: { tool },
        message: tool + ' 收到不该有的键: ' + fb.join(','),
        fix: '删掉这些键，工具不认'
      }));
      stats.extraKey++;
    }

    const sc = (c.GEN.tools || {})[tool];
    if (sc && sc.closed && Array.isArray(sc.props) && sc.props.length) {
      rules.push(mk('PARAM-UNKNOWN:' + tool, { type: 'unknownKey', in: 'args', allowed: sc.props }, {
        title: '未声明的键', appliesTo: { tool },
        message: tool + ' 的 schema 声明了 additionalProperties:false，出现未声明的键',
        fix: '只传 schema 里声明过的键'
      }));
      stats.unknownKey++;
    }

    const ip = ITEM_PROPS[tool];
    if (ip) {
      for (const [arrKey, allowed] of Object.entries(ip)) {
        rules.push(mk('PARAM-ITEMUNKNOWN:' + tool + ':' + arrKey,
          { type: 'unknownKey', in: 'args.' + arrKey + '[]', allowed }, {
            title: '数组项里的未声明键', appliesTo: { tool },
            message: tool + ' 的 ' + arrKey + '[] 只认 ' + allowed.join('/'),
            fix: '数组项里只留 ' + allowed.join('/')
          }));
        stats.itemUnknownKey++;
      }
    }
  }
  return { rules, stats, unverified };
}

/**
 * 把包里的规则集展开成可直接 judge 的规则数组
 * @param {object[]} rules  已装载的规则（可能含 generator 声明）
 * @param {object} opts     { dir }
 */
function expandAll(rules, opts) {
  const out = [];
  const report = { generators: 0, emitted: 0, stats: {} };
  for (const r of rules) {
    if (r.generator) {
      report.generators++;
      if (r.generator.kind === 'contractTable') {
        const sub = expandContractTable(r.generator, opts);
        out.push(...sub.rules);
        report.emitted += sub.rules.length;
        report.stats = sub.stats;
        report.unverified = sub.unverified;
        continue;
      }
      throw new Error('未知生成器: ' + r.generator.kind);
    }
    out.push(r);
  }
  return { rules: out, report };
}

module.exports = { expandAll, expandContractTable, buildContract, NOREQ, ITEM_PROPS, TOOLS_DIR };
