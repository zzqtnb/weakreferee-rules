# 弱裁判 规则包

> 管 AI 的「手」：在它调用工具之前，检查这次调用的参数写对没有。

判据清单在线版（4 个包 38 条，每条写明它看什么、命中时说什么、怎么改）：<https://zzqtnb.github.io/weakreferee-rules/>

## What this is (English)

WeakReferee is a **guardrail** pack for AI coding agents: it inspects the arguments of a **tool call** *before* the call runs — missing required keys, near-miss key names, illegal JSON, PowerShell writes without `-Encoding`, and a few cross-call patterns such as sending an identical failed command again, or claiming a file was edited when nothing ever wrote it.

Four ways to run it: a DSH **plugin**, an **MCP server** (Claude Code, Cursor, or any MCP client), a CLI, and a plain rules package. Rules are data, not code: a few dozen hand-written judgements expand into several hundred checks. It only ships checks that can be decided from the call itself; anything that needs judgement is recorded as a warning instead of a block.

What it is not: not the first project of its kind (closely related ideas exist under *vacuity*, *record-replay divergence* and tool-call schema validation), and not an LLM evaluator — it cannot tell whether an answer is *correct*. It catches malformed or self-defeating agent behaviour, and blocks only what cannot possibly be meant.

Every rule is listed publicly, with what it looks at, what it says when it fires, and how to fix it: <https://zzqtnb.github.io/weakreferee-rules/>

Keywords: AI agent guardrail, LLM tool call validation, tool-call schema validation, MCP server, Claude Code / Cursor plugin, agent retry loop detection, empty tool result, PowerShell encoding guard, DSH plugin, AGPL-3.0.


## 让别人的 AI 自己装

这个仓库根目录有一份 [`AGENTS.md`](AGENTS.md)——给 AI 看的安装单，只有确切命令、期望输出和失败分支，没有废话。
把仓库链接连同下面这句发给你正在用的 AI（Claude Code / Cursor / Codex / Trae / DSH 都认这个文件名）：

```
读 https://github.com/zzqtnb/weakreferee-rules 的 AGENTS.md，按第 0–3 步在我这台机器上把它装好，
每一步的验收命令都真跑一遍，把退出码和关键输出原样贴给我。装不成不要改命令，直接说卡在哪一步。
```

它先在第 1 步证明「引擎能判」（不装任何东西），再问你要不要挂到 DSH 上。判据清单默认是空的——装上不装判据等于空转，这是有意的。

## 接进 MCP 客户端（不装 DSH 也能用）

`dsh-judge-gate/mcp-server.cjs` 是个零依赖的 MCP stdio 服务器，判定用的是同一份 `lib/` 与 `engine/`，不是另写一套。

Claude Code：

```bash
claude mcp add weakreferee -- node <仓库路径>/dsh-judge-gate/mcp-server.cjs
```

Cursor（`~/.cursor/mcp.json`）或任何写 json 的客户端：

```json
{
  "mcpServers": {
    "weakreferee": { "command": "node", "args": ["<仓库路径>/dsh-judge-gate/mcp-server.cjs"] }
  }
}
```

三个工具：`judge_check`（判一次调用，拦下时 `isError: true`，文本里给判据编号）、`judge_packs`（这台机器装了哪些包、展开多少条）、`judge_rules`（已装判据的编号与一句话说明）。
判定读的是 `dsh-judge-gate/data/judges-installed.json`——**清单空着＝判据包空转**（跟插件一致）；参数形态的基础判定（缺必填键、http 只收 https）不依赖清单，照样生效。

## 一句话

市面上的 agent 安全工具大多在管 **该不该做**（这条命令危不危险、要不要人工批准）。
这个仓库在管 **做得对不对**（必填参数缺了没有、键名拼错了没有、写文件带编码了没有）。

前者没有标准答案，靠策略；后者有明确答案，靠判据。

## 它跟现有的几个项目不是一回事

