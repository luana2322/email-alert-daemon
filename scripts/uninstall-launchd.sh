#!/bin/bash
# uninstall-launchd.sh - Removes Email Alert Daemon LaunchAgent from macOS

PLIST_NAME="com.emailmonitoring.daemon.plist"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME"

if [ -f "$PLIST_PATH" ]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null
  rm -f "$PLIST_PATH"
  echo "✅ Đã gỡ bỏ Email Alert Daemon khỏi macOS LaunchAgents thành công."
else
  echo "ℹ️ LaunchAgent không tồn tại: $PLIST_PATH"
fi

