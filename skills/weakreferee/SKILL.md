---
name: weakreferee
description: 弱裁判把「我觉得对」换成机器能戳穿的检查：一套可自测的判据包（core / cross-call / dsh-host / windows-powershell / browser / doc-suite / publish / preference 八个包，手写 49 条、展开 498 条细项；判据按来源分「模型错误」与「个人偏好」两类）加三种接法——DSH 插件在工具调用前同步拦、安装包接任意 MCP 客户端或直接跑命令行、本 skill 只做自查提醒。用户问「这个操作该不该拦」「我之前踩过哪些重复的坑」「装个闸」「检查这次改动会不会又犯老错」「这套检查怎么给别人用」时使用。
license: AGPL-3.0
compatibility: 插件形态需要 DSH 桌面版；安装包形态只需要 Node.js 22 以上（包里不带 node 运行时）；规则里 windows-powershell 域只在 Windows 上生效，core 域跨平台。
metadata:
  version: "0.4.0"
  homepage: "https://github.com/zzqtnb/weakreferee-rules"
---

# 弱裁判

一句话：**拦下才拒，其余只记账。** 判据只管「这一步会不会造成不可逆的损失」，不管代码写得漂不漂亮。

## 红线：这里不放判据

判据的唯一真源是 `dsh-judge-gate/rules/<包>/rules.json`，判据库的说明在仓库根 `catalog/<域>/<编号>.json`。本 skill 只写「什么时候跑哪条命令」——把判据抄一份进来，就是造第二个真源，两边必然对不上。

## 先查这张表：想干什么，跑哪条

| 你想干的事 | 跑这个 | 成功长什么样 |
|---|---|---|
| 让每次工具调用前先被检查 | `dsh-judge-gate\install.ps1`（DSH 插件） | 装完完全退出 DSH 再开，之后每次调用前同步判 |
| 问单条命令会不会被拦 | `node dsh-judge-gate\check.cjs <工具名> "k=v"` | 「判定：拦下 / 提示 / 通过」，退出码 0 通过、1 拦下 |
| 看装了哪些判据、条数对不对 | `node weakreferee-cli.js packs` | 末行「完整性：8 个包与清单一致」 |
| 翻过去的会话，看重复踩了什么坑 | `node weakreferee-cli.js mine <会话目录>` | 命中按判据号分组 |
| 把这一轮遇到的错攒成候选、够次数再起草 | `node weakreferee-cli.js notes add/list/report/promote` | `notes list` 里次数累加；`report` 标出「够次数」与「像同一条」；`promote` 只产 `drafts/` 草案，不自动进包 |
| 看哪条判据该升级成拦、哪条该退回 | `node tools/observe.mjs --ledger <拦截台账.tsv> --days 7` | 一张表：触发次数 / 算几次 / 拦下 / 只提醒 / 结论；`--write` 落报告，`--json` 机读 |
| 改判据 / 加一条判据 | 改 `rules\<包>\rules.json` → 重新生成清单 | 见下面「改判据的流程」 |

## 三种接法

### 一、硬拦：装进 DSH

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <包>\dsh-judge-gate\install.ps1
```

`-DryRun` 只看会改什么，`-Uninstall` 卸载。**装完必须完全退出 DSH 再打开**——运行中的进程仍是旧代码，这是这个项目最容易踩的坑（判据 P6 专门盯它）。

### 二、安装包：不装 DSH 也能用

解压后就是普通目录，要求本机有 Node 22 以上：

```powershell
node weakreferee-cli.js check pwsh "command=Out-File a.ps1 -InputObject 中文"
node weakreferee-cli.js packs
```

接到任意支持 MCP 的客户端，在配置里指到 `dsh-judge-gate\mcp-server.cjs` 即可，工具名 `judge_check`。

### 三、本 skill：只提醒，不拦

它不执行、不拦截，只是让模型知道「这件事该先跑哪条命令自查」。要真拦走前两条。

## 改判据的流程

1. 改 `dsh-judge-gate\rules\<包>\rules.json`（判据库说明同步改 `catalog\<域>\<编号>.json`）
2. `node tools\gen-manifest.js dsh-judge-gate/rules` 重算清单；仓库根 `packs\` 那份镜像也要一致
3. `node tools\validate.js` 结构全部通过；`node weakreferee-cli.js packs` 完整性一致
4. 把改完的 `dsh-judge-gate\` 覆盖到你正在用的那份插件目录（通常是 `<profile>\node_modules\dsh-judge-gate\`），`templates\`、`contract\`、`rules\`、`data\judges-installed.json` 一起覆盖
5. 完全退出 DSH 再打开，新判据才生效

入库有一条硬线：**实测档必须写明是哪个模型犯过、几次**；本机拦下的写「DSH 模型犯过 N 次」——DSH 背后就是模型，本机拦下就是它犯的。

## Gotchas

- **只提醒命中落在「通过」里。** 账本结果列写「通过」，说明列才写判据号与「只提醒只记不拦」。算「撞上几次」必须按说明列算。
- **P6 不是业务命中。** 它管的是「判据代码比宿主进程新，闸还在跑旧逻辑」；看到 P6 满屏先去重启。
- **规则包有两份，必须逐字节相同。** `packs\<包>\rules.json` 与 `dsh-judge-gate\rules\<包>\rules.json`；`validate.js` 会比对。
- **插件有多份副本。** 仓库（唯一源）、`%APPDATA%\dsh\profiles\desktop\node_modules\dsh-judge-gate`（DSH 真加载的那份）、`参赛\软件`。只改仓库那份，再用同步脚本铺开。
- **安装包不带 node 运行时。** 解压就能用，但对方得自己有 Node 22 以上；系统 Node 低于 22.15 读不了会话存档（缺 `zlib.zstdDecompressSync`）。
- **本机数据别跟着包发出去。** `data\` 下的账本、备份、自查标记都是自己机器的记录，导出与打包都排除。
- **默认备份落点是包内 `data\回收站\`**，可用 `DSH_JUDGE_DATA` 指到别处；写不进时它会明说「这次没备份」。

## 什么时候别用

- 要找代码风格问题、review 意见——这不是 linter
- 想靠它替代测试——它拦的是操作形态，不是逻辑对不对
- 拿它当合规证明——只提醒判据只记不拦，命中数也不是覆盖率

## 三条纪律

1. 本 skill **不拦截**，只提醒；要真拦装插件或接 MCP
2. 判据条数不写死在文档里，从 `packs` 或 `judge-packs.cjs status` 现算；数字对不上先怀疑文档没更新
3. 转正（影子转真拦）必须在**本地账本**上重算误拦率，不能照抄作者机器上的数字
