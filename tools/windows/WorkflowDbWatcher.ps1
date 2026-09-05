param(
    [string]$WatchPath = "",
    [string]$ApiUrl = "http://127.0.0.1:8009/api/watcher/events",
    [string]$OncePath = "",
    [string]$EventType = "changed"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Send-WorkflowDbEvent {
    param(
        [Parameter(Mandatory = $true)][string]$ApiUrl,
        [Parameter(Mandatory = $true)][string]$EventType,
        [Parameter(Mandatory = $true)][string]$FullPath,
        [string]$OldFullPath = ""
    )
    $body = @{
        event_type = $EventType
        full_path = $FullPath
        old_full_path = $OldFullPath
        timestamp = [DateTimeOffset]::Now.ToString("o")
    } | ConvertTo-Json -Depth 4
    Invoke-RestMethod -Uri $ApiUrl -Method Post -ContentType "application/json" -Body $body | Out-Null
}

if ($OncePath) {
    Send-WorkflowDbEvent -ApiUrl $ApiUrl -EventType $EventType -FullPath $OncePath
    Write-Host "sent event_type=$EventType path=$OncePath"
    exit 0
}

$watcher = New-Object System.IO.FileSystemWatcher
# WatchPath 必填(不再硬编码开发机路径):连续监听模式必须显式传入
if (-not $WatchPath) {
    Write-Error "WatchPath 未指定。连续监听模式下必须通过 -WatchPath 传入要监听的目录(仅 -OncePath 通知可省略)。"
    exit 1
}
if (-not (Test-Path -LiteralPath $WatchPath)) {
    Write-Error "WatchPath 不存在: $WatchPath"
    exit 1
}
$watcher.Path = $WatchPath
$watcher.IncludeSubdirectories = $true
$watcher.Filter = "*.*"
$watcher.NotifyFilter = [System.IO.NotifyFilters]'FileName, LastWrite, CreationTime, DirectoryName, Size'
$watcher.EnableRaisingEvents = $true

# Store API URL in global scope so event action blocks can access it
$global:WatcherApiUrl = $ApiUrl

$action = {
    param($sender, $eventArgs)
    $path = $eventArgs.FullPath
    if (-not $path) {
        return
    }
    $ext = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
    if ($ext -notin @(".png", ".webp", ".jpg", ".jpeg")) {
        return
    }
    $eventType = $eventArgs.ChangeType.ToString().ToLowerInvariant()
    $oldPath = ""
    if ($eventArgs -is [System.IO.RenamedEventArgs]) {
        $oldPath = $eventArgs.OldFullPath
    }
    try {
        Send-WorkflowDbEvent -ApiUrl $global:WatcherApiUrl -EventType $eventType -FullPath $path -OldFullPath $oldPath
        Write-Host ("[{0}] {1} {2}" -f ([DateTimeOffset]::Now.ToString("o")), $eventType, $path)
    }
    catch {
        Write-Warning ("watcher event post failed: {0}" -f $_.Exception.Message)
    }
}

$subscriptions = @(
    Register-ObjectEvent -InputObject $watcher -EventName Created -Action $action
    Register-ObjectEvent -InputObject $watcher -EventName Changed -Action $action
    Register-ObjectEvent -InputObject $watcher -EventName Deleted -Action $action
    Register-ObjectEvent -InputObject $watcher -EventName Renamed -Action $action
)

Write-Host "WorkflowDbWatcher listening on $WatchPath -> $ApiUrl"
try {
    while ($true) {
        Wait-Event -Timeout 1 | Out-Null
    }
}
finally {
    foreach ($subscription in $subscriptions) {
        if ($null -ne $subscription) {
            Unregister-Event -SubscriptionId $subscription.Id -ErrorAction SilentlyContinue
            Remove-Job -Id $subscription.Id -Force -ErrorAction SilentlyContinue
        }
    }
    $watcher.Dispose()
}
