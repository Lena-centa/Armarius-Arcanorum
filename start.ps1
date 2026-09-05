# Workflow DB 启动/初始化脚本(Windows PowerShell)— 单一入口
# 用法:
#   .\start.ps1          默认(同 start):依赖检查,缺失项自动初始化补齐(幂等)后前台启动
#   .\start.ps1 setup    显式全量初始化:环境预检→venv→npm install→.env→自检(已装好则各步跳过)
#   .\start.ps1 check    环境检查(必须依赖缺失则失败,可选依赖仅警告;不安装不修复)
#   .\start.ps1 start    依赖检查(失败自动补齐)后前台启动 NestJS Gateway(:8009),日志实时输出,Ctrl+C 停止;
#                                  可选依赖检查(ComfyUI 可达性等)异步执行,结果稍后打印,不阻塞启动;
#                                  网关就绪后自动用默认浏览器打开工具页(WORKFLOW_DB_AUTO_OPEN=0 关闭)
#   .\start.ps1 stop     停止后台网关(如存在)
#   .\start.ps1 logs     查看历史运行日志(win_run.log)
#   .\start.ps1 optional-check   内部命令:仅执行可选依赖检查(供 start 后台子进程调用)
#   .\start.ps1 open-browser     内部命令:等待网关就绪后用默认浏览器打开工具页(供 start 后台子进程调用)
# 配置来源:用户数据目录 .env(缺失时 setup/网关首启自动生成;参见 .env.example)

param(
    [Parameter(Position = 0)]
    [ValidateSet('setup', 'check', 'start', 'stop', 'logs', 'optional-check', 'open-browser', 'help')]
    [string]$Command = 'start'
)


[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8


$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $RepoRoot) { $RepoRoot = $PSScriptRoot }
if (-not $RepoRoot) { $RepoRoot = (Get-Location).Path }
Set-Location $RepoRoot

# 确保 Python 模块查找能定位到 RepoRoot (供 worker 与自检使用)
if ($env:PYTHONPATH) {
    if (-not ($env:PYTHONPATH -split ';' -contains $RepoRoot)) {
        $env:PYTHONPATH = "$RepoRoot;$env:PYTHONPATH"
    }
} else {
    $env:PYTHONPATH = $RepoRoot
}

$NestDist = Join-Path $RepoRoot 'nest_gateway\dist\main.js'
$NestNodeModules = Join-Path $RepoRoot 'nest_gateway\node_modules'
# runtime venv 自愈:pyvenv.cfg 的 home 指向构建机路径,发布包已脱敏,
# 跨机部署后 venv python 会报 "No Python at ..."。检测到不可用即用包内
# python312 现场重建(离线可行:venv 创建/ensurepip 用内置组件),已装包
# 从旧 site-packages 迁入,新 pyvenv.cfg 自动指向部署位置的 python312。
function Repair-PkgVenv {
    param([string]$VenvRoot, [string]$BasePy)
    try {
        $baseExe = Join-Path $BasePy 'python.exe'
        if (-not (Test-Path -LiteralPath $baseExe -PathType Leaf)) { return $false }
        $venvPy = Join-Path $VenvRoot 'Scripts\python.exe'
        $sitePkgs = Join-Path $VenvRoot 'Lib\site-packages'
        $saved = Join-Path $env:TEMP ("wfdb-site-packages-" + [guid]::NewGuid().ToString('N'))
        if (Test-Path -LiteralPath $sitePkgs -PathType Container) {
            Move-Item -LiteralPath $sitePkgs -Destination $saved -Force
        }
        Remove-Item -LiteralPath $VenvRoot -Recurse -Force -ErrorAction SilentlyContinue
        # 2>&1 合并重定向:PS 5.1 的 EAP=Stop 下原生程序写 stderr 会抛
        # NativeCommandError(2>$null 抑制不住),管道消费则安全
        & $baseExe -m venv $VenvRoot 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPy -PathType Leaf)) {
            # 重建失败:尽力恢复原状,避免已装包丢失
            if (Test-Path -LiteralPath $saved -PathType Container) {
                New-Item -ItemType Directory -Path $sitePkgs -Force | Out-Null
                Move-Item -LiteralPath $saved -Destination $sitePkgs -Force
            }
            return $false
        }
        # 用旧 site-packages 整体替换新建的(旧含已装依赖,新只有 pip)
        if (Test-Path -LiteralPath $saved -PathType Container) {
            Remove-Item -LiteralPath $sitePkgs -Recurse -Force -ErrorAction SilentlyContinue
            Move-Item -LiteralPath $saved -Destination $sitePkgs -Force
        }
        return $true
    } catch {
        return $false
    }
}

# Python worker venv 选择块已移至文件尾(函数定义之后、switch 派发之前):
# PowerShell 顶层代码顺序执行,块内调用的 stamp/repair 函数须先行定义。
$StdoutLog = Join-Path $RepoRoot 'win_run.log'
$StderrLog = Join-Path $RepoRoot 'win_run_err.log'
# 便携 node 自动安装配置(setup 缺 node 时触发;与 deploy.ps1 目录约定一致)
$NodeVersion = if ($env:NODE_VERSION) { $env:NODE_VERSION } else { 'v22.23.2' }
$NodeDistMirror = if ($env:NODE_DIST_MIRROR) { $env:NODE_DIST_MIRROR } else { 'https://registry.npmmirror.com/-/binary/node' }
$PortableNodeDir = Join-Path $env:LOCALAPPDATA 'node22'
$PortableNodeBin = Join-Path $PortableNodeDir 'node.exe'
$EnvProvidedBeforeLoad = @{}
$EnvLoadedByScript = @{}
Get-ChildItem Env: | ForEach-Object { $EnvProvidedBeforeLoad[$_.Name] = $true }

function Print-Context {
    Write-Host "Workflow DB context:"
    Write-Host "  repo root:      $RepoRoot"
    Write-Host "  gateway dist:   $NestDist"
    Write-Host "  python worker:  $VenPy"
    Write-Host "  mongodb uri:    $(if ($env:MONGODB_URI) { $env:MONGODB_URI } else { 'mongodb://127.0.0.1:27017' })"
    Write-Host "  scan root:      $(if ($env:COMFY_SCAN_ROOT) { $env:COMFY_SCAN_ROOT } else { '<empty>' })"
    Write-Host "  comfyui base:   $(if ($env:COMFYUI_BASE_URL) { $env:COMFYUI_BASE_URL } else { 'http://127.0.0.1:8188' })"
}

# 从数据目录 .env 读取 KEY=VALUE(不覆盖已存在的进程环境变量)。
# 可选 .env.windows 先加载,其中的值优先于共享 .env。
function Resolve-DataDir {
    # 用户数据目录解析(与 nest_gateway/src/config/data-dir.ts 对齐):
    # ARMARIUS_DATA_DIR / WORKFLOW_DATA_DIR(绝对路径,/mnt 形式归一化)优先;
    # 默认优先 %LOCALAPPDATA%\armarius_arcanorum(旧目录 %LOCALAPPDATA%\workflow_db 存在时平滑回退/兼容)。
    $envVal = if ($env:ARMARIUS_DATA_DIR) { $env:ARMARIUS_DATA_DIR } elseif ($env:WORKFLOW_DATA_DIR) { $env:WORKFLOW_DATA_DIR } else { '' }
    $configured = Convert-ConfiguredPath $envVal
    if ($configured -and [System.IO.Path]::IsPathRooted($configured)) { return $configured }
    $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
    $newDir = Join-Path $base 'armarius_arcanorum'
    $legacyDir = Join-Path $base 'workflow_db'
    if (Test-Path -LiteralPath $newDir) { return $newDir }
    if (Test-Path -LiteralPath $legacyDir) { return $legacyDir }
    return $newDir
}

