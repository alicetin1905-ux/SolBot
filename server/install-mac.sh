#!/bin/bash
# SolBot Mac installer / updater.
#   curl -fsSL https://raw.githubusercontent.com/alicetin1905-ux/SolBot/main/server/install-mac.sh | bash
# Installs the latest SolBot into ~/SolBot, starts the server via launchd (starts at login,
# restarts automatically) and keeps the Mac awake while it runs. Run it again to update.
set -euo pipefail

APP="$HOME/SolBot"
DATA="$HOME/SolBot-data"
LABEL="com.solbot.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ZIP_URL="https://github.com/alicetin1905-ux/SolBot/archive/refs/heads/main.zip"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ "$(uname)" = "Darwin" ] || { echo "Dit script is voor macOS."; exit 1; }

say "1/4  Node.js controleren"
NODE="$(command -v node || true)"
for p in /usr/local/bin/node /opt/homebrew/bin/node; do [ -z "$NODE" ] && [ -x "$p" ] && NODE="$p"; done
if [ -z "$NODE" ]; then
  echo "Node.js is niet geïnstalleerd."
  echo "→ Ga naar https://nodejs.org, download de LTS-versie (macOS Installer, .pkg), installeer die,"
  echo "  en plak daarna dit commando opnieuw in Terminal."
  open "https://nodejs.org/en/download" 2>/dev/null || true
  exit 1
fi
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 22 ]; then
  echo "Node.js $("$NODE" -v) is te oud: SolBot heeft versie 22 of nieuwer nodig."
  echo "→ Installeer de LTS-versie via https://nodejs.org en plak dit commando daarna opnieuw."
  exit 1
fi
echo "Node.js $("$NODE" -v) gevonden: $NODE"

say "2/4  Nieuwste SolBot downloaden"
mkdir -p "$APP" "$DATA" "$HOME/Library/LaunchAgents"
TMP="$(mktemp -d)"
curl -fsSL "$ZIP_URL" -o "$TMP/solbot.zip"
unzip -q "$TMP/solbot.zip" -d "$TMP"
rsync -a --delete "$TMP/SolBot-main/" "$APP/"
rm -rf "${TMP:?}"
echo "Code staat in $APP (je data blijft apart in $DATA)"

say "3/4  Server instellen (start automatisch, Mac blijft wakker)"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-is</string>
    <string>$NODE</string><string>$APP/server/solbot-server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>EnvironmentVariables</key><dict><key>SOLBOT_DATA</key><string>$DATA</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DATA/server.log</string>
  <key>StandardErrorPath</key><string>$DATA/server.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST"

say "4/4  Starten…"
for i in $(seq 1 20); do
  [ -f "$DATA/config.json" ] && curl -fs "http://localhost:8787/api/hello" >/dev/null 2>&1 && break
  sleep 1
done
PORT="$("$NODE" -p "require('$DATA/config.json').port" 2>/dev/null || echo 8787)"
CODE="$("$NODE" -p "require('$DATA/config.json').key" 2>/dev/null || echo '?')"
HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '')"

if curl -fs "http://localhost:$PORT/api/hello" >/dev/null 2>&1; then
  say "✅ SolBot draait 24/7 op deze Mac"
  echo "   Op deze Mac:      http://localhost:$PORT"
  echo "   Thuis op iPhone:  http://$HOST.local:$PORT${IP:+    (of http://$IP:$PORT)}"
  echo "   Toegangscode:     $CODE"
  echo
  echo "   Log bekijken:     tail -f $DATA/server.log"
  echo "   Updaten:          plak hetzelfde installatiecommando opnieuw"
  echo "   Stoppen:          launchctl bootout gui/\$(id -u)/$LABEL"
  open "http://localhost:$PORT" 2>/dev/null || true
else
  say "⚠️ De server reageert nog niet. Laatste regels uit het log:"
  tail -n 30 "$DATA/server.log" 2>/dev/null || true
fi
