#Requires -Version 5.1
<#
.SYNOPSIS
    Install the cue local speech service: per-user venv, pinned dependencies, model cache,
    and an optional logon autostart task.

.DESCRIPTION
    Everything lives under the current user's profile - nothing is written into the cue
    repository and nothing outside %LOCALAPPDATA%\cue-speech is modified:

        %LOCALAPPDATA%\cue-speech\venv     isolated Python environment
        %LOCALAPPDATA%\cue-speech\models   Whisper model cache (large, never in the repo)
        %LOCALAPPDATA%\cue-speech\logs     server log

    No administrator rights are required. The script is idempotent: an existing venv is
    reused and only the pinned requirements are (re)applied; existing models are kept.
    It never deletes anything except its own scheduled task with -RemoveAutostart.

    Steps: resolve Python -> create/reuse venv -> pip install -r requirements.txt ->
    download and verify the model -> register the "cue-speech" logon task -> start the
    service (duplicate-safe).

.PARAMETER PythonExe
    Base Python 3.10+ interpreter used to create the venv. Auto-detected when omitted.

.PARAMETER ModelsDir
    Model cache directory. Default %LOCALAPPDATA%\cue-speech\models.

.PARAMETER Port
    Service port. Default 8765 (must match the "URL" in cue settings).

.PARAMETER Model
    Whisper model to serve. Only "small" is supported.

.PARAMETER SkipModelDownload
    Do not pre-download the model; it is fetched on first service start instead.

.PARAMETER SkipAutostart
    Do not register the logon task (service must then be started by hand).

.PARAMETER SkipStart
    Do not start the service at the end of the installation.

.PARAMETER RemoveAutostart
    Unregister the "cue-speech" logon task and exit. Files are left untouched.

.PARAMETER Offline
    Passed to the service: never contact the network, use the cached model only.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File speech\install-windows.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File speech\install-windows.ps1 -SkipAutostart
#>
[CmdletBinding()]
param(
    [string]$PythonExe = "",
    [string]$ModelsDir = "",
    [int]$Port = 8765,
    [string]$Model = "small",
    [switch]$SkipModelDownload,
    [switch]$SkipAutostart,
    [switch]$SkipStart,
    [switch]$RemoveAutostart,
    [switch]$Offline
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$SpeechDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerPy = Join-Path $SpeechDir "server.py"
$Requirements = Join-Path $SpeechDir "requirements.txt"
$StartScript = Join-Path $SpeechDir "start-windows.ps1"
$TaskName = "cue-speech"

if ($env:CUE_SPEECH_HOME) {
    $HomeDir = $env:CUE_SPEECH_HOME
} elseif ($env:LOCALAPPDATA) {
    $HomeDir = Join-Path $env:LOCALAPPDATA "cue-speech"
} else {
    $HomeDir = Join-Path $HOME ".local\share\cue-speech"
}
$VenvDir = Join-Path $HomeDir "venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
if (-not $ModelsDir) { $ModelsDir = Join-Path $HomeDir "models" }
$LogFile = Join-Path $HomeDir "logs\server.log"

function Remove-SpeechAutostart {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "[OK] removed logon task '$TaskName'"
    } else {
        Write-Output "[i] no logon task '$TaskName' to remove"
    }
}

# Quote only what needs it, so paths with spaces or non-ASCII characters survive
# Start-Process / the scheduled-task command line (both split on plain spaces).
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

# Resolve a PowerShell executable for the task action and the child start call.
# $PSHOME is the *current* host's home, so under pwsh 7 it points at pwsh.exe's
# folder, which has no powershell.exe. Windows PowerShell 5.1 is always present,
# and both scripts run on it, so prefer it; fall back to the current host.
function Resolve-PowerShellHost {
    $windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (Test-Path -LiteralPath $windowsPowerShell) { return $windowsPowerShell }
    $current = (Get-Process -Id $PID).Path
    if ($current -and (Test-Path -LiteralPath $current)) { return $current }
    return "powershell.exe"
}

function Resolve-BasePython {
    param([string]$Explicit)

    $candidates = New-Object System.Collections.ArrayList
    if ($Explicit) { [void]$candidates.Add($Explicit) }
    if ($env:CUE_SPEECH_PYTHON) { [void]$candidates.Add($env:CUE_SPEECH_PYTHON) }
    [void]$candidates.Add("py")
    [void]$candidates.Add("python")
    if ($env:LOCALAPPDATA) {
        [void]$candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"))
        [void]$candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"))
    }

    foreach ($candidate in $candidates) {
        $isLauncher = ($candidate -eq "py")
        $exe = $candidate
        if (-not (Test-Path -LiteralPath $candidate)) {
            $command = Get-Command -Name $candidate -CommandType Application -ErrorAction SilentlyContinue
            if (-not $command) { continue }
            $exe = $command.Source
        }
        $arguments = @()
        if ($isLauncher) { $arguments += "-3" }
        $arguments += @("-c", "import sys;print(sys.executable);print('%d.%d' % sys.version_info[:2])")
        try {
            $output = & $exe @arguments 2>$null
        } catch {
            continue
        }
        if ($LASTEXITCODE -ne 0 -or -not $output) { continue }
        $path = @($output)[0]
        $version = @($output)[1]
        if ($version) {
            $parts = $version.Split(".")
            if ([int]$parts[0] -lt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -lt 10)) {
                Write-Output "[i] skipping $path (Python $version is older than 3.10)"
                continue
            }
        }
        return $path
    }
    return ""
}

