# Installs the watchdog as a scheduled task that runs at the user's logon
# (M1-29): it starts the desktop app, keeps it running, and restarts it when
# it exits or stops answering. On Windows this task is how the app starts at
# login (W-01): the app doesn't add its own login item there. Run once, as the
# signed-in user:
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1
# The installer puts the app in the user's own Programs folder (electron-builder.yml); pass another
# path to the .exe if it is elsewhere.
param([string]$Exe = (Join-Path $env:LOCALAPPDATA "Programs\West 4 Staff\West 4 Staff.exe"))
$resources = Join-Path (Split-Path $Exe) "resources"
$watchdog = Join-Path $resources "watchdog.cjs"
# The app's own folder (main.ts pins userData to %APPDATA%\west4-desktop on every platform).
$alive = Join-Path $env:APPDATA "west4-desktop\alive"
New-Item -ItemType Directory -Force -Path (Split-Path $alive) | Out-Null
# ELECTRON_RUN_AS_NODE makes the app's own binary run the watchdog script as Node.js. It is set for
# this one process through cmd.exe, never for the whole user: set user-wide, every Electron app the
# user opens (West 4 Staff itself from the Start menu too) would start as Node.js instead.
$arguments = "/d /s /c `"set ELECTRON_RUN_AS_NODE=1&& `"$Exe`" `"$watchdog`" --app `"$Exe`" --alive `"$alive`" -- --at-login`""
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
# An earlier version of this script set ELECTRON_RUN_AS_NODE for the whole user: take it back out.
[Environment]::SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", $null, "User")
Register-ScheduledTask -TaskName "West 4 Staff watchdog" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Output "watchdog installed: scheduled task 'West 4 Staff watchdog'"
