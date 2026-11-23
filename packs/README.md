# packs/ — 机器读的规则包

判据库（`catalog/`）是给人挑的目录，这里是给引擎吃的配方。装插件时读的就是这一层。

## 目录

```
packs/
├── manifest.json              每个包的文件数、字节数、sha256（工具生成，别手改）
├── core/                      core/pack.json + core/rules.json
├── dsh-host/
├── windows-powershell/
└── community/                 社区贡献的包（可以不建，没有就是空的）
    └── <作者>/<域>/           整包：pack.json + rules.json + README.md
```

三个内置包分别管：**core** 跨环境的通用约束（2 条）、**dsh-host** DSH 桌面版自身特性（3 条）、**windows-powershell** Windows + PowerShell 的坑（9 条）。合计 14 条手写规则，带契约表展开后 464 条。

## 一个包两个文件

- `pack.json`：包的身份（`name`/`kind`/`version`/`rules` 条数/`ruleIds`/适用环境）
- `rules.json`：规则数组，每条含 `id`/`title`/`when`/`appliesTo`/`condition`/`action`/`selfTest`

条件类型与字段定义见 `schema/`。写新规则看 `CONTRIBUTING.md` 的四道关和 `docs/怎么写一条规矩.md`。

## 同一份规则存了两处

`packs/<域>/rules.json` 与 `dsh-judge-gate/rules/<域>/rules.json` **必须逐字节相同**：

- `packs/` 这份给便携包和外部使用者
- `dsh-judge-gate/rules/` 这份给装进 DSH 的插件

`node tools/validate.js` 会比对两边的 sha256 与字节数，不一致直接报错。改规则时两边一起改，`manifest.json` 用 `node tools/gen-manifest.js` 重算。

## 社区包

放在 `packs/community/<作者>/<域>/`，整包提交，附一段 README 写清：

- 适用什么模型 / 系统 / 宿主
- 证据是怎么来的（多少次调用、几个会话、什么时间范围）
- 什么情况下**不该**装

社区包不并进顶层三个包，是为了让「跟随版本维护的」和「社区自己维护的」分得开。谁写谁负责，出问题找作者。
