#!/bin/bash
#
# Xcode Cloud: ci_post_xcodebuild.sh
# Runs after xcodebuild completes.
# Validates the build output and prints diagnostics.

set -euo pipefail

echo "━━━ CursorBuddy: Post-Build ━━━"

# Print build result
if [ "${CI_XCODEBUILD_EXIT_CODE:-0}" -eq 0 ]; then
    echo "✅ Build succeeded"
else
    echo "❌ Build failed with exit code: ${CI_XCODEBUILD_EXIT_CODE}"
    exit 1
fi

# Print archive info if available
if [ -n "${CI_ARCHIVE_PATH:-}" ] && [ -d "$CI_ARCHIVE_PATH" ]; then
    echo "Archive: $CI_ARCHIVE_PATH"
    
    APP_PATH="$CI_ARCHIVE_PATH/Products/Applications/CursorBuddy.app"
    if [ -d "$APP_PATH" ]; then
        echo "App bundle found: $APP_PATH"
        
        # Verify Info.plist
        BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "unknown")
        VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "unknown")
        BUILD=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "unknown")
        
        echo "Bundle ID: $BUNDLE_ID"
        echo "Version: $VERSION ($BUILD)"
        
        # Verify code signature
        if codesign --verify --deep --strict "$APP_PATH" 2>/dev/null; then
            echo "✅ Code signature valid"
        else
            echo "⚠️ Code signature verification failed"
        fi
    fi
fi

echo "━━━ Post-Build Complete ━━━"