# ---- 启动探测 stamp 缓存 ----
# node ABI 探测与 venv 可用性探测每轮冷启动都要 spawn 子进程(数百 ms);
# 结论以 key=value 落在数据目录 startup-stamps.txt,下次启动校验关键二进制
# 指纹(mtime+size,零子进程开销)一致即直接复用;任一失配走全量探测并回写。
# 只缓存"纯探测"结论:venv import、SQLite quick_check 等真实门禁检查不受
# 影响,每轮照跑。Save 做合并写入,node 与 venv 两处 stamp 互不覆盖。
function Get-StartupStampMap {
    $map = @{}
    $file = Join-Path (Resolve-DataDir) 'startup-stamps.txt'
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        foreach ($line in (Get-Content -LiteralPath $file)) {
            $t = $line.Trim()
            $eq = $t.IndexOf('=')
            if ($eq -ge 1) { $map[$t.Substring(0, $eq)] = $t.Substring($eq + 1) }
        }
    }
    return $map
}

function Save-StartupStamp {
    param([hashtable]$Entries)
    try {
        $dir = Resolve-DataDir
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $merged = Get-StartupStampMap
        foreach ($key in $Entries.Keys) { $merged[$key] = $Entries[$key] }
        $lines = foreach ($key in ($merged.Keys | Sort-Object)) { '{0}={1}' -f $key, $merged[$key] }
        Set-Content -Path (Join-Path $dir 'startup-stamps.txt') -Value $lines -Encoding UTF8
    } catch { }
}

# 二进制指纹:mtime(UTC ticks)+大小;node/python 升级、重装、venv 重建都会改变其中之一
function Get-BinFingerprint {
    param([string]$Path)
    if (-not $Path) { return $null }
    $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $item) { return $null }
    return '{0}:{1}' -f $item.LastWriteTimeUtc.Ticks, $item.Length
}

