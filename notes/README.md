# notes/ — 仓库版的「阉割错误库」

这里只放**机器能查的错**。跟本机那套错误库（会把判断类、口径类的经验也收进来）不同，这一层刻意做窄：

| 收 | 不收 |
|---|---|
| 能写成对工具参数断言的错（缺必填键、键名近似、编码漏了、危险命令） | 「应该先想清楚再动手」这类判断 |
| 能给出正反两个用例、可以自测 | 只有描述、跑不起来的 |
| 说得出是哪一次真事 | 「我觉得可能会」 |

## 三条硬门槛

一条候选进来，必须同时满足：

1. `condition` 是一个断言对象（`{"type":"argsMissing","keys":[...]}` 这种），不是一段话
2. `selfTest.cases` 里有一条 `expect: "block"`、一条 `expect: "pass"`
3. `symptom` 写清是哪一次真事

缺任何一条，`notes add` 当场拒收并说明缺什么。

## 一轮怎么用

```bash
# 会话里遇到能机器查的错，攒成一个小 JSON（数组或单条都行），加进来
node weakreferee-cli.js notes add round.json

# 看看现在都攒了什么（按次数倒序）
node weakreferee-cli.js notes list

# 手动改过文件、或从不同机器合过来，先去重
node weakreferee-cli.js notes merge

# 每周一次：出周报，回答「够不够格起草」+ 哪两条像同一条
node weakreferee-cli.js notes report

# 人说「这两条是一回事」，才把它们并成一条
node weakreferee-cli.js notes absorb N-0003 N-0001

# 够 3 次了，起草（不加 --confirm 只打印草案，不落盘）
node weakreferee-cli.js notes promote N-0001 --pack windows-powershell --confirm
```

草案进包是最后一步，手工做，共四处：

1. 把 `drafts/NOTE-XXXX.json` 里的 `rule` 贴进 `packs/<包>/rules.json`
2. 镜像那份 `dsh-judge-gate/rules/<包>/rules.json` 同样贴一份
3. `packs/<包>/pack.json` 的 `rules` 数字加一（不改这个数，`validate` 会报「写的 16、实际 17」）
4. `node tools/gen-manifest.js packs dsh-judge-gate/rules` → `node tools/validate.js` → `node weakreferee-cli.js selftest`

## 一条候选长什么样

```json
{
  "tool": "pwsh",
  "type": "param-missing",
  "title": "pwsh 写了脚本却没给 description",
  "symptom": "2026-11-27 一次批量改文件名，连发三条都被工具回「缺 description」",
  "condition": { "type": "argsMissing", "keys": ["description"] },
  "selfTest": {
    "cases": [
      { "args": { "command": "Get-Date" }, "expect": "block" },
      { "args": { "description": "看当前时间", "command": "Get-Date" }, "expect": "pass" }
    ]
  },
  "session": "session-xxxx"
}
```

## 取舍（别在这儿加回去）

- **不做语义合并**：同工具 + 同类型 + 标题相似度 ≥ 0.8 才算同一条。合并要调模型，一调就不再是「零依赖、谁都能跑」。相似度落在 0.5–0.8 的，周报会列成「看着像同一条」，由人用 `absorb` 并。
- **条件类型不写死**：`notes add` 时会去现有 `packs/*/rules.json` 里取一遍引擎认的类型，写了个引擎不认的（比如想当然的 `argsMissing`）当场拒收，并列出可用类型。
- **不自动进判据包**：`promote` 只产草案到 `drafts/`，并进 `packs/` 是人的动作（四处：两份 rules.json + pack.json 计数 + 三道闸）。
- **够 3 次才许起草**：偶发一次的多半是环境问题，反复出现的才是模型的老毛病。
- **判断类的错不要塞进来**：写成守则 / 文档给人看，比塞进这里当一条永远不会命中的判据有用。

## 运行时产物（不入库）

`notes/candidates.json`（攒下来的候选）与 `drafts/`（起草出来的草案）都是本机产物，`.gitignore` 里已排除；仓库里只留这份说明和 `tools/notes.js`。
