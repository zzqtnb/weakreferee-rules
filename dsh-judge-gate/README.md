# 弱裁判 · dsh-judge-gate

一个挂在 DSH 工具调用路上的闸：**调用前同步核参数，拦下才拒，其余只记账**。

判定只看机器当场能判的东西——缺必填键、形近错键、多余键、非法 JSON；写文本文件漏 `-Encoding`；给 PowerShell 自动变量赋值；往 `.ps1` 写中文不带 BOM；往 `.bat`/`.cmd` 写中文（控制台按 GBK 读，必乱码）；判据代码比宿主新（改了没重启，闸跑的还是旧逻辑）；一次写了多个文件没备份；命令里有删/改绝对路径的文件动词而没先备份。判不了的它不猜，只记一行。

当前 14 条规则、分三包：`core` 2 条（工具参数形态）、`windows-powershell` 9 条（PowerShell 与批处理的写读坑）、`dsh-host` 3 条（闸自己的状态与备份）。条数以 `rules/manifest.json` 为准。

包里自带全部运行零件（判据代码、引擎、规则包、契约表），**装到哪台机器都从自己所在的目录找**，不认本机路径。

---

## 装：三行

在 cmd 里逐行跑（Windows 自带 PowerShell 就够）：

1. `git clone https://github.com/zzqtnb/weakreferee-rules.git "%USERPROFILE%\weakreferee-rules"`
2. `powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\weakreferee-rules\dsh-judge-gate\install.ps1"`
3. 完全退出 DSH（含托盘图标）再打开 —— 这一行是动手，不是命令

没有 git 就下 ZIP（仓库页 Code → Download ZIP），解压到 `%USERPROFILE%\weakreferee-rules`，第二行的路径照上面写。

装完你会看到 `STEP 1 … STEP 8` 和一行 `自检通过`。装到一半报错，`install.ps1` 不会留下半死状态：`package.json` 每次都先备份成 `.bak-judge-gate-<时间>`，删掉插件目录即回到装之前。

若 `DSH_HOME` 没在环境变量里（非桌面版启动方式），第二行后面补 `-DshHome "<你的 dsh 数据目录>"`。

---

## 验一句

```
node "%USERPROFILE%\weakreferee-rules\dsh-judge-gate\check.cjs" pwsh "command=Out-File D:\a.ps1 -InputObject 中文"
```

会打印并排的两行判定（主判定 / 新引擎）和「一致」，被拦时退出码 1。

`node "<插件目录>\check.cjs" --selfcheck` 只查零件齐不齐，不判任何调用——装完自检跑的就是它。

---

## 账本在哪

每判一次落一行 tsv：时间、工具、结果、判据号、一句说明。默认写在 `<插件目录>\data\拦截.tsv`；那个位置写不进就按下面「配置」一节的顺序换个地方，并在启动日志里说是哪一个。

「结果」四档：`拦下`（调用被拒，模型会改写重试）、`提示`（只提醒，照常执行——影子期与 warn 档都落这里）、`通过`（判了没命中）、`未验`（判据要现场条件，比如文件在不在，当场判不了，不算通过）。

想统计「某条判据撞了多少次」，按说明列里的判据号数行，别只看结果列——影子期命中落在「通过」里。

---

## 卸

```
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\weakreferee-rules\dsh-judge-gate\install.ps1" -Uninstall
```

删插件目录、删掉 profile `package.json` 里那两行，DSH 照常启动。再启动就不加载它了。

---

## 配置

profile 的 `cordis.patch.yml` 里对这一条：

```yaml
- id: judge-gate
  name: dsh-judge-gate
  config:
    enforce: true            # false = 只记账不拦（影子模式）
    logPath: ''              # 空 = 自动挑一个可写的地方（见下）
    skip: []                 # 跳过的工具名
```

日志落点按顺序试，第一个能写进的就用：配置的 `logPath` → 环境变量 `DSH_JUDGE_LOG` → 插件自己的 `data\拦截.tsv` → `$DSH_HOME\logs\judge-gate\` → 用户目录 `.dsh-judge-gate\` → 临时目录。全都不行就空转并在启动日志里喊一句，**不会假装记上了**。

想同时看规则包的判定：设 `DSH_JUDGE_ENGINE=shadow`，两边结论落在 `新引擎对照.tsv`，不参与拦截。

`DSH_JUDGE_SHELL` 可以指定判据里认的 shell（默认 pwsh）。

只想用其中几条：`check.cjs` 支持 `--only J8,J12` / `--skip J9`，环境变量 `DSH_JUDGE_ONLY` / `DSH_JUDGE_SKIP` 也认（逗号、分号、空格都行），名字写错会当场点名。**注意范围**：名单管的是规则包引擎那一侧——`check.cjs` 的新引擎列、`DSH_JUDGE_ENGINE=shadow` 的旁路；插件在工具调用前拦的那一下走包内 `lib\paramcheck.js` 的内置判定，不吃名单。

---

## 目录

```
index.js            闸本体（ctx.tools.guard 在 dispatch 前核参）
check.cjs           手动问一句 + 零件自检
install.ps1         装 / 卸
lib/                主判定 paramcheck.js 与三份契约表
engine/             规则引擎（载入、展开、判定、账本、挖掘、重放）
rules/              规则包三份：core / windows-powershell / dsh-host
CHANGELOG.md        每版换了什么
LICENSE             GPL-3.0 全文
```

判据的编号与条数以规则包为准，改判据只动 `rules/` 与 `lib/`，不改 `index.js`。

---

## 别人机器上可能没有的东西

这插件是从我本机长出来的，有几样东西别人不一定有，逐个说清会怎样：

- **没有 D 盘**：备份与自查标记默认落在插件自己的 `data\`（0.3.0 起），不再指向任何固定盘符。想换地方设 `DSH_JUDGE_DATA`，或单独设 `DSH_JUDGE_BACKUP` / `DSH_JUDGE_MARKS`
- **没有装 node**：安装照走，`install.ps1` 先找 PATH 里的 node，再找 DSH 自带的 `resources\runtime\primary-runtime\dependencies\node\bin\node.exe` 与 `tools\bin\node.exe`；都没有就跳过自检并打印一句，安装本身不受影响
- **没设 `DSH_HOME`**：安装命令后面补 `-DshHome "<你的 dsh 数据目录>"`；桌面版启动时自己会设这个变量
- **没有「每轮自动记错」这类插件**：不影响拦截。那套东西只喂给我自己的判据挖掘脚本（`judge-errors.js` 读它的 state 文件），闸的运行时不读它，缺了就是少一路候选来源
- **不是 Windows**：未验证。`windows-powershell` 那 9 条只对 pwsh 与批处理有意义，`core` 那 2 条判的是参数形态、理论上与平台无关，但没在 Linux / macOS 上跑过——别当成「支持」
- **判据要现场条件的**（比如「改文件前原句还在不在」要看真文件），在别人机器上判不了就记 `未验`，不会记成 `通过`——这是有意的，宁可说不知道

---

## 边界

- 它只报警不纠错：拦下的调用不执行，放行的调用不动。
- 插件自己崩了会放行——闸的代价下限不能是「用不了」。
- 判不了的记「未验」，不记「通过」。

作者 ZQ。许可见 `LICENSE`（GPL-3.0）。
