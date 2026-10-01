# Installs the watchdog as a scheduled task that runs at the user's logon
# (M1-29): it starts the desktop app, keeps it running, and restarts it when
# it exits or stops answering. Run once, as the signed-in user:
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1 "C:\Program Files\West 4 Staff\West 4 Staff.exe"
param([string]$Exe = "C:\Program Files\West 4 Staff\West 4 Staff.exe")
$resources = Join-Path (Split-Path $Exe) "resources"
$watchdog = Join-Path $resources "watchdog.cjs"
$alive = Join-Path $env:APPDATA "west4-desktop\alive"
New-Item -ItemType Directory -Force -Path (Split-Path $alive) | Out-Null
$arguments = "`"$watchdog`" --app `"$Exe`" --alive `"$alive`" -- --at-login"
$action = New-ScheduledTaskAction -Execute $Exe -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
# ELECTRON_RUN_AS_NODE makes the app's own binary run the watchdog script as Node.js.
[Environment]::SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "1", "User")
Register-ScheduledTask -TaskName "West 4 Staff watchdog" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Output "watchdog installed: scheduled task 'West 4 Staff watchdog'"
