#!/usr/bin/env bash
# Installs the watchdog as a launchd agent for the signed-in user (M1-29):
# it starts at login, keeps the desktop app running, and restarts it when it
# exits or stops answering. Run once on the bar and front-desk computers:
#   bash install-macos.sh "/Applications/West 4 Staff.app"
set -euo pipefail
app="${1:-/Applications/West 4 Staff.app}"
exe="$app/Contents/MacOS/West 4 Staff"
watchdog="$app/Contents/Resources/watchdog.cjs"
alive="$HOME/Library/Application Support/west4-desktop/alive"
label="com.west4.staff.watchdog"
plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$alive")"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>$exe</string><string>$watchdog</string>
    <string>--app</string><string>$exe</string>
    <string>--alive</string><string>$alive</string>
    <string>--</string><string>--at-login</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/west4-watchdog.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/west4-watchdog.log</string>
</dict></plist>
PLIST
launchctl unload "$plist" 2>/dev/null || true
launchctl load -w "$plist"
echo "watchdog installed: $plist"
