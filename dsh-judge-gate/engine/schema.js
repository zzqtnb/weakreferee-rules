'use strict';
/*
 * 工具定义 -> 契约表（三件套）。
 *
 * 为什么要这个文件：
 *   判据里那四百多条「参数形态」不是手写的，是生成器按契约表长出来的。
 *   契约表原来只有一份，来自作者本机的工具目录；换一个模型、换一个 IDE，
 *   工具名与参数全变，那批判据就全不匹配。这个文件负责把任何一家的
 *   工具定义（MCP 的 inputSchema、OpenAI 的 function.parameters、
 *   Claude 的 input_schema，或一张手写的 name -> schema 表）转成契约表。
 *
 * 只做机械转换，不做判断：必填、属性、类型、枚举、是否封闭，都是定义里现成的。
 * 形近错键（wrongkey）与禁止键（forbid）属于人写的部分，这里只给候选。
 */

const SYN = [
  ['url', 'urls'],
  ['query', 'queries'],
  ['path', 'file_path'],
  ['name', 'names'],
  ['command', 'cmd'],
  ['content', 'text'],
  ['prompt', 'input'],
  ['id', 'ids'],
];

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** 从一份 JSON 里认出工具定义，返回 [{ name, schema }] */
function pickTools(input) {
  const out = [];
  const push = (name, schema) => {
    if (typeof name !== 'string' || !name) return;
    out.push({ name, schema: isObj(schema) ? schema : {} });
  };

  const fromItem = (it) => {
    if (!isObj(it)) return;
    if (isObj(it.function)) {
      push(it.function.name, it.function.parameters);
      return;
    }
    if (isObj(it.inputSchema)) {
      push(it.name, it.inputSchema);
      return;
    }
    if (isObj(it.input_schema)) {
      push(it.name, it.input_schema);
      return;
    }
    if (isObj(it.parameters)) {
      push(it.name, it.parameters);
      return;
    }
  };

  if (Array.isArray(input)) {
    for (const it of input) {
      if (isObj(it) && it.name && (it.properties || it.type === 'object')) push(it.name, it);
      else fromItem(it);
    }
    return out;
  }

  if (!isObj(input)) return out;

  if (Array.isArray(input.tools)) {
    for (const it of input.tools) fromItem(it);
    return out;
  }

  if (isObj(input.tools)) {
    for (const [k, v] of Object.entries(input.tools)) {
      if (isObj(v) && (v.properties || v.type === 'object')) push(k, v);
      else if (isObj(v) && isObj(v.inputSchema)) push(k, v.inputSchema);
      else if (isObj(v) && isObj(v.parameters)) push(k, v.parameters);
      else if (isObj(v) && isObj(v.input_schema)) push(k, v.input_schema);
    }
    return out;
  }

  if (isObj(input.functions)) {
    for (const it of [].concat(input.functions)) {
      if (isObj(it) && isObj(it.parameters)) push(it.name, it.parameters);
    }
    return out;
  }

  // 裸表：{ 工具名: schema }
  for (const [k, v] of Object.entries(input)) {
    if (isObj(v) && (v.properties || v.type === 'object')) push(k, v);
  }
  return out;
}

/** schema -> 必填键（含 anyOf 互斥必填的 @any: 写法） */
function requiredOf(schema) {
  const req = Array.isArray(schema.required) ? schema.required.filter((x) => typeof x === 'string') : [];
  if (req.length) return req;
  const groups = [];
  const collect = (node) => {
    if (!isObj(node)) return;
    if (Array.isArray(node.required) && node.required.length) groups.push(node.required.filter((x) => typeof x === 'string'));
    for (const k of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(node[k])) for (const sub of node[k]) collect(sub);
    }
  };
  collect(schema);
  const flat = [];
  for (const g of groups) for (const k of g) if (!flat.includes(k)) flat.push(k);
  if (flat.length > 1 && groups.length > 1) return ['@any:' + flat.join('|')];
  return flat;
}

function typesOf(schema) {
  const out = {};
  const props = isObj(schema.properties) ? schema.properties : {};
  for (const [k, v] of Object.entries(props)) {
    if (!isObj(v)) continue;
    const t = {};
    const ty = Array.isArray(v.type) ? v.type.find((x) => x !== 'null') || v.type[0] : v.type;
    if (typeof ty === 'string') t.type = ty;
    if (Array.isArray(v.enum)) t.enum = v.enum.slice(0, 20);
    if (isObj(v.items) && typeof v.items.type === 'string') t.items = v.items.type;
    if (Object.keys(t).length) out[k] = t;
  }
  return out;
}

