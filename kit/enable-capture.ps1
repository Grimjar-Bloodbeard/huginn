<#
  enable-capture.ps1 - turn on Huginn's live packet view by installing Npcap.

  Huginn shows the devices and traffic without any driver. The live "sparks" (this PC's
  own packets moving on the map) need a capture driver: Npcap. This helper detects whether
  Npcap is already there, and if not, runs the official Npcap installer for you and checks
  that it took.

  Npcap is made by the Nmap project. Its free licence does NOT allow us to redistribute the
  installer, so this kit does not ship it. You download it once from the official site
  (https://npcap.com, free for a few machines) and drop it in the capture\ folder, or let
  this script fetch it with -Download. Either way it runs the real, signed Npcap installer,
  so whoever runs the network (IT) can see exactly what is being installed.

  A capture driver is a kernel driver. On a managed PC this is the step most likely to be
  blocked by endpoint protection (CrowdStrike and the like). Get it approved first; do not
  try to work around it.

  Usage (from the kit folder):
    powershell -ExecutionPolicy Bypass -File kit\enable-capture.ps1              detect, then install from capture\npcap-*.exe
    powershell -ExecutionPolicy Bypass -File kit\enable-capture.ps1 -Download    download the official installer first, then install
    powershell -ExecutionPolicy Bypass -File kit\enable-capture.ps1 -Status      only report whether Npcap is installed
    powershell -ExecutionPolicy Bypass -File kit\enable-capture.ps1 -Installer C:\path\npcap.exe
    optional: -Hash <sha256>   verify the installer matches a hash you trust before running
              -Version 1.82    which version to download (default below), or -Url <full url>
              -Silent          run the installer with no prompts (less transparent; interactive is default)

  No em dashes. PowerShell 5.1.
#>

param(
  [switch]$Status,
  [switch]$Download,
  [switch]$Silent,
  [string]$Installer,
  [string]$Hash,
  [string]$Version = "1.82",
  [string]$Url
)

$ErrorActionPreference = "Stop"
$KitDir     = $PSScriptRoot
$Root       = Split-Path -Parent $KitDir
$CaptureDir = Join-Path $Root "capture"

function Test-Npcap {
  if (Get-Service -Name npcap -ErrorAction SilentlyContinue) { return $true }
  if (Test-Path (Join-Path $env:SystemRoot "System32\Npcap\wpcap.dll")) { return $true }
  if (Test-Path (Join-Path $env:SystemRoot "System32\wpcap.dll")) { return $true }
  return $false
}
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}

if (Test-Npcap) {
  Write-Host "Npcap is already installed. Huginn's live packet view will work." -ForegroundColor Green
  exit 0
}
if ($Status) {
  Write-Host "Npcap is NOT installed. Huginn runs fine without it, but the live packet sparks are off." -ForegroundColor Yellow
  Write-Host "Run this script without -Status to install it (needs administrator and, on a managed PC, IT approval)."
  exit 1
}

Write-Host "Npcap is not installed yet. The live packet view needs it." -ForegroundColor Yellow

# Find or fetch the installer.
if (-not (Test-Path $CaptureDir)) { New-Item -ItemType Directory -Path $CaptureDir | Out-Null }
$pkg = $null
if ($Installer) {
  if (-not (Test-Path $Installer)) { Write-Host "No file at -Installer path: $Installer" -ForegroundColor Red; exit 1 }
  $pkg = (Resolve-Path $Installer).Path
} else {
  $local = Get-ChildItem -Path $CaptureDir -Filter "npcap*.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($local) { $pkg = $local.FullName }
}

if (-not $pkg -and $Download) {
  if (-not $Url) { $Url = "https://npcap.com/dist/npcap-$Version.exe" }
  $pkg = Join-Path $CaptureDir ("npcap-" + $Version + ".exe")
  Write-Host "Downloading the official installer from $Url ..."
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $pkg -UseBasicParsing
  } catch {
    Write-Host "Download failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Get it by hand from https://npcap.com (Downloads), save it into:`n  $CaptureDir`nthen run this again."
    exit 1
  }
}

if (-not $pkg) {
  Write-Host "No installer found. Do ONE of these:" -ForegroundColor Yellow
  Write-Host "  1. Download Npcap from https://npcap.com (free for a few machines), save the .exe into:"
  Write-Host "       $CaptureDir"
  Write-Host "     then run this script again; or"
  Write-Host "  2. Run this script with -Download to fetch it (needs internet)."
  exit 1
}

# Show the hash so you (and IT) can verify it against npcap.com before anything runs.
$sha = (Get-FileHash -Algorithm SHA256 -Path $pkg).Hash
Write-Host ""
Write-Host "Installer: $pkg"
Write-Host "SHA-256  : $sha"
Write-Host "Check this matches the hash shown for this version on https://npcap.com before you trust it."
if ($Hash) {
  if ($sha -ne $Hash.ToUpper().Replace(" ", "")) {
    Write-Host "STOP: the installer's SHA-256 does not match the -Hash you gave. Not running it." -ForegroundColor Red
    exit 1
  }
  Write-Host "Hash matches the value you supplied." -ForegroundColor Green
}

# Installing a driver needs administrator. Re-launch elevated if we are not.
if (-not (Test-Admin)) {
  Write-Host "`nThis needs administrator (it installs a driver). Asking for elevation..."
  $fwd = @("-NoProfile","-ExecutionPolicy","Bypass","-File","`"$PSCommandPath`"","-Installer","`"$pkg`"")
  if ($Silent) { $fwd += "-Silent" }
  if ($Hash)   { $fwd += @("-Hash", $Hash) }
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $fwd
  exit 0
}

Write-Host "`nLaunching the Npcap installer..." -ForegroundColor Cyan
if ($Silent) {
  Start-Process -FilePath $pkg -ArgumentList "/S" -Wait
} else {
  Write-Host "Follow its prompts (the defaults are fine). It is the official, signed Npcap installer."
  Start-Process -FilePath $pkg -Wait
}

Start-Sleep -Seconds 2
if (Test-Npcap) {
  Write-Host "`nDone. Npcap is installed. Start Huginn (Start.bat) and the live packet sparks will show." -ForegroundColor Green
  exit 0
} else {
  Write-Host "`nNpcap still does not look installed. If the installer was blocked, that is likely endpoint protection (EDR). Check with whoever runs the PC." -ForegroundColor Yellow
  exit 1
}
