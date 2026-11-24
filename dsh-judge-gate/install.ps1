<#
  dsh-judge-gate 安装 / 卸载。

  用法（在 cmd 里逐行跑）：
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Uninstall

  可选参数：
    -DshHome <路径>   默认读环境变量 DSH_HOME（桌面版自己会设）
    -Profile <名字>   默认 desktop
    -DryRun           只打印要做的事，不落盘

  它做三件事：把插件复制进 <profile>\node_modules\dsh-judge-gate；
  在 profile 的 package.json 里登记一条依赖与一个 bundle（改前先备份）；
  用自带的 check.cjs --selfcheck 验零件齐不齐。不需要 pnpm，不需要联网。
#>
[CmdletBinding()]
param(
  [string]$DshHome = $env:DSH_HOME,
  [string]$Profile = $env:DSH_PROFILE,
  [string]$Source = '',
  [switch]$Uninstall,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Pkg = 'dsh-judge-gate'
$Bundled = @('index.js', 'check.cjs', 'package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE', 'install.ps1', 'tools', 'lib', 'engine', 'rules')

function Write-Step([string]$n, [string]$m) { Write-Host ("STEP {0} {1}" -f $n, $m) }

if (-not $Profile) { $Profile = 'desktop' }

# 脚本自己所在的目录：-File 与 & 调用下 $PSScriptRoot 表现不一致，三条路依次认
if (-not $Source) {
  $cands = @($PSScriptRoot)
  if ($PSCommandPath) { $cands += (Split-Path -Parent $PSCommandPath) }
  if ($MyInvocation.MyCommand.Path) { $cands += (Split-Path -Parent $MyInvocation.MyCommand.Path) }
  foreach ($c in $cands) {
    if ($c -and (Test-Path -LiteralPath (Join-Path $c 'check.cjs'))) { $Source = $c; break }
  }
  if (-not $Source) { foreach ($c in $cands) { if ($c) { $Source = $c; break } } }
}
if (-not $Source) { throw '定位不到安装目录，请显式给 -Source "插件目录"。' }

if (-not $DshHome) {
  throw '找不到 DSH_HOME：先设环境变量，或显式给 -DshHome "<你的 dsh 家目录，通常形如 %APPDATA%\dsh>"。'
}

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$pjPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $pjPath)) {
  throw "这个 profile 里没有 package.json：$pjPath（用 -DshHome / -Profile 指到对的地方）"
}
$nmDir = Join-Path $profileDir 'node_modules'
$target = Join-Path $nmDir $Pkg
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
Write-Step 1 "profile = $profileDir"

# ── package.json：行级插 / 删，其余格式一字不动 ────────────────────────
$raw = [IO.File]::ReadAllText($pjPath, [Text.Encoding]::UTF8)
$nl = if ($raw -match "`r`n") { "`r`n" } else { "`n" }
$lines = [Collections.Generic.List[string]]($raw -split "`r?`n")

function Save-Json([Collections.Generic.List[string]]$ls, [string]$path) {
  $text = ($ls -join $nl)
  $null = $text | ConvertFrom-Json          # 写回前先让解析器过一遍：坏 json 就地炸，不留半死的 profile
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
}

# 按括号计数找某个键的取值范围（本文件是简单配置，不计字符串里的括号）
function Find-JsonBlock([Collections.Generic.List[string]]$ls, [string]$key) {
  for ($i = 0; $i -lt $ls.Count; $i++) {
    if ($ls[$i] -match ('^\s*"' + [regex]::Escape($key) + '"\s*:\s*([\{\[])(.*)$')) {
      $open = $Matches[1]
      $close = if ($open -eq '{') { '}' } else { ']' }
      $depth = 0
      $text = ''
      for ($j = $i; $j -lt $ls.Count; $j++) {
        $line = $ls[$j]
        if ($j -eq $i) { $line = $line.Substring($line.IndexOf($open)) }
        foreach ($ch in $line.ToCharArray()) {
          if ($ch -eq $open) { $depth++ }
          elseif ($ch -eq $close) { $depth-- }
        }
        $text += $line
        if ($depth -le 0) { return @{ start = $i; end = $j; open = $open; close = $close; text = $text } }
      }
      return $null
    }
  }
  return $null
}

