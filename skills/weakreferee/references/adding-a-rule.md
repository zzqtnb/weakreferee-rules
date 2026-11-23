# 加一条判据，或改一条现有的

改判据只有一条正路：**改底稿，重新生成，验证，同步三处副本，重启**。跳过任何一步都会出现「文件看着是新的，闸跑的还是旧的」。

## 五个步骤

### 1. 改底稿

底稿在 `参赛\软件\judges\<ID>.json`（或发行包里的 `judges\<ID>.json`），一条一个文件。

一个条目长这样：

```json
{
  "id": "J8",
  "order": 8,
  "title": "写文本文件漏 -Encoding",
  "doc": { "lines": ["## 写文本文件漏 -Encoding", "", "判什么…"] },
  "rules": [
    {
      "id": "WIN-ENC-01",
      "legacy": "J8",
      "domain": "windows-powershell",
      "pkgOrder": 3,
      "state": "active",
      "when": "pre",
      "appliesTo": { "tool": "pwsh" },
      "condition": { "type": "regexHit", "target": "command", "pattern": "Out-File(?!.*-Encoding)" },
      "action": "block",
      "selfTest": { "cases": [{ "input": { "command": "Out-File a.txt" }, "expect": "block" }] },
      "scene": "一条命令的摘要（会成为「场景例」）"
    }
  ],
  "cases": { "real": [], "abstract": [{ "summary": "…", "from": "…" }] },
  "status": "active"
}
```

要点：

- `id`（条目级）是给人看的编号（`J8`、`P6`、`BAT`）；`rules[].id` 是规则的全名（`WIN-ENC-01`），插件账本里记的是后者，`legacy` 才回落到前者。
- `state`：`active` 真拦、`observing` 只记账不拦（影子期）、没有 `rules` 数组就是 `doc-only`（只写规矩、机器不判）。
- `domain` 决定进哪个包：`core` / `dsh-host` / `windows-powershell`。
- `pkgOrder` 决定它在这个包里的顺序；不写就会按目录扫到的顺序，`judgectl check` 立刻报字节不一致。
- `condition.type` 只支持六种：`regexHit`、`regexMiss`、`fileAnchorMissing`、`fileNewerThanProcessStart`、`cmdAbsPathWritten`、`fileHasBom`。需要新类型就是改引擎，不是改规则。
- `selfTest.cases[].expect` 只认 `block` / `pass`（`block` 的语义是「期望命中」，与规则 `action` 无关）。

### 2. 生成

```powershell
node <工作区>\_tmp\judgectl.js render --write   # 生成 判据库.md 给人看
node <工作区>\_tmp\judgectl.js emit   --write   # 生成 rules\*\rules.json 给机器读
```

生成物落在 `_gen\`，**不直接生效**——这是故意的，防止改一半就影响线上。

### 3. 搬进正式位置

```powershell
Copy-Item _gen\判据库.md $env:USERPROFILE\..\经验库\判据库.md -Force
Copy-Item _gen\rules\* 参赛\软件\rules\ -Recurse -Force
node 参赛\软件\tools\gen-manifest.js 参赛\软件\rules
```

`gen-manifest.js` 重算每个包的条数、字节数与 sha256。**manifest 里的 `generatedAt` 每次都变，比对一致性只能比 `rules.json` 的哈希，不能拿 manifest 比。**

### 4. 验证（缺一步都不算完）

```powershell
node _tmp\judgectl.js check                      # 判据库逐字节 + 三包语义，必须 PASS
node tools\validate.js                           # 两处 rules.json 必须逐字节相同
node dsh-judge-gate\check.cjs --selfcheck        # 装 N 条、展开 M 条、拒装 0
```

`check.cjs --selfcheck` 会顺带跑每条规则的 `selfTest`。拒装不为 0 时，先看它报的是「环境变量未设置」还是「正则编译失败」——前者是路径兜底没配好，后者是规则本身写错了。

### 5. 同步三处副本并重启

判据插件有三份实体副本，**没有软链**：

1. `D:\deepseek\deepseek插件\本地插件\dsh-judge-gate`（开发位置）
2. `%APPDATA%\dsh\profiles\desktop\node_modules\dsh-judge-gate`（DSH 真正加载的那份）
3. 仓库 `weakreferee-rules\dsh-judge-gate`（推送 GitHub 的位置）

三处的 `index.js`、`engine\`、`rules\`、`lib\` 都要一致，改完比一次哈希再重启。**完全退出 DSH 再打开**，托盘也要退。

## 常见错法

| 现象 | 原因 |
|---|---|
| 判据库字节不一致 | 手改过 `判据库.md`，或 `pkgOrder` 缺失导致顺序不同 |
| 规则包两处哈希不同 | 只改了 `packs\`，没改插件里的 `rules\` |
| 装了 14 条却只拦 13 条 | 有一条被 `validateRule` 拒装，多半是 `{环境变量}` 没设也没写默认值 |
| 改了规则闸却不生效 | 宿主进程没重启；判据 P6 会记一条提醒 |
| 账本里一条命中都没有 | 那条还是 `observing`，命中落在结果列「通过」里 |

## 什么时候该把 shadow 转成 active

在**本地账本**上算，不照抄作者机器上的数字：

- 撞上次数 ≥ 10（拦下 + 提示 + 影子期落在「通过」里的都算）
- 误拦率 < 20%（抽 5–10 条原始记录，看说明列写的那次操作到底该不该拦）
- 观察满 7 天

三条都满足才改 `state: "active"`，然后重跑一遍第 2–5 步。转正后冤一次，用户就得重做一轮，所以宁可多观察一周。
