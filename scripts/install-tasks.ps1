<#
.SYNOPSIS
  Installs (or removes) the Windows Task Scheduler tasks of the speculation automation.

.DESCRIPTION
  Registers four tasks in the task folder \krypto-kal\, all defined in ONE table ($Tasks below), so the
  -WhatIf plan and the real install are built from the same definitions:

    speculation-tick   npm run auto -- tick   (BOT_CONFIG=config\bot.auto.json)
                       twelve daily triggers at 00:00Z, 02:00Z ... 22:00Z (start boundaries in UTC),
                       each repeated every 10 minutes for 40 minutes (retries; the tick is idempotent),
                       plus at logon and on wake from sleep (Power-Troubleshooter event 1).
                       Ignores a new start while one runs, stops after 30 minutes, starts when available.
    speculation-score  npm run auto -- score  (BOT_CONFIG=config\bot.auto.json), daily 23:30 local.
    server             npm start, at logon, restart every minute up to 999 times, no time limit.
    bot                npm run bot -- run --config config/bot.auto.json, at logon delayed 1 minute
                       (so the server is up), same restart settings, no time limit.

  All tasks run as the current user, only while that user is logged on (no stored password, limited
  privileges). The working directory is the repo root, resolved from this script's location.

  LIMITATION (DST): Task Scheduler normally works in local time. The tick triggers are written with UTC
  start boundaries ("2026-10-13T02:00:00Z", the "synchronize across time zones" option), which Task
  Scheduler is documented to keep on the UTC clock, so the grid should survive a daylight-saving change.
  This is not yet verified on this machine: after the next DST change (last Sunday of March or October in
  Europe) check the tasks' next run times; if they moved by an hour, re-run this script, which recomputes
  everything. A late tick still catches up (the tick is idempotent and finds the due slot), so a shifted
  trigger delays a report by up to an hour; it does not lose it. The score task is deliberately local time
  (23:30 on the local clock, no zone designator).

.PARAMETER Uninstall
  Removes every task in the \krypto-kal\ folder (and the folder itself). Nothing outside that folder.

.PARAMETER WhatIf
  Prints the plan (tasks to create or remove) and changes nothing.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-tasks.ps1 -WhatIf
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-tasks.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-tasks.ps1 -Uninstall
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Uninstall
)

# -WhatIf is the common parameter that SupportsShouldProcess adds; it sets $WhatIfPreference. This script
# checks it itself (prints the plan and returns before any change) AND every state-changing call goes through
# $PSCmdlet.ShouldProcess, which also passes -WhatIf down to the cmdlets, so a bug cannot change anything.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$TaskPath = '\krypto-kal\'
$DryRun = [bool]$WhatIfPreference
$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$UserId = "$env:USERDOMAIN\$env:USERNAME"

function Write-Line([string]$Text) { Write-Host $Text }

# Load the modules up front with WhatIf off: their auto-import only defines aliases, and under -WhatIf it would
# otherwise print a "Set Alias" line for each of them.
& { $WhatIfPreference = $false; Import-Module ScheduledTasks, CimCmdlets -Global }

# ---------------------------------------------------------------------------------------------- uninstall
if ($Uninstall) {
  $existing = @(Get-ScheduledTask -TaskPath $TaskPath -ErrorAction SilentlyContinue)
  if ($existing.Count -eq 0) {
    Write-Line "No tasks in $TaskPath; nothing to remove."
  }
  foreach ($t in $existing) {
    if ($DryRun) {
      Write-Line ("WhatIf: would remove task {0}{1}" -f $t.TaskPath, $t.TaskName)
    }
    if ($PSCmdlet.ShouldProcess("$($t.TaskPath)$($t.TaskName)", 'Unregister scheduled task')) {
      Unregister-ScheduledTask -TaskPath $t.TaskPath -TaskName $t.TaskName -Confirm:$false
      Write-Line ("Removed {0}{1}" -f $t.TaskPath, $t.TaskName)
    }
  }
  # Remove the then empty folder through the Task Scheduler COM API (there is no cmdlet for folders).
  $folderName = $TaskPath.Trim('\')
  if ($DryRun) {
    Write-Line "WhatIf: would remove the task folder $TaskPath if it exists and is empty"
  }
  if ($PSCmdlet.ShouldProcess($TaskPath, 'Delete task folder')) {
    try {
      $svc = New-Object -ComObject 'Schedule.Service'
      $svc.Connect()
      $svc.GetFolder('\').DeleteFolder($folderName, 0)
      Write-Line "Removed folder $TaskPath"
    } catch {
      Write-Line "Folder $TaskPath not removed (missing or not empty)."
    }
  }
  return
}

# -------------------------------------------------------------------------------------------- npm lookup
# npm.cmd is looked up on PATH; if only node is on PATH, npm.cmd normally sits next to node.exe.
function Find-Npm {
  $cmd = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $cmd) { return $cmd.Source }
  $node = Get-Command 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $node) {
    $candidate = Join-Path (Split-Path $node.Source -Parent) 'npm.cmd'
    if (Test-Path $candidate) { return $candidate }
  }
  throw 'npm.cmd not found: install Node.js (>= 23.6) and make sure npm is on PATH.'
}
$Npm = Find-Npm

