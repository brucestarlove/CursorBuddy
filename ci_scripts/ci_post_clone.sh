#!/bin/bash
#
# Xcode Cloud: ci_post_clone.sh
# Runs after the repository is cloned.
# Resolves Swift Package Manager dependencies.

set -euo pipefail

echo "━━━ CursorBuddy: Post-Clone ━━━"
echo "Xcode version: $(xcodebuild -version | head -1)"
echo "Swift version: $(swift --version | head -1)"
echo "Working directory: $(pwd)"

# Resolve SPM dependencies
echo "Resolving Swift Package Manager dependencies..."
swift package resolve

echo "━━━ Post-Clone Complete ━━━"
