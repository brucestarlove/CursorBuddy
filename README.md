# CursorBuddy

CursorBuddy is a native macOS menu bar AI companion that lives in your system tray and helps you learn, think, and create through voice conversation.

## What It Does

CursorBuddy is a push-to-talk AI assistant that:

- Lives in the macOS menu bar (LSUIElement app — no dock icon)
- Captures your screen for visual context when you talk to it
- Transcribes your speech via multiple providers (OpenAI, Deepgram, AssemblyAI, Apple Speech)
- Sends your transcript + screenshot to Claude AI for intelligent responses
- Speaks responses back to you using ElevenLabs or Cartesia text-to-speech
- Supports global hotkeys for push-to-talk activation
- Features a cursor overlay that flies to and points at UI elements on screen

## Architecture

```
CursorBuddy/
├── CursorBuddyApp.swift       # SwiftUI App entry point, menu bar setup
├── CompanionAppDelegate.swift  # NSApplicationDelegate, manager orchestration
├── Info.plist                  # App configuration, permissions, Sparkle config
├── CursorBuddy.entitlements   # Sandbox disabled (CGEvent tap, screen capture)
├── Views/                      # SwiftUI views (settings, popover, overlays)
│   ├── CompanionPanelView      # Main chat panel UI
│   ├── MenuBarPanelManager     # NSStatusItem + NSPanel management
│   ├── SettingsWindow          # Full settings with sidebar navigation
│   └── LensSettingsView        # Liquid Glass lens configuration
├── Managers/                   # Core business logic
│   ├── CompanionManager        # Orchestrates talk → transcribe → AI → TTS flow
│   └── FloatingSessionButton   # Floating mic button
├── API/                        # API clients
│   ├── ClaudeAPI               # Anthropic Claude (vision + text, streaming)
│   ├── CodexAPI                # OpenAI chat completions
│   ├── OpenAIAPI               # Whisper transcription
│   ├── ElevenLabsTTSClient     # ElevenLabs text-to-speech
│   └── CartesiaTTSClient       # Cartesia real-time TTS
├── Audio/                      # Audio recording + transcription
│   ├── BuddyDictationManager   # AVAudioEngine recording
│   ├── TranscriptionProtocol   # Provider protocol
│   ├── VoiceActivityDetector   # VAD for auto-stop
│   └── Provider implementations (OpenAI, Deepgram, AssemblyAI, Apple Speech)
├── Overlay/                    # Screen overlay views
│   ├── CursorOverlayView       # Animated cursor buddy
│   ├── OverlayWindow           # Per-screen transparent windows
│   ├── LensOverlay             # Liquid Glass magnification lens
│   ├── CompanionResponseOverlay # Streaming response bubble
│   └── GlobalPushToTalkOverlay  # PTT visual indicator
├── Utilities/                  # Helpers + system integration
│   ├── APIKeyConfig            # Multi-source key resolution
│   ├── APIKeysManager          # Key persistence
│   ├── CompanionPermissionCenter # macOS permission management
│   ├── ElementLocationDetector  # [POINT:] tag parsing + cursor flight
│   ├── ScreenshotManager       # ScreenCaptureKit integration
│   ├── SelectedTextMonitor      # AX API selected text tracking
│   └── CGEventShortcutMonitor   # Global hotkey via CGEvent tap
└── Resources/                  # Assets (AppIcon.icns)
```

**Key technology choices:**
- **SwiftUI + AppKit** hybrid — SwiftUI for views, AppKit for menu bar, overlays, and system APIs
- **No sandbox** — required for CGEvent tap (global hotkeys) and screen capture
- **Universal binary** — runs natively on both Apple Silicon and Intel Macs
- **macOS 26+** — uses Liquid Glass effects

**Dependencies:**
- [Sparkle](https://github.com/sparkle-project/Sparkle) — auto-updates
- [PostHog](https://github.com/PostHog/posthog-ios) — analytics
- [PLCrashReporter](https://github.com/microsoft/plcrashreporter) — crash reporting

## Building

### Prerequisites
- Xcode 26+ with macOS 26 SDK
- Swift 6.2+

### Build with Xcode
1. Open `Package.swift` in Xcode (File → Open → select Package.swift)
2. Select the "CursorBuddy" scheme and "My Mac" as the run destination
3. Build and run (⌘R)

### Build from command line
```bash
swift build
swift run CursorBuddy
```

### Dev Build & Install
```bash
./build-and-run.sh  # Builds, signs, installs to /Applications, launches
```

### Release Build
```bash
./release-build.sh  # Archives, signs with Developer ID, creates DMG + ZIP
```

### API Keys
Configure in the app's Settings → API Keys, or create `~/.cursorbuddy/keys.json`:
```json
{
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "OPENAI_API_KEY": "sk-...",
    "ELEVENLABS_API_KEY": "...",
    "DEEPGRAM_API_KEY": "..."
}
```

Or set environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, etc.

## CI/CD

### Xcode Cloud
The `ci_scripts/` directory contains scripts for Xcode Cloud workflows:
- `ci_post_clone.sh` — resolves SPM dependencies after clone
- `ci_post_xcodebuild.sh` — post-build validation

### GitHub Actions
`.github/workflows/release.yml` handles:
- Build + sign with Developer ID certificate
- Notarize with Apple
- Create DMG + ZIP artifacts
- Upload to GitHub Releases

Required secrets: `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

## License

MIT