function Load-EnvFile {
    param([string]$EnvFile)
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { return }
    Get-Content -LiteralPath $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { return }
        $key = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim()
        if ($value.Length -ge 2 -and
            (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or
             ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        if ($key -match '^[A-Za-z_][A-Za-z0-9_]*$' -and
            -not $EnvProvidedBeforeLoad.ContainsKey($key) -and
            -not $EnvLoadedByScript.ContainsKey($key)) {
            [Environment]::SetEnvironmentVariable($key, $value, 'Process')
            $EnvLoadedByScript[$key] = $true
        }
    }
}

function Convert-ConfiguredPath {
    param([string]$Value)
    if ($null -eq $Value) { return $Value }
    $trimmed = $Value.Trim()
    $match = [regex]::Match($trimmed, '^/mnt/([A-Za-z])/(.*)$')
    if (-not $match.Success) { return $trimmed }
    $drive = $match.Groups[1].Value.ToUpperInvariant()
    $tail = $match.Groups[2].Value.Replace('/', '\')
    return '{0}:\{1}' -f $drive, $tail
}

function Normalize-ConfiguredPaths {
    foreach ($key in @(
        'COMFY_SCAN_ROOT', 'COMFY_OUTPUT_DIR', 'SQLITE_DB_PATH',
        'WORKFLOW_DB_BACKUP_DIR', 'WORKFLOW_DB_ROOT', 'WORKER_CWD',
        'WORKER_PYTHON_BIN'
    )) {
        $value = [Environment]::GetEnvironmentVariable($key, 'Process')
        if (-not $value) { continue }
        $normalized = Convert-ConfiguredPath $value
        if ($key -eq 'WORKER_PYTHON_BIN' -and
            $normalized -match '[\\/]venv[\\/]bin[\\/]python(?:\.exe)?$') {
            $candidates = @(
                (Join-Path $RepoRoot 'runtime\venv\Scripts\python.exe'),
                (Join-Path $RepoRoot 'venv\Scripts\python.exe')
            )
            $replacement = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
            if ($replacement) { $normalized = $replacement }
        }
        [Environment]::SetEnvironmentVariable($key, $normalized, 'Process')
    }
}

function Load-Env {
    $dataDir = Resolve-DataDir
    Load-EnvFile (Join-Path $dataDir '.env.windows')
    Load-EnvFile (Join-Path $dataDir '.env')
    Normalize-ConfiguredPaths
}

# TCP 可达性检查(TCP connect 成功即视为可用,不做鉴权验证)
function Test-MongoDb {
    param([string]$Uri)
    $match = [regex]::Match($Uri, '^mongodb(?:\+srv)?://(?:[^@]*@)?([^/:\s]+)(?::(\d+))?')
    if (-not $match.Success) { return $false }
    $hostName = $match.Groups[1].Value
    $port = if ($match.Groups[2].Success) { [int]$match.Groups[2].Value } else { 27017 }
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $tcp.BeginConnect($hostName, $port, $null, $null)
        if ($async.AsyncWaitHandle.WaitOne(3000) -and $tcp.Connected) { return $true }
        return $false
    } catch {
        return $false
    } finally {
        $tcp.Close()
    }
}

# SQLite 主库健康检查(打开 + PRAGMA quick_check)。
# Node 与 better-sqlite3 必须使用同一 ABI;发布包内 Node 22 与 PATH Node
# 可能同时存在,因此 Resolve-NodeBin 会实际探测哪个 Node 能加载当前模块。
function Test-Sqlite {
    param([string]$DbPath)
    $bs3 = Join-Path $PSScriptRoot 'nest_gateway\node_modules\better-sqlite3'
    if (-not (Test-Path (Join-Path $bs3 'package.json'))) { return $false }
    $nodeBin = Resolve-NodeBin
    if (-not $nodeBin) { return $false }
    $js = @'
const Database = require(process.argv[2]);
const db = new Database(process.argv[3], { readonly: true });
// 大库(>1GB)完整 quick_check 可能耗时数分钟阻塞启动,降为 quick_check(1)
// (仅顶层页面,秒级);小库仍做完整校验
const big = db.pragma("page_count", { simple: true }) * db.pragma("page_size", { simple: true }) > 1e9;
const row = db.prepare(big ? "PRAGMA quick_check(1)" : "PRAGMA quick_check").get();
db.close();
process.exit(row && row.quick_check === "ok" ? 0 : 1);
'@
    $tmp = Join-Path $env:TEMP "bs3-check-$([guid]::NewGuid().ToString('N')).js"
    Set-Content -Path $tmp -Value $js -Encoding UTF8
    try {
        & $nodeBin $tmp $bs3 $DbPath 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
}

# 探测某 node 能否加载当前 better-sqlite3;成功时 stdout 顺带输出该 node 的
# 版本号 —— 与"node --version"合并为一次子进程调用,消除原先的双重 spawn。
# 用临时 .js 文件执行(而非 -e):PS 5.1 调用原生命令会剥离 -e 参数内嵌的
# 双引号,导致 new D(":memory:") 变成 SyntaxError,探测恒失败。
function Probe-BetterSqlite3 {
    param([string]$NodeBin, [string]$Bs3)
    $js = 'const D = require(process.argv[2]); const db = new D(":memory:"); db.close(); console.log(process.version);'
    $tmp = Join-Path $env:TEMP "bs3-probe-$([guid]::NewGuid().ToString('N')).js"
    Set-Content -Path $tmp -Value $js -Encoding UTF8
    try {
        $out = & $NodeBin $tmp $Bs3 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return [string](@($out)[0])
    } catch {
        return $null
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
}

function Test-BetterSqlite3Load {
    param([string]$NodeBin, [string]$Bs3)
    return $null -ne (Probe-BetterSqlite3 $NodeBin $Bs3)
}

# 解析能加载当前 better-sqlite3 的 node 可执行文件。
# 适配策略(sqlite 依赖 node ABI):先探测候选 node 能否加载现有预编译
# (dist 版优先,不拉网络);全部不匹配时用默认 node 重新拉取与当前 ABI
# 匹配的预编译(npm rebuild → prebuild-install 自动下载对应 ABI 预编译),
# 拉取后回探;仍失败则返回默认 node 交由自检报错。
# 热路径:startup stamp 记录的上次探测结果经二进制指纹(node.exe 与
# better_sqlite3.node 均未变)校验通过时,免去本轮全部探测 spawn。
function Resolve-NodeBin {
    if ($script:ResolvedNodeBin) { return $script:ResolvedNodeBin }
    $bs3 = Join-Path $PSScriptRoot 'nest_gateway\node_modules\better-sqlite3'
    # stamp 复用:路径存在 + node 与原生模块两处指纹均未变才放行。
    # 返回值保持原展示形态('node'/绝对路径),供来源显示与启动命令使用
    $stamp = Get-StartupStampMap
    if ($stamp['node_bin'] -and $stamp['node_form'] -and (Test-Path -LiteralPath $stamp['node_bin'] -PathType Leaf)) {
        if ($stamp['node_fp'] -eq (Get-BinFingerprint $stamp['node_bin']) -and
            $stamp['bs3_fp'] -eq (Get-BinFingerprint (Join-Path $bs3 'build\Release\better_sqlite3.node'))) {
            $script:ResolvedNodeBin = if ($stamp['node_form'] -eq 'node') { 'node' } else { $stamp['node_bin'] }
            $script:ResolvedNodeVer = $stamp['node_ver']
            return $script:ResolvedNodeBin
        }
    }
    $candidates = @()
    if (Get-Command node -ErrorAction SilentlyContinue) { $candidates += 'node' }
    $runtime = Join-Path $RepoRoot 'runtime\node22\node.exe'
    if (Test-Path -LiteralPath $runtime -PathType Leaf) { $candidates += $runtime }
    $portable = Join-Path $env:LOCALAPPDATA 'node22\node.exe'
    if (Test-Path -LiteralPath $portable -PathType Leaf) { $candidates += $portable }

    if (Test-Path -LiteralPath (Join-Path $bs3 'package.json') -PathType Leaf) {
        foreach ($candidate in $candidates) {
            $ver = Probe-BetterSqlite3 $candidate $bs3
            if ($null -ne $ver) {
                Set-ResolvedNode -Candidate $candidate -Version $ver
                return $script:ResolvedNodeBin
            }
        }
        # 现有预编译与所有候选 node 的 ABI 都不匹配 → 用默认 node 重新拉取匹配预编译
        if ($candidates.Count -gt 0) {
            $def = $candidates[0]
            Write-Host "  INFO: better-sqlite3 与默认 node($def) ABI 不匹配,重新拉取匹配预编译..." -ForegroundColor Yellow
            Push-Location (Join-Path $PSScriptRoot 'nest_gateway')
            try {
                if ($def -eq 'node') {
                    & npm rebuild better-sqlite3 2>&1 | Out-Null
                } else {
                    $npmCli = Join-Path (Split-Path $def -Parent) 'node_modules\npm\bin\npm-cli.js'
                    if (Test-Path $npmCli) { & $def $npmCli rebuild better-sqlite3 2>&1 | Out-Null }
                    else { & npm rebuild better-sqlite3 2>&1 | Out-Null }
                }
            } catch { }
            Pop-Location
            # 回探:拉取后能否加载
            $ver = Probe-BetterSqlite3 $def $bs3
            if ($null -ne $ver) {
                Set-ResolvedNode -Candidate $def -Version $ver
                return $script:ResolvedNodeBin
            }
            Write-Host "  FAIL: 拉取匹配预编译后仍无法加载 better-sqlite3(可能无对应 prebuild,或需 VS Build Tools 本地编译)" -ForegroundColor Red
            Set-ResolvedNode -Candidate $def -Version $null
            return $script:ResolvedNodeBin
        }
    }
    if ($candidates.Count -gt 0) {
        Set-ResolvedNode -Candidate $candidates[0] -Version $null
        return $script:ResolvedNodeBin
    }
    return $null
}

# 统一登记探测结果:脚本级缓存(本进程内免重探)+ 探测成功时写 startup
# stamp 供下轮冷启动免探测。$Candidate 保持原展示形态('node'/绝对路径,
# Invoke-DependencyCheck 据此显示来源);$Abs 为指纹用的绝对路径。
# 版本号为空(未真正完成 ABI 校验的兜底分支)不写 stamp,避免缓存未验证结论。
function Set-ResolvedNode {
    param([string]$Candidate, [string]$Version)
    $script:ResolvedNodeBin = $Candidate
    $script:ResolvedNodeVer = $Version
    if (-not $Version) { return }
    $abs = $Candidate
    if ($Candidate -eq 'node') {
        $src = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $src) { return }
        $abs = $src
    }
    Save-StartupStamp @{
        node_bin = $abs
        node_form = $Candidate
        node_fp = (Get-BinFingerprint $abs)
        node_ver = $Version
        bs3_fp = (Get-BinFingerprint (Join-Path $PSScriptRoot 'nest_gateway\node_modules\better-sqlite3\build\Release\better_sqlite3.node'))
    }
}

# 任意 HTTP 响应(含 4xx/5xx)即视为服务可达
function Test-Url {
    param([string]$Url)
    try {
        Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec 3 -UseBasicParsing | Out-Null
        return $true
    } catch {
        # PS 5.1 抛 WebException,PS 7+ 抛 HttpResponseException;只要拿到响应即视为可达
        if ($_.Exception.Response) { return $true }
        return $false
    }
}

# 必须依赖:任一失败返回 $false
function Invoke-DependencyCheck {
    $failed = $false
    Write-Host "Checking required dependencies..."
    $resolvedNode = Resolve-NodeBin
    if ($resolvedNode) {
        # 版本号通常已随 ABI 探测(stamp 命中时由缓存)带回;
        # 仅兜底分支(如 bs3 目录缺失未走探测)才额外 spawn 一次取版本
        if (-not $script:ResolvedNodeVer) {
            $script:ResolvedNodeVer = [string](& $resolvedNode --version 2>$null)
        }
        $nodeVer = $script:ResolvedNodeVer
        $pkgRuntime = Join-Path $RepoRoot 'runtime\node22\node.exe'
        $nodeOrigin = if ($resolvedNode -eq 'node') { 'PATH' } elseif ($resolvedNode -eq $pkgRuntime) { '包内 runtime 便携' } else { '便携 runtime' }
        Write-Host "  OK: node $nodeVer ($nodeOrigin, better-sqlite3 ABI 匹配)" -ForegroundColor Green
    } else {
        Write-Host "  FAIL: node not found (install Node.js >= 20,或发布包内置 runtime)" -ForegroundColor Red
        $failed = $true
    }
    if (Test-Path $NestNodeModules) {
        Write-Host "  OK: nest_gateway/node_modules present" -ForegroundColor Green
    } else {
        Write-Host "  FAIL: node_modules missing, run 'cd nest_gateway && npm install'" -ForegroundColor Red
        $failed = $true
    }
    if (Test-Path $NestDist) {
        Write-Host "  OK: NestJS dist present" -ForegroundColor Green
    } else {
        Write-Host "  FAIL: dist missing, run 'cd nest_gateway && npm run build'" -ForegroundColor Red
        $failed = $true
    }
    if (Test-Path $VenPy) {
        $importCheckCode = "import sys; sys.path.insert(0, r'$RepoRoot'); import workflow_db.parser, workflow_db.comfy_replay, workflow_db.parse_worker, workflow_db.generate_worker"
        $importErr = & $VenPy -c $importCheckCode 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  OK: venv python + worker assets importable" -ForegroundColor Green
        } else {
            Write-Host "  FAIL: worker assets import failed: $importErr" -ForegroundColor Red
            $failed = $true
        }
    } else {
        Write-Host "  FAIL: venv missing, create it with 'python -m venv venv' and 'venv\Scripts\pip install -r requirements.txt'" -ForegroundColor Red
        $failed = $true
    }
    # SQLite 单引擎(显式 SQLITE_READ=1 或 MONGODB_URI 留空自动启用)时
    # SQLite 为必须依赖,Mongo 退化为可选;fresh 部署缺库仅警告(首启自动建库)
    $sqliteRead = if ($env:SQLITE_READ) { $env:SQLITE_READ } else { '0' }
    $mongoUri = if ($env:MONGODB_URI) { $env:MONGODB_URI } else { '' }
    if ($sqliteRead -eq '1' -or -not $mongoUri) {
        $dbPath = if ($env:SQLITE_DB_PATH) { $env:SQLITE_DB_PATH } else { Join-Path (Resolve-DataDir) 'gray_workflow.sqlite3' }
        if (Test-Path $dbPath) {
            if (Test-Sqlite $dbPath) {
                Write-Host "  OK: SQLite db healthy: $dbPath" -ForegroundColor Green
            } else {
                Write-Host "  FAIL: SQLite db check failed: $dbPath" -ForegroundColor Red
                $failed = $true
            }
        } elseif ($sqliteRead -eq '1') {
            $dbParent = Split-Path -Parent $dbPath
            if ($dbParent -and -not (Test-Path -LiteralPath $dbParent -PathType Container)) {
                # data/ 被 gitignore,全新部署通常不存在;网关 openSqlite 会自动建目录建库,此处仅预建目录
                try {
                    New-Item -ItemType Directory -Path $dbParent -Force | Out-Null
                    Write-Host "  OK: SQLite db parent created: $dbParent" -ForegroundColor Green
                } catch {
                    Write-Host "  FAIL: cannot create SQLite db parent: $dbParent" -ForegroundColor Red
                    $failed = $true
                }
            } else {
                Write-Host "  WARNING: SQLite db尚未创建: $dbPath - 首次启动会自动建库" -ForegroundColor Yellow
            }
        } else {
            Write-Host "  WARNING: SQLite 主库尚未创建 - 首次启动会自动建库,无需手工干预" -ForegroundColor Yellow
        }
    } else {
        if (Test-MongoDb $mongoUri) {
            Write-Host "  OK: MongoDB reachable at $mongoUri" -ForegroundColor Green
        } else {
            Write-Host "  FAIL: MongoDB not reachable at $mongoUri (check mongod service and MONGODB_URI)" -ForegroundColor Red
            $failed = $true
        }
    }
    $scanRoot = $env:COMFY_SCAN_ROOT
    if ($scanRoot) {
        if (Test-Path -LiteralPath $scanRoot -PathType Container) {
            Write-Host "  OK: scan root exists: $scanRoot" -ForegroundColor Green
        } else {
            Write-Host "  FAIL: COMFY_SCAN_ROOT 已配置但不存在: $scanRoot" -ForegroundColor Red
            $failed = $true
        }
    } else {
        Write-Host "  WARNING: COMFY_SCAN_ROOT 未配置 - 空库可启动,在设置页配置图片目录后重启即可摄入" -ForegroundColor Yellow
    }
    if ($failed) { return $false }
    return $true
}

# 可选依赖:仅提示 warning,不阻断启动
function Invoke-OptionalCheck {
    Write-Host "Checking optional dependencies..."
    $comfy = if ($env:COMFYUI_BASE_URL) { $env:COMFYUI_BASE_URL } else { 'http://127.0.0.1:8188' }
    if (Test-Url $comfy) {
        Write-Host "  OK: ComfyUI reachable at $comfy" -ForegroundColor Green
    } else {
        Write-Host "  WARNING: ComfyUI not reachable at $comfy - near-realtime ingest (history poll) and the generate panel will be unavailable; start ComfyUI to enable" -ForegroundColor Yellow
    }
    $backupDir = if ($env:ARMARIUS_BACKUP_DIR) { $env:ARMARIUS_BACKUP_DIR } else { $env:WORKFLOW_DB_BACKUP_DIR }
    if ($backupDir) {
        # 注意:$sqliteRead 是 Invoke-DependencyCheck 的函数局部变量,此处不可见,
        # 需重读环境变量(否则 SQLITE_READ=1 时恒走 mongodump 分支误报警告)
        $sqliteReadHere = if ($env:SQLITE_READ) { $env:SQLITE_READ } else { '0' }
        if ($sqliteReadHere -eq '1') {
            Write-Host "  OK: SQLite backup engine (backup API, WORKFLOW_DB_BACKUP_DIR set)" -ForegroundColor Green
        } elseif (Get-Command mongodump -ErrorAction SilentlyContinue) {
            Write-Host "  OK: mongodump available (backup loop)" -ForegroundColor Green
        } else {
            Write-Host "  WARNING: WORKFLOW_DB_BACKUP_DIR is set but mongodump not found in PATH - backup loop will be disabled (install MongoDB Database Tools)" -ForegroundColor Yellow
        }
    }
}

# 解析工具页 URL(端口/绑定地址来自环境,通配绑定按回环访问)
function Get-ToolUrl {
    $port = if ($env:NEST_GATEWAY_PORT) { $env:NEST_GATEWAY_PORT } else { '8009' }
    $bind = if ($env:ARMARIUS_BIND_HOST) { $env:ARMARIUS_BIND_HOST } elseif ($env:WORKFLOW_DB_BIND_HOST) { $env:WORKFLOW_DB_BIND_HOST } else { '127.0.0.1' }
    if ($bind -in @('', '0.0.0.0', '::')) { $bind = '127.0.0.1' }
    return "http://${bind}:${port}/"
}

# 从 App Paths 注册表解析浏览器可执行文件完整路径(两视图都查)
function Resolve-BrowserExe {
    param([string]$ExeName)
    foreach ($hive in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths',
                        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths')) {
        $key = Join-Path $hive $ExeName
        if (Test-Path $key) {
            $v = (Get-ItemProperty $key -ErrorAction SilentlyContinue).'(default)'
            if ($v -and (Test-Path $v -PathType Leaf)) { return $v }
        }
    }
    return $null
}

# 计算独立应用窗口几何参数:目标 1440x900 居中(按主屏工作区,避开任务栏);
# 屏幕工作区小于目标时收缩到工作区尺寸。Add-Type 失败等异常退化为仅设尺寸。
function Get-AppWindowGeometry {
    param([int]$TargetW = 1440, [int]$TargetH = 900)
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $w = [Math]::Min($TargetW, $area.Width)
        $h = [Math]::Min($TargetH, $area.Height)
        $x = $area.X + [int](($area.Width - $w) / 2)
        $y = $area.Y + [int](($area.Height - $h) / 2)
        return '--window-size={0},{1} --window-position={2},{3}' -f $w, $h, $x, $y
    } catch {
        return '--window-size={0},{1}' -f $TargetW, $TargetH
    }
}

