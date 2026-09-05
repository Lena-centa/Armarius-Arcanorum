# ============================================================================
# 构建发布运行时(runtime/ 目录)— 打包已验证环境,开箱即用
#
# 目标:将开发机已验证的运行时(便携 node22 + 便携 python312 + venv 依赖
#       + nest_gateway node_modules)打包进发布 zip,空白机器/沙箱部署时
#       无需联网下载;若目标机已有可用环境则优先复用(不浪费空间)。
#
# 产物(仓库根 runtime/,已 gitignore):
#   runtime/node22/         便携 node(zip 解压,含 npm)
#   runtime/python312/      便携 python(官方 NuGet 包解压,含 venv)
#   runtime/venv/           python312 创建的 venv(已装 requirements.txt)
#   runtime/node_modules/   nest_gateway 生产依赖(ABI 匹配 node22)
#   runtime/RUNTIME.json    清单:版本/组件/构建时间
#
# 用法(Windows PowerShell,在仓库根执行):
#   powershell -ExecutionPolicy Bypass -File tools\windows\build_runtime.ps1
# 可选: -NodeZipPath/-NodeDir 指定宿主 node 便携目录(默认 $env:LOCALAPPDATA\node22)
#        -SkipNodeModules 跳过 node_modules(体积敏感时)
# ============================================================================
param(
    [string]$Root = '',
    [string]$NodeVersion = 'v22.23.2',
    [string]$PyVersion = '3.12.8',
    [switch]$SkipNodeModules
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
[System.Net.WebRequest]::DefaultWebProxy = $null
if (-not $Root) {
    # 本脚本位于 <根>\tools\windows\,向上三级为仓库根
    $Root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
}
Set-Location $Root

$RuntimeDir = Join-Path $Root 'runtime'
$NodeDir = Join-Path $RuntimeDir 'node22'
$NodeBin = Join-Path $NodeDir 'node.exe'
$PyDir = Join-Path $RuntimeDir 'python312'
$PyBin = Join-Path $PyDir 'python.exe'
$VenDir = Join-Path $RuntimeDir 'venv'
$RuntimeNodeModules = Join-Path $RuntimeDir 'node_modules'

Write-Host "================================================"
Write-Host " 构建发布运行时 → $RuntimeDir"
Write-Host " node:  $NodeVersion | python: $PyVersion"
Write-Host "================================================"

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

# ---------------------------------------------------------------------------
# 1. 便携 node22(优先复用宿主已验证副本,否则下载)
# ---------------------------------------------------------------------------
Write-Host "[1/5] 便携 node"
$hostNode = Join-Path $env:LOCALAPPDATA "node22\node.exe"
if (Test-Path $hostNode) {
    Write-Host "  复制宿主已验证 node22: $env:LOCALAPPDATA\node22 → runtime\node22"
    Copy-Item (Split-Path $hostNode -Parent) $NodeDir -Recurse -Force
} elseif (Test-Path $NodeBin) {
    Write-Host "  复用已有 runtime\node22"
} else {
    Write-Host "  下载 $NodeVersion ..."
    $zip = Join-Path $env:TEMP "node-$NodeVersion-win-x64.zip"
    Invoke-WebRequest -Uri "https://registry.npmmirror.com/-/binary/node/$NodeVersion/node-$NodeVersion-win-x64.zip" -OutFile $zip -UseBasicParsing
    $tmp = Join-Path $env:TEMP "node-extract-$([guid]::NewGuid().ToString('N'))"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
    # robocopy 处理只读/特殊属性文件(Move-Item 对 corepack 等会 UnauthorizedAccess)
    robocopy (Join-Path $tmp "node-$NodeVersion-win-x64") $NodeDir /E /MOVE /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Write-Host "FAIL: node 解压移动失败" -ForegroundColor Red; exit 1 }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path $NodeBin)) { Write-Host "FAIL: node 不可用" -ForegroundColor Red; exit 1 }
Write-Host "  OK: $(& $NodeBin --version)"

# ---------------------------------------------------------------------------
# 2. 便携 python312(官方 NuGet 包 = 完整 Python,含 venv)
# ---------------------------------------------------------------------------
Write-Host "[2/5] 便携 python"
if (-not (Test-Path $PyBin)) {
    Write-Host "  下载 NuGet python $PyVersion ..."
    $nupkg = Join-Path $env:TEMP "python-$PyVersion.nupkg"
    Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/python/$PyVersion" -OutFile $nupkg -UseBasicParsing
    $tmp = Join-Path $env:TEMP "py-extract-$([guid]::NewGuid().ToString('N'))"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($nupkg, $tmp)
    New-Item -ItemType Directory -Path $PyDir -Force | Out-Null
    robocopy (Join-Path $tmp 'tools') $PyDir /E /MOVE /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Write-Host "FAIL: python 解压移动失败" -ForegroundColor Red; exit 1 }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $nupkg -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path $PyBin)) { Write-Host "FAIL: python 不可用" -ForegroundColor Red; exit 1 }
Write-Host "  OK: $(& $PyBin --version)"

