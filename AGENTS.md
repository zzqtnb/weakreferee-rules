# 给 AI 看的安装与验收

这个人把仓库链接丢给你，意思是：按这里写的，在我这台机器上把它跑起来。
本文件只写可执行的事，读完照做，不要改写命令，不要先问一堆问题。

## 先搞清楚这是什么（三句）

1. 它在 AI 调工具之前判一次「这次调用的参数写对没有」：缺必填键、键名写成形近词、写文本文件漏编码、改文件前锚点丢了。
2. 判据是数据，不是代码：`catalog/` 是目录（看有哪些），`packs/` 是挑好的一批（按域整包装），`data/judges-installed.json` 是这台机器上到底装了哪些——**清单空着它就不拦任何东西，这是设计，不是坏了**。
3. 它不判断一件事该不该做（那是策略层），只判断做的时候参数对不对。

## 第 0 步：确认环境（一条）

```bash
node -v
```

- 期望：`v22` 或更高。低于 22 就停下，告诉用户「需要 Node 22 以上」，不要自己装别的版本管理器。

## 第 1 步：不装任何东西，先证明它能判（三条，都在仓库根跑）

```bash
node weakreferee-cli.js selftest
node weakreferee-cli.js check pwsh "command=Out-File a.txt -InputObject 中文"
node weakreferee-cli.js check pwsh "command=Get-ChildItem -Path ."
```

期望，逐条核对，不要只看有没有报错：

| 命令 | 期望退出码 | 输出里应出现 |
|---|---|---|
| `selftest` | 0 | 末行 `自检：全部通过（15 项）` |
| 第 2 条 | **1** | `判定：拦下`，判据编号 `WIN-ENC-01`（写文本文件没带 -Encoding） |
| 第 3 条 | **0** | `判定：通过`，以及 `装载 27 条判据（展开 476 条规则）` |

三条对得上，说明引擎和判据在这台机器上可用；对不上就停，把原始输出贴给用户，别自己改判据。

## 第 2 步：挂上去（两条路，按用户用的宿主选一条）

### 2A：用户用 DSH（Windows）

仓库根执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-judge-gate\install.ps1
```

- 它会打印 `STEP 1` 到 `STEP 8`。**STEP 8 会直接打出下一步该跑的命令**，复制它。
- 若打印 `WARN 跳过 bundle 登记`：让用户手工把 `"dsh-judge-gate"` 加进 `profiles\desktop\package.json` 的 `dsh.profile.bundles` 数组，再继续。
- 装完的插件在 `<DSH_HOME>\profiles\<profile>\node_modules\dsh-judge-gate`。

装判据（**用插件目录里那份工具，不是克隆目录里那份**）：

```bash
node "<上一步的插件目录>\tools\judge-packs.cjs" add core
node "<上一步的插件目录>\tools\judge-packs.cjs" add windows-powershell
```

然后让用户**完全退出 DSH 再打开**（托盘退出，不是关窗口）。不重启，加载的还是旧代码。

### 2B：用户用 Claude Code / Cursor / 其它 MCP 客户端

不装插件，只注册一个 MCP 服务器（零依赖，判定用同一份引擎）：

```bash
claude mcp add weakreferee -- node <仓库绝对路径>/dsh-judge-gate/mcp-server.cjs
```

写 json 的客户端（Cursor 的 `~/.cursor/mcp.json` 等）：

```json
{ "mcpServers": { "weakreferee": { "command": "node", "args": ["<仓库绝对路径>/dsh-judge-gate/mcp-server.cjs"] } } }
```

注册完让它调一次 `judge_packs` 验证：应打出「实际生效 N 条」或「空转」（清单空＝空转，正常）。要继续装判据，用仓库里那份工具：

```bash
node dsh-judge-gate/tools/judge-packs.cjs add core
```

**必须跟用户讲清一条**：MCP 形态没有钩子，管不到客户端自己的工具派发——它只能靠模型在动手前主动调 `judge_check`。所以要让它真起作用，得在客户端的规则文件里加一句「每次调工具前先 judge_check 一次」。强制卡口只有插件形态（2A）才有。

## 第 3 步：验收（三条，缺一条都不算装好）

```bash
node "<插件目录>\tools\judge-packs.cjs"
node "<插件目录>\check.cjs" --selfcheck
node "<插件目录>\check.cjs" web_fetch url=http://example.com
```

| 命令 | 期望 |
|---|---|
| judge-packs（不带参数） | 打出「来源：…node_modules\dsh-judge-gate\data\judges-installed.json」与「实际生效 N 条」，N ≥ 6 |
| selfcheck | exit 0，末两行 `规则包: 装 N 条，展开后 M 条，拒装 0 条` 与 `自检通过` |
| 第 3 条 | 输出里有 `引擎：block [CORE-HTTPS-01:block]` 且 exit 1 |

第三行为什么用它做验收：`CORE-HTTPS-01` 是**规则包**里的判据，只有包真的装上了才会出现在「引擎」那一行。清单空着时它不会出现（那时只剩基础参数判定在拦），所以看的是这行文字，不是退出码。

## 失败怎么办（照顺序，别乱试）

| 现象 | 处理 |
|---|---|
| `selftest` 报 engine 载入失败 | 仓库不完整（多半是只下了一个子目录），让用户删掉重下整个仓库 |
| install.ps1 报 `check.cjs` 找不到 | 用 `-Source` 指到 `dsh-judge-gate` 目录 |
| 装完不拦东西 | 先跑第 3 步第一条：清单里 `实际生效` 是 0，就是判据没写进插件目录那份（克隆目录里装的不算数） |
| 装完重启后第一次工具调用被拦一次 | 正常：判据文件比宿主新时，它先拦一次提醒「改了没重启」，同一 key 第二次放行 |
| 改完配置后行为没变 | 面板/进程需要完全退出，不是关窗口 |

## 不要做

- 不要手改 `data/judges-installed.json` 里的桶号或字节；用 `judge-packs.cjs add/remove`，它才负责展开与校验。
- 不要在克隆目录里 `add` 完就以为装好了：插件读的是自己目录那份清单。
- 不要用 `node --check` 当验收：它只查语法，查不出「用了没声明的变量」——真验收是上面第 3 步喂三条真参数。
- 不要把 `catalog/` 里的条目当成已装：目录是「能装什么」，清单是「装了什么」。

## 判据从哪来（两条路，落点同一份清单）

- 人挑：`node "<插件目录>\tools\judge-packs.cjs" add <包名>`，或看 `catalog/` 单条要。
- 机器挑：`node weakreferee-cli.js mine` 从会话记录里统计形态、出草案，`suggest` 先在自己的历史里回放一遍，命中过的才建议收。

两条路最终都写进同一份 `data/judges-installed.json`。