# 打开工具页:WORKFLOW_DB_OPEN_MODE=app 时按系统默认浏览器开独立应用窗口
# (Chromium 系 --app= 无标签页/地址栏,观感类原生应用,固定 1440x900 居中;
# Firefox 无 app 模式退化为 -new-window,尺寸交由浏览器记忆);
# 识别不出 ProgId 或浏览器未装则回退普通打开
function Open-ToolPage {
    $url = Get-ToolUrl
    $openMode = if ($env:ARMARIUS_OPEN_MODE) { $env:ARMARIUS_OPEN_MODE } else { $env:WORKFLOW_DB_OPEN_MODE }
    if ($openMode -eq 'app') {
        $progId = ''
        try { $progId = (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice' -ErrorAction Stop).ProgId } catch { }
        $exe = $null
        $argList = $null
        if ($progId -like 'MSEdgeHTM*') {
            $exe = Resolve-BrowserExe 'msedge.exe'
            $argList = '--app="{0}" {1}' -f $url, (Get-AppWindowGeometry)
        } elseif ($progId -like 'ChromeHTML*') {
            $exe = Resolve-BrowserExe 'chrome.exe'
            $argList = '--app="{0}" {1}' -f $url, (Get-AppWindowGeometry)
        } elseif ($progId -like 'Firefox*') {
            $exe = Resolve-BrowserExe 'firefox.exe'
            $argList = '-new-window "{0}"' -f $url
        }
        if ($exe) {
            Start-Process -FilePath $exe -ArgumentList $argList
            Write-Host "  OK: 已在独立窗口打开 $url ($([IO.Path]::GetFileName($exe)))" -ForegroundColor Green
            return
        }
        Write-Host "  INFO: 未识别默认浏览器($progId 或未安装),回退普通窗口打开" -ForegroundColor Yellow
    }
    Start-Process $url
    Write-Host "  OK: 已在默认浏览器打开 $url" -ForegroundColor Green
}

# 启动完成后用默认浏览器打开工具页(start 的后台子进程调用):轮询网关直至
# 任意 HTTP 响应(复用 Test-Url)即打开;超时仅提示不报错,不影响前台日志流。
function Invoke-OpenBrowser {
    $url = Get-ToolUrl
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        if (Test-Url $url) {
            Open-ToolPage
            return
        }
        # 150ms 粒度:listen 后最多再等一个周期即出窗(本地探测开销可忽略)
        Start-Sleep -Milliseconds 150
    }
    Write-Host "  WARNING: 等待网关就绪超时(90s),未自动打开浏览器 - 手动访问 $url" -ForegroundColor Yellow
}

# 平台 node_modules 激活守卫:node_modules → node_modules.win(junction)。
# 平台目录(带 .platform 标记)由 start.ps1 setup 安装;发布包旧布局(无标记真实目录)
# 视为当前平台放行并提示迁移;链接指向他平台时自动改链(目标目录存在则免重装,
# 缺失才拒绝启动,避免 ABI 错配);npm install/ci 的链接自愈见
# nest_gateway/scripts/ensure-platform.mjs(preinstall/postinstall 挂钩)。
# ABI 由 Resolve-NodeBin 实际探测选择可加载 better-sqlite3 的 node,此处不再重复。
function Ensure-PlatformNodeModules {
    $nm = Join-Path $RepoRoot 'nest_gateway\node_modules'
    $platDir = Join-Path $RepoRoot 'nest_gateway\node_modules.win'
    if (Test-Path $nm) {
        # 标记优先:junction 与真实目录均可读取 .platform
        if (Test-Path (Join-Path $nm '.platform')) {
            $plat = (Get-Content (Join-Path $nm '.platform') -Raw).Trim()
            if ($plat -eq 'windows') { return $true }
            # 链接指向他平台:目标平台目录存在则自动改链(免重装),不存在才 FAIL
            if (Test-Path $platDir) {
                (Get-Item $nm -Force).Delete()
                if (-not (New-ActivationLink $nm $platDir)) {
                    Write-Host "  FAIL: 自动改链失败 — 请运行 .\start.ps1 setup 重建" -ForegroundColor Red
                    return $false
                }
                Write-Host "  OK: 自动切换激活链接 node_modules → node_modules.win(原指向 $plat)" -ForegroundColor Green
                return $true
            }
            Write-Host "  FAIL: nest_gateway\node_modules 指向 $plat 平台,且 node_modules.win 不存在 — 请先运行 .\start.ps1 setup 初始化" -ForegroundColor Red
            return $false
        }
        $isReparse = (Get-Item $nm -Force -ErrorAction SilentlyContinue).Attributes -band [IO.FileAttributes]::ReparsePoint
        if ($isReparse) {
            # 链接目标无平台标记(损坏):目标平台目录存在则重建链接
            if (Test-Path $platDir) {
                (Get-Item $nm -Force).Delete()
                if (-not (New-ActivationLink $nm $platDir)) {
                    Write-Host "  FAIL: 重建激活链接失败 — 请运行 .\start.ps1 setup 重建" -ForegroundColor Red
                    return $false
                }
                Write-Host "  OK: 修复损坏激活链接 node_modules → node_modules.win" -ForegroundColor Green
                return $true
            }
            Write-Host "  FAIL: nest_gateway\node_modules 链接目标无平台标记(损坏)— 删除链接后重跑 start.ps1 setup" -ForegroundColor Red
            return $false
        }
        Write-Host "  WARNING: nest_gateway\node_modules 为旧布局(无平台标记)— 建议运行 start.ps1 setup 迁移为 node_modules.win" -ForegroundColor Yellow
        return $true
    }
    if (-not (Test-Path $platDir)) {
        Write-Host "  FAIL: node_modules.win 不存在 — 请先运行 .\start.ps1 setup 初始化" -ForegroundColor Red
        return $false
    }
    if (-not (New-ActivationLink $nm $platDir)) { return $false }
    Write-Host "  OK: 激活 node_modules → node_modules.win (junction)" -ForegroundColor Green
    return $true
}

# 创建激活链接(node_modules → 平台目录;junction 免管理员)
function New-ActivationLink {
    param([string]$Nm, [string]$PlatDir)
    & cmd /c mklink /J "$Nm" "$PlatDir" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Nm)) {
        Write-Host "  FAIL: 创建 junction 失败: $Nm → $PlatDir" -ForegroundColor Red
        return $false
    }
    return $true
}