| 项目 | 星 | 抓哪一层 | 规则从哪来 |
|---|---|---|---|
| [avakill](https://github.com/log-bell/avakill) | 26 | 策略层：命令该不该跑 | 人工写的 YAML 策略 |
| [hol-guard](https://github.com/hashgraph-online/hol-guard) | 1118 | 策略层 + 供应链 + 提示注入 | 内置安全清单 |
| [Doberman-Core](https://github.com/DobermanCore/Doberman-Core) | 240 | 策略层：执行路径上的唯一裁决 | 策略 |
| [cordum](https://github.com/cordum-io/cordum) | 508 | 治理层：策略检查 + 人工审批 + 审计 | 策略 |
| **本仓库** | — | **机械层：参数形态与文件写入** | **一次真实使用里 18,360 次调用、403 次拦截反推出来的** |

前四个的立论都对——「不在执行路径上的护栏只能提建议」这句话我也认。
差别在于管的东西不同：它们回答「这条命令危不危险」，这里回答「这次调用的参数写对没有」。两者可叠加，不是替代关系。

## 数据

规则不是想出来的，是从一次真实的翻车里长出来的。

**下面的数字来自作者本人的使用环境（2026-11，Windows 上的 DSH 桌面版）。**
换一个人、换一台机器，命中率会完全不同——工具集不一样、习惯不一样、模型也不一样。
这个仓库给的是判据和写法；你自己的数字要自己跑一遍攒出来。
规则里的 `evidence` 只写「命中几次、跨几个会话」，不写具体哪天、在谁的机器上。

| 项 | 数 |
|---|---|
| 统计期间的模型调用 | 18,360 次（截至 2026-11-22 06:26） |
| 其中被判据拦下 | 403 次（2.20%） |
| 会话数 | 186 个（有工具调用的 160 个） |
| 命中过至少一次的会话 | 67 个 |
| 规则条数 | 不写死在这一行——跑 `node weakreferee-cli.js packs` 现查（2026-11-27 查得手写 38 条、展开 487 条；此后加减判据都不回改这张表） |

每条规则的 `evidence` 字段里写着它命中过几次、跨几个会话、命中的时间戳在哪儿。
**没有 evidence 的规则可以装，但体检报告会把它列进「从没命中过」**——这比假装每条规则都很有用更诚实。

## 三件东西：本体、判据库、判据包

本体和判据是分开的：本体负责「在工具调用前问一句」，判据负责「问什么」。

| 件 | 位置 | 是什么 | 装上之后 |
|---|---|---|---|
| **本体** | `dsh-judge-gate/` | 引擎（插件）与便携包，会跑、会判 | **一条判据都没装时，判据包不拦东西**（插件形态只剩非法 JSON、写文件前备份等基础动作；命令行与 MCP 形态仍判最基础的参数形态） |
| **判据库** | `catalog/` | 市场：一条一个条目，看「都查些什么」 | 看到的不等于装上的 |
| **判据包** | `packs/` | 别人挑好的一批：按域整包装 | 装上才进判定 |

本体空着也能装，装上不装判据就是空转——这是有意的。什么该拦应该是你的决定，不是预先塞给你的一批。

判据库是**目录**：一条一个 json，写「检查什么、什么时候会撞上、撞上了怎么办」，不放正则。判定在包里。两边都存一篇正则，早晚有一边忘了改。

库里每一条固定四行：`判据：` / `例子｜该拦…不该拦…` / `边界：` / `场景例：`。缺哪一行 `tools/validate.js` 都不让进，别人投稿也一样卡，见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

判据包是**配方**：`rules.json` 里是真的条件与正则，机器读这个。同一个域在 `packs/` 和 `dsh-judge-gate/rules/` 各存一份，必须逐字节相同，`tools/validate.js` 会查。

引擎是**两个能跑的东西**：装进 DSH 的插件（每次工具调用前同步判），和不依赖 DSH 的便携包（对已有会话事后体检）。同一个引擎，同一份判据。
### 仓库里直接跑命令行

不装插件也能用：克隆下来就能对一次调用判一遍，需要 Node.js 18 及以上。

```
node weakreferee-cli.js check pwsh "command=Out-File a.txt -InputObject 中文"
node weakreferee-cli.js check write "file_path=D:\a.ps1" "content=中文"
node weakreferee-cli.js packs        # 看装到了哪些包、几条
node weakreferee-cli.js selftest     # 自检：装载、忽略、草案、记账、脱敏
```

命令行读的是 `dsh-judge-gate/` 下的引擎、契约表与规则包，和插件跑的是同一份代码，
所以在仓库根跑还是装成插件，结论一致。退出码：0 通过、1 拦下、2 提示、3 判不了。

### 装判据

```
node dsh-judge-gate/tools/judge-packs.cjs list                     # 看市场，* 是已装的
node dsh-judge-gate/tools/judge-packs.cjs add windows-powershell   # 整包装
node dsh-judge-gate/tools/judge-packs.cjs add WIN-ENC-01 WIN-RMDIR-01   # 只挑两条
node dsh-judge-gate/tools/judge-packs.cjs remove core              # 卸掉一个包
node dsh-judge-gate/tools/judge-packs.cjs status                   # 现在实际生效几条
```

清单写在 `data/judges-installed.json`，改完重启 DSH 生效。插件包里没有 `judges/` 源文件时，`list` 直接从 `rules/*/rules.json` 读——你看到的就是能装的。

装上了以后多严，也归你定。包里写的 `action` 是作者给的默认值，你可以不改文件就覆盖它：面板每条右边三档「拦 / 提示 / 默认」，或者命令行 `node dsh-judge-gate/tools/judge-packs.cjs action WIN-BAT-CJK-01 block`（写 `warn` 只提示，写 `default` 退回作者的值）。改动只记进上面那份清单，`rules.json` 一个字不动，包升级冲不掉；`action CORE-PARAMS-GEN warn` 会连带它展开出来的那批条目一起变松。

发布自己改过的包给别用：`node dsh-judge-gate/tools/judge-packs.cjs export` 把 `rules/` 下这几个包连同 `catalog/` 说明按 `package.json` 的版本号导到仓库根的 `release/v<版本>/`，附一份 `packs.json`（每包的条数、字节、sha256）。它只读源文件——你本机 `data/` 里的东西（装了哪些包、调过的三档、删掉的条目）一条都不进发布版。

不喜欢某一条，不用卸整包：面板卡片右下「删掉」，或者 `node dsh-judge-gate/tools/judge-packs.cjs delete WIN-BAT-CJK-01`。删掉的那条不再判、从列表里消失，记录写进清单的 `removed`；`restore` 放回来，整包升级也不会把它带回来。手工删的、误删的都在这儿：`judge-packs.cjs list` 里已删的标 `-`。

面板还有一栏「库里」：整份判据库 45 条都在这里，装进闸的可以直接调三档，还没写成机器判据的显示成灰卡（右上标「还没写成规则」）。每条带「判据 / 例子 / 边界 / 已测」四段——它为什么存在、该拦什么、什么情况放过。说明来自仓库根的 `catalog/`，装成插件后跟包一起走。

### 判据从哪来：两条路

**一条人挑**：上面那些命令，`list` 看市场、`add` 装包或单条。适合「我知道我要防什么」。

**一条机器挑**：`node weakreferee-cli.js mine` 扫自己的会话历史，把反复出现、现在没人管的写法列成草案；确认后 `judge-packs.cjs add --draft mine-rules.json` 把它装成一个自建包（落在 `data/custom/mine/`）。适合「我不知道自己会被什么坑，让记录说话」。草案的 `action` 一律是 `warn`（只提示不拦）。跑一段时间看它误拦多少，再决定要不要变严：面板点「拦」，或 `judge-packs.cjs action MINE-BAT-CJK-01 block`。

两条路的落点都是同一份清单，装载时不区分来源。哪条路进来都一样：装几条、拦几条、误拦归谁，账上都记着。

### 装多装少的代价

自己掂量，不替你选：

| 装多了 | 装少了 |
|---|---|
| 误拦叠加：单条误报约 1%，一次任务碰到 5 条相关判据，冤你一次的机会约 5% | 该拦的没拦：没装删除类，递归删就直接执行了 |
| 日志变长，翻起来慢 | 出了事才知道漏 |

不分多少的一条：判据只判「参数形态」这类机器能戳穿的错（字段名、类型、编码、危险命令），判不了方案好不好。

目录导览看 `catalog/INDEX.md`；加一条自己的规矩看 `CONTRIBUTING.md`。

## 包里有什么

```
catalog/                  判据库：一条一个 json + INDEX.md 目录页
packs/
  core/                   不依赖平台与宿主，换到哪都成立
  windows-powershell/     只在 Windows + PowerShell 生效，换 Linux 整包不装
  dsh-host/               依赖宿主自身状态，换宿主整包不装
  cross-call/             看前几次调用：失败后又原样发、同一个文件连着磕。只提示不拦，可单独装
  community/              社区贡献的包（<作者>/<域>）
weakreferee-cli.js        命令行入口：不装插件也能判
guide.js                  向导：引导第一次运行、把结果写到桌面
dsh-judge-gate/           引擎：装进 DSH 的插件（含 installer 与自检）
skills/weakreferee/       给 agent 看的用法说明，不含判据
tools/                    validate.js（结构校验）、gen-manifest.js（清单重算）
schema/                   规则与判据库条目的结构定义
docs/                     怎么写一条规矩、跟同类项目差在哪
```

每个包目录里有两个文件：

- `pack.json` —— 元数据：生效范围、版本、**在什么宿主、哪个模型、多少次调用上验过**（`testedOn`）
- `rules.json` —— 规则数组，结构见 `schema/rule.schema.json`

`testedOn` 是这个仓库最不想省的东西。一条规矩「在 18,360 次真实调用上验过、命中 29 次」和一条「我觉得应该这么写」，价值差得很远。

**同一份规则存了两处**：`packs/*/rules.json` 和 `dsh-judge-gate/rules/*/rules.json` 内容必须逐字节相同——前者给只拿规则包的人，后者是插件包里跑的那份。改规则要两处一起改，然后 `node tools/validate.js` 发现不一致会当场报（比对 `bytes` 与 `sha256`）；只改一处的提交不算改完。
但 `testedOn` 记的是**作者的**环境；它说明这条规矩真被用过，不是保证在你这里也会命中。

## 一条规则长什么样

```json
{
  "id": "CORE-HTTPS-01",
  "title": "web_fetch 只接受 https",
  "when": "tool:pre",
  "appliesTo": { "tool": "web_fetch" },
  "condition": {
    "any": [
      { "type": "regexHit", "in": "args.url",  "pattern": "^http://" },
      { "type": "regexHit", "in": "args.urls", "pattern": "^http://" }
    ]
  },
  "action": "block",
  "severity": "B",
  "message": "web_fetch 只收 https，http:// 会被工具直接拒绝",
  "fix": "把 http:// 换成 https://",
  "reversible": false,
  "evidence": { "hits": 3, "sessions": 3, "source": "作者环境拦记账本（累计命中见 hits）" },
  "selfTest": {
    "cases": [
      { "args": { "url": "http://example.com" },  "expect": "block" },
      { "args": { "url": "https://example.com" }, "expect": "pass"  },
      { "args": { "urls": ["http://a.com", "https://b.com"] }, "expect": "block" }
    ]
  }
}
```

四个动作，含义写死：

| action | 做什么 | 用在什么情况 |
|---|---|---|
| `block` | 拒绝执行 | 客观上就是错的（缺必填键、写文件会乱码） |
| `warn` | 放行，记一条账 | 可疑但可能正当 |
| `steer` | 放行，附一句提示 | 提醒一下就好，不打断 |
| `default` | 只在参数缺失时补一个默认值 | 用户偏好。**已写的值一律不动** |

`default` 是唯一会改动调用的动作，且只在「用户没说」时生效——补的是用户习惯，不是替用户做主。

## 二十四种判定条件

判定只认 `condition.type`，不认业务。加规矩不用改引擎，落不进这些才需要扩内核。

**看这一次调用**

`missingKey` `emptyValue` `missingAnyOf` `wrongKey` `extraKey` `typeMismatch`
`missingFlag` `regexHit` `regexMiss`
`fileLacksBom` `fileHasBom` `fileAnchorMissing` `fileAnchorMultiple` `fileNewerThan` `fileNewerThanProcessStart`
`unknownKey` `pathOutside` `cmdAbsPathWritten`

**看前几次调用**（判据要写 `needs: ["history"]`，拿不到历史时显式标「跳过」，不算通过）

`noCallSince` `callCountSince` `argRepeat`
`failRepeat` `failCountSince`

`failRepeat` 与 `failCountSince` 只看记了成败的历史：条目的 `ok` 是 `true`/`false` 才算数，`null`（不知道成没成）一律跳过——猜出来的成败会把误报说成「有依据」。
`failRepeat` 加 `streak: true` 时从最近一条往前数，遇到同值成功就断：失败两次之后中间成功过五回，再来一次不算死磕，那是正常工作。

可以嵌套组合：`all`（全真）、`any`（至少一真）、`not`（取反）。

三条容易踩的语义约定：

1. **字段没给 ≠ 值不对**。`regexMiss` 在字段不存在时返回 false，不是 true。
2. **引号里的内容不算命令**。判 `-Encoding` 在不在时，先把引号内的字面量抹掉，否则一句话里提到这个词就会被误判。
3. **正则装载时校验**。编译失败、超长、疑似灾难性回溯的，直接拒装并说明原因，不让一个包把判定器卡死。

## 怎么用

### 一、直接跑（Windows，免安装）

到 [Releases](https://github.com/zzqtnb/weakreferee-rules/releases) 下 `weakreferee-0.1.0-win64.zip`，
解压到任意目录——D 盘、E 盘、U 盘都行，路径带空格也行，不写注册表、不要管理员权限、不用装 node。

- 不熟命令行：双击 `傻瓜模式.bat`，按菜单选
- 熟命令行：双击 `启动.bat` 敲 `weakreferee check pwsh "command=..."`

第一次运行时 Windows 可能弹「已保护你的电脑」（未签名所致），点「更多信息 → 仍要运行」。
包里带 `使用说明.txt`，八节，写清怎么看结果、退出码哪几个。

### 二、只拿规则包

这只是一个规则包仓库，**不带引擎**。格式是公开的：读 `packs/*/rules.json`，按 `appliesTo` 筛掉不适用的，
按 `when` 分组，在对应时点调用你的判定函数即可。

### 三、模型档案

判据库不收单独的模型档案目录：原来那一份里只有一个模型有真实数据，其余全是空位，空位比没有更误导，已经撤掉。
模型短板的写法在 [`CONTRIBUTING.md`](CONTRIBUTING.md) 第四节——写进 `model` 包的 `modelProfile` 字段，跟规则放在一起，有数据才写得出。

### 四、装成 DSH 插件

仓库里的 `dsh-judge-gate/` 就是这个闸的插件包：判据代码、判定引擎、三份规则包、契约表全在包内，
**运行时只认自己所在的那一层目录，不认任何本机绝对路径**。换台机器复制过去就能跑。

三行装完：

1. `git clone https://github.com/zzqtnb/weakreferee-rules.git "%USERPROFILE%\weakreferee-rules"`
2. `powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\weakreferee-rules\dsh-judge-gate\install.ps1"`
3. 完全退出 DSH（含托盘图标）再打开

装完验一句（这条会被拦）：

```
node "%USERPROFILE%\weakreferee-rules\dsh-judge-gate\check.cjs" pwsh "command=Out-File D:\a.ps1 -InputObject 中文"
```

装完还不判东西——本体装上空转是设计。要它真拦，接着装判据包，注意**用插件目录里那份工具**（写进插件自己的清单才算数）：

```
node "<profile>\node_modules\dsh-judge-gate\tools\judge-packs.cjs" list
node "<profile>\node_modules\dsh-judge-gate\tools\judge-packs.cjs" add core
```

`<profile>` 是 install.ps1 打印的那条路径（它装完会把这条命令原样打在屏幕上，复制即可）。
**为什么不能在本仓库目录里装**：`judge-packs.cjs` 写的是自己所在包里的 `data/judges-installed.json`，在克隆目录跑就写进克隆目录那份，而插件读的是自己目录那一份，两边不是一个文件——屏幕显示「已装 18 条」，插件那边还是空的，且不报错。装完再完全退出 DSH 重开一次才生效。

卸载：第 2 行同一条命令加 `-Uninstall`，profile 的 `package.json` 退回装之前的样子，一行不剩。

装脚本只碰三样东西：把插件目录复制进 profile 的 `node_modules`、在 profile 的 `package.json` 里加一条依赖与一个 bundle、
跑一次零件自检（`check.cjs --selfcheck`）。改 profile 之前先把 `package.json` 备份成 `.bak-judge-gate-<时间>`，
自检不过就当场停下，并告诉你备份在哪儿。

细节见 [`dsh-judge-gate/README.md`](dsh-judge-gate/README.md)。

**插件还多一层影子观测（2026-11-24 起，只记不拦）**：判据都在工具调用「之前」看参数，插件额外挂了一个结果监听——某个工具返回失败（报错、找不到文件、空结果）之后 5 分钟内又对同一个文件 `write` / `edit`，就在 `data\j15.log` 里记一行「疑似无视失败」，附上前后两次的工具与目标。它需要宿主的事件流（`tools/result`），规则包引擎没有这条路，所以只有插件版有。看一周，真有东西再谈要不要转正；不需要就设 `DSH_JUDGE_J15=0` 关掉。

### 五、只装其中几条

装卸整包或单条，用 `tools/judge-packs.cjs`（推荐，会写进安装清单、重启后仍生效）。**装成插件之后，要用插件目录里那份**（`<profile>\node_modules\dsh-judge-gate\tools\judge-packs.cjs`），理由同上段：清单写在哪一份，决定插件看不看得到。

命令行临时试判、或不想动清单时，用下面的 `--only` / `--skip`：

```
node weakreferee-cli.js packs --only J8,J12
node weakreferee-cli.js scan <会话目录> --only J8
node dsh-judge-gate/check.cjs pwsh "command=Out-File D:\a.ps1 -InputObject 中文" --only J8
```

也可以在项目根的 `.weakreferee.json` 里写 `"only": ["J8","J12"]`，或用环境变量 `DSH_JUDGE_ONLY`（逗号、分号、空格都认）。反过来写 `--skip J9` 是「其余都装，就它不要」。

两个名字都认：包里那个号（`WIN-ENC-01`）和给人看的号（`J8`）。名字写错会被点名，不会静默少装。

**名单两侧都管**（2026-11-23 改）：插件在工具调用前拦的那一下（`lib/paramcheck.js`）也按同一份名单走，名单外的判据直接跳过；把 `J3` 写进 `--skip`，参数形态整条不判（返回「J3 已按名单关闭」，不静默放行）。配置可以写在 profile 的 `judges.only` / `judges.skipJudges`，也可以写环境变量 `DSH_JUDGE_ONLY` / `DSH_JUDGE_SKIP`。**仍有一处例外**：`J6`（这轮读过的文件是不是这一回的）、`J14`（一小时内查没查过自己的工具）与 `J15`（工具失败后又动同一文件）的判定状态记在进程内，规则包表达不了，名单对它们不起作用。

### 六、查工具描述有没有夹带东西

工具描述会原样进模型上下文。装新插件、接 MCP 服务器之前扫一遍：

```
node tools/mcp-descan.js 某个工具定义.json
node tools/mcp-descan.js --profile        # 本机所有 profile 的配置
node tools/mcp-descan.js --self-test      # 自检：5 坏样本该中、3 好样本不该中
```

11 条规则（指令覆盖 / 隐藏动作 / 保密要求 / 偷看提示词 / 偷凭据 / 不可见字符 / HTML 注释 / base64 块），`high` 级命中退出码 1。

只查描述文字，不查工具背后的代码到底做了什么——中了不代表一定坏，没中也不代表干净。

## 跨调用：它是不是在原地打转

前面那些判据看的是「这一次调用写得对不对」。还有一类错只在两次之间才看得出来：同一条命令刚失败过、一个字没改又发一遍；同一个文件连着没写成、还在往它身上试。这类判据放在 `cross-call` 包里，**默认不装**：

```
node dsh-judge-gate/tools/judge-packs.cjs add cross-call      # 装上（只提示，不拦）
node dsh-judge-gate/tools/judge-packs.cjs remove cross-call    # 撤掉，行为回到没装的样子
```

装之前值得先在自己的历史上验一遍——判据吵不吵，取决于你平时怎么干活：

```
weakreferee trace --max-files 400
```

它会读 `$DSH_HOME/sessions` 下的会话日志，把每次调用的成败从 `tool/result` 帧里对出来（对不上结果的调用直接丢掉，不猜），按时间顺序喂历史，报两条判据各命中几次、头几条长什么样。仓库作者这台机器上跑出来是这样：

| 判据 | 命中 | 人工核 20 条 |
|---|---|---|
| `CROSS-RETRY-01`（同命令失败后又原样发） | 27 次 / 28,001 次调用 | 20 条全部是「前一条同命令失败，2~9 秒后又原样发」，无一误报 |
| `CROSS-BLIND-01`（同文件连败仍继续试） | 1 次 | 未抽样 |
| `CROSS-GRIND-01`（同工具连败三次、参数没改） | 0 次 | 按「命中 0 次不收」暂不进包，条件留在引擎里 |

那 27 次里有一条值得单说：`CROSS-BLIND-01` 一开始按「20 分钟内这个文件失败过两次」判，报 23 次，人工一看绝大多数是「失败两次 → 成功改了五回 → 又来一条」，属于正常工作。改成「连败」语义（中间成功就断）后只剩 1 次。**这类判据最贵的不是漏报，是把你正常干活报成毛病**，所以它宁可少报。

## 让它自己长出规矩来

判据不必全由人写。`mine` 扫自己的会话记录，把反复出现的形态统计出来，次数够了就出草案：

```bash
weakreferee mine "$DSH_HOME/sessions" --max-files 400          # 先看报告
weakreferee mine "$DSH_HOME/sessions" --max-files 400 --pack ./mined   # 直接写成能装的包
node tools/validate.js ./mined                                 # 自查结构
```

出草案之前会先把现有全部规则跑一遍：这件事要是已经有人管（比如 `WIN-BAT-CJK-01`），就只记一行「本来会出草案，实判发现已经有人管」，不再出一条管同一件事的重复判据。作者机上 709 次「write 往文本文件写中文」也是这么被判成「不该管」的——计数多不等于该拦。

草案一律 `action: warn`。要真拦，自己改成 `block` 并补齐正反用例；别人的机器上什么情况，光看自己的记录看不出来。

### 判据也要能被淘汰

命中与误报都记账，一条命令看全：

```bash
weakreferee stats --ledger ./ledger.jsonl
weakreferee fp WIN-ENC-01 --note "这次是有意不写 -Encoding" --ledger ./ledger.jsonl
```

`fp`（false positive，误报）由人判，机器不猜。建议只看三件事：误报绝对数、误报占命中的比例、这条到底命中过没有——

| 情况 | 建议 |
|---|---|
| 误报 ≥ 3 次，且占命中 30% 以上 | 该降：降成只提示，或删掉 |
| 一次都没命中过，只被标过误报 | 该撤 |
| 命中 ≥ 5 次，且误报不到 10% | 该留 |
| 其余 | 再观察 |

实测一次：某条判据命中 5 次、被标 3 次误报（60%），`stats` 直接报「该降：误报多，降成只提示或删掉」，并在末尾列出「要动的：WIN-ENC-01」。
判据库只增不减是这类工具的通病（条数好看，报出来的东西没人信），这一层就是给它装一个删除键。

## 怎么写自己的规矩

见 [`docs/怎么写一条规矩.md`](docs/怎么写一条规矩.md)。要点三条：

1. 先有事故，再写规矩。想不出来的规矩，装上去也永远不会命中。
2. 每条规矩至少写一个「该拦」和一个「该放」的用例。只有该拦没有该放的规矩，很容易宽到把所有正常操作都拦掉。
3. 写清 `appliesTo`。忘了写 `fileMatches`，一条只想管 `.ps1` 的规矩会去管所有文件——这是本仓库自己踩过的坑。

## 明确不做

1. **不纠错**——发现错了就拦，不悄悄替你改。改了你就不知道原来的写法有问题。
2. **不训练模型**——这不是模型侧的方案。
3. **不做生成**——不生成代码、不生成回复。
4. **不保证正确**——没写进规则里的错，它挡不住。这一点写在最前面，不藏在文档末尾。
5. **不联网**——判定过程纯本地，不查云端、不调模型。

## 与同类的关系

检索范围内，没有查到把「参数级机械判据」「判据自身的误报检测」「可装载规则包」三件事放在一起做的工作。

**但这只是「未查到」，不是首创声明。** 同类项目 2025 年以来增长很快，本仓库的检索不构成穷尽。

## 许可证

这个仓库分两种许可，各管各的：

| 内容 | 许可证 | 它要求什么 |
|---|---|---|
| 程序代码、规则包（`packs/` `catalog/` `schema/` `tools/`） | **AGPL-3.0**，见 [LICENSE](LICENSE) | 随便用、随便改、随便开源分发；**但改了并分发、或者做成对外提供的服务，就必须把你的修改也开源** |
| 文档（README、`docs/`、CONTRIBUTING.md 与各包说明文字） | **CC BY 4.0**，见 [LICENSE-docs](LICENSE-docs) | 随便用、随便改、随便商用；只要求保留署名 |

为什么代码不选 MIT / Apache-2.0：那两份明确允许「拿了改一改、闭源卖钱、不告诉任何人你用过」。
这个仓库的目的是让规则被广泛使用和贡献，不是让某个公司包装成产品去卖。
AGPL 把这条界限画清楚了——**自己用、内部用、研究用，一点限制都没有；拿它赚钱，就得把改动放出来**。

三个需要说清的点：

1. **内部使用不触发任何义务**。装在自己电脑上、公司内部用，改不改、要不要开源，都随你。
2. **AGPL 不等于禁止商用**。它允许商用，前提是商用方也开源。真正被挡住的是「闭源拿去卖」。
3. **想闭源商用**：需要单独的商业授权，联系作者。

规则包为什么也跟着 AGPL：它离开引擎只是一堆 JSON，单独拿走的实际用途有限；跟随引擎保持一致，比维护两套许可证更不容易出错。
如果你只想借思路、在自己项目里重写一份，**思路不受许可证保护**，尽管用。