Write-Output "[i] cue-speech home: $HomeDir"

if ($RemoveAutostart) {
    Remove-SpeechAutostart
    exit 0
}

if (-not (Test-Path -LiteralPath $ServerPy)) {
    Write-Output "[!] server.py not found next to this script: $ServerPy"
    exit 1
}
if (-not (Test-Path -LiteralPath $Requirements)) {
    Write-Output "[!] requirements.txt not found next to this script: $Requirements"
    exit 1
}

# --- 1. base interpreter -----------------------------------------------------
$basePython = Resolve-BasePython -Explicit $PythonExe
if (-not $basePython) {
    Write-Output "[!] no Python 3.10+ found. Install Python 3.12 (python.org, 'Add python.exe to PATH')"
    Write-Output "[!] or re-run with: -PythonExe C:\path\to\python.exe"
    exit 1
}
Write-Output "[i] base interpreter: $basePython"

# --- 2. per-user venv (reused if present) ------------------------------------
if (Test-Path -LiteralPath $VenvPython) {
    Write-Output "[i] reusing existing venv: $VenvDir"
} else {
    Write-Output "[i] creating venv: $VenvDir"
    New-Item -ItemType Directory -Path $HomeDir -Force | Out-Null
    & $basePython -m venv $VenvDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $VenvPython)) {
        Write-Output "[!] failed to create the venv at $VenvDir"
        exit 1
    }
}

# --- 3. pinned dependencies --------------------------------------------------
Write-Output "[i] installing pinned dependencies (faster-whisper, fastapi, uvicorn, ...)"
& $VenvPython -m pip install --disable-pip-version-check --no-input -r $Requirements
if ($LASTEXITCODE -ne 0) {
    Write-Output "[!] pip install failed (exit $LASTEXITCODE); fix the error above and re-run this script"
    exit 1
}

# --- 4. model download / verification ---------------------------------------
$modelArgs = @($ServerPy, "--download-model", "--model", $Model, "--models-dir", $ModelsDir, "--log-file", $LogFile)
if ($Offline) { $modelArgs += "--offline" }
if ($SkipModelDownload) {
    Write-Output "[i] skipping the model download (-SkipModelDownload); the service fetches it on first start"
} else {
    Write-Output "[i] downloading/verifying model '$Model' into $ModelsDir (several hundred MB on first run)"
    & $VenvPython -u @modelArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Output "[!] model preparation failed (exit $LASTEXITCODE); re-run this script once the network is available"
        exit 1
    }
}

# --- 5. logon autostart task (no admin required) -----------------------------
if ($SkipAutostart) {
    Write-Output "[i] skipping autostart registration (-SkipAutostart)"
} else {
    try {
        $taskArgs = ConvertTo-QuotedArgumentList -Items @(
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
            "-File", $StartScript,
            "-Port", "$Port", "-Model", $Model, "-ModelsDir", $ModelsDir
        )
        if ($Offline) { $taskArgs += ' -Offline' }
        $action = New-ScheduledTaskAction -Execute (Resolve-PowerShellHost) `
            -Argument $taskArgs -WorkingDirectory $SpeechDir
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -StartWhenAvailable -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
            -Description "Starts the cue local speech service (faster-whisper) at logon. Removes with: install-windows.ps1 -RemoveAutostart" `
            -Force | Out-Null
        Write-Output "[OK] logon task '$TaskName' registered (current user, no admin needed)"
    } catch {
        Write-Output "[!] could not register the logon task: $($_.Exception.Message)"
        Write-Output "[!] the service still works; start it manually with speech\start-windows.ps1"
    }
}

# --- 6. start now (duplicate-safe) -------------------------------------------
if ($SkipStart) {
    Write-Output "[i] skipping start (-SkipStart)"
} else {
    $startArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $StartScript, '-Port', "$Port", '-Model', $Model, '-ModelsDir', $ModelsDir)
    if ($Offline) { $startArgs += '-Offline' }
    & (Resolve-PowerShellHost) @startArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Output "[!] the service did not come up; see $LogFile"
        exit 1
    }
}

Write-Output ""
Write-Output "[OK] cue-speech installed."
Write-Output "     endpoint : http://127.0.0.1:$Port/v1"
Write-Output "     health   : http://127.0.0.1:$Port/health"
Write-Output "     venv     : $VenvPython"
Write-Output "     models   : $ModelsDir"
Write-Output "     log      : $LogFile"
exit 0