function Insert-BlockEntry([Collections.Generic.List[string]]$ls, $blk, [string]$entry) {
  $ind = ($ls[$blk.start] -replace '^(\s*).*', '$1')
  if ($blk.start -eq $blk.end) {
    # 一行写完的空块，例如 "bundles": []   —— 展开成多行再放条目
    $line = $ls[$blk.start]
    $iOpen = $line.IndexOf($blk.open)
    $iClose = $line.LastIndexOf($blk.close)
    $head = $line.Substring(0, $iOpen + 1)
    $inner = ''
    if ($iClose -gt $iOpen + 1) { $inner = $line.Substring($iOpen + 1, $iClose - $iOpen - 1) }
    $tail = $line.Substring($iClose + 1)
    $new = New-Object Collections.Generic.List[string]
    $new.Add($head)
    $new.Add($ind + '  ' + $entry)
    foreach ($e in ($inner -split ',')) {
      if ($e.Trim()) { $new.Add($ind + '  ' + $e.Trim()) }
    }
    # 最后一项不带逗号
    $last = $new[$new.Count - 1]
    $new[$new.Count - 1] = ($last -replace ',\s*$', '')
    $new.Add($ind + $blk.close + $tail)
    $ls.RemoveAt($blk.start)
    $ls.InsertRange($blk.start, [string[]]$new)
    return $true
  }
  $ind2 = $ind + '  '
  if ($blk.start + 1 -lt $ls.Count -and $ls[$blk.start + 1] -match '^(\s*)\S') { $ind2 = $Matches[1] }
  $ls.Insert($blk.start + 1, $ind2 + $entry + ',')
  return $true
}

# 单行 JSON 的兜底：在整段文本里按「键: {…}」就地插一条
function Add-InlineEntry([Collections.Generic.List[string]]$ls, [string]$key, [string]$entry) {
  $text = ($ls -join $nl)
  $pat = '"' + [regex]::Escape($key) + '"\s*:\s*([\{\[])([^\{\}\[\]]*)([\}\]])'
  $m = [regex]::Match($text, $pat)
  if (-not $m.Success) { return $false }
  $inner = $m.Groups[2].Value.Trim()
  if ($inner) { $inner = $inner + ', ' + $entry } else { $inner = $entry }
  $block = '"' + $key + '": ' + $m.Groups[1].Value + ' ' + $inner + ' ' + $m.Groups[3].Value
  $newText = $text.Substring(0, $m.Index) + $block + $text.Substring($m.Index + $m.Length)
  $ls.Clear()
  $ls.AddRange([string[]]($newText -split "`r?`n"))
  return $true
}

if ($Uninstall) {
  Write-Step 2 "卸载目标 $target"
  if ($DryRun) {
    Write-Step 3 '干跑：会删目录，并删掉 package.json 里的依赖行与 bundles 行'
    Write-Step 4 '干跑结束，什么都没改'
    return
  }
  $bak = "$pjPath.bak-judge-gate-$ts"
  Copy-Item -LiteralPath $pjPath -Destination $bak -Force
  Write-Step 3 "备份 $bak"
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Step 4 '目录已删'
  } else {
    Write-Step 4 '目录本来就不在'
  }
  $n = 0
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -match ('^\s*"' + $Pkg + '"\s*:')) { $lines.RemoveAt($i); $n++; continue }
    if ($lines[$i] -match ('^\s*"' + $Pkg + '"\s*,?\s*$')) { $lines.RemoveAt($i); $n++; continue }
    if ($lines[$i] -match ('^(\s*)"[^"]+"\s*:\s*\[' + [regex]::Escape('"' + $Pkg + '"') + '\s*\]\s*,?\s*$')) {
      $lines[$i] = $Matches[1] + '"bundles": []'
      $n++
      continue
    }
  }
  # 行级没清干净的（单行 JSON 之类）走文本级清理，再修掉可能剩下的逗号
  $txt = ($lines -join $nl)
  if ($txt -match [regex]::Escape('"' + $Pkg + '"')) {
    $txt = [regex]::Replace($txt, '(\r?\n)?[ \t]*"' + $Pkg + '"\s*:\s*"[^"]*"\s*,?', '')
    $txt = [regex]::Replace($txt, '(\r?\n)?[ \t]*"' + $Pkg + '"\s*,?', '')
  }
  $txt = [regex]::Replace($txt, ',\s*([\}\]])', '$1')
  $lines.Clear()
  $lines.AddRange([string[]]($txt -split "`r?`n"))
  Save-Json $lines $pjPath
  Write-Step 5 "package.json 已改，删掉 $n 行 / 文本级残留一并清理（备份可回滚）"
  Write-Step 6 '完全退出 DSH（含托盘）再打开，就不再加载本插件'
  return
}

# ── 安装 ────────────────────────────────────────────────────────────────
foreach ($item in $Bundled) {
  $fp = Join-Path $Source $item
  if (-not (Test-Path -LiteralPath $fp)) { throw "安装源不全，缺 $item（在 $Source 下）" }
}
$fileSpec = (Resolve-Path -LiteralPath $Source).Path -replace '\\', '/'
Write-Step 2 "源 $Source"

if ($DryRun) {
  Write-Step 3 "干跑：会复制 $($Bundled.Count) 项到 $target，并在 package.json 里登记依赖与 bundle"
  Write-Step 4 '干跑结束，什么都没改'
  return
}

$bak = "$pjPath.bak-judge-gate-$ts"
Copy-Item -LiteralPath $pjPath -Destination $bak -Force
Write-Step 3 "备份 $bak"

New-Item -ItemType Directory -Force -Path $nmDir | Out-Null
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $target | Out-Null
foreach ($item in $Bundled) {
  Copy-Item -LiteralPath (Join-Path $Source $item) -Destination $target -Recurse -Force
}
Write-Step 4 "已复制到 $target"

