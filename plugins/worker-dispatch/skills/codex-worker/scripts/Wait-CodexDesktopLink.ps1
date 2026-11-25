#Requires -Version 7
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$StatusFile,
    [Parameter(Mandatory)] [int]$RunnerPid,
    [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'
$runner = Get-Process -Id $RunnerPid -ErrorAction SilentlyContinue
$timer = [Diagnostics.Stopwatch]::StartNew()
try {
    while ($true) {
        $exited = -not $runner -or $runner.HasExited
        if ([IO.File]::Exists($StatusFile)) {
            try {
                $stream = [IO.FileStream]::new($StatusFile, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
                $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false))
                try { $json = $reader.ReadToEnd() } finally { $reader.Dispose() }
                $status = ConvertFrom-Json -InputObject $json -ErrorAction Stop
            } catch [IO.IOException], [ArgumentException] {
                if ($exited) { throw }
                $status = $null
            }
            if ($status.desktopUrl -and $status.state -in @('starting', 'running', 'finished')) {
                Write-Output $status.desktopUrl
                return
            }
            if ($status -and $status.state -notin @('starting', 'running')) {
                $detail = if ($status.error) { $status.error } else { "state=$($status.state)" }
                throw "Codex ended before publishing desktopUrl: $detail"
            }
        }
        if ($exited) { throw "Codex runner $RunnerPid exited without publishing a desktop link." }
        if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
            throw "Timed out after $TimeoutSeconds seconds waiting for Codex desktopUrl."
        }
        [void]$runner.WaitForExit(250)
    }
} finally {
    if ($runner) { $runner.Dispose() }
}
