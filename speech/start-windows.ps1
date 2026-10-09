#Requires -Version 5.1
<#
.SYNOPSIS
    Start the cue local speech service (faster-whisper) unless it is already running.

.DESCRIPTION
    Duplicate-safe: if http://127.0.0.1:<port>/health already answers, nothing is started.
    Otherwise the venv pythonw.exe runs speech\server.py detached, so recognition keeps
    working while cue itself is restarted or quit. The service writes its own rotating log
    (%LOCALAPPDATA%\cue-speech\logs\server.log); pythonw has no console to write to.

    Called at logon by the "cue-speech" scheduled task that install-windows.ps1 registers,
    and safe to run by hand at any time.

.PARAMETER Port
    Service port. Default 8765 (must match the "URL" in cue settings).

.PARAMETER Model
    Whisper model. Only "small" is supported.

.PARAMETER ModelsDir
    Model cache directory. Default %LOCALAPPDATA%\cue-speech\models.

.PARAMETER Offline
    Never contact the network; use the already downloaded model only.

.PARAMETER Foreground
    Run in this console (Ctrl+C stops it) instead of detaching pythonw.

.PARAMETER HealthTimeoutSec
    How long to wait for /health after launching. Default 90.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File speech\start-windows.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File speech\start-windows.ps1 -Foreground
#>
[CmdletBinding()]
param(
    [int]$Port = 8765,
    [string]$Model = "small",
    [string]$ModelsDir = "",
    [switch]$Offline,
    [switch]$Foreground,
    [int]$HealthTimeoutSec = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$SpeechDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($env:CUE_SPEECH_HOME) {
    $HomeDir = $env:CUE_SPEECH_HOME
} elseif ($env:LOCALAPPDATA) {
    $HomeDir = Join-Path $env:LOCALAPPDATA "cue-speech"
} else {
    $HomeDir = Join-Path $HOME ".local\share\cue-speech"
}
if (-not $ModelsDir) { $ModelsDir = Join-Path $HomeDir "models" }
$LogFile = Join-Path $HomeDir "logs\server.log"
$VenvPython = Join-Path $HomeDir "venv\Scripts\python.exe"
$VenvPythonw = Join-Path $HomeDir "venv\Scripts\pythonw.exe"
$ServerPy = Join-Path $SpeechDir "server.py"
$HealthUrl = "http://127.0.0.1:$Port/health"

function Test-SpeechHealth {
    try {
        $response = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2 -ErrorAction Stop
        if ($response -and ($response.status -eq "ok")) { return $response }
    } catch {
        return $null
    }
    return $null
}

# Quote only what needs it, so paths with spaces or non-ASCII characters survive
# Start-Process (which joins -ArgumentList with plain spaces).
function ConvertTo-QuotedArgumentList {
    param([string[]]$Items)
    $quoted = foreach ($item in $Items) {
        if ($item -match '[\s"]' -or $item.Length -eq 0) {
            $escaped = [regex]::Replace($item, '(\\*)"', '$1$1\"')
            $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
            '"' + $escaped + '"'
        } else { $item }
    }
    return ($quoted -join " ")
}

$running = Test-SpeechHealth
if ($running) {
    Write-Output "[i] cue-speech is already running: model=$($running.model) url=$HealthUrl"
    exit 0
}

if (-not (Test-Path -LiteralPath $VenvPython)) {
    Write-Output "[!] venv python not found: $VenvPython"
    Write-Output "[!] run speech\install-windows.ps1 first"
    exit 1
}
if (-not (Test-Path -LiteralPath $ServerPy)) {
    Write-Output "[!] server.py not found: $ServerPy"
    exit 1
}

$serverArgs = @($ServerPy, "--port", "$Port", "--model", $Model, "--models-dir", $ModelsDir, "--log-file", $LogFile)
if ($Offline) { $serverArgs += "--offline" }

if ($Foreground) {
    Write-Output "[i] running cue-speech in the foreground (Ctrl+C stops it); log: $LogFile"
    & $VenvPython -u @serverArgs
    exit $LASTEXITCODE
}

$pythonw = if (Test-Path -LiteralPath $VenvPythonw) { $VenvPythonw } else { $VenvPython }
$process = Start-Process -FilePath $pythonw `
    -ArgumentList (ConvertTo-QuotedArgumentList -Items $serverArgs) `
    -WorkingDirectory $SpeechDir -WindowStyle Hidden -PassThru
Write-Output "[i] started cue-speech (pid $($process.Id)); waiting for $HealthUrl"

$deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 750
    $health = Test-SpeechHealth
    if ($health) {
        Write-Output "[OK] cue-speech ready: model=$($health.model) url=$HealthUrl log=$LogFile"
        exit 0
    }
}

Write-Output "[!] cue-speech did not answer on $HealthUrl within $HealthTimeoutSec s"
Write-Output "[!] check the log: $LogFile"
exit 1