# 启动前置门槛(check / start 共用):必须依赖缺失即失败,可选依赖仅警告。
# start 用 -SkipOptional:可选检查改由后台子进程执行,不再阻塞启动(见 Invoke-Start)
function Invoke-DependencyGate {
    param([switch]$SkipOptional)
    if (-not (Ensure-PlatformNodeModules)) { return $false }
    if (Invoke-DependencyCheck) {
        Write-Host ""
        if (-not $SkipOptional) { Invoke-OptionalCheck }
        Write-Host ""
        return $true
    }
    Write-Host ""
    return $false
}

function Invoke-Check {
    Load-Env
    Print-Context
    Write-Host ""
    if (Invoke-DependencyGate) {
        Write-Host "Environment check passed." -ForegroundColor Green
    } else {
        Write-Host "Environment check FAILED - fix the FAIL items above and re-run." -ForegroundColor Red
        exit 1
    }
}

# 下载便携 node(npmmirror win-x64 zip)到 %LOCALAPPDATA%\node22,免管理员
function Install-PortableNode {
    # 显式 TLS 1.2 + 强制直连(PS 5.1 默认协商与系统代理可能干扰下载);
    # 仅在真正下载时设置,不影响常规运行路径的 Invoke-WebRequest 代理行为
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    [System.Net.WebRequest]::DefaultWebProxy = $null
    if (Test-Path -LiteralPath $PortableNodeBin -PathType Leaf) { return $true }
    $url = "$NodeDistMirror/$NodeVersion/node-$NodeVersion-win-x64.zip"
    $tmp = Join-Path $env:TEMP "node-$NodeVersion-win-x64.zip"
    Write-Host "  INSTALL: 未找到 node,下载便携 node $NodeVersion → $PortableNodeDir"
    try {
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -TimeoutSec 120
    } catch {
        Write-Host "  FAIL: 下载便携 node 失败($url) - 请手动安装 Node.js 22 LTS 或更高" -ForegroundColor Red
        return $false
    }
    New-Item -ItemType Directory -Path $PortableNodeDir -Force | Out-Null
    $extractTmp = Join-Path $env:TEMP "node-extract-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $extractTmp -Force | Out-Null
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($tmp, $extractTmp)
        $inner = Join-Path $extractTmp "node-$NodeVersion-win-x64"
        Get-ChildItem $inner | Move-Item -Destination $PortableNodeDir -Force
    } catch {
        Write-Host "  FAIL: 解压便携 node 失败: $($_.Exception.Message)" -ForegroundColor Red
        Remove-Item $extractTmp -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        return $false
    }
    Remove-Item $extractTmp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Write-Host "  OK: 便携 node $NodeVersion 已安装到 $PortableNodeDir"
    return $true
}