# Every action runs through cmd.exe: npm is a .cmd shim anyway, `set "VAR=value"&&` scopes BOT_CONFIG to this
# one process tree without touching the user's environment, and cmd passes `--` through to npm unchanged,
# whereas Windows PowerShell 5.1 can strip a bare `--` from native command lines. The command after /c always
# starts with `set` (a harmless marker variable when there is no BOT_CONFIG), never with a quote, so cmd's
# quote-stripping rule for `/c "..."` cannot mangle the quoted npm path.
function New-NpmCommand([string]$NpmArgs, [string]$BotConfig) {
  $prefix = ''
  if ($BotConfig) { $prefix = "set `"BOT_CONFIG=$BotConfig`"&& " }
  else { $prefix = 'set "KRYPTO_KAL_TASK=1"&& ' }
  return "/c $prefix`"$Npm`" $NpmArgs"
}

# ---------------------------------------------------------------------------------------------- triggers
# Every even UTC hour of today (00:00Z ... 22:00Z), as UTC DateTimes.
function Get-SlotUtcTimes {
  $utcMidnight = [DateTime]::SpecifyKind([DateTime]::UtcNow.Date, [DateTimeKind]::Utc)
  $times = @()
  for ($h = 0; $h -lt 24; $h += 2) { $times += $utcMidnight.AddHours($h) }
  return $times
}

# A daily trigger whose start boundary is written in UTC ("...Z", "synchronize across time zones"), repeated
# every 10 minutes for 40 minutes. The boundary is set explicitly, not left to the cmdlet's conversion.
function New-RetryingDailyTrigger([DateTime]$AtUtc) {
  $trigger = New-ScheduledTaskTrigger -Daily -At $AtUtc.ToLocalTime()
  $repeat = New-ScheduledTaskTrigger -Once -At $AtUtc.ToLocalTime() -RepetitionInterval (New-TimeSpan -Minutes 10) `
    -RepetitionDuration (New-TimeSpan -Minutes 40)
  $trigger.Repetition = $repeat.Repetition
  $trigger.StartBoundary = $AtUtc.ToString('yyyy-MM-ddTHH:mm:ss') + 'Z'
  return $trigger
}

# A daily trigger at a LOCAL clock time: the start boundary carries no zone designator, so it follows DST.
function New-LocalDailyTrigger([int]$Hour, [int]$Minute) {
  $at = [DateTime]::Today.AddHours($Hour).AddMinutes($Minute)
  $trigger = New-ScheduledTaskTrigger -Daily -At $at
  $trigger.StartBoundary = $at.ToString('yyyy-MM-ddTHH:mm:ss')
  return $trigger
}

function New-LogonTrigger([string]$Delay) {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
  if ($Delay) { $trigger.Delay = $Delay }
  return $trigger
}

# Wake from sleep: event 1 of Microsoft-Windows-Power-Troubleshooter in the System log. The ScheduledTasks
# module has no cmdlet for event triggers, so the CIM class is instantiated client-side (in memory only).
function New-WakeTrigger {
  $class = Get-CimClass -ClassName 'MSFT_TaskEventTrigger' -Namespace 'Root/Microsoft/Windows/TaskScheduler'
  $trigger = New-CimInstance -CimClass $class -ClientOnly -WhatIf:$false
  $trigger.Enabled = $true
  $trigger.Subscription = '<QueryList><Query Id="0" Path="System"><Select Path="System">' +
    "*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]" +
    '</Select></Query></QueryList>'
  return $trigger
}

$slotTimes = Get-SlotUtcTimes
$offset = [TimeZoneInfo]::Local.GetUtcOffset([DateTime]::UtcNow)
$offsetText = '{0}{1:hh\:mm}' -f $(if ($offset -lt [TimeSpan]::Zero) { '-' } else { '+' }), $offset
$slotText = ($slotTimes | ForEach-Object { $_.ToLocalTime() } | Sort-Object { $_.TimeOfDay } |
  ForEach-Object { $_.ToString('HH:mm') }) -join ' '

# ------------------------------------------------------------------------------------------- the table
$Tasks = @(
  [pscustomobject]@{
    Name        = 'speculation-tick'
    Description = 'krypto-kal: 2-hour speculation report, checker and bot policy handoff (npm run auto -- tick).'
    Arguments   = (New-NpmCommand 'run auto -- tick' 'config\bot.auto.json')
    TriggerText = "daily at 00:00Z 02:00Z ... 22:00Z (UTC boundaries; now local $slotText at UTC$offsetText), each repeated every 10 min for 40 min; at logon; on wake from sleep"
    Triggers    = { @($slotTimes | ForEach-Object { New-RetryingDailyTrigger $_ }) + @(New-LogonTrigger '') + @(New-WakeTrigger) }
    Settings    = { New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
                      -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries }
    SettingText = 'ignore new instance while running; time limit 30 min; start when available'
  },
  [pscustomobject]@{
    Name        = 'speculation-score'
    Description = 'krypto-kal: score the speculation bets and biases (npm run auto -- score).'
    Arguments   = (New-NpmCommand 'run auto -- score' 'config\bot.auto.json')
    TriggerText = 'daily at 23:30 local'
    Triggers    = { @(New-LocalDailyTrigger 23 30) }
    Settings    = { New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
                      -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries }
    SettingText = 'ignore new instance while running; time limit 30 min; start when available'
  },
  [pscustomobject]@{
    Name        = 'server'
    Description = 'krypto-kal: MCP server (npm start).'
    Arguments   = (New-NpmCommand 'start' '')
    TriggerText = 'at logon'
    Triggers    = { @(New-LogonTrigger '') }
    Settings    = { New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
                      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries }
    SettingText = 'no time limit; restart on failure every 1 min, up to 999 times'
  },
  [pscustomobject]@{
    Name        = 'bot'
    Description = 'krypto-kal: dry-run trading bot (npm run bot -- run --config config/bot.auto.json).'
    Arguments   = (New-NpmCommand 'run bot -- run --config config/bot.auto.json' '')
    TriggerText = 'at logon, delayed 1 min'
    Triggers    = { @(New-LogonTrigger 'PT1M') }
    Settings    = { New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
                      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries }
    SettingText = 'no time limit; restart on failure every 1 min, up to 999 times'
  }
)

# ----------------------------------------------------------------------------------------------- plan
Write-Line "Task folder:       $TaskPath"
Write-Line "Run as:            $UserId (only when logged on, limited privileges)"
Write-Line "Working directory: $RepoDir"
Write-Line "npm:               $Npm"
Write-Line ''
foreach ($t in $Tasks) {
  Write-Line ("{0}{1}" -f $TaskPath, $t.Name)
  Write-Line ("  triggers: {0}" -f $t.TriggerText)
  Write-Line ("  command:  cmd.exe {0}" -f $t.Arguments)
  Write-Line ("  cwd:      {0}" -f $RepoDir)
  Write-Line ("  settings: {0}" -f $t.SettingText)
  Write-Line ''
}

# -------------------------------------------------------------------------------------------- install
# The task objects are built in memory in both modes (New-ScheduledTask registers nothing), so -WhatIf also
# proves that every definition is valid. Only Register-ScheduledTask changes the machine.
$principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
foreach ($t in $Tasks) {
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $t.Arguments -WorkingDirectory $RepoDir
  $triggers = & $t.Triggers
  $settings = & $t.Settings
  $task = New-ScheduledTask -Action $action -Trigger $triggers -Principal $principal -Settings $settings `
    -Description $t.Description
  if ($DryRun) {
    Write-Line ("WhatIf: built {0}{1} in memory ({2} triggers), not registered" -f $TaskPath, $t.Name, @($task.Triggers).Count)
    continue
  }
  if ($PSCmdlet.ShouldProcess("$TaskPath$($t.Name)", 'Register scheduled task')) {
    Register-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -Description $t.Description `
      -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
    Write-Line "Registered $TaskPath$($t.Name)"
  }
}
if ($DryRun) {
  Write-Line 'WhatIf: nothing was registered.'
} else {
  Write-Line 'Done. Re-run this script after every daylight-saving change (see the header).'
}
