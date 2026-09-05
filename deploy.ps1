# ============================================================================
# Workflow DB 一键部署(Windows)— 空白机器 → 启动(免管理员)
#
# 流程:
#   [1/5] 环境预检:已存在的依赖直接复用,仅缺失项安装(零侵入)
#   [2/5] 代码获取:git clone(-RepoUrl) / 发布 zip(-ZipPath 或同目录 *.zip)
#   [3/5] 部署预检汇总
#   [4/5] .\start.ps1 setup 初始化(venv + npm + .env + 自检,幂等)
#   [5/5] .\start.ps1 start 前台启动
#
# 用法(在部署目录执行):
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1                    # 已在仓库内
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -RepoUrl <url>     # 空白机器 clone
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -ZipPath <path>    # 空白机器解压发布包
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Command check     # 仅预检
#
# 环境变量覆盖:
#   NODE_VERSION       便携 Node 版本(默认 v22.23.2,better-sqlite3 预编译覆盖)
#   PYTHON_VERSION     Python 版本(NuGet 便携解压,默认 3.12.8)
#   NODE_DIST_MIRROR   Node 下载镜像(默认 npmmirror 国内镜像)
#   NPM_REGISTRY       npm 源(默认 npmmirror,透传 setup.ps1)
#
# 说明:
#   - Node 走便携安装( %LOCALAPPDATA%\node22 ),与 setup.ps1 /
#     start.ps1 的便携探测机制天然兼容,无需管理员权限
#   - Python 走 NuGet 便携解压(包内 runtime\python312),零持久注册:
#     PATH 前置仅进程级,不写用户/系统 PATH、PEP 514 注册表、py 启动器,
#     避免遮蔽宿主机既有 Python 环境(绘世整合包会因解释器被抢占报
#     "未安装任何版本的 PyTorch")
# ============================================================================
param(
    [string]$RepoUrl,
    [string]$ZipPath,
    [ValidateSet('deploy', 'check')]
    [string]$Command = 'deploy'
)

# 兼容位置参数调用 .\deploy.ps1 check(PS 默认按声明顺序位置绑定,check 会先绑到 -RepoUrl)
if ($RepoUrl -eq 'check') { $Command = 'check'; $RepoUrl = '' }

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# 显式启用 TLS 1.2(PS 5.1 默认协商可能被旧策略限制,现代 HTTPS 源必需)
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# 强制直连下载:绕过系统代理(Windows Sandbox 继承宿主机代理设置,
# 但沙箱内 127.0.0.1:PORT 无代理服务 → Invoke-WebRequest 连接失败;
# 下载源为国内镜像,直连可达)
[System.Net.WebRequest]::DefaultWebProxy = $null

# 状态钩子:沙箱测试时由 run-sandbox-test.ps1 注入 SANDBOX_STATE_FILE,
# 每个关键步骤写实时状态(宿主机 WSL 可即时观测,定位卡点)
function State-Hook {
    param([string]$Stage, [string]$Note = '')
    if (-not $env:SANDBOX_STATE_FILE) { return }
    try {
        $state = @{
            stage = $Stage
            note  = $Note
            ts    = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
            pid   = $PID
        } | ConvertTo-Json -Compress
        Set-Content -Path $env:SANDBOX_STATE_FILE -Value $state -Encoding UTF8
    } catch { }
}
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeVersion = if ($env:NODE_VERSION) { $env:NODE_VERSION } else { 'v22.23.2' }
$PyVersion = if ($env:PYTHON_VERSION) { $env:PYTHON_VERSION } else { '3.12.8' }
$NodeDistMirror = if ($env:NODE_DIST_MIRROR) { $env:NODE_DIST_MIRROR } else { 'https://registry.npmmirror.com/-/binary/node' }
$PortableNodeDir = Join-Path $env:LOCALAPPDATA 'node22'
$PortableNodeBin = Join-Path $PortableNodeDir 'node.exe'
# 历史便携 Python 位置(仅复用不新装;新装一律进包内 runtime\python312,零持久注册)
$PortablePythonDir = Join-Path $env:LOCALAPPDATA "python$($PyVersion -replace '\.', '')"
$PortablePythonBin = Join-Path $PortablePythonDir 'python.exe'
$NodeUrl = "$NodeDistMirror/$NodeVersion/node-$NodeVersion-win-x64.zip"

$Summary = New-Object System.Collections.ArrayList
$MissFlag = $false

