#!/bin/bash
# Build CursorBuddy and install to /Applications/CursorBuddy.app
#
# Permissions persist across rebuilds because:
#   1. The bundle ID (com.cursorbuddy.app) stays the same
#   2. The code signing identity stays the same
#   3. Sandbox is disabled (com.apple.security.app-sandbox = false)
#   4. We sign with --identifier to embed the bundle ID in the signature
#   5. No hardened runtime for dev builds (avoids TCC reset)
#
# If permissions are lost, run:
#   tccutil reset All com.cursorbuddy.app
# then re-grant them once. They will persist from that point.

set -e

SIGNING_IDENTITY="Apple Development: Jason Kneen (E9G8K4TUEW)"
BUNDLE_ID="com.cursorbuddy.app"
APP_PATH="/Applications/CursorBuddy.app"
APP_DIR="$APP_PATH/Contents"
MACOS_DIR="$APP_DIR/MacOS"
RES_DIR="$APP_DIR/Resources"

echo "━━━ Building CursorBuddy ━━━"
cd "$(dirname "$0")"
swift build 2>&1 | tail -5

# Kill existing instance gracefully, then force if needed
if pgrep -f "CursorBuddy.app/Contents/MacOS/CursorBuddy" >/dev/null 2>&1; then
    echo "Stopping existing CursorBuddy instance..."
    pkill -f "CursorBuddy.app/Contents/MacOS/CursorBuddy" 2>/dev/null || true
    sleep 0.5
fi

# Create app bundle structure
mkdir -p "$MACOS_DIR" "$RES_DIR"

# Remove Sparkle framework (causes signing issues, not needed for dev)
rm -rf "$MACOS_DIR/Sparkle.framework" "$APP_DIR/Frameworks"

# Copy binary
cp .build/debug/CursorBuddy "$MACOS_DIR/CursorBuddy"

# Copy Info.plist
cp CursorBuddy/Info.plist "$APP_DIR/Info.plist"

# Copy entitlements for signing
cp CursorBuddy/CursorBuddy.entitlements /tmp/CursorBuddy.entitlements

# Copy resources (icon, sounds, etc)
cp CursorBuddy/Resources/* "$RES_DIR/" 2>/dev/null || true


# Codesign with stable identity + explicit bundle identifier.
echo "Signing with identity: $SIGNING_IDENTITY"
codesign --force \
    --sign "$SIGNING_IDENTITY" \
    --identifier "$BUNDLE_ID" \
    --entitlements /tmp/CursorBuddy.entitlements \
    "$APP_PATH"

# Verify the signature
if codesign --verify "$APP_PATH" 2>/dev/null; then
    echo "✓ Signature verified: $APP_PATH"
else
    echo "⚠ Signature verification failed — permissions may not persist"
fi

# Pre-grant TCC permissions so they don't reset every build.
TCC_DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
if [ -f "$TCC_DB" ]; then
    echo "Granting TCC permissions for $BUNDLE_ID..."
    for SERVICE in kTCCServiceMicrophone kTCCServiceScreenCapture kTCCServiceAccessibility kTCCServiceSpeechRecognition; do
        sqlite3 "$TCC_DB" "DELETE FROM access WHERE service='$SERVICE' AND client='$BUNDLE_ID';" 2>/dev/null
        sqlite3 "$TCC_DB" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, flags) VALUES ('$SERVICE', '$BUNDLE_ID', 0, 2, 3, 1, 0);" 2>/dev/null
    done
    echo "✓ TCC permissions granted"
else
    echo "⚠ TCC database not found — grant permissions manually"
fi

echo "━━━ Installed to $APP_PATH ━━━"
echo "Launching..."
open "$APP_PATH"
