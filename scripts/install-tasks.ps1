<#
.SYNOPSIS
  Installs (or removes) the Windows Task Scheduler tasks of the speculation automation.

.DESCRIPTION
  Registers four tasks in the task folder \krypto-kal\, all defined in ONE table ($Tasks below), so the
  -WhatIf plan and the real install are built from the same definitions:

    speculation-tick   npm run auto -- tick   (BOT_CONFIG=config\bot.auto.json)
                       24 hourly daily triggers at 00:00Z ... 23:00Z (start boundaries in UTC; Task Scheduler
                       allows at most 48 triggers per task), each repeated every 10 minutes for 55 minutes:
                       a start every 10 minutes, so up to 3 starts per 30-minute slot (+0, +10, +20 min;
                       retries, the tick is idempotent). Plus at logon and on wake from sleep
                       (Power-Troubleshooter event 1), both delayed 2 minutes so the MCP server listens first.
                       Ignores a new start while one runs, stops after 30 minutes, starts when available.
    speculation-score  npm run auto -- score  (BOT_CONFIG=config\bot.auto.json), daily 23:30 local.
    server             npm start: at logon, plus a logon trigger repeated every 5 minutes indefinitely.
    bot                npm run bot -- run --config config/bot.auto.json: at logon delayed 1 minute (so the
                       server is up), plus the same 5-minute repeating trigger (also delayed 1 minute).

  All tasks run as the current user, only while that user is logged on (no stored password, limited
  privileges). The working directory is the repo root, resolved from this script's location.

  SUPERVISION (server, bot): every task uses MultipleInstances IgnoreNew, so the 5-minute repeating trigger
  starts the program again within 5 minutes after it has exited and leaves a running instance alone. The
  restart-on-failure settings (every 1 minute, up to 999 times) are kept but cover little: they react to a
  non-zero exit code, and the headless console host (below) always reports 0, so in practice they only cover
  a failure to launch. Limits:
    - a hung but still running process is not detected (the task stays "running", nothing restarts it);
    - the bot launcher runs the trader and the watchdog; if the trader crashes while the watchdog lives,
      the launcher has not exited, so nothing is restarted until the launcher itself exits;
    - a server or bot started by hand outside the task is not seen by Task Scheduler: the task starts a
      second one (the server's fails to bind the port and exits; a second bot is NOT prevented).

  CONSOLE WINDOWS: actions run as `conhost.exe --headless cmd.exe /c ...`, so no console window opens (proven
  on the author's machine with a harmless command: the file was written, no window, exit in ~0.1 s, and
  conhost stays alive while its child runs). Side effect: conhost's exit code is always 0, so Task
  Scheduler's "Last Run Result" does not show failures; the automation's own run log and alerts.md do.

  STOPPING: Stop-ScheduledTask, the 30-minute time limit of the tick and -Uninstall end the task's top
  process (conhost); the cmd/node processes under it may be left running (orphaned). Check with Task Manager
  (node.exe) after an uninstall.

  LIMITATION (DST): Task Scheduler normally works in local time. The tick triggers are written with UTC
  start boundaries ("2026-10-13T02:00:00Z", the "synchronize across time zones" option), which Task
  Scheduler is documented to keep on the UTC clock, so the grid should survive a daylight-saving change.
  This is not yet verified on this machine: after the first DST change (2026-10-25) check the tasks' next
  run times; if they moved by an hour, re-run this script, which recomputes everything. A late tick still
  catches up (the tick is idempotent and finds the due slot), so a shifted trigger delays a report by up to
  an hour; it does not lose it. The score task is deliberately local time (23:30 on the local clock).

  NPM PATH: the full path of npm.cmd is resolved at install time and written into the tasks. After
  reinstalling Node.js into another folder, re-run this script.

  ELEVATION: the tasks themselves run Limited as the current user, but creating the \krypto-kal\ task
  folder may need an elevated (Run as administrator) shell on some machines. If registering fails with
  "Access is denied", run the install once from an elevated PowerShell.

.PARAMETER Uninstall
  Stops and removes the four tasks of this script (names from the table below) in \krypto-kal\, then the
  folder if it is empty. Nothing else is touched.

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
# The only tasks this script creates or removes. The table below must use exactly these names.
$TaskNames = @('speculation-tick', 'speculation-score', 'server', 'bot')
$DryRun = [bool]$WhatIfPreference
$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$UserId = "$env:USERDOMAIN\$env:USERNAME"

function Write-Line([string]$Text) { Write-Host $Text }

# Load the modules up front with WhatIf off: their auto-import only defines aliases, and under -WhatIf it would
# otherwise print a "Set Alias" line for each of them.
& { $WhatIfPreference = $false; Import-Module ScheduledTasks, CimCmdlets -Global }

# ---------------------------------------------------------------------------------------------- uninstall
if ($Uninstall) {
  $found = 0
  foreach ($name in $TaskNames) {
    $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $name -ErrorAction SilentlyContinue
    if ($null -eq $task) {
      Write-Line "Not installed: $TaskPath$name"
      continue
    }
    $found++
    if ($DryRun) {
      Write-Line "WhatIf: would stop and remove task $TaskPath$name"
    }
    if ($PSCmdlet.ShouldProcess("$TaskPath$name", 'Stop and unregister scheduled task')) {
      # Stopping ends the task's top process; node under it may be left running (see STOPPING above).
      # A failure on one task is printed and the others are still removed; a failed stop does not
      # prevent the unregister.
      try {
        try {
          Stop-ScheduledTask -TaskPath $TaskPath -TaskName $name
        } catch {
          Write-Line "Could not stop $TaskPath${name}: $($_.Exception.Message)"
        }
        Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $name -Confirm:$false
        Write-Line "Removed $TaskPath$name"
      } catch {
        Write-Line "Could not remove $TaskPath${name}: $($_.Exception.Message)"
      }
    }
  }
  if ($found -eq 0) { Write-Line "None of the tasks are installed; nothing to remove." }
  # Remove the folder through the Task Scheduler COM API (there is no cmdlet for folders); it fails, and
  # stays, when it is missing or still holds other tasks.
  $folderName = $TaskPath.Trim('\')
  if ($DryRun) {
    Write-Line "WhatIf: would remove the task folder $TaskPath if it exists and is empty"
  }
  if ($PSCmdlet.ShouldProcess($TaskPath, 'Delete task folder if empty')) {
    try {
      $svc = New-Object -ComObject 'Schedule.Service'
      $svc.Connect()
      $svc.GetFolder('\').DeleteFolder($folderName, 0)
      Write-Line "Removed folder $TaskPath"
    } catch {
      Write-Line ("Folder $TaskPath not removed: {0}" -f $_.Exception.Message)
    }
  }
  return
}

# -------------------------------------------------------------------------------------------- npm lookup
# npm.cmd is looked up on PATH; if only node is on PATH, npm.cmd normally sits next to node.exe. The path is
# fixed at install time (see NPM PATH in the header).
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
$Conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
if (-not (Test-Path $Conhost)) { throw "conhost.exe not found at $Conhost" }

# Every action is `conhost.exe --headless cmd.exe /c ...`. conhost --headless gives the console programs a
# console without a window (see CONSOLE WINDOWS in the header). cmd.exe because npm is a .cmd shim anyway,
# `set "VAR=value"&&` scopes BOT_CONFIG to this one process tree without touching the user's environment, and
# cmd passes `--` through to npm unchanged, whereas Windows PowerShell 5.1 can strip a bare `--` from native
# command lines. The command after /c always starts with `set` (a harmless marker variable when there is no
# BOT_CONFIG), never with a quote, so cmd's quote-stripping rule for `/c "..."` cannot mangle the npm path.
function New-NpmCommand([string]$NpmArgs, [string]$BotConfig) {
  $prefix = ''
  if ($BotConfig) { $prefix = "set `"BOT_CONFIG=$BotConfig`"&& " }
  else { $prefix = 'set "KRYPTO_KAL_TASK=1"&& ' }
  return "--headless cmd.exe /c $prefix`"$Npm`" $NpmArgs"
}

# ---------------------------------------------------------------------------------------------- triggers
# Every hour of today (00:00Z, 01:00Z ... 23:00Z), as UTC DateTimes. Task Scheduler allows at most 48 triggers
# per task, so one trigger per hour (repeating every 10 minutes) covers both half-hour slots.
function Get-SlotUtcTimes {
  $utcMidnight = [DateTime]::SpecifyKind([DateTime]::UtcNow.Date, [DateTimeKind]::Utc)
  $times = @()
  for ($m = 0; $m -lt 24 * 60; $m += 60) { $times += $utcMidnight.AddMinutes($m) }
  return $times
}

# A daily trigger whose start boundary is written in UTC ("...Z", "synchronize across time zones"), repeated
# every 10 minutes for 55 minutes (starts at +0, +10 ... +50: two 30-minute slots, each with up to 3 starts). The boundary is set explicitly, not left to the cmdlet's conversion.
function New-RetryingDailyTrigger([DateTime]$AtUtc) {
  $trigger = New-ScheduledTaskTrigger -Daily -At $AtUtc.ToLocalTime()
  $repeat = New-ScheduledTaskTrigger -Once -At $AtUtc.ToLocalTime() -RepetitionInterval (New-TimeSpan -Minutes 10) `
    -RepetitionDuration (New-TimeSpan -Minutes 55)
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

# A logon trigger repeated every 5 minutes with no duration limit (an empty Duration means indefinitely).
# Together with MultipleInstances IgnoreNew this restarts an exited program and leaves a running one alone.
function New-SupervisorTrigger([string]$Delay) {
  $trigger = New-LogonTrigger $Delay
  $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $trigger.Repetition = $repeat.Repetition
  return $trigger
}

# Wake from sleep: event 1 of Microsoft-Windows-Power-Troubleshooter in the System log. The ScheduledTasks
# module has no cmdlet for event triggers, so the CIM class is instantiated client-side (in memory only).
# MSFT_TaskEventTrigger has a Delay property, used to give the server time to come back after wake.
function New-WakeTrigger([string]$Delay) {
  $class = Get-CimClass -ClassName 'MSFT_TaskEventTrigger' -Namespace 'Root/Microsoft/Windows/TaskScheduler'
  $trigger = New-CimInstance -CimClass $class -ClientOnly -WhatIf:$false
  $trigger.Enabled = $true
  $trigger.Subscription = '<QueryList><Query Id="0" Path="System"><Select Path="System">' +
    "*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]" +
    '</Select></Query></QueryList>'
  if ($Delay) { $trigger.Delay = $Delay }
  return $trigger
}

$slotTimes = Get-SlotUtcTimes
$offset = [TimeZoneInfo]::Local.GetUtcOffset([DateTime]::UtcNow)
$offsetText = '{0}{1:hh\:mm}' -f $(if ($offset -lt [TimeSpan]::Zero) { '-' } else { '+' }), $offset
$slotText = "every hour, $(@($slotTimes).Count) triggers a day"

$supervisedSettings = {
  New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
}
$supervisedText = 'ignore new instance while running; no time limit; restart on failure every 1 min, up to 999 times'
$shortSettings = {
  New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
}
$shortText = 'ignore new instance while running; time limit 30 min; start when available'

# ------------------------------------------------------------------------------------------- the table
$Tasks = @(
  [pscustomobject]@{
    Name        = 'speculation-tick'
    Description = 'krypto-kal: 30-minute speculation report, checker and bot policy handoff (npm run auto -- tick).'
    Arguments   = (New-NpmCommand 'run auto -- tick' 'config\bot.auto.json')
    TriggerText = "daily at 00:00Z 01:00Z ... 23:00Z (UTC boundaries; local $slotText at UTC$offsetText), " +
                  'each repeated every 10 min for 55 min (a start every 10 min, so up to 3 starts per 30-min slot: +0..+20 min); ' +
                  'at logon, delayed 2 min; on wake from sleep, delayed 2 min'
    Triggers    = { @($slotTimes | ForEach-Object { New-RetryingDailyTrigger $_ }) + @(New-LogonTrigger 'PT2M') + @(New-WakeTrigger 'PT2M') }
    Settings    = $shortSettings
    SettingText = $shortText
  },
  [pscustomobject]@{
    Name        = 'speculation-score'
    Description = 'krypto-kal: score the speculation bets and biases (npm run auto -- score).'
    Arguments   = (New-NpmCommand 'run auto -- score' 'config\bot.auto.json')
    TriggerText = 'daily at 23:30 local'
    Triggers    = { @(New-LocalDailyTrigger 23 30) }
    Settings    = $shortSettings
    SettingText = $shortText
  },
  [pscustomobject]@{
    Name        = 'server'
    Description = 'krypto-kal: MCP server (npm start).'
    Arguments   = (New-NpmCommand 'start' '')
    TriggerText = 'at logon; at logon repeated every 5 min indefinitely (restarts it after an exit)'
    Triggers    = { @(New-LogonTrigger '') + @(New-SupervisorTrigger '') }
    Settings    = $supervisedSettings
    SettingText = $supervisedText
  },
  [pscustomobject]@{
    Name        = 'bot'
    Description = 'krypto-kal: dry-run trading bot (npm run bot -- run --config config/bot.auto.json).'
    Arguments   = (New-NpmCommand 'run bot -- run --config config/bot.auto.json' '')
    TriggerText = 'at logon, delayed 1 min; at logon delayed 1 min, repeated every 5 min indefinitely (restarts it after an exit)'
    Triggers    = { @(New-LogonTrigger 'PT1M') + @(New-SupervisorTrigger 'PT1M') }
    Settings    = $supervisedSettings
    SettingText = $supervisedText
  }
)
$tableNames = @($Tasks | ForEach-Object { $_.Name })
if (($tableNames -join ',') -ne ($TaskNames -join ',')) { throw 'The task table does not match $TaskNames.' }

# ----------------------------------------------------------------------------------------------- plan
Write-Line "Task folder:       $TaskPath"
Write-Line "Run as:            $UserId (only when logged on, limited privileges)"
Write-Line "Working directory: $RepoDir"
Write-Line "npm:               $Npm"
Write-Line ''
foreach ($t in $Tasks) {
  Write-Line ("{0}{1}" -f $TaskPath, $t.Name)
  Write-Line ("  triggers: {0}" -f $t.TriggerText)
  Write-Line ("  command:  {0} {1}" -f $Conhost, $t.Arguments)
  Write-Line ("  cwd:      {0}" -f $RepoDir)
  Write-Line ("  settings: {0}" -f $t.SettingText)
  Write-Line ''
}

# -------------------------------------------------------------------------------------------- install
# The task objects are built in memory in both modes (New-ScheduledTask registers nothing), so -WhatIf also
# proves that every definition is valid. Only Register-ScheduledTask changes the machine.
$principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
foreach ($t in $Tasks) {
  $action = New-ScheduledTaskAction -Execute $Conhost -Argument $t.Arguments -WorkingDirectory $RepoDir
  $triggers = & $t.Triggers
  $settings = & $t.Settings
  $task = New-ScheduledTask -Action $action -Trigger $triggers -Principal $principal -Settings $settings `
    -Description $t.Description
  if ($DryRun) {
    Write-Line ("WhatIf: built {0}{1} in memory ({2} triggers), not registered" -f $TaskPath, $t.Name, @($task.Triggers).Count)
    $kinds = $task.Triggers | Group-Object {
      $kind = $_.CimClass.CimClassName -replace '^MSFT_Task|Trigger$', ''
      $rep = ''
      if ($_.Repetition -and $_.Repetition.Interval) {
        $for = 'indefinitely'
        if ($_.Repetition.Duration) { $for = "for $($_.Repetition.Duration)" }
        $rep = " every $($_.Repetition.Interval) $for"
      }
      $delay = ''
      if (($_.CimInstanceProperties.Name -contains 'Delay') -and $_.Delay) { $delay = " delay $($_.Delay)" }
      "$kind$delay$rep"
    }
    foreach ($k in $kinds) { Write-Line ("          {0} x {1}" -f $k.Count, $k.Name) }
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
  Write-Line 'Done. After the first DST change (2026-10-25) check the next run times of speculation-tick and re-run this script if they moved.'
}