/** 形近/同义错键候选：工具里有这个键，但别的工具把它的同义键当必填 */
function wrongkeyCandidates(all) {
  const reqIndex = new Map();
  for (const t of all) {
    for (const k of requiredOf(t.schema)) {
      if (k.startsWith('@any:')) continue;
      if (!reqIndex.has(k)) reqIndex.set(k, []);
      reqIndex.get(k).push(t.name);
    }
  }
  const out = {};
  for (const t of all) {
    const props = Object.keys(isObj(t.schema.properties) ? t.schema.properties : {});
    const req = requiredOf(t.schema);
    const hits = [];
    for (const p of props) {
      if (req.includes(p)) continue;
      for (const [a, b] of SYN) {
        const other = a === p ? b : b === p ? a : null;
        if (!other) continue;
        if (reqIndex.has(other) && !props.includes(other)) hits.push(p);
      }
    }
    if (hits.length) out[t.name] = Array.from(new Set(hits));
  }
  return out;
}

function convert(input, meta) {
  const tools = pickTools(input);
  const seen = new Set();
  const uniq = [];
  for (const t of tools) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    uniq.push(t);
  }

  const req = {};
  const anyOfOut = {};
  const schemaTools = {};
  const typesTools = {};
  let withRequired = 0;
  let closed = 0;
  let typedKeys = 0;
  let enumKeys = 0;

  for (const t of uniq) {
    const rAll = requiredOf(t.schema);
    const r = rAll.filter((k) => !String(k).startsWith('@any:'));
    if (r.length) {
      req[t.name] = r;
      withRequired += 1;
    }
    const props = Object.keys(isObj(t.schema.properties) ? t.schema.properties : {});
    const anyOf = [];
    const collectGroups = (node) => {
      if (!isObj(node)) return;
      for (const k of ['anyOf', 'oneOf']) {
        if (!Array.isArray(node[k])) continue;
        // anyOf 的语义是「至少一个分支成立」。判据侧只认「一组键里至少中一个」，
        // 所以把各分支的 required 并成一组：对单键分支是精确的，对多键分支是放宽的。
        const union = [];
        for (const sub of node[k]) {
          if (!isObj(sub) || !Array.isArray(sub.required)) continue;
          for (const r of sub.required) if (!union.includes(r)) union.push(r);
        }
        if (union.length) anyOf.push(union);
      }
    };
    collectGroups(t.schema);
    if (anyOf.length) anyOfOut[t.name] = anyOf.map((g) => g.join('|'));
    const isClosed = t.schema.additionalProperties === false;
    if (isClosed) closed += 1;
    schemaTools[t.name] = {
      name: t.name,
      req: r,
      props,
      closed: isClosed,
      anyOf,
      hasSchema: true,
    };
    const ty = typesOf(t.schema);
    typesTools[t.name] = ty;
    for (const v of Object.values(ty)) {
      typedKeys += 1;
      if (v.enum) enumKeys += 1;
    }
  }

  const generatedAt = new Date().toISOString();
  const src = (meta && meta.source) || 'unknown';
  const params = {
    _说明:
      '工具参数约束表：单一真源。判据生成器按这张表长出「必填缺失 / 形近错键 / 多余键」那一批判据。由 weakreferee schema 从工具定义自动生成。',
    _更新: '改这张表等于改闸门。改完重跑 selftest 与 suggest 回放，命中数变化要能解释。',
    _生成: { generatedAt, source: src, tools: uniq.length },
    req,
    anyOf: anyOfOut,
    wrongkey: wrongkeyCandidates(uniq),
    forbid: {},
  };
  const schema = {
    generatedAt,
    sources: [{ file: src, tools: uniq.length }],
    totals: { tools: uniq.length, withRequired, closed, anyOfOnly: uniq.filter((t) => requiredOf(t.schema).some((k) => k.startsWith('@any:'))).length },
    tools: schemaTools,
  };
  const types = {
    generatedAt,
    sources: [src],
    headers: uniq.length,
    totals: { tools: uniq.length, withType: Object.keys(typesTools).filter((k) => Object.keys(typesTools[k]).length).length, typedKeys, enumKeys },
    tools: typesTools,
  };

  return {
    params,
    schema,
    types,
    stats: {
      tools: uniq.length,
      withRequired,
      closed,
      wrongkeyTools: Object.keys(params.wrongkey).length,
      typedKeys,
      enumKeys,
    },
  };
}

module.exports = { convert, pickTools, requiredOf, typesOf, wrongkeyCandidates, SYN };