function Note {
    param([string]$Status, [string]$Item, [string]$Detail)
    if ($Status -eq 'MISS') { $script:MissFlag = $true }
    [void]$script:Summary.Add(("{0,-5} {1,-18} {2}" -f $Status, $Item, $Detail))
}

# 解析 node:便携 node22 优先(预编译 ABI 匹配),否则 PATH node
# node 解析优先级:系统 PATH(已有环境优先)→ 包内 runtime\node22(已验证环境)→ 下载
# $PkgNodeBin 指向发布包内 runtime(zip 解压后与 deploy.ps1 同根)
function Resolve-NodeBin {
    if (Get-Command node -ErrorAction SilentlyContinue) { return 'node' }
    $pkg = Join-Path $Root 'runtime\node22\node.exe'
    if (Test-Path $pkg) { return $pkg }
    if (Test-Path $PortableNodeBin) { return $PortableNodeBin }
    return $null
}

# 用 .NET TcpClient 探测(沙箱内 WMI/CIM 不可用:Test-NetConnection 依赖 CIM
# 结果,最小化 Windows/Sandbox 中会抛错或误报 — 与下方 TcpListener 端口探测
# 同理;纯 socket 直连已由 run-sandbox-test 的 [net] 阶段验证可用)
function Test-Network {
    param([string]$HostName)
    try {
        $client = New-Object Net.Sockets.TcpClient
        $client.Connect($HostName, 443)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

# 刷新进程 PATH(winget 安装 git 后生效;仅从持久 PATH 重载,不做任何写入)
function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

# ---------------------------------------------------------------------------
# [1/5] 环境预检
# ---------------------------------------------------------------------------
function Test-Node {
    $bin = Resolve-NodeBin
    if ($bin -and $bin -eq $PortableNodeBin) {
        $ver = (& $bin --version) 2>$null
        if (-not $ver) { return $false }
        Write-Host "  OK: node $ver (便携 $PortableNodeDir)"
        Note 'OK' 'Node' "便携 $ver (复用)"
        return $true
    }
    if ($bin) {
        $ver = (& $bin --version) 2>$null
        if (-not $ver) { return $false }
        $major = [int]($ver.TrimStart('v') -split '\.')[0]
        $where = if (Test-Path $bin -PathType Leaf) { '包内 runtime 便携' } else { 'PATH 复用' }
        # 与 package.json engines(>=22 <27)及 deploy.sh 门禁对齐(OPS-05):
        # 22/24/25/26 复用;20/23 无预编译仅警告复用;其余(过旧或 27+)便携替换
        if (22, 24, 25, 26 -contains $major) {
            Write-Host "  OK: node $ver ($where)"
            Note 'OK' 'Node' "$ver ($where)"
            return $true
        }
        if (20, 23 -contains $major) {
            Write-Host "  WARNING: node $ver 无 better-sqlite3 预编译,可能触发本地编译(需 VS Build Tools);建议 Node 22 LTS" -ForegroundColor Yellow
            Note 'OK' 'Node' "$ver ($where,无预编译)"
            return $true
        }
        Write-Host "  WARNING: node $ver 不满足 engines(>=22 <27),将改用便携 node $NodeVersion" -ForegroundColor Yellow
        Note 'REPL' 'Node' "$ver → 便携 $NodeVersion"
    }
    Write-Host "  INSTALL: 便携 node $NodeVersion → $PortableNodeDir"
    if ($Command -eq 'check') { Note 'MISS' 'Node' "便携 node $NodeVersion"; return $false }
    if (-not (Install-PortableNode)) { return $false }
    Note 'NEW' 'Node' "便携 $NodeVersion → $PortableNodeDir"
    return $true
}

function Install-PortableNode {
    if (Test-Path $PortableNodeBin) { return $true }
    $probeHost = ([uri]$NodeDistMirror).Host
    if (-not (Test-Network $probeHost)) {
        Write-Host "  FAIL: 无法访问 $probeHost - 离线机器请预装 Node,或改用 -ZipPath 流程" -ForegroundColor Red
        return $false
    }
    $tmp = Join-Path $env:TEMP "node-$NodeVersion-win-x64.zip"
    Write-Host "  下载 $NodeUrl ..."
    State-Hook 'node-download' $NodeUrl
    try {
        Invoke-WebRequest -Uri $NodeUrl -OutFile $tmp -UseBasicParsing
    } catch {
        Write-Host "  FAIL: 下载失败: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
    State-Hook 'node-extract' '解压 node zip'
    New-Item -ItemType Directory -Path $PortableNodeDir -Force | Out-Null
    $extractTmp = Join-Path $env:TEMP "node-extract-$([guid]::NewGuid().ToString('N'))"
    # 用 .NET ZipFile 而非 Expand-Archive(见 Invoke-Acquire 注释)
    New-Item -ItemType Directory -Path $extractTmp -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($tmp, $extractTmp)
    $inner = Join-Path $extractTmp "node-$NodeVersion-win-x64"
    Get-ChildItem $inner | Move-Item -Destination $PortableNodeDir -Force
    Remove-Item $extractTmp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Write-Host "  OK: node $(& $PortableNodeBin --version) 已安装到 $PortableNodeDir"
    return $true
}

# python 解析优先级:包内 runtime\python312(已验证环境,零持久注册)→
# 历史 LOCALAPPDATA 便携(仅复用)→ 系统 PATH(py/python,只读复用)→ NuGet 下载
# 防御性约束:PATH 前置一律进程级($env:PATH),绝不持久注册
function Get-PythonCmd {
    $pkg = Join-Path $Root 'runtime\python312\python.exe'
    if (Test-Path $pkg) {
        $env:PATH = "$(Split-Path $pkg -Parent);$env:PATH"
        return $pkg
    }
    if (Test-Path $PortablePythonBin) {
        # 历史便携安装复用:进程级 PATH 前置,保证同进程子步骤(setup.ps1)可解析
        $env:PATH = "$PortablePythonDir;$env:PATH"
        return $PortablePythonBin
    }
    foreach ($cand in @('py', 'python')) {
        if (-not (Get-Command $cand -ErrorAction SilentlyContinue)) { continue }
        $ver = & $cand -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $ver) { continue }
        $parts = $ver.Split('.')
        if ([int]$parts[0] -ge 3 -and [int]$parts[1] -ge 10) { return $cand }
    }
    return $null
}

function Test-Python {
    $py = Get-PythonCmd
    if ($py) {
        $ver = (& $py --version) 2>&1
        $where = if ($py -like "$Root*") { '包内 runtime 便携' }
        elseif (Test-Path $py -PathType Leaf) { '历史便携复用' } else { 'PATH 复用' }
        Write-Host "  OK: $ver ($where)"
        Note 'OK' 'Python' "$ver ($where)"
        return $true
    }
    Write-Host "  INSTALL: Python $PyVersion (NuGet 便携解压,零持久注册)"
    if ($Command -eq 'check') { Note 'MISS' 'Python' "Python $PyVersion"; return $false }
    if (-not (Install-Python)) { return $false }
    Note 'NEW' 'Python' "$PyVersion (NuGet 便携,零持久注册)"
    return $true
}

# 便携 Python:官方 NuGet 包(zip)解压即完整 Python(含 venv),
# 免安装器/免提权 —— 解决 python.org 安装器在最小化系统/沙箱中
# 卡静默安装(UAC 弹窗不可见/组件缺失)的问题,与便携 node 同思路
# 防御性约束:解压目标为包内 runtime\python312(当前部署目录),PATH 前置
# 仅进程级 —— 不写用户/系统 PATH、PEP 514 注册表、py 启动器,避免污染
# 宿主机既有 Python 环境(绘世等整合包因解释器被抢占会报 PyTorch 缺失)
function Install-PortablePython {
    $PkgPythonDir = Join-Path $Root 'runtime\python312'
    $PkgPythonBin = Join-Path $PkgPythonDir 'python.exe'
    if (Test-Path $PkgPythonBin) { return $true }
    $nugetHost = 'www.nuget.org'
    if (-not (Test-Network $nugetHost)) {
        Write-Host "  FAIL: $nugetHost 不可达 - 离线机器请预置包内 runtime\python312,或手动安装 Python 3.10+ 后重跑" -ForegroundColor Red
        return $false
    }
    $url = "https://$nugetHost/api/v2/package/python/$PyVersion"
    $tmp = Join-Path $env:TEMP "python-$PyVersion.nupkg"
    State-Hook 'python-download' $url
    Write-Host "  下载便携 python $url ..."
    try {
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    } catch {
        Write-Host "  FAIL: 便携 python 下载失败: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
    State-Hook 'python-extract' '解压 NuGet 包'
    New-Item -ItemType Directory -Path $PkgPythonDir -Force | Out-Null
    $extractTmp = Join-Path $env:TEMP "py-extract-$([guid]::NewGuid().ToString('N'))"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($tmp, $extractTmp)
    Get-ChildItem (Join-Path $extractTmp 'tools') | Move-Item -Destination $PkgPythonDir -Force
    Remove-Item $extractTmp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $PkgPythonBin)) {
        Write-Host "  FAIL: 便携 python 解压异常(runtime\python312\python.exe 缺失)" -ForegroundColor Red
        return $false
    }
    $env:PATH = "$PkgPythonDir;$env:PATH"
    State-Hook 'python-installed' $PkgPythonDir
    Write-Host "  OK: $(& $PkgPythonBin --version) 便携解压到 $PkgPythonDir(零持久注册)"
    return $true
}

function Install-Python {
    # 防御性约束:唯一引导方式为 NuGet 便携解压(包内 runtime\python312 +
    # 进程级 PATH 前置)。刻意不回退 winget / python.org 安装器:二者必然写
    # PEP 514 注册表(HKCU\Software\Python\PythonCore),且可能装入 py 启动器
    # 与持久 PATH,会遮蔽宿主机既有 Python 环境(绘世整合包因此报
    # "未安装任何版本的 PyTorch"),违反"仅当前目录 + 进程级注册"原则
    if (Install-PortablePython) { return $true }
    Write-Host "  FAIL: Python 获取失败 - 手动安装 Python 3.10+ 后重跑本脚本,或预置包内 runtime\python312" -ForegroundColor Red
    return $false
}

function Test-Git {
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $ver = git --version
        Write-Host "  OK: $ver (复用)"
        Note 'OK' 'git' $ver
        return $true
    }
    Write-Host "  INSTALL: git (winget)"
    if ($Command -eq 'check') { Note 'MISS' 'git' 'git clone 需要'; return $false }
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        & winget install --id Git.Git --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0) {
            Refresh-Path
            Note 'NEW' 'git' 'winget Git.Git'
            return $true
        }
    }
    Write-Host "  FAIL: 无法安装 git - 请手动安装 https://git-scm.com/download/win" -ForegroundColor Red
    return $false
}

