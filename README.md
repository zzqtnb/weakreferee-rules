# 弱裁判 规则包

> 管 AI 的「手」：在它调用工具之前，检查这次调用的参数写对没有。

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
| 规则条数 | 14 条（core 2 / windows-powershell 9 / dsh-host 3） |

每条规则的 `evidence` 字段里写着它命中过几次、跨几个会话、命中的时间戳在哪儿。
**没有 evidence 的规则可以装，但体检报告会把它列进「从没命中过」**——这比假装每条规则都很有用更诚实。

## 三块东西：判据库、判据包、引擎

仓库分三层，各管一件事：

| 层 | 位置 | 给谁用 | 能不能自己挑 |
|---|---|---|---|
| **判据库** | `catalog/` | 想看「都查些什么」的人 | 一条一条看，挑着想装哪几条 |
| **判据包** | `packs/` | 装了插件或便携包的人 | 按域整包装，也可以自己改 |
| **引擎** | `dsh-judge-gate/` | 想让它真拦的人 | 装一次，之后自动跑 |

判据库是**目录**：一条一个 json，写「检查什么、什么时候会撞上、撞上了怎么办」，不放正则。判定在包里。两边都存一篇正则，早晚有一边忘了改。

库里每一条固定四行：`判据：` / `例子｜该拦…不该拦…` / `边界：` / `场景例：`。缺哪一行 `tools/validate.js` 都不让进，别人投稿也一样卡，见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

判据包是**配方**：`rules.json` 里是真的条件与正则，机器读这个。同一个域在 `packs/` 和 `dsh-judge-gate/rules/` 各存一份，必须逐字节相同，`tools/validate.js` 会查。

引擎是**两个能跑的东西**：装进 DSH 的插件（每次工具调用前同步判），和不依赖 DSH 的便携包（对已有会话事后体检）。同一个引擎，同一份规则。

目录导览看 `catalog/INDEX.md`；加一条自己的规矩看 `CONTRIBUTING.md`。

## 包里有什么

```
catalog/                  判据库：一条一个 json + INDEX.md 目录页
packs/
  core/                   不依赖平台与宿主，换到哪都成立
  windows-powershell/     只在 Windows + PowerShell 生效，换 Linux 整包不装
  dsh-host/               依赖宿主自身状态，换宿主整包不装
  community/              社区贡献的包（<作者>/<域>）
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

## 十八种判定条件

判定只认 `condition.type`，不认业务。加规矩不用改引擎，落不进这十八种才需要扩内核。

`missingKey` `emptyValue` `missingAnyOf` `wrongKey` `extraKey` `typeMismatch`
`missingFlag` `regexHit` `regexMiss`
`fileLacksBom` `fileHasBom` `fileAnchorMissing` `fileAnchorMultiple` `fileNewerThan` `fileNewerThanProcessStart`
`unknownKey` `pathOutside` `cmdAbsPathWritten`

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

卸载：第 2 行同一条命令加 `-Uninstall`，profile 的 `package.json` 退回装之前的样子，一行不剩。

装脚本只碰三样东西：把插件目录复制进 profile 的 `node_modules`、在 profile 的 `package.json` 里加一条依赖与一个 bundle、
跑一次零件自检（`check.cjs --selfcheck`）。改 profile 之前先把 `package.json` 备份成 `.bak-judge-gate-<时间>`，
自检不过就当场停下，并告诉你备份在哪儿。

细节见 [`dsh-judge-gate/README.md`](dsh-judge-gate/README.md)。

**插件还多一层影子观测（2026-11-24 起，只记不拦）**：判据都在工具调用「之前」看参数，插件额外挂了一个结果监听——某个工具返回失败（报错、找不到文件、空结果）之后 5 分钟内又对同一个文件 `write` / `edit`，就在 `data\j15.log` 里记一行「疑似无视失败」，附上前后两次的工具与目标。它需要宿主的事件流（`tools/result`），规则包引擎没有这条路，所以只有插件版有。看一周，真有东西再谈要不要转正；不需要就设 `DSH_JUDGE_J15=0` 关掉。

### 五、只装其中几条

目录里的判据不必全要。点名要哪几条，其余不加载：

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