# 安装戳 = sha256(package.json) + sha256(package-lock.json)(小写 hex,
# 与 ensure-platform.mjs 一致);由 postinstall 写入平台目录 .npm-stamp。
# 目录存在仅代表装过,依赖是否过期靠戳判断 —— 戳缺失/不匹配时执行增量安装。
function Get-NpmStamp {
    $h1 = if (Test-Path (Join-Path $RepoRoot 'nest_gateway\package.json')) { (Get-FileHash (Join-Path $RepoRoot 'nest_gateway\package.json') -Algorithm SHA256).Hash.ToLower() } else { '' }
    $h2 = if (Test-Path (Join-Path $RepoRoot 'nest_gateway\package-lock.json')) { (Get-FileHash (Join-Path $RepoRoot 'nest_gateway\package-lock.json') -Algorithm SHA256).Hash.ToLower() } else { '' }
    return "$h1$h2"
}

# 全量初始化(setup 子命令 / start 自动补齐共用):环境预检 → venv → npm install
# → .env → 自检。各步幂等,已装好即跳过。-SkipCheck 供 start 补齐路径跳过尾部
# 自检(随后门禁会立即重跑)。硬性失败(版本过旧/npm 失败等)直接 exit 1。
function Invoke-Setup {
    param([switch]$SkipCheck)

    Write-Host "================================================"
    Write-Host " Workflow DB - 初始化 (Windows)"
    Write-Host "================================================"

    Write-Host "[1/5] 环境预检"
    $nodeBin = Resolve-NodeBin
    if (-not $nodeBin) {
        if (-not (Install-PortableNode)) { exit 1 }
        $nodeBin = Resolve-NodeBin
        if (-not $nodeBin) {
            Write-Host "  FAIL: 便携 node 安装后仍不可解析" -ForegroundColor Red
            exit 1
        }
    }
    if ($nodeBin -eq 'node') {
        # PATH node 裸名换完整路径:后续 Split-Path 需推导 node 目录(PATH 前置/npm-cli 定位)
        $src = (Get-Command node -ErrorAction SilentlyContinue).Source
        if ($src) { $nodeBin = $src }
    }
    $nodeVer = (& $nodeBin --version 2>$null)
    $major = [int](($nodeVer.TrimStart('v') -split '\.')[0])
    if ($major -ge 22 -and $major -ne 23) {
        Write-Host "  OK: node $nodeVer (better-sqlite3 预编译覆盖)"
    } elseif ($major -eq 20 -or $major -eq 23) {
        Write-Host "  WARNING: node $nodeVer 无 better-sqlite3 预编译,可能触发本地编译(需 VS Build Tools);建议安装 Node 22 LTS" -ForegroundColor Yellow
    } else {
        Write-Host "  FAIL: node $nodeVer 版本过旧 - 请安装 Node.js 22 LTS 或更高" -ForegroundColor Red
        exit 1
    }
    $pyCmd = $null
    # 包内 runtime 便携 python 优先(已验证环境,免安装)
    $pkgPy = Join-Path $RepoRoot 'runtime\python312\python.exe'
    if (Test-Path $pkgPy) {
        $pyCmd = $pkgPy
    } else {
        foreach ($cand in @('py', 'python')) {
            if (Get-Command $cand -ErrorAction SilentlyContinue) { $pyCmd = $cand; break }
        }
    }
    if (-not $pyCmd) {
        Write-Host "  FAIL: 未找到 Python - 请安装 Python 3.10+ (https://www.python.org,安装时勾选 Add to PATH)" -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK: $(& $pyCmd --version 2>&1)"
    Write-Host ""

    Write-Host "[2/5] Python 虚拟环境"
    $pkgVenv = Join-Path $RepoRoot 'runtime\venv\Scripts\python.exe'
    if (Test-Path $pkgVenv) {
        Write-Host "  OK: 复用包内 runtime venv(已验证环境,免 venv/pip)"
    } else {
        if (-not (Test-Path "$RepoRoot\venv\Scripts\python.exe")) {
            Write-Host "  venv 不存在,自动创建..."
            & $pyCmd -m venv "$RepoRoot\venv"
            if ($LASTEXITCODE -ne 0) {
                Write-Host "  FAIL: 创建 venv 失败" -ForegroundColor Red
                exit 1
            }
        }
        Write-Host "  安装 Python 依赖..."
        # 优先方案:发布包内置 wheel(runtime\wheels\*.whl)用 .NET ZipFile 直接解包进
        # site-packages,免 pip 且完全离线;幂等:PIL 标记存在即跳过
        $site = Join-Path $RepoRoot 'venv\Lib\site-packages'
        $pilMarker = Join-Path $site 'PIL\__init__.py'
        if (Test-Path $pilMarker) {
            Write-Host "  OK: Python 依赖已存在(PIL),跳过解包"
        } else {
            $wheels = @(Get-ChildItem (Join-Path $RepoRoot 'runtime\wheels') -Filter '*.whl' -ErrorAction SilentlyContinue)
            if ($wheels.Count -gt 0) {
                Add-Type -AssemblyName System.IO.Compression.FileSystem
                foreach ($w in $wheels) {
                    [System.IO.Compression.ZipFile]::ExtractToDirectory($w.FullName, $site)
                    Write-Host "  OK: 解包 $($w.Name) → site-packages"
                }
            } else {
                # 兜底:pip 在线安装(临时降级 EAP,避免 PS 5.1 中原生命令写 stderr
                # 在 EAP=Stop 下触发 NativeCommandError 中断脚本)
                $savedEap = $ErrorActionPreference
                $ErrorActionPreference = 'Continue'
                & "$RepoRoot\venv\Scripts\python.exe" -m pip install -i "$(if ($env:PIP_INDEX_URL) { $env:PIP_INDEX_URL } else { 'https://pypi.tuna.tsinghua.edu.cn/simple' })" -r "$RepoRoot\requirements.txt"
                $pipRc = $LASTEXITCODE
                $ErrorActionPreference = $savedEap
                if ($pipRc -ne 0) {
                    Write-Host "  FAIL: pip install 失败(检查网络与 pip 源)" -ForegroundColor Red
                    exit 1
                }
            }
        }
    }
    Write-Host "  OK: venv 就绪"
    Write-Host ""

    Write-Host "[3/5] Node 依赖 (nest_gateway/node_modules.win)"
    $winDir = Join-Path $RepoRoot 'nest_gateway\node_modules.win'
    $newStamp = Get-NpmStamp
    $needInstall = $false
    if (-not (Test-Path $winDir)) { $needInstall = $true }
    else {
        $stampFile = Join-Path $winDir '.npm-stamp'
        if (-not (Test-Path $stampFile)) { $needInstall = $true }
        elseif ((Get-Content $stampFile -Raw).Trim() -ne $newStamp) { $needInstall = $true }
    }
    if ($needInstall) {
        # 链接指向他平台/损坏时由 preinstall 守卫改链或移除(防止写穿链接污染);
        # 真实目录/缺失目录由 npm 增量安装 + postinstall 迁移为平台目录,无需预操作
        Set-Location "$RepoRoot\nest_gateway"
        # 关键:npm 的 install 脚本(prebuild-install)按 PATH 第一个 node 的 ABI 下载
        # 预编译二进制;必须把目标 node 前置 PATH,否则系统默认 node 会拉错 ABI,
        # 导致目标 node 加载失败(ERR_DLOPEN_FAILED)
        $nodeDir = Split-Path $nodeBin -Parent
        $env:PATH = "$nodeDir;$env:PATH"
        $npmCli = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
        $npmReg = if ($env:NPM_REGISTRY) { $env:NPM_REGISTRY } else { 'https://registry.npmmirror.com' }
        if (Test-Path $npmCli) {
            & $nodeBin $npmCli install --no-audit --no-fund --registry $npmReg
        } else {
            & npm install --no-audit --no-fund --registry $npmReg
        }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  FAIL: npm install 失败 - better-sqlite3 预编译从 GitHub 下载,检查网络" -ForegroundColor Red
            exit 1
        }
        $nmDir = Join-Path $RepoRoot 'nest_gateway\node_modules'
        if (-not (Test-Path $nmDir) -and -not (Test-Path $winDir)) {
            Write-Host "  FAIL: npm install 未产出 node_modules 且平台目录不存在" -ForegroundColor Red
            exit 1
        }
        # postinstall 已把全新安装迁移为平台目录并写标记/安装戳;此处兜底
        if ((Test-Path $nmDir) -and -not (Test-Path $winDir)) {
            Rename-Item -Path $nmDir -NewName (Split-Path $winDir -Leaf)
            Write-Host "  已安装到 node_modules.win"
        }
        Set-Content -Path (Join-Path $winDir '.platform') -Value 'windows' -NoNewline -Encoding ASCII
        Set-Content -Path (Join-Path $winDir '.npm-stamp') -Value $newStamp -NoNewline -Encoding ASCII
        Set-Location $RepoRoot
    } else {
        Write-Host "  OK: node_modules.win 已存在且依赖无变更,跳过 npm install"
    }
    # 激活链接守卫与 junction 创建复用启动路径同一实现(旧布局放行警告可迁移)
    if (-not (Ensure-PlatformNodeModules)) { exit 1 }
    # 安装后 ABI 校验:目标 node 实际加载 better-sqlite3,失败即硬失败
    $bs3 = Join-Path $PSScriptRoot 'nest_gateway\node_modules\better-sqlite3'
    if (-not (Test-BetterSqlite3Load $nodeBin $bs3)) {
        Write-Host "  FAIL: better-sqlite3 与 node 版本不匹配(node $nodeVer) - 删除 nest_gateway\node_modules.win 后重跑 setup" -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK: Node 依赖就绪(better-sqlite3 ABI 校验通过)"
    Write-Host ""

    Write-Host "[4/5] 环境配置 (.env)"
    # 与网关冷迁移同规则:旧仓库根 .env 优先迁入;都没有才从模板生成
    $dataDir = Resolve-DataDir
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    if (Test-Path "$RepoRoot\.env") {
        if (-not (Test-Path (Join-Path $dataDir '.env'))) {
            Copy-Item "$RepoRoot\.env" (Join-Path $dataDir '.env')
            Write-Host "  已迁移旧仓库根 .env → $dataDir\.env"
        } else {
            Write-Host "  .env 已存在($dataDir),跳过(旧仓库根 .env 不再使用)"
        }
    } elseif (-not (Test-Path (Join-Path $dataDir '.env'))) {
        Copy-Item "$RepoRoot\.env.example" (Join-Path $dataDir '.env')
        Write-Host "  已从 .env.example 生成 $dataDir\.env(默认 SQLite 单引擎,零配置)"
    } else {
        Write-Host "  .env 已存在($dataDir),跳过"
    }
    Write-Host "  (.env 存放于用户数据目录,外置代码树;更新/重装不丢失)"
    Write-Host "  提示:可复制 .env.windows.example 为数据目录内 .env.windows,配置 Windows 路径"
    Write-Host "        也可在设置页配置 COMFY_SCAN_ROOT(图片目录)与 MongoDB(可选引擎)"
    Write-Host ""

    if (-not $SkipCheck) {
        Write-Host "[5/5] 环境自检"
        Invoke-Check
        Write-Host "初始化完成。"
    } else {
        Write-Host "初始化补齐完成。"
    }
    Write-Host "  启动:   .\start.ps1 start"
    Write-Host "  停止:   .\start.ps1 stop"
    $port = if ($env:NEST_GATEWAY_PORT) { $env:NEST_GATEWAY_PORT } else { '8009' }
    Write-Host "  状态:   http://127.0.0.1:$port"
    Write-Host ""
}

function Invoke-Start {
    Load-Env
    # 已运行检测:先毫秒级端口探测(覆盖绝大多数情形,含便携 node 等路径
    # 不含 nodejs 的形态);未响应再退回进程级匹配 —— 处理"网关进程在但端口
    # 已死"的 zombie 场景(拒绝重复拉起)。正常冷启动路径 WMI 查询不执行。
    $toolUrl = Get-ToolUrl
    if (Test-Url $toolUrl) {
        Write-Host "Gateway already running (stop it first with: .\start.ps1 stop)" -ForegroundColor Yellow
        # 已在运行:不重复拉起服务,直接补开工具页
        Open-ToolPage
        return
    }
    if (Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*nodejs*' } | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -like '*nest_gateway\dist\main.js*' }) {
        Write-Host "Gateway already running (stop it first with: .\start.ps1 stop)" -ForegroundColor Yellow
        Write-Host "  WARNING: 网关进程存在但 $toolUrl 未响应,未打开工具页,亦不重复拉起" -ForegroundColor Yellow
        return
    }
    Print-Context
    Write-Host ""
    if (-not (Invoke-DependencyGate -SkipOptional)) {
        # 门禁失败自动补齐:node/venv/npm 依赖类问题由 setup 幂等修复后重试;
        # Mongo 不可达、扫描根不存在等 setup 无法修复的问题重跑门禁仍失败即退出
        Write-Host "依赖检查未通过,自动执行初始化补齐(setup)..." -ForegroundColor Cyan
        Write-Host ""
        Invoke-Setup -SkipCheck
        Write-Host ""
        if (-not (Invoke-DependencyGate -SkipOptional)) {
            Write-Host "Start aborted - fix the FAIL items above and re-run." -ForegroundColor Red
            exit 1
        }
    }
    Write-Host "Starting NestJS Gateway on :8009 (foreground, logs stream below; press Ctrl+C to stop)..." -ForegroundColor Cyan
    Write-Host "  [start] node: $(Resolve-NodeBin) | NODE_OPTIONS=$env:NODE_OPTIONS"
    # 可选依赖检查(ComfyUI 可达性等)异步执行:独立子进程输出直接进当前控制台,
    # 与网关日志交错(等价 bash 的 &),不阻塞启动;环境变量已由 Load-Env 注入并被子进程继承
    Start-Process powershell -NoNewWindow -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, 'optional-check'
    # 网关就绪后自动用默认浏览器打开工具页:后台子进程轮询,不阻塞日志流;
    # WORKFLOW_DB_AUTO_OPEN=0 关闭(环境变量已由 Load-Env 注入并被子进程继承)
    $autoOpen = if ($env:ARMARIUS_AUTO_OPEN) { $env:ARMARIUS_AUTO_OPEN } elseif ($env:WORKFLOW_DB_AUTO_OPEN) { $env:WORKFLOW_DB_AUTO_OPEN } else { '1' }
    if ($autoOpen -eq '1') {
        Start-Process powershell -NoNewWindow -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, 'open-browser'
    }
    # 大图库首轮全量摄入 + stats 汇总重建需较大堆(实测 98K 图默认 4GB 堆 OOM);
    # 用户可通过环境变量 NODE_OPTIONS 覆盖
    if (-not $env:NODE_OPTIONS) {
        $env:NODE_OPTIONS = '--max-old-space-size=8192'
    }
    try {
        # 输出同时落盘 win_run.log(沙箱等环境下转录可能丢失原生子进程输出,
        # 文件在映射目录内宿主可直接查看;Tee 保留前台流式输出)
        # 临时降级 EAP:node 的 stderr(如 mongo-lazy "可忽略"警告)在 PS 5.1 的
        # EAP=Stop 下会触发 NativeCommandError 终止脚本,即使网关本身正常运行
        $savedEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & (Resolve-NodeBin) $NestDist 2>&1 | Tee-Object -FilePath $StdoutLog
        $gwRc = $LASTEXITCODE
        $ErrorActionPreference = $savedEap
        if ($gwRc -ne 0) {
            Write-Host "Gateway exited with code $gwRc" -ForegroundColor Red
            exit $gwRc
        }
    } catch {
        Write-Host "Failed to start gateway: $_" -ForegroundColor Red
        exit 1
    }
}

function Invoke-Stop {
    # 匹配两种启动形态:启动脚本的绝对路径(nest_gateway\dist\main.js)与
    # 手动 cd nest_gateway 后 node dist\main.js 的相对路径
    $targets = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match '(?:nest_gateway[\\/])?dist[\\/]main\.js' }
    if (-not $targets) {
        Write-Host "No running gateway found."
        return
    }
    foreach ($t in $targets) {
        Write-Host "Stopping gateway PID $($t.ProcessId)..."
        Stop-Process -Id $t.ProcessId -Force
    }
}

