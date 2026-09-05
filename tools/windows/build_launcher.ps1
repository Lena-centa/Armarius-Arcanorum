# ============================================================================
# 编译双击启动器 exe(Windows 发布包用,零基础用户免 PowerShell 交互)
#
# 用法:
#   .\build_launcher.ps1                      # 编译到本目录
#   .\build_launcher.ps1 -OutDir D:\tmp\pkg   # 指定输出目录
#
# 产物:deploy.exe(双击=一键部署)、start.exe(双击=启动,参数透传)。
# exe 只是启动器:内部调用同目录 ps1(powershell -ExecutionPolicy Bypass -File),
# 等待退出并透传退出码;逻辑全在 ps1 内,可维护可测试。
# 编译用 Windows 自带 .NET Framework(Add-Type → csc),离线可用;
# 仅 Windows 平台适用,由 release.sh 在 Windows 打包时调用。
# ============================================================================
param([string]$OutDir = (Split-Path -Parent $MyInvocation.MyCommand.Path))

$ErrorActionPreference = 'Stop'

$Template = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

class Program
{
    static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(dir, "{{PS1}}");
        if (!File.Exists(script))
        {
            Console.Error.WriteLine("缺少 " + Path.GetFileName(script) + ",请确认与启动器在同一目录");
            return 1;
        }
        string defaultArgs = "{{DEFAULT_ARGS}}";
        string all = defaultArgs;
        if (args.Length > 0)
        {
            all = string.Join(" ", args.Select(a => "\"" + a.Replace("\"", "\\\"") + "\""));
        }
        var psi = new ProcessStartInfo("powershell.exe",
            "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\""
            + (all.Length > 0 ? " " + all : ""))
        {
            WorkingDirectory = dir,
            UseShellExecute = false
        };
        try
        {
            Process p = Process.Start(psi);
            p.WaitForExit();
            return p.ExitCode;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("启动失败: " + ex.Message);
            return 1;
        }
    }
}
'@

$Launchers = @(
    @{ Name = 'deploy.exe';       Ps1 = 'deploy.ps1';       DefaultArgs = '' },
    @{ Name = 'start.exe';       Ps1 = 'start.ps1';       DefaultArgs = 'start' }
)

foreach ($l in $Launchers) {
    $code = $Template.Replace('{{PS1}}', $l.Ps1).Replace('{{DEFAULT_ARGS}}', $l.DefaultArgs)
    $out = Join-Path $OutDir $l.Name
    try {
        Add-Type -TypeDefinition $code -OutputAssembly $out -OutputType ConsoleApplication
        Write-Host "OK: $out"
    } catch {
        Write-Host "FAIL: 编译 $($l.Name) 失败: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}
