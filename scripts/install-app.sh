#!/bin/sh
# Builds ~/Applications/Situation Room.app: this repo's Electron, renamed, running main.js from here.
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
APP="$HOME/Applications/Situation Room.app"
TMP=$(mktemp -d)

mkdir "$TMP/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$REPO/assets/icon.png" --out "$TMP/icon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$REPO/assets/icon.png" --out "$TMP/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$TMP/icon.iconset" -o "$TMP/icon.icns"

cp -R "$REPO/node_modules/electron/dist/Electron.app" "$TMP/Situation Room.app"
C="$TMP/Situation Room.app/Contents"
cp "$TMP/icon.icns" "$C/Resources/electron.icns"
P=/usr/libexec/PlistBuddy
$P -c "Set :CFBundleName Situation Room" -c "Set :CFBundleIdentifier dev.situation-room" "$C/Info.plist"
$P -c "Set :CFBundleDisplayName Situation Room" "$C/Info.plist" 2>/dev/null || $P -c "Add :CFBundleDisplayName string Situation Room" "$C/Info.plist"

mkdir "$C/Resources/app"
printf '{ "name": "situation-room", "productName": "Situation Room", "main": "index.js" }\n' > "$C/Resources/app/package.json"
cat > "$C/Resources/app/index.js" <<JS
const { app } = require('electron');
const path = require('path');
app.setPath('userData', path.join(app.getPath('appData'), 'situation-room'));
require('$REPO/main.js');
JS

codesign --force --deep --sign - "$TMP/Situation Room.app" 2>/dev/null
mkdir -p "$HOME/Applications"
rm -rf "$APP"
mv "$TMP/Situation Room.app" "$APP"
rm -rf "$TMP"
echo "Installed $APP"
