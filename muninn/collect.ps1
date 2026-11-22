# Home lab collector. Windows 10 PowerShell 5.1. Admin recommended.
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Out = Join-Path $Root "reports\$Stamp"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function Write-Info($name, $data) {
    $path = Join-Path $Out $name
    $data | Out-File -FilePath $path -Encoding UTF8
}

$hostInfo = [pscustomobject]@{
    Computer     = $env:COMPUTERNAME
    User         = $env:USERNAME
    OS           = (Get-CimInstance Win32_OperatingSystem).Caption
    Time         = (Get-Date).ToString("s")
    IsAdmin      = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
Write-Info "00-host.txt" ($hostInfo | Format-List | Out-String)

# host.json: the same, plus this computer's network addresses and hardware IDs, so Huginn can put the
# report on the right device on its map. Read-only, like everything else here.
$addrs = @()
try {
    $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | ForEach-Object {
        $ad = Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue
        [pscustomobject]@{ ip = $_.IPAddress; mac = if ($ad) { $ad.MacAddress -replace "-", ":" } else { $null }; adapter = $_.InterfaceAlias }
    }
} catch { }
[pscustomobject]@{
    computer = $hostInfo.Computer; user = $hostInfo.User; os = $hostInfo.OS; time = $hostInfo.Time; isAdmin = $hostInfo.IsAdmin
    addresses = @($addrs)
} | ConvertTo-Json -Depth 4 | Out-File -FilePath (Join-Path $Out "host.json") -Encoding UTF8

$procs = Get-CimInstance Win32_Process | ForEach-Object {
    $path = $_.ExecutablePath
    $sig  = $null
    $status = "no-path"
    if ($path -and (Test-Path $path)) {
        try {
            $s = Get-AuthenticodeSignature -FilePath $path -ErrorAction Stop
            $status = [string]$s.Status
            if ($s.SignerCertificate) { $sig = $s.SignerCertificate.Subject }
        } catch {
            $status = "error"
        }
    }
    [pscustomobject]@{
        Pid        = $_.ProcessId
        Name       = $_.Name
        Path       = $path
        Command    = $_.CommandLine
        User       = (Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue).User  # CIM objects have no .GetOwner() (that was WMI); fixed 2026-11-21
        SigStatus  = $status
        Signer     = $sig
    }
}
$procs | Sort-Object Name | Export-Csv (Join-Path $Out "01-processes.csv") -NoTypeInformation -Encoding UTF8

try {
    Get-NetTCPConnection -ErrorAction Stop |
        Select-Object LocalAddress, LocalPort, RemoteAddress, RemotePort, State, OwningProcess |
        Export-Csv (Join-Path $Out "02-net-tcp.csv") -NoTypeInformation -Encoding UTF8
} catch {
    netstat -ano | Out-File (Join-Path $Out "02-netstat.txt") -Encoding UTF8
}

$runKeys = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
)
$startup = foreach ($key in $runKeys) {
    if (Test-Path $key) {
        Get-ItemProperty $key | ForEach-Object {
            $_.PSObject.Properties |
                Where-Object { $_.Name -notmatch "^PS" } |
                ForEach-Object {
                    [pscustomobject]@{ Hive = $key; Name = $_.Name; Value = $_.Value }
                }
        }
    }
}
$startup | Export-Csv (Join-Path $Out "03-run-keys.csv") -NoTypeInformation -Encoding UTF8

Get-CimInstance Win32_StartupCommand |
    Select-Object Name, Command, Location, User |
    Export-Csv (Join-Path $Out "04-startup-command.csv") -NoTypeInformation -Encoding UTF8

try {
    Get-ScheduledTask | ForEach-Object {
        $info = $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
        $actions = ($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join " | "
        [pscustomobject]@{
            TaskName = $_.TaskName
            Path     = $_.TaskPath
            State    = $_.State
            LastRun  = $info.LastRunTime
            Actions  = $actions
        }
    } | Export-Csv (Join-Path $Out "05-scheduled-tasks.csv") -NoTypeInformation -Encoding UTF8
} catch {
    schtasks /query /fo LIST /v | Out-File (Join-Path $Out "05-scheduled-tasks.txt") -Encoding UTF8
}

Get-CimInstance Win32_Service |
    Select-Object Name, DisplayName, State, StartMode, PathName, StartName |
    Export-Csv (Join-Path $Out "06-services.csv") -NoTypeInformation -Encoding UTF8

"Report written to $Out" | Tee-Object (Join-Path $Out "DONE.txt")
Write-Host "Report written to $Out"
