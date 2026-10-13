<#
.SYNOPSIS
  Reverts everything scripts\install-tasks.ps1 set up, including the processes the tasks leave behind.

.DESCRIPTION
  1. Runs install-tasks.ps1 -Uninstall: stops and unregisters speculation-tick, speculation-score, server and
     bot in \krypto-kal\, then deletes the task folder if it is empty.
  2. Stops the processes those tasks started and Task Scheduler cannot stop (see STOPPING in install-tasks.ps1):
     the MCP server, the bot launcher with its trader and watchdog, and a running tick or score, plus the
     headless conhost.exe and cmd.exe parents of those. They are found by command line (the same npm scripts
     the tasks run), so a server or bot you started by hand is stopped too.

  Not touched: .env, the SQLite files and logs in ~\.krypto-kal\ (cache, bot.db, automation state, stats), and the
  vault. They are data, not setup; delete them yourself if you want a clean slate.

.PARAMETER WhatIf
  Prints what would be removed or stopped and changes nothing.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-tasks.ps1 -WhatIf
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-tasks.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$DryRun = [bool]$WhatIfPreference

function Write-Line([string]$Text) { Write-Host $Text }

# ------------------------------------------------------------------------------------------------- tasks
Write-Line '== Scheduled tasks =='
$installer = Join-Path $PSScriptRoot 'install-tasks.ps1'
if ($DryRun) { & $installer -Uninstall -WhatIf } else { & $installer -Uninstall }

# --------------------------------------------------------------------------------------------- processes
# Command-line fragments of what the tasks run (npm scripts: start, run bot, run auto) and of the node children
# those spawn. Slashes are normalised before matching.
$patterns = @(
  'src/server/mcp-server.ts',
  'src/bot/',
  'src/automation/cli.ts',
  'config/bot.auto.json',
  'KRYPTO_KAL_TASK'
)

function Test-Ours([string]$CommandLine) {
  if (-not $CommandLine) { return $false }
  $norm = $CommandLine -replace '\\', '/'
  foreach ($p in $patterns) { if ($norm.Contains($p)) { return $true } }
  return $false
}

Write-Line ''
Write-Line '== Leftover processes =='
$all = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe' OR Name='conhost.exe'")
$ours = @($all | Where-Object { $_.ProcessId -ne $PID -and (Test-Ours $_.CommandLine) })
# Plus the headless conhost.exe of a task: it is the parent of a matched cmd.exe, but its own command line does not match.
$targets = @($ours) + @($all | Where-Object {
    $pp = $_.ProcessId
    $_.Name -eq 'conhost.exe' -and $_.CommandLine -match '--headless' -and
      @($ours | Where-Object { $_.ParentProcessId -eq $pp }).Count -gt 0
  })
$targets = @($targets | Sort-Object ProcessId -Unique)

if ($targets.Count -eq 0) {
  Write-Line 'No leftover processes.'
} else {
  foreach ($t in $targets) {
    $cmd = $t.CommandLine
    if ($cmd.Length -gt 110) { $cmd = $cmd.Substring(0, 110) + '...' }
    if ($DryRun) { Write-Line ("WhatIf: would stop {0} {1}: {2}" -f $t.Name, $t.ProcessId, $cmd) }
    if ($PSCmdlet.ShouldProcess("$($t.Name) $($t.ProcessId)", 'Stop process tree')) {
      # taskkill /t ends the whole tree, so later entries may already be gone: that is not an error. The
      # redirect is done by cmd, because PowerShell 5.1 turns native stderr into a terminating error under Stop.
      if ($null -eq (Get-Process -Id $t.ProcessId -ErrorAction SilentlyContinue)) {
        Write-Line ("Already gone {0} {1}" -f $t.Name, $t.ProcessId)
        continue
      }
      & cmd.exe /c "taskkill /pid $($t.ProcessId) /t /f >nul 2>&1"
      Write-Line ("Stopped {0} {1}: {2}" -f $t.Name, $t.ProcessId, $cmd)
    }
  }
}

if ($DryRun) { Write-Line "`nWhatIf: nothing was changed." } else { Write-Line "`nDone." }