# ── 判据清单的落点 ──────────────────────────────────────────────────
# 判据清单必须落在插件目录这一份里才算数：插件读的是自己的 data\judges-installed.json，
# 在克隆目录里装判据只会写进克隆目录那份，插件看不到。
New-Item -ItemType Directory -Force -Path (Join-Path $target 'data') | Out-Null
$srcList = Join-Path (Join-Path $Source 'data') 'judges-installed.json'
if (Test-Path -LiteralPath $srcList) {
  Copy-Item -LiteralPath $srcList -Destination (Join-Path $target 'data\judges-installed.json') -Force
  Write-Step 4 '已把源目录的判据清单抄进插件目录（data\judges-installed.json）'
}

# 依赖
$dep = Find-JsonBlock $lines 'dependencies'
$depEntry = '"' + $Pkg + '": "file:' + $fileSpec + '"'
if ($null -eq $dep) {
  if (Add-InlineEntry $lines 'dependencies' $depEntry) { Write-Step 5 '依赖已登记（单行 JSON）' }
  else { Write-Host 'WARN package.json 里没有 dependencies 块，跳过依赖登记（插件目录已就位，仍能加载）' }
} elseif ($dep.text -match [regex]::Escape('"' + $Pkg + '"')) {
  Write-Step 5 '依赖已存在，不动'
} else {
  $null = Insert-BlockEntry $lines $dep $depEntry
  Write-Step 5 "依赖已登记 file:$fileSpec"
}

# bundles
$bun = Find-JsonBlock $lines 'bundles'
if ($null -eq $bun) {
  if (Add-InlineEntry $lines 'bundles' ('"' + $Pkg + '"')) { Write-Step 6 'bundle 已登记（单行 JSON）' }
    Write-Host 'WARN package.json 里没有 dsh.profile.bundles 块，bundle 没登记（插件不会自动加载）。下一步：打开 profile 的 package.json，手工把 "dsh-judge-gate" 加进 dsh.profile.bundles 数组'
} elseif ($bun.text -match [regex]::Escape('"' + $Pkg + '"')) {
  Write-Step 6 'bundle 已存在，不动'
} else {
  $null = Insert-BlockEntry $lines $bun ('"' + $Pkg + '"')
  Write-Step 6 'bundle 已登记'
}

Save-Json $lines $pjPath
$chk = [IO.File]::ReadAllText($pjPath, [Text.Encoding]::UTF8)
if (($chk -match [regex]::Escape('"' + $Pkg + '"')) -eq $false) { throw 'package.json 写回后找不到插件名，已中止' }

# ── 自检 ────────────────────────────────────────────────────────────────
function Find-NodeExe() {
  if ($env:DSH_NODE -and (Test-Path -LiteralPath $env:DSH_NODE)) { return $env:DSH_NODE }
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $rel = @(
    'resources\runtime\primary-runtime\dependencies\node\bin\node.exe',
    'runtime\primary-runtime\dependencies\node\bin\node.exe',
    'tools\bin\node.exe'
  )
  $parent = Split-Path -Parent $DshHome
  $grand = Split-Path -Parent $parent
  $roots = @($DshHome)
  if ($parent) { $roots += $parent }
  if ($grand -and (Test-Path -LiteralPath $grand)) {
    $roots += $grand
    $roots += (Get-ChildItem -LiteralPath $grand -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  }
  foreach ($r in $roots) {
    foreach ($x in $rel) {
      $fp = Join-Path $r $x
      if (Test-Path -LiteralPath $fp) { return $fp }
    }
  }
  return $null
}

$node = Find-NodeExe
if (-not $node) {
  Write-Step 7 '没找到 node，跳过自检（不影响安装）。有 node 后手动跑：node "<插件目录>\check.cjs" --selfcheck'
} else {
  Write-Step 7 "自检（$node）"
  & $node (Join-Path $target 'check.cjs') --selfcheck
  if ($LASTEXITCODE -ne 0) {
    throw "自检没过，安装不完整。package.json 备份在 $bak，删掉 $target 即可回滚。"
  }
}

Write-Step 8 '装好了。完全退出 DSH（含托盘）再打开，闸就挂上了。'

Write-Host '装判据要用插件目录里那份工具（写进插件自己的清单才算数，写进克隆目录的不算）：'
if ($node) { Write-Host ('  "{0}" "{1}" add core' -f $node, (Join-Path $target 'tools\judge-packs.cjs')) }
Write-Host '  装完再完全退出 DSH 重开一次，判据才生效'
Write-Host ''
Write-Host '验一句（这条会被拦）：'
if ($node) { Write-Host ('  "{0}" "{1}" pwsh "command=Out-File D:\a.ps1 -InputObject 中文"' -f $node, (Join-Path $target 'check.cjs')) } else { Write-Host ('  找到 node 后跑：node "{0}" pwsh "command=Out-File D:\a.ps1 -InputObject 中文"' -f (Join-Path $target 'check.cjs')) }
Write-Host '卸载：同一条命令加 -Uninstall'
