[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$ServerPid,

    [Parameter(Mandatory = $true)]
    [string]$LocalAddress,

    [ValidateRange(1024, 65535)]
    [int]$Port = 8766,

    [string]$NodePath = 'C:\Program Files\nodejs\node.exe'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Require-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator elevation is required. No firewall rule was created.'
    }
}

function Get-ServerProcess {
    Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ServerPid" -ErrorAction SilentlyContinue
}

Require-Administrator

$parsedAddress = $null
if (-not [Net.IPAddress]::TryParse($LocalAddress, [ref]$parsedAddress) -or $parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
    throw 'LocalAddress must be a valid IPv4 address.'
}

if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw 'NodePath does not point to an existing executable.'
}

$nodeFullPath = [IO.Path]::GetFullPath($NodePath)
$repoRoot = Split-Path -Parent $PSCommandPath
$serverScript = Join-Path $repoRoot 'video-server.cjs'
if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) {
    throw 'video-server.cjs must be beside this helper script.'
}

$process = Get-ServerProcess
if (-not $process) {
    throw "Server PID $ServerPid is not running."
}

if ([string]::IsNullOrWhiteSpace($process.ExecutablePath) -or -not [string]::Equals([IO.Path]::GetFullPath($process.ExecutablePath), $nodeFullPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Server PID is not the requested node executable.'
}

if ([string]::IsNullOrWhiteSpace($process.CommandLine) -or $process.CommandLine.IndexOf($serverScript, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw 'Server PID was not started with this repository video-server.cjs.'
}

$creationDate = $process.CreationDate
$ruleName = 'PixelTVVideoTestLAN-' + $ServerPid + '-' + [Guid]::NewGuid().ToString('N')
$ruleCreated = $false

function Test-OriginalServerStillRunning {
    $current = Get-ServerProcess
    if (-not $current -or $current.CreationDate -ne $creationDate) { return $false }
    if ([string]::IsNullOrWhiteSpace($current.ExecutablePath) -or -not [string]::Equals([IO.Path]::GetFullPath($current.ExecutablePath), $nodeFullPath, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    return -not [string]::IsNullOrWhiteSpace($current.CommandLine) -and $current.CommandLine.IndexOf($serverScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

try {
    New-NetFirewallRule -Name $ruleName -DisplayName $ruleName -Description 'Temporary Pixel TV isolated video-test LAN access; removed when its Node server exits.' -Direction Inbound -Action Allow -Program $nodeFullPath -Protocol TCP -LocalPort $Port -LocalAddress $parsedAddress.IPAddressToString -RemoteAddress LocalSubnet -Profile Any -EdgeTraversalPolicy Block | Out-Null
    $ruleCreated = $true
    Write-Host "Temporary LAN rule enabled for $($parsedAddress.IPAddressToString):$Port (LocalSubnet only)."
    Write-Host 'It will be removed when the verified video server stops, its PID changes, or four hours pass.'

    $deadline = (Get-Date).AddHours(4)
    while ((Get-Date) -lt $deadline -and (Test-OriginalServerStillRunning)) {
        Start-Sleep -Seconds 5
    }
}
finally {
    if ($ruleCreated) {
        Remove-NetFirewallRule -Name $ruleName -ErrorAction Stop
        Write-Host 'Temporary LAN rule removed.'
    }
}