function Test-Port8009 {
    # 用 .NET TcpListener 探测(沙箱内 WMI/CIM 不可用,Get-NetTCPConnection 会
    # 抛 "Cannot connect to CIM server" 终止性错误)
    try {
        $l = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, 8009)
        $l.Start()
        $l.Stop()
        Note 'OK' '端口 8009' '空闲'
    } catch {
        Write-Host "  WARNING: 8009 端口已被占用 - 启动前请改 NEST_GATEWAY_PORT" -ForegroundColor Yellow
        Note 'WARN' '端口 8009' '已被占用'
    }
}

# ---------------------------------------------------------------------------
# [2/5] 代码获取
# ---------------------------------------------------------------------------
function Invoke-Acquire {
    # 已有部署 → 复用(start.ps1 为发布包唯一入口脚本,存在即视为已获取)。
    # 旧入口名 run_workflow_db.ps1 已移除,不再识别。
    if (Test-Path (Join-Path $Root 'start.ps1')) {
        Write-Host "  OK: $Root 已有部署(start.ps1 存在),跳过代码获取"
        Note 'OK' '代码' '已存在,复用'
        return $true
    }
    # 来源解析:-RepoUrl > -ZipPath > 同目录 *.zip;无来源则报错
    $repo = $RepoUrl
    $zip = $ZipPath
    if (-not $repo -and -not $zip) {
        $zips = @(Get-ChildItem -Path $Root -Filter *.zip -ErrorAction SilentlyContinue)
        if ($zips.Count -eq 1) {
            $zip = $zips[0].FullName
        } elseif ($zips.Count -gt 1) {
            Write-Host "  FAIL: 本目录发现多个发布包,请用 -ZipPath 指定: $($zips.FullName -join ', ')" -ForegroundColor Red
            return $false
        }
    }
    if (-not $repo -and -not $zip) {
        Write-Host "  FAIL: 未指定代码来源 - 请用 -RepoUrl <url> 或 -ZipPath <发布包>;或在仓库目录内直接运行本脚本" -ForegroundColor Red
        return $false
    }

    if ($repo) {
        if (-not (Test-Git)) { return $false }
        if (-not (Test-Network 'github.com')) {
            Write-Host "  FAIL: 无法访问 github.com - 离线机器请改用 -ZipPath 或预装依赖" -ForegroundColor Red
            return $false
        }
        $items = @(Get-ChildItem -Path $Root -Force -ErrorAction SilentlyContinue)
        if ($items.Count -gt 0) {
            Write-Host "  FAIL: 目标目录非空: $Root" -ForegroundColor Red
            Write-Host "        请将本脚本放入空目录后重试,或在仓库内直接运行" -ForegroundColor Red
            return $false
        }
        Write-Host "  INSTALL: git clone $repo → $Root"
        git clone $repo $Root
        if ($LASTEXITCODE -ne 0) { return $false }
        Note 'NEW' '代码' "git clone $repo"
        return $true
    }

    if (-not (Test-Path $zip)) {
        Write-Host "  FAIL: zip 不存在: $zip" -ForegroundColor Red
        return $false
    }
    Write-Host "  INSTALL: 解压 $zip → $Root"
    # 用 .NET ZipFile 而非 Expand-Archive:后者依赖 PowerShell Archive 模块的
    # 本地化资源(en-US),在最小化 Windows/Sandbox 中缺失会直接失败
    # 注意: ExtractToDirectory 在目标文件已存在时直接抛错(发布包内含
    # deploy.ps1/setup.ps1 等,与预置脚本同目录必冲突),须逐条覆盖解压
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $n = 0
        foreach ($entry in $archive.Entries) {
            # zip-slip 防护:目录穿越(..\)、盘符(C:\)、根路径(\)条目可把
            # 文件写出解压目录,恶意 zip 借此覆盖任意路径。采用"拒绝并报错"
            # (fail-closed):发布包由 release.sh 自产,合法条目不会命中;一旦
            # 命中即视为被篡改,中止部署,避免"跳过"后部署出半残缺环境
            $norm = $entry.FullName.Replace('/', '\')
            if ($norm -match '(^|\\)\.\.(\\)|^[A-Za-z]:|^\\') {
                throw "zip-slip 检测: 非法条目 '$($entry.FullName)' — 已中止解压,请检查 zip 来源"
            }
            $dest = Join-Path $Root $norm
            if ($entry.FullName.EndsWith('/')) {
                New-Item -ItemType Directory -Path $dest -Force | Out-Null
                continue
            }
            New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
            # 覆盖解压:Defender 实时防护会短暂锁定新 exe,重试 5 次
            for ($t = 0; $t -lt 5; $t++) {
                try {
                    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
                    break
                } catch {
                    if ($t -eq 4) { throw }
                    Start-Sleep -Milliseconds 800
                }
            }
            $n++
        }
        Write-Host "  已解压 $n 个文件"
    } finally {
        $archive.Dispose()
    }
    Note 'NEW' '代码' "解压发布包 $zip"
    if (-not (Test-Path (Join-Path $Root 'start.ps1'))) {
        Write-Host "  FAIL: zip 内未找到 start.ps1,非有效发布包" -ForegroundColor Red
        return $false
    }
    return $true
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
Write-Host "================================================"
Write-Host " Workflow DB 一键部署 (Windows)"
Write-Host " 目标目录: $Root"
Write-Host "================================================"
Write-Host ""
# [1/5] 代码获取提前:解压仅用 .NET(无 node/python 依赖),解压后
#      发布包内置 runtime\ 就位,环境预检才能命中"包内已验证环境"分支
Write-Host "[1/5] 代码获取(解压发布包 → 内置 runtime 就位)"
State-Hook 'stage-1' '代码获取'
if (-not (Invoke-Acquire)) { exit 1 }
Write-Host ""
Write-Host "[2/5] 环境预检(系统已有环境优先 → 包内 runtime → 下载兜底)"
State-Hook 'stage-2' '环境预检'
# check 模式:预检 MISS 仅记录并继续(与 deploy.sh 的 note-then-return 对齐,
# OPS-03),汇总照常打印后统一按 MissFlag 退出;deploy 模式缺依赖无法继续 → 立即终止
if (-not (Test-Node) -and $Command -ne 'check') { exit 1 }
if (-not (Test-Python) -and $Command -ne 'check') { exit 1 }
Test-Port8009
Write-Host ""

Write-Host "================================================"
Write-Host " 部署预检汇总(OK 复用 / NEW 新装 / MISS 缺失)"
Write-Host "================================================"
foreach ($line in $Summary) { Write-Host "  $line" }
Write-Host "================================================"

if ($Command -eq 'check') {
    Write-Host "预检完成(check 模式,未安装 / 未部署)"
    exit $(if ($MissFlag) { 1 } else { 0 })
}

Write-Host ""
Write-Host "[4/5] 初始化 (.\start.ps1 setup)"
State-Hook 'stage-4' '初始化'
& (Join-Path $Root "start.ps1") setup
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "[5/5] 启动 (.\start.ps1 start)"
State-Hook 'stage-5' '启动网关'
& (Join-Path $Root "start.ps1") start
exit $LASTEXITCODE
