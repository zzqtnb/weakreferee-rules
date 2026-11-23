---
name: weakreferee
description: 弱裁判把「我觉得对」换成机器能戳穿的检查：一套可自测的判据包（core / dsh-host / windows-powershell，14 条规则）加三种用法——DSH 插件在工具调用前同步拦、便携包对已有会话事后体检、命令行单条试判。用户问「这个操作该不该拦」「我之前踩过哪些重复的坑」「装个闸」「检查这次改动会不会又犯老错」「把一套检查交给别人」时使用。
license: GPL-3.0
compatibility: 插件形态需要 DSH 桌面版；便携包需要 Node 22.15 以上（自带 node.exe 的发行包不受此限）；规则包里只有 core 域跨平台，windows-powershell 域只在 Windows 上生效。
metadata:
  version: "0.3.0"
  homepage: "https://github.com/zzqtnb/weakreferee-rules"
---

# 弱裁判

一句话：**拦下才拒，其余只记账。** 判据只管「这一步会不会造成不可逆的损失」，不管代码写得漂不漂亮。

## 红线：这里不放判据

判据的唯一真源是 `judges\<ID>.json`（一条一个文件），编译产物是 `packs\<域>\rules.json`。本 skill 只写「什么时候跑哪条命令」——把判据抄一份到这里，就等于造了第二个真源，两边必然对不上。

## 先查这张表：想干什么，跑哪条

| 你想干的事 | 跑这个 | 成功长什么样 |
|---|---|---|
| 让我以后动手前先被检查 | `dsh-judge-gate\install.ps1`（插件） | 装完重启，之后每次工具调用前同步判 |
| 问单条命令会不会被拦 | `dsh-judge-gate\check.cjs <工具名> "k=v"` | 三行：主判定 / 新引擎 / 是否一致；退出码 0 通过 1 拦下 |
| 翻过去的会话，看重复踩了什么坑 | `weakreferee-cli.js scan\|mine\|replay` | 命中按判据号分组 |
| 每周看一眼、给自己认过的错归档 | `tools\judge-weekly.js`、`judge-errors.js`、`judge-claims.js` | 一份 md 周报 |
| 改判据 / 加一条判据 | 改 `judges\<ID>.json` → 重新生成 | 见下面「改判据的五步」 |

## 四种用法

### 一、硬拦：装进 DSH

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <包>\dsh-judge-gate\install.ps1 -DshHome "$env:APPDATA\dsh"
```

`-DryRun` 只看会改什么，`-Uninstall` 卸载。**装完必须完全退出 DSH 再打开**——运行中的进程仍是旧代码，这是这个项目最容易踩的坑（判据 P6 专门盯它）。

### 二、单条试判

```powershell
node <包>\dsh-judge-gate\check.cjs pwsh "command=Out-File C:\a.ps1 -InputObject 中文"
node <包>\dsh-judge-gate\check.cjs write "file_path=C:\a.txt" "content=hello"
```

退出码就是结论：`0` 通过，`1` 拦下。别用输出里的字去猜。

### 三、事后体检

```powershell
node <包>\weakreferee-cli.js scan <会话目录>
node <包>\weakreferee-cli.js mine <会话目录> --top 20
node <包>\weakreferee-cli.js replay <账本> --stat
```

会话目录形如 `%APPDATA%\dsh\sessions`（每个工作区一个子目录，里面是 `session-*\session.v4.jsonl.zstd`）。`scan` 全量、慢；`mine` 只列命中。

### 四、每周复查

```powershell
node <包>\tools\judge-weekly.js --ledger <账本> --out <输出目录>
node <包>\tools\judge-errors.js import --sessions <会话目录>
node <包>\tools\judge-claims.js --sessions <会话目录> --days 7
```

三个脚本各管一件事：周报（哪些够格转正、哪些是新候选）、把 agent 当场认的错抽成候选、找「说改好了但其实没写」的地方。

## 改判据的五步

1. 改 `judges\<ID>.json`（**不要**直接改 `rules.json` 或 `判据库.md`，两个都是生成物）
2. `node _tmp\judgectl.js render --write` 生成判据库，`emit --write` 生成规则包
3. 把生成物搬到正式位置（`_gen\` 是中转目录，不直接生效）
4. 验证：`node tools\gen-manifest.js rules` → `node tools\validate.js` → `node dsh-judge-gate\check.cjs --selfcheck`
5. 三处副本同步（开发目录 / profile 的 node_modules / 仓库），再重启 DSH

详细版见 [references/adding-a-rule.md](references/adding-a-rule.md)。

## Gotchas

- **影子期命中落在「通过」里。** 账本结果列写「通过」，说明列才写判据号与「影子期只记不拦」。算「撞上几次」必须按说明列算，只看结果列会得出「一次没撞上」的假结论。
- **P6 会刷屏。** 它管的是「判据代码比宿主进程新，闸还在跑旧逻辑」，不是业务命中。看到 P6 满屏先去重启，别当成用户踩坑；账本「提示」列被它淹过两千多条。
- **规则包有两份，必须逐字节相同。** `packs\` 与 `dsh-judge-gate\rules\`；`validate.js` 会比对，别只改一处。
- **判据插件有三份副本。** 开发目录、`%APPDATA%\dsh\profiles\desktop\node_modules\dsh-judge-gate`（DSH 真加载的那份）、仓库副本。只改一份等于没改。
- **便携包里的 node 自带 zstd，系统的 Node 要 22.15 以上**才有 `zlib.zstdDecompressSync`；低于这个版本读不了会话存档，脚本会直说而不是静默返回空。
- **本机数据别跟着包发出去。** `data\自报错误.jsonl`、账本、`j6.log` / `j14.log` 都是自己机器的记录，打包前整目录排除。
- **默认备份落点是包内 `data\回收站\`**，不是某个固定盘符；可用 `DSH_JUDGE_DATA` 指到别处，写不进时它会明说「这次没备份」，不再假装成功。

## 什么时候别用

- 要找代码风格问题、review 意见——这不是 linter，判据只管「会不会造成损失」
- 想靠它替代测试——它拦的是操作形态（缺参数、写文件没说编码、递归删除没试运行），不是逻辑对不对
- 拿它当合规证明——影子期判据只记不拦，命中数也不是覆盖率

## 三条纪律

1. 本 skill **不拦截**，只提醒；要真拦装 `dsh-judge-gate`
2. 判据条数与分层不写死在文档里，从 `judges\` 现算；看到数字对不上，先怀疑文档没重新生成
3. 转正（影子转真拦）必须在**本地账本**上重算误拦率，不能照抄作者机器上的数字
