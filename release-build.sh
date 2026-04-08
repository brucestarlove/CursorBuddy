#!/bin/bash
#
# Build a distributable Release archive for Pucks.
# Optional notarization is enabled when NOTARY_PROFILE is set.
#
# Usage:
#   ./release-build.sh
#   DEVELOPER_IDENTITY="Developer ID Application: Your Name (TEAMID)" ./release-build.sh
#   NOTARY_PROFILE="pucks-notary" ./release-build.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_PATH="$ROOT_DIR/.swiftpm/xcode/package.xcworkspace"
SCHEME="Pucks"
CONFIGURATION="Release"
APP_NAME="Pucks"
BUNDLE_ID="com.pucksapp.pucks"
ENTITLEMENTS_PATH="$ROOT_DIR/Pucks/Pucks.entitlements"
INFO_PLIST_PATH="$ROOT_DIR/Pucks/Info.plist"

BUILD_ROOT="$ROOT_DIR/.build/release"
DERIVED_DATA_PATH="$BUILD_ROOT/DerivedData"
ARCHIVE_PATH="$BUILD_ROOT/$APP_NAME.xcarchive"
EXPORT_DIR="$BUILD_ROOT/export"
APP_PATH="$EXPORT_DIR/$APP_NAME.app"
ZIP_PATH="$BUILD_ROOT/$APP_NAME-macOS.zip"
DMG_PATH="$BUILD_ROOT/$APP_NAME-macOS.dmg"
STAGING_DMG_DIR="$BUILD_ROOT/dmg"

DEVELOPER_IDENTITY="${DEVELOPER_IDENTITY:-}"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"
TEAM_ID="${TEAM_ID:-}"

if [ -z "$DEVELOPER_IDENTITY" ]; then
    MATCHING_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" | head -1 | sed 's/.*"//; s/"$//')"
    if [ -n "$MATCHING_IDENTITY" ]; then
        DEVELOPER_IDENTITY="$MATCHING_IDENTITY"
    fi
fi

if [ -z "$DEVELOPER_IDENTITY" ]; then
    echo "No Developer ID Application certificate found."
    echo "Set DEVELOPER_IDENTITY explicitly, for example:"
    echo "  DEVELOPER_IDENTITY=\"Developer ID Application: Your Name (TEAMID)\" ./release-build.sh"
    exit 1
fi

echo "━━━ Building Pucks Release Archive ━━━"
echo "Workspace: $WORKSPACE_PATH"
echo "Signing identity: $DEVELOPER_IDENTITY"
if [ -n "$NOTARY_PROFILE" ]; then
    echo "Notary profile: $NOTARY_PROFILE"
fi

rm -rf "$ARCHIVE_PATH" "$EXPORT_DIR" "$ZIP_PATH" "$DMG_PATH" "$STAGING_DMG_DIR"
mkdir -p "$BUILD_ROOT" "$EXPORT_DIR" "$STAGING_DMG_DIR"

xcodebuild \
    -workspace "$WORKSPACE_PATH" \
    -scheme "$SCHEME" \
    -configuration "$CONFIGURATION" \
    -derivedDataPath "$DERIVED_DATA_PATH" \
    -archivePath "$ARCHIVE_PATH" \
    CODE_SIGNING_ALLOWED=NO \
    archive

cp -R "$ARCHIVE_PATH/Products/Applications/$APP_NAME.app" "$APP_PATH"

# Ensure the archived app carries the project plist in case the archive was built unsigned.
cp "$INFO_PLIST_PATH" "$APP_PATH/Contents/Info.plist"

sign_path() {
    local path="$1"
    echo "Signing: $path"
    codesign \
        --force \
        --sign "$DEVELOPER_IDENTITY" \
        --timestamp \
        --options runtime \
        --entitlements "$ENTITLEMENTS_PATH" \
        "$path"
}

# Sign nested code before the app bundle itself.
while IFS= read -r path; do
    sign_path "$path"
done < <(find "$APP_PATH/Contents" \
    \( -name "*.framework" -o -name "*.dylib" -o -name "*.bundle" -o -name "*.xpc" -o -perm -111 \) \
    -print | sort)

sign_path "$APP_PATH"

echo "Verifying signature..."
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH"

echo "Creating ZIP artifact..."
ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

echo "Creating DMG artifact..."
mkdir -p "$STAGING_DMG_DIR"
cp -R "$APP_PATH" "$STAGING_DMG_DIR/"
hdiutil create \
    -volname "$APP_NAME" \
    -srcfolder "$STAGING_DMG_DIR" \
    -ov \
    -format UDZO \
    "$DMG_PATH" >/dev/null

if [ -n "$NOTARY_PROFILE" ]; then
    echo "Submitting DMG for notarization..."
    xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" --wait

    echo "Stapling notarization ticket..."
    xcrun stapler staple "$DMG_PATH"

    echo "Re-validating stapled DMG..."
    xcrun stapler validate "$DMG_PATH"
else
    echo "Skipping notarization. Set NOTARY_PROFILE to notarize and staple the DMG."
fi

echo "━━━ Release Artifacts Ready ━━━"
echo "App: $APP_PATH"
echo "ZIP: $ZIP_PATH"
echo "DMG: $DMG_PATH"
if [ -n "$TEAM_ID" ]; then
    echo "Team ID: $TEAM_ID"
fi
