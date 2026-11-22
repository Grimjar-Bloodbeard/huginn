# Marks likely-odd items. Not a verdict.
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Reports = Join-Path $Root "reports"
$Latest = Get-ChildItem $Reports -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $Latest) {
    Write-Host "No reports folder yet. Run collect.ps1 first."
    exit 1
}
$Out = $Latest.FullName
$Flags = Join-Path $Out "FLAGS.txt"
$lines = New-Object System.Collections.Generic.List[string]
$json = [ordered]@{ report = $Latest.Name; processes = @(); runKeys = @(); tasks = @(); services = @() }   # flags.json, for Huginn
$lines.Add("TRIAGE $($Latest.Name)")
$lines.Add("This is a flag list. Confirm by hand.")
$lines.Add("")

$badPath = {
    param($p)
    if (-not $p) { return $false }
    $l = $p.ToLower()
    return (
        $l -match "\\users\\[^\\]+\\downloads\\" -or
        $l -match "\\appdata\\local\\temp\\" -or
        $l -match "\\windows\\temp\\" -or
        $l -match "\\appdata\\roaming\\" -or
        $l -match "\\appdata\\local\\" -or
        $l -match "\\programdata\\"
    )
}

$procFile = Join-Path $Out "01-processes.csv"
if (Test-Path $procFile) {
    $lines.Add("== PROCESSES ==")
    Import-Csv $procFile | ForEach-Object {
        $path = $_.Path
        $sig  = $_.SigStatus
        $oddSig = $sig -and $sig -ne "Valid" -and $path
        $oddLoc = & $badPath $path
        if ($oddSig -or $oddLoc) {
            $lines.Add(("PID {0}  {1}  sig={2}  {3}" -f $_.Pid, $_.Name, $sig, $path))
            $json.processes += [pscustomobject]@{ pid = $_.Pid; name = $_.Name; sig = $sig; path = $path }
        }
    }
    $lines.Add("")
}

$runFile = Join-Path $Out "03-run-keys.csv"
if (Test-Path $runFile) {
    $lines.Add("== RUN KEYS ==")
    Import-Csv $runFile | ForEach-Object {
        $lines.Add(("{0}  {1} = {2}" -f $_.Hive, $_.Name, $_.Value))
        $json.runKeys += [pscustomobject]@{ hive = $_.Hive; name = $_.Name; value = $_.Value }
    }
    $lines.Add("")
}

$taskFile = Join-Path $Out "05-scheduled-tasks.csv"
if (Test-Path $taskFile) {
    $lines.Add("== TASKS WITH USER-ISH PATHS ==")
    Import-Csv $taskFile | ForEach-Object {
        if (& $badPath $_.Actions) {
            $lines.Add(("{0}{1}  {2}" -f $_.Path, $_.TaskName, $_.Actions))
            $json.tasks += [pscustomobject]@{ name = "$($_.Path)$($_.TaskName)"; action = $_.Actions }
        }
    }
    $lines.Add("")
}

$svcFile = Join-Path $Out "06-services.csv"
if (Test-Path $svcFile) {
    $lines.Add("== SERVICES WITH USER-ISH PATHS ==")
    Import-Csv $svcFile | ForEach-Object {
        if (& $badPath $_.PathName) {
            $lines.Add(("{0}  {1}  {2}" -f $_.Name, $_.State, $_.PathName))
            $json.services += [pscustomobject]@{ name = $_.Name; state = $_.State; path = $_.PathName }
        }
    }
}

$lines.Add("")
$lines.Add("NEXT")
$lines.Add("1. Open FLAGS.txt")
$lines.Add("2. If a process looks fake, open Process Explorer and Suspend, do not Kill first.")
$lines.Add("3. Open Autoruns, hide Microsoft/Windows entries, uncheck the odd ones.")
$lines.Add("4. Reboot and see if they stay off.")

$lines | Out-File $Flags -Encoding UTF8
$json | ConvertTo-Json -Depth 4 | Out-File (Join-Path $Out "flags.json") -Encoding UTF8
Write-Host "Flags written to $Flags"