# ---------------------------------------------------------------------------
# 3. venv(便携 python 创建,装 requirements.txt)
# ---------------------------------------------------------------------------
Write-Host "[3/5] venv + Python 依赖"
if (-not (Test-Path (Join-Path $VenDir 'Scripts\python.exe'))) {
    & $PyBin -m venv $VenDir
    if ($LASTEXITCODE -ne 0) { Write-Host "FAIL: venv 创建失败" -ForegroundColor Red; exit 1 }
}
Write-Host "  安装 requirements.txt(清华源)..."
& (Join-Path $VenDir 'Scripts\pip.exe') install -q -i 'https://pypi.tuna.tsinghua.edu.cn/simple' -r (Join-Path $Root 'requirements.txt')
if ($LASTEXITCODE -ne 0) { Write-Host "FAIL: pip install 失败" -ForegroundColor Red; exit 1 }
Write-Host "  OK: venv 就绪"

# ---------------------------------------------------------------------------
# 3.5 runtime/wheels(离线安装兜底:setup 在无 runtime venv 时用 .NET ZipFile
#     直接解包 *.whl 进 site-packages,免 pip;与 venv 同版本平台 wheel 齐备)
# ---------------------------------------------------------------------------
Write-Host "[3.5/5] 离线 wheel 目录"
$WheelDir = Join-Path $RuntimeDir 'wheels'
New-Item -ItemType Directory -Path $WheelDir -Force | Out-Null
if (@(Get-ChildItem $WheelDir -Filter 'numpy-*.whl' -ErrorAction SilentlyContinue).Count -gt 0) {
    Write-Host "  OK: numpy wheel 已存在,跳过"
} else {
    Write-Host "  下载 numpy wheel(cp312)..."
    & (Join-Path $VenDir 'Scripts\pip.exe') download 'numpy>=2,<3' -d $WheelDir --only-binary=:all: --no-deps -i 'https://pypi.tuna.tsinghua.edu.cn/simple'
    if ($LASTEXITCODE -ne 0) { Write-Host "FAIL: numpy wheel 下载失败" -ForegroundColor Red; exit 1 }
    Write-Host "  OK: numpy wheel 就绪"
}

# ---------------------------------------------------------------------------
# 4. nest_gateway node_modules(复用宿主已验证依赖,ABI 匹配 node22)
#    源优先平台目录 node_modules.win(平台隔离),回退旧布局 node_modules
# ---------------------------------------------------------------------------
$NestedNodeModules = Join-Path $Root 'nest_gateway\node_modules.win'
if (-not (Test-Path $NestedNodeModules)) {
    $NestedNodeModules = Join-Path $Root 'nest_gateway\node_modules'
}
if ($SkipNodeModules) {
    Write-Host "[4/5] 跳过 node_modules(-SkipNodeModules)"
} elseif (Test-Path $NestedNodeModules) {
    Write-Host "[4/5] 复制宿主 node_modules(已验证,ABI 匹配 node22)..."
    if (Test-Path $RuntimeNodeModules) { Remove-Item $RuntimeNodeModules -Recurse -Force }
    Copy-Item $NestedNodeModules $RuntimeNodeModules -Recurse -Force
    Write-Host "  OK: node_modules 就绪"
} else {
    Write-Host "[4/5] 宿主 node_modules 不存在,用 npm install 构建..."
    $env:PATH = "$NodeDir;$env:PATH"
    $npmCli = Join-Path $NodeDir 'node_modules\npm\bin\npm-cli.js'
    Set-Location (Join-Path $Root 'nest_gateway')
    if (Test-Path $npmCli) {
        & $NodeBin $npmCli install --no-audit --no-fund --registry 'https://registry.npmmirror.com' --omit=dev
    } else {
        & npm install --no-audit --no-fund --registry 'https://registry.npmmirror.com' --omit=dev
    }
    if ($LASTEXITCODE -ne 0) { Write-Host "FAIL: npm install 失败" -ForegroundColor Red; exit 1 }
    if (Test-Path $RuntimeNodeModules) { Remove-Item $RuntimeNodeModules -Recurse -Force }
    Move-Item $NestedNodeModules $RuntimeNodeModules -Force
}
Set-Location $Root

# ---------------------------------------------------------------------------
# 5. 清单
# ---------------------------------------------------------------------------
$manifest = @{
    node        = (& $NodeBin --version) 2>&1
    python      = (& $PyBin --version) 2>&1
    venv        = (Test-Path (Join-Path $VenDir 'Scripts\python.exe'))
    node_modules = (Test-Path (Join-Path $RuntimeNodeModules 'better-sqlite3'))
    platform    = 'windows'
    built_at    = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    source      = '开发机已验证环境'
} | ConvertTo-Json
$manifest | Set-Content (Join-Path $RuntimeDir 'RUNTIME.json') -Encoding UTF8
Write-Host "  清单: $(Join-Path $RuntimeDir 'RUNTIME.json')"
Write-Host "================================================"
Write-Host " 构建完成。发布前确认 release.sh 会纳入 runtime/ 目录。"
Write-Host "================================================"
