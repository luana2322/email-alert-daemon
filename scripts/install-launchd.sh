#!/bin/bash
# install-launchd.sh - Registers Email Alert Daemon as a macOS LaunchAgent (auto-start on boot)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_NAME="com.emailmonitoring.daemon.plist"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME"
NODE_PATH="$(which node)"

if [ -z "$NODE_PATH" ]; then
  echo "❌ Error: Node.js binary not found in PATH."
  exit 1
fi

mkdir -p "$SCRIPT_DIR/logs"
mkdir -p "$HOME/Library/LaunchAgents"

# Stop existing service if loaded
launchctl unload "$PLIST_PATH" 2>/dev/null

# Generate plist
cat <<EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.emailmonitoring.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$SCRIPT_DIR/src/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$SCRIPT_DIR/logs/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>$SCRIPT_DIR/logs/daemon-error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
    </dict>
</dict>
</plist>
EOF

chmod 644 "$PLIST_PATH"
launchctl load "$PLIST_PATH"

echo "✅ Email Alert Daemon đã được đăng ký thành công vào macOS LaunchAgents!"
echo "📍 Tệp cấu hình: $PLIST_PATH"
echo "📄 Nhật ký ghi tại: $SCRIPT_DIR/logs/daemon.log"
echo "🚀 Trạng thái: Daemon đang chạy ngầm và sẽ tự khởi động mỗi khi bạn bật máy Mac."