function Invoke-Logs {
    if (-not (Test-Path $StdoutLog)) {
        Write-Host "No log file yet ($StdoutLog)"
        return
    }
    Get-Content $StdoutLog -Tail 40
}

# Python worker:优先包内 runtime venv;构建机路径失效(跨机部署)时自动
# 重建,仍不可用才回退本地 venv。可用性结论记入 startup stamp(python.exe
# 指纹未变即复用),免去每轮冷启动的一次 python spawn;真正的依赖门禁
# (venv import 检查,见 Invoke-DependencyCheck)不受影响,每轮照跑。
# 注意:本块为顶层代码,PowerShell 顺序执行 —— 必须位于所用函数
# (Get-StartupStampMap/Save-StartupStamp/Repair-PkgVenv)定义之后,
# 故置于文件尾 switch 派发之前。
$PkgVenPy = Join-Path $RepoRoot 'runtime\venv\Scripts\python.exe'
$VenPy = $null
if (Test-Path -LiteralPath $PkgVenPy -PathType Leaf) {
    $stamp = Get-StartupStampMap
    $pkgVenUsable = $false
    if ($stamp['venv_py'] -eq $PkgVenPy -and
        $stamp['venv_fp'] -and $stamp['venv_fp'] -eq (Get-BinFingerprint $PkgVenPy)) {
        # 上轮探测通过且 python.exe 未被替换/升级 → 免 spawn 复用结论
        $pkgVenUsable = $true
    } else {
        try {
            & $PkgVenPy -c "import sys" 2>&1 | Out-Null
            $pkgVenUsable = ($LASTEXITCODE -eq 0)
        } catch { $pkgVenUsable = $false }
        if ($pkgVenUsable) {
            Save-StartupStamp @{ venv_py = $PkgVenPy; venv_fp = (Get-BinFingerprint $PkgVenPy) }
        }
    }
    if ($pkgVenUsable) {
        $VenPy = $PkgVenPy
    } else {
        Write-Host "  [venv] runtime venv 不可用(构建机路径失效),用包内 python312 重建..."
        if (Repair-PkgVenv -VenvRoot (Join-Path $RepoRoot 'runtime\venv') -BasePy (Join-Path $RepoRoot 'runtime\python312')) {
            $VenPy = $PkgVenPy
        } else {
            Write-Host "  [venv] runtime venv 重建失败,回退本地 venv" -ForegroundColor Yellow
        }
    }
}
if (-not $VenPy) {
    $VenPy = Join-Path $RepoRoot 'venv\Scripts\python.exe'
}

switch ($Command) {
    'setup' { Invoke-Setup }
    'check' { Invoke-Check }
    'start' { Invoke-Start }
    'stop' { Invoke-Stop }
    'logs' { Invoke-Logs }
    'optional-check' { Invoke-OptionalCheck }
    'open-browser' { Invoke-OpenBrowser }
    default {
        Get-Content -Path $MyInvocation.MyCommand.Path -TotalCount 13 | Where-Object { $_ -like '#*' }
    }
}
